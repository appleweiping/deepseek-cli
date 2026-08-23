import assert from "node:assert/strict";
import { Agent as HttpAgent, request as httpRequest } from "node:http";

const { startRuntimeApi } = await import("../src/server/runtime-api.ts");

// Stub deps: a fake agent + cost tracker + a runTurn that echoes.
const deps = {
  agent: {},
  costTracker: { snapshot: () => ({ costUsd: 0.5, turns: 2, promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 }) },
  runTurn: async (m) => `echo: ${m}`,
};

const api = await startRuntimeApi(deps, { host: "127.0.0.1", port: 0 }); // port 0 = ephemeral
const base = api.url.replace(/:0$/, ""); // url uses 0; get actual port from server address
const addr = api.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const root = `http://127.0.0.1:${port}`;

try {
  // 1. /health is unauthenticated.
  const health = await fetch(`${root}/health`);
  assert.equal(health.status, 200, "health 200");
  const hbody = await health.json();
  assert.equal(hbody.ok, true, "health ok");
  assert.equal(hbody.service, "weiping-whale", "service name");
  assert.equal(health.headers.get("cache-control"), "no-store", "JSON responses are not cached");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff", "JSON responses disable MIME sniffing");

  // 2. /v1 without token -> 401.
  const noAuth = await fetch(`${root}/v1/cost`);
  assert.equal(noAuth.status, 401, "no token -> 401");

  // 3. /v1 with WRONG token -> 401.
  const badAuth = await fetch(`${root}/v1/cost`, { headers: { Authorization: "Bearer wrong-token" } });
  assert.equal(badAuth.status, 401, "wrong token -> 401");

  // 4. /v1/cost with correct token.
  const auth = { Authorization: `Bearer ${api.token}` };
  const cost = await fetch(`${root}/v1/cost`, { headers: auth });
  assert.equal(cost.status, 200, "cost 200 with token");
  assert.equal((await cost.json()).turns, 2, "cost body");

  // 5. /v1/message runs a turn.
  const msg = await fetch(`${root}/v1/message`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(msg.status, 200, "message 200");
  assert.equal((await msg.json()).reply, "echo: hello", "turn ran");

  // 6. /v1/message with empty body -> 400.
  const empty = await fetch(`${root}/v1/message`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400, "empty message -> 400");

  // 7. SSE stream is now POST (prompt in body, not URL); emits start/reply/done.
  const sse = await fetch(`${root}/v1/stream`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(sse.status, 200, "stream 200");
  assert.match(sse.headers.get("content-type") || "", /text\/event-stream/, "sse content-type");
  const text = await sse.text();
  assert.match(text, /event: start/, "sse start event");
  assert.match(text, /event: reply/, "sse reply event");
  assert.match(text, /echo: hi/, "sse reply payload");
  assert.match(text, /event: done/, "sse done event");

  // 7b. GET on stream is no longer supported (must be POST).
  const sseGet = await fetch(`${root}/v1/stream?message=hi`, { headers: auth });
  assert.equal(sseGet.status, 405, "GET /v1/stream -> 405 (POST only)");
  assert.equal(sseGet.headers.get("allow"), "POST");

  // 7c. Malformed JSON and oversized bodies have distinct, stable responses.
  const malformed = await fetch(`${root}/v1/message`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400, "malformed JSON -> 400");
  const oversized = await fetch(`${root}/v1/message`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(1_000_001) }),
  });
  assert.equal(oversized.status, 413, "oversized body -> 413 without connection reset");

  // 400/405/413 responses must leave a fully consumed connection reusable.
  // This catches paused IncomingMessage bodies that look fine to fetch() but
  // strand the next request on a single-socket keep-alive agent.
  const keepAlive = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  try {
    const malformedRaw = await rawRequest(root, keepAlive, api.token, "POST", "/v1/message", "{bad-json");
    assert.equal(malformedRaw.status, 400);
    const after400 = await rawRequest(root, keepAlive, api.token, "GET", "/v1/cost");
    assert.equal(after400.status, 200);
    assert.equal(after400.reusedSocket, true, "connection is reusable after 400");

    const wrongMethod = await rawRequest(root, keepAlive, api.token, "PUT", "/v1/message", "x".repeat(200_000));
    assert.equal(wrongMethod.status, 405);
    const after405 = await rawRequest(root, keepAlive, api.token, "GET", "/v1/cost");
    assert.equal(after405.status, 200);
    assert.equal(after405.reusedSocket, true, "connection is reusable after a body-bearing 405");

    const oversizedRaw = await rawRequest(
      root,
      keepAlive,
      api.token,
      "POST",
      "/v1/message",
      JSON.stringify({ message: "x".repeat(1_000_001) }),
    );
    assert.equal(oversizedRaw.status, 413);
    const after413 = await rawRequest(root, keepAlive, api.token, "GET", "/v1/cost");
    assert.equal(after413.status, 200);
    assert.equal(after413.reusedSocket, true, "connection is reusable after 413");
  } finally {
    keepAlive.destroy();
  }

  // 8. unknown path -> 404.
  const nf = await fetch(`${root}/nope`);
  assert.equal(nf.status, 404, "unknown path 404");

  // 9. case-insensitive bearer scheme is accepted.
  const lower = await fetch(`${root}/v1/cost`, { headers: { Authorization: `bearer ${api.token}` } });
  assert.equal(lower.status, 200, "lowercase 'bearer' scheme accepted");

  console.log("server e2e ok");
} finally {
  await api.close();
}

function rawRequest(root, agent, token, method, path, body = "") {
  const target = new URL(path, root);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      agent,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    const timer = setTimeout(() => req.destroy(new Error(`timed out: ${method} ${path}`)), 5_000);
    req.on("response", (res) => {
      res.resume();
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, reusedSocket: req.reusedSocket });
      });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
}
