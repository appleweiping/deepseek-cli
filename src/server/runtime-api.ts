/**
 * server/runtime-api.ts — optional local HTTP/SSE control surface for WEIPING_WHALE.
 *
 * SECURITY POSTURE (deliberate):
 *  - OFF by default; only starts when the user passes `--serve`.
 *  - Binds 127.0.0.1 only unless the user explicitly sets a host.
 *  - Requires a bearer token on every /v1 route; a token is auto-generated and
 *    printed once at startup if none is configured.
 *  - No file paths, secrets, or provider URLs are exposed in responses.
 *
 * Endpoints:
 *   GET  /health                      -> { ok, service, version }   (no auth)
 *   POST /v1/message  {message}       -> runs a turn, returns { reply }
 *   GET  /v1/stream?message=...       -> SSE: token/тool events then done
 *   GET  /v1/cost                     -> cost snapshot
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import type { Agent } from "../agent.js";
import type { CostTracker } from "../cost.js";
import { VERSION } from "../runtime/version.js";
import { safeErrorMessage } from "../runtime/safe-text.js";

export interface RuntimeApiOptions {
  host?: string;
  port?: number;
  token?: string; // if omitted, one is generated
}

export interface RuntimeApiHandle {
  server: Server;
  url: string;
  token: string;
  close: () => Promise<void>;
}

export interface RuntimeApiDeps {
  agent: Agent;
  costTracker: CostTracker;
  // Serialize turns so concurrent requests don't interleave on one agent.
  runTurn: (message: string) => Promise<string>;
}

const MAX_MESSAGE_CHARS = 100_000;
const MAX_IN_FLIGHT_TURNS = 4;
const MAX_SSE_CONNECTIONS = 8;

/** Per-server runtime limits + counters. */
interface ApiState {
  inFlight: number;
  sseCount: number;
  tryAcquire: () => boolean;
  release: () => void;
}

export function startRuntimeApi(deps: RuntimeApiDeps, opts: RuntimeApiOptions = {}): Promise<RuntimeApiHandle> {
  const host = opts.host || "127.0.0.1";
  const port = opts.port ?? 7878;
  const token = opts.token || randomBytes(24).toString("hex");

  const state: ApiState = {
    inFlight: 0,
    sseCount: 0,
    tryAcquire() {
      if (this.inFlight >= MAX_IN_FLIGHT_TURNS) return false;
      this.inFlight += 1;
      return true;
    },
    release() {
      this.inFlight = Math.max(0, this.inFlight - 1);
    },
  };

  const server = createServer((req, res) => {
    handle(req, res, deps, token, state).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      resolve({
        server,
        url,
        token,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: RuntimeApiDeps, token: string, state: ApiState): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  // Health is unauthenticated and minimal.
  if (path === "/health" && req.method === "GET") {
    return drainAndSendJson(req, res, 200, { ok: true, service: "weiping-whale", version: VERSION });
  }

  // Everything under /v1 requires a valid bearer token.
  if (path.startsWith("/v1")) {
    if (!checkAuth(req, token)) {
      return drainAndSendJson(req, res, 401, { error: "unauthorized" });
    }
  } else {
    return drainAndSendJson(req, res, 404, { error: "not found" });
  }

  if (path === "/v1/cost" && req.method === "GET") {
    return drainAndSendJson(req, res, 200, deps.costTracker.snapshot());
  }

  if (path === "/v1/message" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const message = typeof body.value?.message === "string" ? body.value.message : "";
    if (!message.trim()) return sendJson(res, 400, { error: "message is required" });
    if (!state.tryAcquire()) return sendJson(res, 429, { error: "too many in-flight turns" });
    try {
      const reply = await deps.runTurn(message.slice(0, MAX_MESSAGE_CHARS));
      return sendJson(res, 200, { reply });
    } finally {
      state.release();
    }
  }

  // Stream a turn over SSE. The prompt is in the POST body (NOT the URL) so it
  // never lands in access logs / shell history.
  if (path === "/v1/stream" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const message = typeof body.value?.message === "string" ? body.value.message : "";
    if (!message.trim()) return sendJson(res, 400, { error: "message is required" });
    if (state.sseCount >= MAX_SSE_CONNECTIONS) return sendJson(res, 429, { error: "too many open streams" });
    if (!state.tryAcquire()) return sendJson(res, 429, { error: "too many in-flight turns" });
    return streamTurn(res, req, deps, message.slice(0, MAX_MESSAGE_CHARS), state);
  }

  if (path === "/v1/message" || path === "/v1/stream" || path === "/v1/cost") {
    res.setHeader("Allow", path === "/v1/cost" ? "GET" : "POST");
    return drainAndSendJson(req, res, 405, { error: "method not allowed" });
  }
  return drainAndSendJson(req, res, 404, { error: "not found" });
}

/** Constant-time bearer token check (scheme is case-insensitive per RFC 7235). */
function checkAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

async function streamTurn(
  res: ServerResponse,
  req: IncomingMessage,
  deps: RuntimeApiDeps,
  message: string,
  state: ApiState,
): Promise<void> {
  state.sseCount += 1;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  const sse = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Keep-alive ping so proxies don't drop the connection.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15000);
  // If the client disconnects, stop pinging immediately (the turn itself still
  // completes — Node can't cancel it — but we free the SSE slot and stop writing).
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    clearInterval(ping);
  };
  req.on("close", onClose);
  try {
    sse("start", {});
    const reply = await deps.runTurn(message);
    if (!clientGone) {
      sse("reply", { reply });
      sse("done", { ok: true });
    }
  } catch (err: any) {
    if (!clientGone) sse("error", { error: safeErrorMessage(err) });
  } finally {
    clearInterval(ping);
    state.release();
    state.sseCount = Math.max(0, state.sseCount - 1);
    if (!res.writableEnded) res.end();
  }
}

type BodyResult =
  | { ok: true; value: any }
  | { ok: false; status: 400 | 413; error: string };

function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    let tooLarge = false;
    const done = (v: BodyResult) => {
      if (settled) return;
      settled = true;
      chunks.length = 0; // release buffers
      resolve(v);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length; // count BYTES, not JS string length
      if (size > 1_000_000) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        done({ ok: false, status: 413, error: "request body too large" });
        return;
      }
      try {
        done({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") });
      } catch {
        done({ ok: false, status: 400, error: "invalid JSON body" });
      }
    });
    // destroy() may emit 'close'/'aborted' instead of 'error' — settle on all.
    const interrupted = () => done({ ok: false, status: 400, error: "request body interrupted" });
    req.on("error", interrupted);
    req.on("close", interrupted);
    req.on("aborted", interrupted);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

/**
 * Drain bodies on routes that reject before `readBody` runs. Leaving an
 * IncomingMessage paused can strand unread bytes ahead of the next request on
 * a keep-alive connection, making a normal 401/404/405 response poison that
 * socket for subsequent API calls.
 */
function drainAndSendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  req.on("error", () => {});
  req.resume();
  sendJson(res, status, body);
}
