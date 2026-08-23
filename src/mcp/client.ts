/**
 * MCP stdio client backed by the official Model Context Protocol SDK.
 *
 * The previous hand-rolled JSON-RPC loop only understood a newline-delimited
 * subset of MCP. The SDK adds protocol negotiation, paginated tool discovery,
 * schema-aware results, request cancellation/timeouts, bounded input buffers,
 * and deterministic child-process shutdown while preserving the small adapter
 * that WEIPING_WHALE exposes to the agent runtime.
 */
import { Client, type Tool, type CallToolResult, type ContentBlock } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ToolDef } from "../llm/deepseek.js";
import type { ToolResult } from "../tools/registry.js";
import { createHash } from "crypto";
import { VERSION } from "../runtime/version.js";
import { safeErrorMessage } from "../runtime/safe-text.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_STDIO_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 100_000;
const MAX_STDERR_TAIL_CHARS = 4_000;

export interface MCPClientOptions {
  cwd?: string;
  timeoutMs?: number;
  includeTools?: string[];
  excludeTools?: string[];
}

export class MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private exposedTools = new Map<string, string>();
  private stderrTail = "";
  public readonly serverName: string;

  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly env: Record<string, string>,
    name: string,
    private readonly options: MCPClientOptions = {},
  ) {
    this.serverName = name;
  }

  async connect(timeoutMs = this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
    if (this.client) throw new Error(`MCP server '${this.serverName}' is already connected`);

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.options.cwd,
      env: { ...baseMcpEnv(), ...this.env },
      stderr: "pipe",
      maxBufferSize: MAX_STDIO_MESSAGE_BYTES,
    });
    transport.stderr?.on("data", (chunk) => {
      this.stderrTail = appendTail(this.stderrTail, chunk.toString(), MAX_STDERR_TAIL_CHARS);
    });

    // Auto negotiation speaks the current 2026 protocol when available and
    // conservatively falls back to the legacy initialize handshake. The SDK
    // performs the probe on a disposable stdio sibling so legacy servers that
    // reject pre-initialize messages remain compatible.
    const client = new Client(
      { name: "weiping-whale", version: VERSION },
      {
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: Math.min(timeoutMs, 3_000), maxRetries: 0 },
        },
        listMaxPages: 64,
      },
    );

    this.client = client;
    this.transport = transport;
    try {
      await client.connect(transport, { timeout: timeoutMs });
      const discovered = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: "refresh" });
      this.tools = filterTools(discovered.tools, this.options.includeTools, this.options.excludeTools);
    } catch (error) {
      await this.closeAfterFailure();
      const stderr = this.stderrTail.trim();
      const detail = stderr ? `; server stderr: ${safeErrorMessage(stderr.slice(-600))}` : "";
      throw new Error(`${safeErrorMessage(error)}${detail}`);
    }
  }

  getToolDefs(): ToolDef[] {
    this.exposedTools.clear();
    return this.tools.map((tool) => {
      const name = exposedToolName(this.serverName, tool.name);
      this.exposedTools.set(name, tool.name);
      return {
        type: "function" as const,
        function: {
          name,
          description: `[MCP:${this.serverName}] ${tool.description || tool.title || tool.name}`,
          parameters: normalizeInputSchema(tool.inputSchema),
        },
      };
    });
  }

  hasExposedTool(name: string): boolean {
    // Ensure the mapping exists even when a caller asks before diagnostics/UI
    // has enumerated definitions.
    if (this.exposedTools.size === 0 && this.tools.length > 0) this.getToolDefs();
    return this.exposedTools.has(name);
  }

  async callExposedTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.exposedTools.size === 0 && this.tools.length > 0) this.getToolDefs();
    const realName = this.exposedTools.get(name);
    if (!realName) return { output: `Unknown MCP tool: ${name}`, error: true };
    return this.callTool(realName, args);
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.client;
    if (!client) return { output: `MCP server '${this.serverName}' is not connected`, error: true };
    if (!this.tools.some((tool) => tool.name === toolName)) {
      return { output: `MCP tool '${toolName}' is not enabled on server '${this.serverName}'`, error: true };
    }

    const timeout = this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    try {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        { timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: true },
      );
      return {
        output: renderToolResult(result),
        error: result.isError === true,
      };
    } catch (error) {
      return { output: `MCP error: ${safeErrorMessage(error)}`, error: true };
    }
  }

  /** Ordered shutdown; the SDK closes stdin then escalates TERM/KILL. */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.exposedTools.clear();
    if (client) await client.close().catch(() => {});
  }

  private async closeAfterFailure(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.exposedTools.clear();
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch {
      // Preserve the original connection error.
    }
  }
}

function filterTools(tools: Tool[], include?: string[], exclude?: string[]): Tool[] {
  const allow = include?.length ? new Set(include) : null;
  const deny = new Set(exclude ?? []);
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if ((!allow || allow.has(tool.name)) && !deny.has(tool.name) && !seen.has(tool.name)) {
      seen.add(tool.name);
      return true;
    }
    return false;
  });
}

/**
 * OpenAI-compatible, globally collision-resistant function name.
 *
 * Sanitizing `a.b` and `a_b` produces the same text, and delimiter-only names
 * are ambiguous (`server=a_b, tool=c` vs `server=a, tool=b_c`). A digest of the
 * original tuple keeps names stable and distinct across every MCP server while
 * retaining a readable prefix.
 */
function exposedToolName(server: string, tool: string): string {
  const raw = `mcp_${server}_${tool}`;
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_") || "mcp_tool";
  const hash = createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 12);
  const stem = sanitized.slice(0, 64 - hash.length - 1);
  return `${stem}_${hash}`;
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  return schema as Record<string, unknown>;
}

function renderToolResult(result: CallToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const rendered = blocks.map(renderContentBlock).filter(Boolean);
  if (result.structuredContent !== undefined) {
    rendered.push(`structured_content: ${safeJson(result.structuredContent)}`);
  }
  const output = rendered.join("\n").trim() || (result.isError ? "MCP tool reported an error" : "(empty MCP result)");
  return output.length > MAX_TOOL_OUTPUT_CHARS
    ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n... MCP output truncated ...`
    : output;
}

function renderContentBlock(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return `[image ${block.mimeType}; ${base64Bytes(block.data)} bytes]`;
  if (block.type === "audio") return `[audio ${block.mimeType}; ${base64Bytes(block.data)} bytes]`;
  if (block.type === "resource_link") return `[resource ${block.name}: ${block.uri}]`;
  if (block.type === "resource") {
    const resource = block.resource;
    if ("text" in resource) return `[resource ${resource.uri}]\n${resource.text}`;
    return `[resource ${resource.uri}; ${resource.mimeType || "application/octet-stream"}; ${base64Bytes(resource.blob)} bytes]`;
  }
  return safeJson(block);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

function base64Bytes(value: string): number {
  return Math.max(0, Math.floor((value.replace(/=+$/, "").length * 3) / 4));
}

function appendTail(current: string, next: string, limit: number): string {
  const joined = current + next;
  return joined.length > limit ? joined.slice(-limit) : joined;
}

/**
 * Deliberately inherit only operational variables. Provider keys and memory
 * credentials never enter an MCP child unless the user explicitly adds them
 * under that server's `env` table.
 */
function baseMcpEnv(): Record<string, string> {
  const names = [
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "SHELL",
    "LANG",
    "LC_ALL",
    "NODE_PATH",
  ];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
