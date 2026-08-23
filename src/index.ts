#!/usr/bin/env node
import { EventEmitter } from "events";
import { MODEL_PRESETS, applyModelOverride, applyRuntimeOverrides, loadConfig, validateConfig, type Config } from "./config.js";
import { Agent } from "./agent.js";
import type { Usage } from "./llm/deepseek.js";
import { MCPManager } from "./mcp/manager.js";
import { getToolDefs } from "./tools/registry.js";
import { formatPatchList, applyFilePatch, createFilePatch, rejectFilePatch } from "./safety/patches.js";
import { classifyShellCommand, getApprovalMode, listShellApprovals, rejectShellApproval, setApprovalMode, takeShellApproval } from "./safety/approval.js";
import { getWriteMode, setWriteMode } from "./safety/patches.js";
import { getSandboxMode, setSandboxMode } from "./safety/sandbox.js";
import { runShellCommand } from "./tools/bash.js";
import { backtrackMessages, createSessionId, forkSession, formatSessionInfo, listSessions, loadSession, resolveSessionRef, saveSession, sessionDir } from "./session.js";
import { writeHandoff } from "./prompts/assemble.js";
import { discoverSkills } from "./skills/index.js";
import { installSkill } from "./skills/install.js";
import { memoryDiagnostics, saveSessionMemory, type SessionMemoryResult } from "./memory.js";
import { VERSION } from "./runtime/version.js";
import { endpointConfigured, endpointHost, safeErrorMessage } from "./runtime/safe-text.js";
import { handleTodoCommand } from "./tools/todo.js";
import { handleMonitorCommand, type MonitorEvent } from "./tools/monitor.js";
import {
  banner,
  createRL,
  printAssistant,
  printError,
  printFooter,
  printHelp,
  printInfo,
  printRuntimeUpdated,
  printStatus,
  printThinking,
  printToolEnd,
  printToolStart,
  type SlashMenuItem,
  TerminalLineReader,
  type SlashMenuResult,
} from "./ui/terminal.js";

// Register built-in tools
import "./tools/bash.js";
import "./tools/file-read.js";
import "./tools/file-write.js";
import "./tools/glob.js";
import "./tools/snapshot-tool.js";
import "./tools/subagent.js";
import { SnapshotManager } from "./snapshot/manager.js";
import { setActiveSnapshotManager } from "./tools/snapshot-tool.js";
import { SubAgentManager, setActiveSubAgentManager } from "./tools/subagent.js";
import { LspManager } from "./lsp/manager.js";
import { setActiveLspManager } from "./lsp/active.js";
import { diagnosticsSuffix } from "./lsp/active.js";
import { startRuntimeApi, type RuntimeApiHandle } from "./server/runtime-api.js";
import { CostTracker } from "./cost.js";
import { isWorkspaceTrusted, trustWorkspace } from "./safety/workspace-trust.js";

// ── Execution mode ────────────────────────────────────────────────────────────
type ExecMode = "auto" | "plan" | "ask";
let _execMode: ExecMode = "auto";
export function getExecMode(): ExecMode { return _execMode; }
export function setExecMode(mode: ExecMode) { _execMode = mode; }

// ── Image attachment queue ────────────────────────────────────────────────────
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { extname, join } from "path";
import { tmpdir } from "os";
const _pendingImages: { path: string; base64: string; mimeType: string }[] = [];
export function attachImage(filePath: string): string {
  if (!existsSync(filePath)) return `File not found: ${filePath}`;
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const mimeType = mimeMap[ext];
  if (!mimeType) return `Unsupported image type: ${ext}. Use jpg, png, gif, or webp.`;
  const base64 = readFileSync(filePath).toString("base64");
  _pendingImages.push({ path: filePath, base64, mimeType });
  return `  Attached: ${filePath} (${mimeType}, ${Math.round(base64.length * 0.75 / 1024)}KB)`;
}
export function getPendingImages() { return [..._pendingImages]; }
export function clearPendingImages() { _pendingImages.length = 0; }



async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.includes("--self-test-editor")) {
    runEditorSelfTest();
    process.exit(0);
  }

  if (args.includes("--self-test-runtime")) {
    await runRuntimeSelfTest();
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let cwdOverride: string | undefined;
  try {
    cwdOverride = readFlag(args, "--cwd") ?? readFlag(args, "--workspace");
    if (cwdOverride) changeDirectory(cwdOverride);
  } catch (err: any) {
    printCliError(safeErrorMessage(err), json);
    process.exit(1);
  }

  if (args.includes("--models")) {
    printModels(json);
    process.exit(0);
  }

  const resumeFlag = readFlag(args, "--resume");
  const wantLast = args.includes("--last");
  // Resolve resume reference: --last, --resume <id|prefix|last>.
  let resumeSessionId: string | undefined;
  let resumeError: string | undefined;
  if (wantLast || resumeFlag !== undefined) {
    const ref = wantLast ? "last" : (resumeFlag || "last");
    const resolved = resolveSessionRef(ref);
    if (resolved.session) resumeSessionId = resolved.session.id;
    else resumeError = resolved.error;
  }
  let sessionId = readFlag(args, "--session") ?? resumeSessionId ?? createSessionId();
  const task = readFlag(args, "-t") ?? readFlag(args, "--task") ?? readPositionalTask(args);

  let workspaceTrusted = isWorkspaceTrusted(process.cwd());
  if (args.includes("--trust-workspace")) {
    const trusted = trustWorkspace(process.cwd());
    workspaceTrusted = true;
    if (!json) printInfo(`Trusted workspace configuration: ${trusted}`);
  }
  let config: Config;
  try {
    config = loadConfig({ allowWorkspaceConfig: workspaceTrusted });
  } catch (err: any) {
    printCliError(safeErrorMessage(err), json);
    process.exit(1);
  }
  if (config.workspace_config_ignored && !json) {
    printInfo(`Ignored untrusted workspace config: ${config.workspace_config_ignored}`);
    printInfo("Review it, then rerun once with --trust-workspace to persist trust for this exact directory.");
  }
  if (!cwdOverride && config.agent.workspace && config.agent.workspace !== ".") {
    try {
      changeDirectory(config.agent.workspace);
    } catch (err: any) {
      printCliError(safeErrorMessage(err), json);
      process.exit(1);
    }
  }
  // "auto" is not a provider model — whether it came from config or CLI, it
  // enables the Fin router and starts from the fast default model.
  let wantAutoRoute = config.llm.model.trim().toLowerCase() === "auto";
  if (wantAutoRoute) applyModelOverride(config, "flash");
  try {
    const runtimeArgs = parseRuntimeArgs(args);
    if (runtimeArgs.model && runtimeArgs.model.trim().toLowerCase() === "auto") {
      wantAutoRoute = true;
      runtimeArgs.model = undefined;
    }
    applyRuntimeOverrides(config, runtimeArgs);
  } catch (err: any) {
    printCliError(safeErrorMessage(err), json);
    process.exit(1);
  }

  if (args.includes("--doctor")) {
    const doctorMcpManager = new MCPManager();
    if (Object.keys(config.mcp_servers).length > 0) {
      await doctorMcpManager.connectAll(config.mcp_servers);
    }
    printDoctor(config, json, doctorMcpManager, wantAutoRoute);
    await doctorMcpManager.disconnectAll();
    process.exit(validateConfig(config).some((check) => check.level === "error") ? 1 : 0);
  }

  if (!config.llm.api_key) {
    printError("Error: DEEPSEEK_API_KEY not set. Set it in env or config.toml");
    process.exit(1);
  }

  const mcpManager = new MCPManager();
  if (Object.keys(config.mcp_servers).length > 0) {
    printInfo("Connecting MCP servers...");
    await mcpManager.connectAll(config.mcp_servers);
  }

  const agent = new Agent(config, mcpManager);
  if (wantAutoRoute) agent.setAutoRoute(true);
  if ((wantLast || resumeFlag !== undefined) && !resumeSessionId) {
    printCliError(resumeError ?? "could not resolve session to resume", json);
    process.exit(1);
  }
  if (resumeSessionId) {
    const saved = loadSession(resumeSessionId);
    if (!saved) {
      printCliError(`No saved session: ${resumeSessionId}`, json);
      process.exit(1);
    }
    agent.restoreMessages(saved.messages);
  }

  // Side-git snapshots: a separate repo under the state root that never touches
  // the user's own .git. Disabled gracefully if git is missing or the workspace
  // is too large. Controlled by config.snapshots.enabled (default true).
  const snapshotManager = new SnapshotManager(process.cwd(), {
    enabled: config.snapshots?.enabled ?? true,
    retentionDays: config.snapshots?.retention_days,
  });
  setActiveSnapshotManager(snapshotManager);
  if (!snapshotManager.isEnabled() && snapshotManager.reason() && !json) {
    printInfo(`Snapshots disabled: ${snapshotManager.reason()}`);
  }

  // Bounded sub-agent pool: children are real Agent instances sharing config+MCP.
  const subAgentManager = new SubAgentManager({
    config,
    mcpManager,
    makeAgent: (cfg, mcp) => new Agent(cfg, mcp, { isSubagent: true }),
    maxAgents: config.subagents?.max_agents ?? 4,
    maxDepth: config.subagents?.max_depth ?? 2,
    depth: 0,
  });
  setActiveSubAgentManager(subAgentManager);

  // LSP post-edit diagnostics (TypeScript + Python). Best-effort; missing servers
  // are silently skipped. Off in JSON/one-shot to avoid spawning servers needlessly.
  const lspManager = new LspManager(process.cwd(), {
    enabled: config.lsp?.enabled ?? true,
    includeWarnings: config.lsp?.include_warnings,
    pollAfterEditMs: config.lsp?.poll_after_edit_ms,
    maxPerFile: config.lsp?.max_per_file,
  });
  setActiveLspManager(lspManager);
  const stats = () => ({
    toolCount: getToolDefs().length + mcpManager.getToolDefs().length,
    mcpServerCount: mcpManager.getServerCount(),
    approvalMode: getApprovalMode(),
    sandboxMode: getSandboxMode(),
    writeMode: getWriteMode(),
  });
  const costTracker = new CostTracker(config.pricing);
  const events = {
    onThinking: json ? undefined : printThinking,
    onToolStart: json ? undefined : printToolStart,
    onToolEnd: json ? undefined : printToolEnd,
    onUsage: (model: string, usage: Usage) => costTracker.record(model, usage),
    onRoute: json ? undefined : (decision: string) => printInfo(`route: ${decision}`),
  };
  const persistSnapshot = async (
    status: "closed" | "interrupted" | "error" | "manual" | "completed",
    note?: string,
    error?: string
  ): Promise<SessionMemoryResult> => {
    saveSession(sessionId, process.cwd(), agent.getRuntime(), agent.getMessages());
    return saveSessionMemory({ sessionId, cwd: process.cwd(), runtime: agent.getRuntime(), messages: agent.getMessages(), status, note, error });
  };

  // Single serialization point for ALL agent turns (REPL input AND the HTTP API),
  // so two turns never run concurrently on the shared message history.
  let turnChain: Promise<unknown> = Promise.resolve();
  const runAgentTurn = (message: string, note: string, images: ReturnType<typeof getPendingImages> = []): Promise<string> => {
    const result = turnChain.then(async () => {
      snapshotManager.beforeTurn();
      const reply = await agent.run(message, events, images);
      snapshotManager.afterTurn();
      await persistSnapshot("completed", note);
      return reply;
    });
    turnChain = result.then(() => undefined, () => undefined);
    return result;
  };

  if (task) {
    try {
      snapshotManager.beforeTurn();
      const taskImages = getPendingImages();
      clearPendingImages();
      const reply = await agent.run(task, events, taskImages);
      snapshotManager.afterTurn();
      await persistSnapshot("completed", "single task completed");
      if (json) {
        console.log(JSON.stringify({ ok: true, session: sessionId, ...agent.getRuntime(), output: reply }, null, 2));
      } else {
        printAssistant(reply);
      }
    } catch (err: any) {
      const message = safeErrorMessage(err);
      await persistSnapshot("error", "single task failed; resume this session and retry after the network recovers", message);
      if (json) console.error(JSON.stringify({ ok: false, session: sessionId, error: { message } }, null, 2));
      else printCliError(message, false);
      lspManager.dispose();
      await mcpManager.disconnectAll();
      process.exit(1);
    }
    lspManager.dispose();
    await mcpManager.disconnectAll();
    process.exit(0);
  }

  banner(agent.getRuntime(), process.cwd(), stats());
  printInfo(formatSessionInfo(sessionId));

  // Optional local HTTP/SSE control surface (off unless --serve). Localhost-only
  // by default; requires a bearer token (auto-generated and printed once).
  let apiHandle: RuntimeApiHandle | undefined;
  if (args.includes("--serve")) {
    // Route API turns through the SAME turnChain as the REPL so they serialize.
    const runTurn = (message: string): Promise<string> => runAgentTurn(message, "api turn completed");
    try {
      const host = readFlag(args, "--host");
      const portStr = readFlag(args, "--port");
      apiHandle = await startRuntimeApi(
        { agent, costTracker, runTurn },
        { host, port: portStr ? Number(portStr) : undefined, token: process.env.WEIPING_WHALE_API_TOKEN },
      );
      printInfo(`HTTP API listening on ${apiHandle.url}`);
      printInfo(`API token: ${apiHandle.token}  (send as: Authorization: Bearer <token>)`);
      if (host && host !== "127.0.0.1" && host !== "localhost") {
        printError(`WARNING: API bound to ${host} (non-localhost). Anyone who can reach this host + token can drive the agent.`);
      }
    } catch (err: any) {
      printError(`Failed to start HTTP API: ${safeErrorMessage(err)}`);
    }
  }

  const commandContext: CommandContext = {
    agent,
    sessionId,
    setSessionId: (id: string) => {
      sessionId = id;
      commandContext.sessionId = id;
    },
    stats,
    mcpManager,
    config,
    snapshotManager,
    costTracker,
    persistSnapshot,
  };
  const rl = createRL((context) => buildSlashMenu(context.line, context.cursor));
  rl.prompt();
  let lineQueue = Promise.resolve();

  const processLine = async (line: string) => {
    const input = normalizeCommandInput(line.trim());
    if (!input) { rl.prompt(); return; }

    const handled = await handleCommand(input, commandContext);
    if (handled) {
      rl.prompt();
      return;
    }

    try {
      const turnImages = getPendingImages();
      clearPendingImages();
      const reply = await runAgentTurn(line, "assistant reply completed", turnImages);
      printAssistant(reply);
      printFooter(costTracker.footer(), costTracker.cacheColor());
    } catch (err: any) {
      const message = safeErrorMessage(err);
      printError(`Error: ${message}`);
      const result = await persistSnapshot("error", "assistant request failed; /retry can resend the last user message", message);
      printMemoryResult(result);
    }
    rl.prompt();
  };

  rl.on("line", (line) => {
    lineQueue = lineQueue.then(() => processLine(line)).catch((err: any) => printError(`Error: ${safeErrorMessage(err)}`));
  });

  rl.on("close", () => void lineQueue.finally(() => shutdown("closed")));

  process.on("SIGINT", () => {
    void shutdown("interrupted");
  });

  async function shutdown(status: "closed" | "interrupted") {
    try {
      await persistSnapshot(status, status === "interrupted" ? "SIGINT received" : "reader closed");
    } catch {}
    if (apiHandle) await apiHandle.close().catch(() => {});
    lspManager.dispose();
    await mcpManager.disconnectAll();
    process.exit(0);
  }
}

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(_enabled: boolean) {}
  resume() {}
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  buffer = "";
  write(chunk: string | Uint8Array): boolean {
    this.buffer += chunk.toString();
    return true;
  }
}

function runEditorSelfTest() {
  const promptInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const promptOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const promptReader = new TerminalLineReader(promptInput, promptOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  promptReader.prompt();
  for (const char of Array.from("hello /thin")) promptReader.debugKey(char, { name: char });
  const menu = promptReader.debugState().slashLabels;
  if (!menu.some((label) => label.startsWith("/thinking"))) throw new Error("slash palette did not expose /thinking");
  promptReader.debugKey(undefined, { name: "tab" });
  if (promptReader.debugState().line !== "hello /thinking ") throw new Error(`slash accept failed: ${promptReader.debugState().line}`);
  promptReader.close();

  const backslashInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const backslashOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const backslashReader = new TerminalLineReader(backslashInput, backslashOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  backslashReader.prompt();
  for (const char of Array.from("please \\per")) backslashReader.debugKey(char, { name: char });
  const backslashMenu = backslashReader.debugState().slashLabels;
  if (!backslashMenu.some((label) => label.includes("/permission-model"))) throw new Error("backslash palette did not expose /permission-model");
  backslashReader.close();

  const nestedInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const nestedOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const nestedReader = new TerminalLineReader(nestedInput, nestedOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  nestedReader.prompt();
  for (const char of Array.from("/permission-model ")) nestedReader.debugKey(char, { name: char });
  const nestedMenu = nestedReader.debugState().slashLabels;
  if (!nestedMenu.some((label) => label === "trusted")) throw new Error("permission-model arguments were not exposed");
  nestedReader.close();

  const mcpInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const mcpOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const mcpReader = new TerminalLineReader(mcpInput, mcpOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  mcpReader.prompt();
  for (const char of Array.from("/mcp ")) mcpReader.debugKey(char, { name: char });
  if (!mcpReader.debugState().slashLabels.includes("reconnect")) throw new Error("mcp reconnect option was not exposed");
  mcpReader.close();

  const memoryInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const memoryOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const memoryReader = new TerminalLineReader(memoryInput, memoryOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  memoryReader.prompt();
  for (const char of Array.from("/memory ")) memoryReader.debugKey(char, { name: char });
  if (!memoryReader.debugState().slashLabels.includes("save")) throw new Error("memory save option was not exposed");
  memoryReader.close();

  const selectionInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const selectionOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const selectionReader = new TerminalLineReader(selectionInput, selectionOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  selectionReader.prompt();
  for (const char of Array.from("abcdef")) selectionReader.debugKey(char, { name: char });
  selectionReader.debugKey(undefined, { name: "left", shift: true, sequence: "\x1b[D" });
  selectionReader.debugKey(undefined, { name: "left", shift: true, sequence: "\x1b[D" });
  selectionReader.debugKey(undefined, { name: "backspace" });
  if (selectionReader.debugState().line !== "abcd") throw new Error(`selection delete failed: ${selectionReader.debugState().line}`);
  selectionReader.close();

  const wrapInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const wrapOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  wrapOutput.columns = 16;
  const wrapReader = new TerminalLineReader(wrapInput, wrapOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  wrapReader.prompt();
  for (const char of Array.from("abcdefghijklmnopqrst")) wrapReader.debugKey(char, { name: char });
  const beforeUp = wrapReader.debugState().cursor;
  wrapReader.debugKey(undefined, { name: "up", sequence: "\x1b[A" });
  const afterUp = wrapReader.debugState().cursor;
  if (afterUp >= beforeUp) throw new Error("up arrow did not move the cursor to the previous visual row");
  wrapReader.debugKey(undefined, { name: "down", sequence: "\x1b[B" });
  if (wrapReader.debugState().cursor !== beforeUp) throw new Error("down arrow did not restore the cursor to the next visual row");
  wrapReader.close();

  const mouseInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const mouseOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const mouseReader = new TerminalLineReader(mouseInput, mouseOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  mouseReader.prompt();
  for (const char of Array.from("abc")) mouseReader.debugKey(char, { name: char });
  mouseReader.debugData("\x1b[<0;1;1M");
  if (mouseReader.debugState().line !== "abc") throw new Error(`mouse sequence leaked into input: ${mouseReader.debugState().line}`);
  mouseReader.close();

  const splitMouseInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const splitMouseOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const splitMouseReader = new TerminalLineReader(splitMouseInput, splitMouseOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  splitMouseReader.prompt();
  for (const char of Array.from("abc")) splitMouseReader.debugKey(char, { name: char });
  splitMouseReader.debugData("\x1b[<0;1;1M");
  if (splitMouseReader.debugState().line !== "abc") throw new Error(`split mouse sequence leaked into input: ${splitMouseReader.debugState().line}`);
  splitMouseReader.close();

  const clickInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const clickOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  clickOutput.rows = 24;
  const clickReader = new TerminalLineReader(clickInput, clickOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  let clickedLine = "";
  clickReader.on("line", (line) => { clickedLine = line; });
  clickReader.prompt();
  clickReader.debugKey("/");
  const clickState = clickReader.debugState();
  const clickY = clickState.inputStartRow + (clickState.slashMenuItemStartRow ?? 0);
  clickReader.debugData(`\x1b[<0;2;${clickY}M`);
  if (clickedLine !== "/help") throw new Error(`slash menu click did not submit first item: ${clickedLine || clickReader.debugState().line}`);
  clickReader.close();

  // Test /permissions nested argument menu
  const permInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const permOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  permOutput.rows = 24;
  const permReader = new TerminalLineReader(permInput, permOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  let permLine = "";
  permReader.on("line", (line) => { permLine = line; });
  permReader.prompt();
  for (const char of Array.from("/permissions ")) permReader.debugKey(char, { name: char === "/" ? undefined : char });
  const permState = permReader.debugState();
  if (permState.slashLabels.length === 0) throw new Error("permissions argument menu not shown");
  if (!permState.slashLabels.includes("safe")) throw new Error(`permissions menu missing 'safe': ${permState.slashLabels}`);
  const permClickY = permState.inputStartRow + (permState.slashMenuItemStartRow ?? 0) + 1;
  permReader.debugData(`\x1b[<0;2;${permClickY}M`);
  if (!permLine.startsWith("/permissions ")) throw new Error(`permissions click did not submit: ${permLine || permReader.debugState().line}`);
  permReader.close();

  const scrollInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const scrollOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const scrollReader = new TerminalLineReader(scrollInput, scrollOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  scrollReader.prompt();
  for (const char of Array.from("abc")) scrollReader.debugKey(char, { name: char });
  scrollReader.debugData("\x1b[<64;10;5M\x1b[<65;10;5M");
  if (scrollReader.debugState().line !== "abc") throw new Error(`scroll wheel leaked into input: ${scrollReader.debugState().line}`);
  if (scrollReader.debugState().cursor !== 3) throw new Error(`scroll wheel moved cursor: ${scrollReader.debugState().cursor}`);
  scrollReader.close();

  // Test multiple rapid scroll events in one chunk (real Windows Terminal behavior)
  const rapidScrollInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const rapidScrollOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const rapidScrollReader = new TerminalLineReader(rapidScrollInput, rapidScrollOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  rapidScrollReader.prompt();
  for (const char of Array.from("hello")) rapidScrollReader.debugKey(char, { name: char });
  rapidScrollReader.debugData("\x1b[<64;32;23M\x1b[<64;32;23M\x1b[<65;32;23M\x1b[<65;32;23M\x1b[<64;32;23M");
  if (rapidScrollReader.debugState().line !== "hello") throw new Error(`rapid scroll leaked: ${rapidScrollReader.debugState().line}`);
  rapidScrollReader.close();

  // Test menu scrolling: type "/" to show all commands, then arrow down past visible window
  const menuScrollInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const menuScrollOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  menuScrollOutput.rows = 24;
  const menuScrollReader = new TerminalLineReader(menuScrollInput, menuScrollOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  menuScrollReader.prompt();
  menuScrollReader.debugKey("/");
  const menuState1 = menuScrollReader.debugState();
  const totalCommands = COMMAND_DEFS.length;
  if (menuState1.slashLabels.length > 9) throw new Error(`menu shows more than 9 items: ${menuState1.slashLabels.length}`);
  if (totalCommands <= 9) throw new Error(`expected more than 9 commands for scroll test, got ${totalCommands}`);
  // Arrow down 10 times to scroll past the visible window
  for (let i = 0; i < 10; i++) menuScrollReader.debugKey(undefined, { name: "down" });
  const menuState2 = menuScrollReader.debugState();
  // After scrolling, the visible labels should have changed (scrolled)
  if (menuState2.slashLabels[0] === menuState1.slashLabels[0] && menuState2.slashLabels.length === menuState1.slashLabels.length) {
    throw new Error("menu did not scroll after pressing down 10 times");
  }
  menuScrollReader.close();

  if (normalizeCommandInput("\\permission-model trusted") !== "/permission-model trusted") {
    throw new Error("backslash normalization failed");
  }

  console.log(JSON.stringify({ ok: true, slash: true, backslash: true, nested: true, mcp_nested: true, memory_nested: true, selection_delete: true, vertical_cursor: true, mouse_swallow: true, split_mouse_swallow: true, menu_mouse_click: true, scroll_wheel: true, rapid_scroll: true, menu_scroll: true }));
}

async function runRuntimeSelfTest() {
  const original = {
    cwd: process.cwd(),
    approval: process.env.DEEPSEEK_APPROVAL_MODE,
    sandbox: process.env.DEEPSEEK_SANDBOX_MODE,
    write: process.env.DEEPSEEK_WRITE_MODE,
    memoryUrl: process.env.AGENTMEMORY_URL,
    outbox: process.env.DEEPSEEK_MEMORY_OUTBOX_DIR,
  };
  const workspace = mkdtempSync(join(tmpdir(), "deepseek-cli-runtime-self-test-"));
  try {
    process.chdir(workspace);
    process.env.DEEPSEEK_APPROVAL_MODE = "on-request";
    process.env.DEEPSEEK_SANDBOX_MODE = "workspace-write";
    process.env.DEEPSEEK_WRITE_MODE = "preview";

    const sample = join(workspace, "sample.txt");
    writeFileSync(sample, "before", "utf-8");
    const patch = createFilePatch("edit", sample, "after");
    if (!formatPatchList().includes(patch.id)) throw new Error("patch preview was not listed");
    const applied = applyFilePatch(patch.id);
    if (!applied.ok) throw new Error(`patch did not apply: ${applied.message}`);
    if (readFileSync(sample, "utf-8") !== "after") throw new Error("patch apply did not update file content");

    const rejected = createFilePatch("write", join(workspace, "reject.txt"), "nope");
    if (!rejectFilePatch(rejected.id)) throw new Error("patch reject failed");
    if (existsSync(join(workspace, "reject.txt"))) throw new Error("rejected write patch created a file");

    const classifierCases: Array<[string, "approval_required" | "blocked"]> = [
      ["ri -r .\\tmp", "approval_required"],
      ["ni pwn.txt -Value x", "approval_required"],
      ["sc pwn.txt x", "approval_required"],
      ["mi a b", "approval_required"],
      ["Remove-Item -Recurse C:\\", "blocked"],
      ["Remove-Item -Recurse C:\\*", "blocked"],
      ["Remove-Item -Recurse .", "blocked"],
      ["rm -rf .", "blocked"],
      ["rm -rf ./*", "blocked"],
      ["rm -rf *", "blocked"],
      ["rm -rf /*", "blocked"],
      ["Remove-Item -Recurse .\\*", "blocked"],
      ["git clean -fdx", "blocked"],
    ];
    for (const [command, expected] of classifierCases) {
      const actual = classifyShellCommand(command).level;
      if (actual !== expected) throw new Error(`shell classifier mismatch for ${command}: ${actual}`);
    }

    const blockedMonitor = handleMonitorCommand("start rm -rf /");
    if (!blockedMonitor.includes("Blocked dangerous monitor command")) throw new Error(`monitor did not block dangerous command: ${blockedMonitor}`);
    const approvalMonitor = handleMonitorCommand("start rm sample.txt");
    if (!approvalMonitor.includes("Monitor approval required")) throw new Error(`monitor did not require approval: ${approvalMonitor}`);
    const monitorApproval = listShellApprovals().find((item) => item.reason.startsWith("monitor command:"));
    if (!monitorApproval) throw new Error("monitor approval was not queued in on-request mode");
    process.env.DEEPSEEK_APPROVAL_MODE = "never";
    const deniedApproval = await runApprovedShellCommand(monitorApproval.id);
    if (!deniedApproval.includes("approval mode is never")) throw new Error(`approve path did not honor never mode: ${deniedApproval}`);
    if (listShellApprovals().some((item) => item.id === monitorApproval.id)) throw new Error("never-mode approval was not consumed");
    const neverMonitor = handleMonitorCommand("start rm sample.txt");
    if (!neverMonitor.includes("risky monitor commands are disabled")) throw new Error(`monitor queued in never mode: ${neverMonitor}`);
    if (listShellApprovals().some((item) => item.reason.startsWith("monitor command:"))) throw new Error("monitor approval was queued in never mode");
    process.env.DEEPSEEK_APPROVAL_MODE = "on-request";

    const outbox = join(workspace, "outbox");
    process.env.AGENTMEMORY_URL = "http://127.0.0.1:9";
    process.env.DEEPSEEK_MEMORY_OUTBOX_DIR = outbox;
    const fakeSecret = ["sk", Date.now().toString(36), "test", "secret", "should", "redact"].join("-");
    const memory = await saveSessionMemory({
      sessionId: "runtime-self-test",
      cwd: workspace,
      runtime: { model: "deepseek-v4-flash", thinking: "enabled", reasoning_effort: "high" },
      messages: [{ role: "user", content: `hello ${fakeSecret}` }],
      status: "manual",
      note: "runtime self-test",
    });
    if (!memory.fallbackPath || !memory.fallbackPath.startsWith(outbox)) throw new Error("memory outbox fallback path was not used");
    const memoryText = readFileSync(memory.fallbackPath, "utf-8");
    if (memoryText.includes(fakeSecret)) throw new Error("memory outbox did not redact secret-looking text");

    console.log(JSON.stringify({ ok: true, runtime: true, patch: true, monitor_safety: true, memory_outbox: true }));
  } finally {
    process.chdir(original.cwd);
    restoreEnv("DEEPSEEK_APPROVAL_MODE", original.approval);
    restoreEnv("DEEPSEEK_SANDBOX_MODE", original.sandbox);
    restoreEnv("DEEPSEEK_WRITE_MODE", original.write);
    restoreEnv("AGENTMEMORY_URL", original.memoryUrl);
    restoreEnv("DEEPSEEK_MEMORY_OUTBOX_DIR", original.outbox);
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function runApprovedShellCommand(id: string): Promise<string> {
  const approval = takeShellApproval(id);
  if (!approval) return `No pending shell approval: ${id}`;

  const risk = classifyShellCommand(approval.command);
  if (risk.level === "blocked") {
    return `Approved shell command not run: ${risk.reason}`;
  }
  if (risk.level === "approval_required" && getApprovalMode() === "never") {
    return `Approved shell command not run: approval mode is never; risky shell commands are disabled.`;
  }

  const result = await runShellCommand(approval.command, approval.timeout);
  return result.output;
}

interface CommandContext {
  agent: Agent;
  sessionId: string;
  setSessionId: (id: string) => void;
  stats: () => ReturnType<typeof currentStats>;
  mcpManager: MCPManager;
  config: Config;
  snapshotManager: SnapshotManager;
  costTracker: CostTracker;
  persistSnapshot: (
    status: "closed" | "interrupted" | "error" | "manual" | "completed",
    note?: string,
    error?: string
  ) => Promise<SessionMemoryResult>;
}

function currentStats() {
  return {
    toolCount: 0,
    mcpServerCount: 0,
    approvalMode: getApprovalMode(),
    sandboxMode: getSandboxMode(),
    writeMode: getWriteMode(),
  };
}

const COMMAND_DEFS = [
  { name: "help", args: "", description: "show commands and editor shortcuts", submit: true },
  { name: "status", args: "", description: "show model, cwd, tools, MCP, and safety state", submit: true },
  { name: "doctor", args: "", description: "run local config/auth/MCP diagnostics", submit: true },
  { name: "tools", args: "", description: "list built-in and MCP tools", submit: true },
  { name: "mcp", args: "<status|reconnect>", description: "inspect or reconnect MCP servers" },
  { name: "sessions", args: "[n]", description: "list recent saved sessions" },
  { name: "fork", args: "", description: "fork the current session into a new branchable session", submit: true },
  { name: "backtrack", args: "[n]", description: "rewind the conversation n user-turns back (default 1)" },
  { name: "memory", args: "<save|status>", description: "save current session summary to agentmemory" },
  { name: "retry", args: "", description: "retry the last user request after a network failure", submit: true },
  { name: "permissions", args: "<setting>", description: "permission model, approval, sandbox, and write-mode controls" },
  { name: "permission-model", args: "<mode>", description: "choose safe, read-only, trusted, or locked safety bundles" },
  { name: "approval", args: "<mode>", description: "set shell approvals: on-request, auto, never" },
  { name: "sandbox", args: "<mode>", description: "set file-write sandbox: workspace-write, read-only, unrestricted" },
  { name: "write-mode", args: "<mode>", description: "set file writes: preview or direct" },
  { name: "models", args: "", description: "list model presets and aliases", submit: true },
  { name: "model", args: "<name>", description: "switch model preset, full model name, or 'auto' for per-turn routing" },
  { name: "thinking", args: "<mode>", description: "switch thinking: auto, on, off, high, max" },
  { name: "session", args: "", description: "save and show current session path", submit: true },
  { name: "compact", args: "[fast]", description: "summarize older context (model summary; 'fast' = offline heuristic)" },
  { name: "snapshots", args: "", description: "list workspace snapshots (side-git checkpoints)", submit: true },
  { name: "cost", args: "", description: "show session token usage, cost, and cache-hit ratio", submit: true },
  { name: "handoff", args: "[text]", description: "write a session relay to .weiping-whale/handoff.md (model-generated if no text)" },
  { name: "skills", args: "<list|install>", description: "list discovered skills or install one from GitHub (owner/repo)" },
  { name: "restore", args: "<id>", description: "restore workspace files to a snapshot id" },
  { name: "undo", args: "", description: "undo the most recent workspace change via snapshots", submit: true },
  { name: "approvals", args: "", description: "list pending shell approvals", submit: true },
  { name: "approve", args: "<id>", description: "run a pending shell command" },
  { name: "deny", args: "<id>", description: "reject a pending shell command" },
  { name: "patches", args: "", description: "list pending file patch previews", submit: true },
  { name: "apply", args: "<id>", description: "apply a pending file patch" },
  { name: "reject", args: "<id>", description: "reject a pending file patch" },
  { name: "clear", args: "", description: "clear the terminal", submit: true },
  { name: "exit", args: "", description: "quit WEIPING_WHALE", submit: true },
  { name: "quit", args: "", description: "quit WEIPING_WHALE", submit: true },
  { name: "todo", args: "<add|done|start|remove|clear|list>", description: "manage persistent task list" },
  { name: "monitor", args: "<start|stop|logs|list>", description: "run and watch background processes" },
  { name: "mode", args: "<auto|plan|ask>", description: "set execution mode: auto (run freely), plan (think first), ask (confirm each edit)" },
  { name: "image", args: "<path>", description: "attach an image to the next message" },
  { name: "images", args: "", description: "list attached images", submit: true },
] as const;

const PERMISSION_MODE_OPTIONS = [
  { value: "safe", description: "preview writes, workspace sandbox, ask before risky shell" },
  { value: "read-only", description: "block file writes, keep shell approvals on-request" },
  { value: "trusted", description: "direct writes, unrestricted sandbox, auto-run risky shell" },
  { value: "locked", description: "preview writes, read-only sandbox, never run risky shell" },
] as const;

const APPROVAL_OPTIONS = [
  { value: "on-request", description: "queue risky shell commands for /approve" },
  { value: "auto", description: "auto-run risky shell commands except blocked patterns" },
  { value: "never", description: "never run risky shell commands" },
] as const;

const SANDBOX_OPTIONS = [
  { value: "workspace-write", description: "allow writes only inside the current workspace" },
  { value: "read-only", description: "block all file writes" },
  { value: "unrestricted", description: "allow writes anywhere this process can write" },
] as const;

const WRITE_MODE_OPTIONS = [
  { value: "preview", description: "create patch previews for /apply" },
  { value: "direct", description: "write files immediately through tools" },
] as const;

const THINKING_OPTIONS = [
  { value: "auto", description: "let DeepSeek default decide" },
  { value: "on", description: "enable thinking with high effort" },
  { value: "off", description: "disable thinking" },
  { value: "high", description: "enable thinking with high effort" },
  { value: "max", description: "enable thinking with max effort" },
] as const;

function normalizeCommandInput(input: string): string {
  if (input.startsWith("\\")) return `/${input.slice(1)}`;
  if (input.startsWith("/")) return input;
  const embedded = input.match(/(?:^|\s)([\\/])([A-Za-z][\w-]*)(?:\s+([^\s]+))?/);
  if (!embedded) return input;
  const command = embedded[2].toLowerCase();
  if (!isKnownCommand(command)) return input;
  const arg = embedded[3] ?? "";
  return `/${command}${arg ? ` ${arg}` : ""}`;
}

function isKnownCommand(command: string): boolean {
  return COMMAND_DEFS.some((item) => item.name === command) || [
    "quit",
    "permissions-model",
    "approval-mode",
    "sandbox-mode",
    "writemode",
  ].includes(command);
}

async function handleCommand(input: string, context: CommandContext): Promise<boolean> {
  const [commandName, ...args] = input.slice(1).split(/\s+/);
  if (!input.startsWith("/") || !commandName) return false;
  const command = commandName.toLowerCase();
  const arg = args.join(" ").trim();

  try {
    switch (command) {
      case "exit":
      case "quit":
        await context.mcpManager.disconnectAll();
        process.exit(0);
        return true;
      case "help":
        printHelp();
        return true;
      case "models":
        printModels(false);
        return true;
      case "doctor":
        printDoctor(context.config, false, context.mcpManager, context.agent.isAutoRoute());
        return true;
      case "tools":
        printTools(context.mcpManager);
        return true;
      case "mcp":
        await handleMcpCommand(arg, context);
        return true;
      case "sessions":
        printSessions(arg ? Number(arg) : 10);
        return true;
      case "memory":
        await handleMemoryCommand(arg, context);
        return true;
      case "retry": {
        const reply = await context.agent.retryLast({ onThinking: printThinking, onToolStart: printToolStart, onToolEnd: printToolEnd });
        await context.persistSnapshot("completed", "retry completed");
        printAssistant(reply);
        return true;
      }
      case "status":
        printStatus(context.agent.getRuntime(), process.cwd(), context.stats());
        return true;
      case "permissions":
        if (!arg || arg === "status") printPermissions();
        else console.log(applyPermissionModel(arg));
        return true;
      case "permission-model":
      case "permissions-model":
        if (!arg) printError("Usage: /permission-model <safe|read-only|trusted|locked>");
        else console.log(applyPermissionModel(arg));
        return true;
      case "approval":
      case "approval-mode":
        if (!arg) printError("Usage: /approval <on-request|auto|never>");
        else console.log(`approval_mode: ${setApprovalMode(arg)}`);
        return true;
      case "sandbox":
      case "sandbox-mode":
        if (!arg) printError("Usage: /sandbox <workspace-write|read-only|unrestricted>");
        else console.log(`sandbox_mode: ${setSandboxMode(arg)}`);
        return true;
      case "write-mode":
      case "writemode":
        if (!arg) printError("Usage: /write-mode <preview|direct>");
        else console.log(`write_mode: ${setWriteMode(arg)}`);
        return true;
      case "session":
        saveSession(context.sessionId, process.cwd(), context.agent.getRuntime(), context.agent.getMessages());
        console.log(formatSessionInfo(context.sessionId));
        return true;
      case "fork": {
        // Persist current state, then create a child sharing the LIVE history.
        const parentId = context.sessionId;
        const liveMessages = context.agent.getMessages();
        saveSession(parentId, process.cwd(), context.agent.getRuntime(), liveMessages);
        const childId = forkSession(parentId, process.cwd(), context.agent.getRuntime(), liveMessages);
        if (!childId) {
          printError("Cannot fork: current session has no messages yet.");
          return true;
        }
        context.setSessionId(childId);
        printInfo(`Forked into new session ${childId} (parent: ${parentId}). Continuing on the fork.`);
        console.log(formatSessionInfo(childId));
        return true;
      }
      case "backtrack": {
        const steps = arg ? Math.max(1, Number(arg) || 1) : 1;
        const rewound = backtrackMessages(context.agent.getMessages(), steps);
        context.agent.restoreMessages(rewound);
        saveSession(context.sessionId, process.cwd(), context.agent.getRuntime(), context.agent.getMessages());
        printInfo(`Rewound ${steps} user-turn(s); conversation now has ${rewound.length} message(s).`);
        return true;
      }
      case "compact": {
        // `/compact` uses a model summary; `/compact fast` is the offline heuristic.
        const fast = /^fast$/i.test(arg.trim());
        const message = fast
          ? context.agent.compactContext()
          : await context.agent.compactWithSummary();
        saveSession(context.sessionId, process.cwd(), context.agent.getRuntime(), context.agent.getMessages());
        console.log(message);
        return true;
      }
      case "snapshots": {
        if (!context.snapshotManager.isEnabled()) {
          printInfo(`Snapshots disabled: ${context.snapshotManager.reason() ?? "unavailable"}`);
          return true;
        }
        const snaps = context.snapshotManager.list(30);
        if (snaps.length === 0) {
          console.log("No snapshots yet. They are taken automatically around each turn.");
          return true;
        }
        console.log(
          snaps
            .map((s) => {
              const when = new Date(s.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
              return `${s.id.slice(0, 12)}  ${when}  ${s.label}`;
            })
            .join("\n"),
        );
        return true;
      }
      case "restore": {
        if (!arg) {
          printError("Usage: /restore <snapshot-id>  (see /snapshots)");
          return true;
        }
        const result = context.snapshotManager.restore(arg);
        if (result.ok) printInfo(`Restored workspace to snapshot ${result.restored?.slice(0, 12)}.`);
        else printError(`Restore failed: ${result.error}`);
        return true;
      }
      case "undo": {
        const result = context.snapshotManager.undo();
        if (result.ok) printInfo(`Undid last change; restored snapshot ${result.restored?.slice(0, 12)}.`);
        else printError(`Undo failed: ${result.error}`);
        return true;
      }
      case "cost": {
        const s = context.costTracker.snapshot();
        const ratio = context.costTracker.cacheHitRatio();
        console.log(
          [
            `cost_usd: $${s.costUsd.toFixed(4)}`,
            `turns: ${s.turns}`,
            `prompt_tokens: ${s.promptTokens}`,
            `completion_tokens: ${s.completionTokens}`,
            `cache_hit_tokens: ${s.cacheHitTokens}`,
            `cache_miss_tokens: ${s.cacheMissTokens}`,
            `cache_hit_ratio: ${ratio == null ? "n/a" : `${Math.round(ratio * 100)}%`}`,
          ].join("\n"),
        );
        return true;
      }
      case "handoff": {
        let content: string;
        if (arg.trim()) {
          content = arg.trim();
        } else {
          printInfo("Generating session handoff relay...");
          try {
            content = await context.agent.generateHandoff();
          } catch (err: any) {
            printError(`Handoff generation failed: ${safeErrorMessage(err)}`);
            return true;
          }
        }
        const path = writeHandoff(process.cwd(), content);
        printInfo(`Wrote handoff relay to ${path}`);
        return true;
      }
      case "skills": {
        const [sub, ...rest] = arg.split(/\s+/);
        const subArg = rest.join(" ").trim();
        if (!sub || sub === "list") {
          const found = discoverSkills(process.cwd());
          if (found.length === 0) {
            console.log("No skills found. Install one with /skills install owner/repo.");
          } else {
            console.log(found.map((s) => `${s.name} [${s.source}]${s.description ? ` — ${s.description}` : ""}\n  ${s.path}`).join("\n"));
          }
          return true;
        }
        if (sub === "install") {
          // Optional trailing "force" to overwrite an existing skill.
          const tokens = subArg.split(/\s+/);
          const force = tokens.includes("force") || tokens.includes("--force");
          const source = tokens.filter((t) => t !== "force" && t !== "--force").join(" ").trim();
          if (!source) {
            printError("Usage: /skills install <owner/repo | github url> [force]");
            return true;
          }
          printInfo(`Installing skill from ${source}...`);
          const result = installSkill(source, { force });
          if (result.ok) printInfo(`Installed skill '${result.name}' to ${result.path}. Restart to load it into the prompt.`);
          else printError(`Install failed: ${result.error}`);
          return true;
        }
        printError("Usage: /skills <list|install owner/repo [force]>");
        return true;
      }
      case "approvals": {
        const approvals = listShellApprovals();
        console.log(approvals.length ? approvals.map((item) => `${item.id} ${item.reason}\n${item.command}`).join("\n\n") : "No pending shell approvals.");
        return true;
      }
      case "approve": {
        if (!arg) printError("Usage: /approve <id>");
        else {
          printInfo(`Reviewing shell approval ${arg}...`);
          console.log(await runApprovedShellCommand(arg));
        }
        return true;
      }
      case "deny":
        if (!arg) printError("Usage: /deny <id>");
        else console.log(rejectShellApproval(arg) ? `Rejected shell approval ${arg}` : `No pending shell approval: ${arg}`);
        return true;
      case "patches":
        console.log(formatPatchList());
        return true;
      case "apply": {
        if (!arg) printError("Usage: /apply <patch-id>");
        else {
          const result = applyFilePatch(arg);
          console.log(result.message);
          if (result.ok && result.patch) {
            const suffix = await diagnosticsSuffix(result.patch.path);
            if (suffix.trim()) console.log(suffix.trim());
          }
        }
        return true;
      }
      case "reject":
        if (!arg) printError("Usage: /reject <patch-id>");
        else console.log(rejectFilePatch(arg) ? `Rejected patch ${arg}` : `No pending patch: ${arg}`);
        return true;
      case "model":
        if (!arg) printError("Usage: /model <auto|pro|flash|chat|reasoner|model-name>");
        else if (arg.trim().toLowerCase() === "auto") {
          context.agent.setAutoRoute(true);
          printInfo("Auto routing enabled (Fin): model + thinking chosen per turn.");
        } else {
          context.agent.setAutoRoute(false);
          context.agent.setModel(arg);
          printRuntimeUpdated(context.agent.getRuntime());
        }
        return true;
      case "thinking":
        if (!arg) printError("Usage: /thinking <auto|on|off|high|max>");
        else {
          const [thinking, effort] = arg.split(/\s+/, 2);
          context.agent.setThinking(thinking, effort);
          printRuntimeUpdated(context.agent.getRuntime());
        }
        return true;
      case "clear":
        console.clear();
        banner(context.agent.getRuntime(), process.cwd(), context.stats());
        return true;
      case "todo":
        console.log(handleTodoCommand(arg || "list"));
        return true;
      case "monitor":
        console.log(handleMonitorCommand(arg || "list", (id, event) => {
          const color = event.type === "stderr" ? "[33m" : event.type === "error" ? "[31m" : "[0m";
          process.stdout.write(`
  [2m[${id}][0m ${color}${event.data}[0m
`);
        }));
        return true;
      case "mode": {
        const validModes = ["auto", "plan", "ask"];
        if (!arg) {
          console.log(`  execution_mode: ${getExecMode()}
  auto  run tools and edits freely
  plan  think and outline before acting
  ask   confirm each file edit before applying`);
        } else if (validModes.includes(arg.toLowerCase())) {
          setExecMode(arg.toLowerCase() as any);
          console.log(`  execution_mode: ${getExecMode()}`);
          if (arg === "plan") {
            context.agent.setSystemSuffix("You are in PLAN MODE. Before taking any action or writing any file, first output a numbered plan of what you will do. Wait for user confirmation before executing. Prefix your plan with [PLAN].");
          } else if (arg === "ask") {
            context.agent.setSystemSuffix("You are in ASK MODE. Before writing or modifying any file, you MUST ask the user for confirmation with the exact change you plan to make. Only proceed after explicit approval.");
          } else {
            context.agent.setSystemSuffix("");
          }
        } else {
          printError("Usage: /mode <auto|plan|ask>");
        }
        return true;
      }
      case "image": {
        if (!arg) { printError("Usage: /image <path>"); return true; }
        console.log(attachImage(arg));
        return true;
      }
      case "images": {
        const imgs = getPendingImages();
        if (imgs.length === 0) { console.log("  No images attached."); }
        else { imgs.forEach((img, i) => console.log(`  [${i+1}] ${img.path} (${img.mimeType})`)); }
        return true;
      }
      default:
        return false;
    }
  } catch (err: any) {
    printError(`Error: ${safeErrorMessage(err)}`);
    return true;
  }
}

function printPermissions() {
  console.log(`\nPermission controls\n  permission_model: ${describeCurrentPermissionModel()}\n  approval_mode:    ${getApprovalMode()}\n  sandbox_mode:     ${getSandboxMode()}\n  write_mode:       ${getWriteMode()}\n\nPermission models\n  safe       preview writes, workspace sandbox, approvals on-request\n  read-only  block file writes, approvals on-request\n  trusted    direct writes, unrestricted sandbox, approvals auto\n  locked     preview writes, read-only sandbox, approvals never\n`);
}

function describeCurrentPermissionModel(): string {
  const approval = getApprovalMode();
  const sandbox = getSandboxMode();
  const write = getWriteMode();
  if (approval === "on-request" && sandbox === "workspace-write" && write === "preview") return "safe";
  if (approval === "on-request" && sandbox === "read-only" && write === "preview") return "read-only";
  if (approval === "auto" && sandbox === "unrestricted" && write === "direct") return "trusted";
  if (approval === "never" && sandbox === "read-only" && write === "preview") return "locked";
  return "custom";
}

function applyPermissionModel(mode: string): string {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "safe" || normalized === "default") {
    setWriteMode("preview");
    setSandboxMode("workspace-write");
    setApprovalMode("on-request");
  } else if (normalized === "read-only" || normalized === "readonly") {
    setWriteMode("preview");
    setSandboxMode("read-only");
    setApprovalMode("on-request");
  } else if (normalized === "trusted" || normalized === "full-access") {
    setWriteMode("direct");
    setSandboxMode("unrestricted");
    setApprovalMode("auto");
  } else if (normalized === "locked") {
    setWriteMode("preview");
    setSandboxMode("read-only");
    setApprovalMode("never");
  } else {
    throw new Error("Permission model must be safe, read-only, trusted, or locked");
  }
  return `permission_model: ${describeCurrentPermissionModel()} (approval=${getApprovalMode()}, sandbox=${getSandboxMode()}, write=${getWriteMode()})`;
}

async function handleMcpCommand(arg: string, context: CommandContext): Promise<void> {
  const subcommand = arg.trim().toLowerCase() || "status";
  if (subcommand === "status" || subcommand === "list") {
    printMcpDiagnostics(context.mcpManager);
    return;
  }
  if (subcommand === "reconnect" || subcommand === "reload") {
    await context.mcpManager.disconnectAll();
    await context.mcpManager.connectAll(context.config.mcp_servers);
    printMcpDiagnostics(context.mcpManager);
    return;
  }
  printError("Usage: /mcp <status|reconnect>");
}

async function handleMemoryCommand(arg: string, context: CommandContext): Promise<void> {
  const subcommand = arg.trim().toLowerCase() || "save";
  if (subcommand === "save" || subcommand === "snapshot") {
    const result = await context.persistSnapshot("manual", "manual /memory save");
    printMemoryResult(result);
    return;
  }
  if (subcommand === "status") {
    const result = await context.persistSnapshot("manual", "manual /memory status probe");
    printMemoryResult(result);
    return;
  }
  printError("Usage: /memory <save|status>");
}

function printTools(mcpManager: MCPManager) {
  const builtin = getToolDefs().map((tool) => tool.function.name);
  const mcp = mcpManager.getToolDefs().map((tool) => tool.function.name);
  console.log(`\nTools\n  built-in (${builtin.length})\n${builtin.map((name) => `    ${name}`).join("\n") || "    none"}\n\n  MCP (${mcp.length})\n${mcp.map((name) => `    ${name}`).join("\n") || "    none"}\n`);
}

function printMcpDiagnostics(mcpManager: MCPManager) {
  const diagnostics = mcpManager.getDiagnostics();
  if (diagnostics.length === 0) {
    console.log("No MCP servers configured or connected.");
    return;
  }
  console.log(diagnostics.map((item) => `${item.ok ? "ok" : "fail"} ${item.name} tools=${item.tools}${item.error ? ` error=${item.error}` : ""}`).join("\n"));
}

function printSessions(limit: number) {
  const sessions = listSessions(Number.isFinite(limit) ? limit : 10);
  if (sessions.length === 0) {
    console.log("No saved sessions.");
    return;
  }
  console.log(
    sessions
      .map((session) => {
        const title = session.title ? ` "${session.title}"` : "";
        const fork = session.parent_session_id ? ` fork<-${session.parent_session_id.slice(0, 16)}` : "";
        return `${session.id}${title} updated=${session.updated_at} messages=${session.messages.length}${fork} cwd=${session.cwd}`;
      })
      .join("\n"),
  );
}

function printMemoryResult(result: SessionMemoryResult) {
  if (result.skipped) {
    console.log("agentmemory autosave skipped by environment setting");
  } else if (result.agentmemory) {
    console.log("saved session summary to agentmemory");
  } else if (result.fallbackPath) {
    console.log(`saved session summary fallback: ${result.fallbackPath}`);
  } else if (result.error) {
    console.log(`memory save failed: ${result.error}`);
  }
}

function buildSlashMenu(line: string, cursor: number): SlashMenuResult | null {
  const token = findSlashToken(line, cursor);
  if (!token) return null;
  const raw = line.slice(token.start, token.end);
  const commandText = raw[0] === "\\" ? `/${raw.slice(1)}` : raw;
  const parts = commandText.slice(1).split(/\s+/);
  const commandQuery = parts[0]?.toLowerCase() ?? "";
  const argumentQuery = parts.length > 1 ? parts.slice(1).join(" ").toLowerCase() : "";
  const hasArgumentPosition = /\s/.test(commandText);

  if (hasArgumentPosition) {
    const nested = buildArgumentMenu(commandQuery, argumentQuery, token.start, token.end);
    if (nested) return nested;
  }

  const items = COMMAND_DEFS
    .filter((command) => fuzzyMatch(command.name, commandQuery))
    .sort((left, right) => commandMatchScore(left.name, commandQuery) - commandMatchScore(right.name, commandQuery))
    .map((command) => {
      const replacement = `/${command.name}${command.args ? " " : ""}`;
      return {
        label: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
        description: command.description,
        replacement,
        submitOnAccept: "submit" in command ? command.submit : false,
      } satisfies SlashMenuItem;
    });

  return {
    title: "Commands",
    replaceStart: token.start,
    replaceEnd: token.end,
    items,
  };
}

function buildArgumentMenu(command: string, query: string, replaceStart: number, replaceEnd: number): SlashMenuResult | null {
  const optionGroups: Record<string, readonly { value: string; description: string }[]> = {
    permissions: [
      { value: "status", description: "show current permission settings" },
      { value: "safe", description: "preview writes, workspace sandbox, approvals on-request" },
      { value: "read-only", description: "block file writes, approvals on-request" },
      { value: "trusted", description: "direct writes, unrestricted sandbox, approvals auto" },
      { value: "locked", description: "preview writes, read-only sandbox, approvals never" },
    ],
    "permission-model": PERMISSION_MODE_OPTIONS,
    "permissions-model": PERMISSION_MODE_OPTIONS,
    approval: APPROVAL_OPTIONS,
    "approval-mode": APPROVAL_OPTIONS,
    sandbox: SANDBOX_OPTIONS,
    "sandbox-mode": SANDBOX_OPTIONS,
    "write-mode": WRITE_MODE_OPTIONS,
    writemode: WRITE_MODE_OPTIONS,
    thinking: THINKING_OPTIONS,
    mcp: [
      { value: "status", description: "show MCP connection diagnostics" },
      { value: "reconnect", description: "disconnect and reconnect configured MCP servers" },
    ],
    memory: [
      { value: "save", description: "save a compact session summary to agentmemory" },
      { value: "status", description: "probe agentmemory save path and report fallback" },
    ],
    model: [
      ...MODEL_PRESETS.map((preset) => ({ value: preset.name, description: `${preset.model}, thinking=${preset.thinking}` })),
      { value: "chat", description: "compatibility alias, non-thinking Flash" },
      { value: "reasoner", description: "compatibility alias, thinking Flash" },
    ],
    mode: [
      { value: "auto", description: "run tools and edits freely without asking" },
      { value: "plan", description: "think and outline before acting, wait for confirmation" },
      { value: "ask", description: "confirm each file edit before applying" },
    ],
    todo: [
      { value: "add", description: "add a new task: /todo add <text>" },
      { value: "done", description: "mark task done: /todo done <id>" },
      { value: "start", description: "mark task in progress: /todo start <id>" },
      { value: "remove", description: "remove a task: /todo remove <id>" },
      { value: "clear", description: "clear done tasks (or all)" },
      { value: "list", description: "list all tasks" },
    ],
    monitor: [
      { value: "start", description: "start monitoring a command: /monitor start <cmd>" },
      { value: "stop", description: "stop a monitor: /monitor stop <id>" },
      { value: "logs", description: "show monitor output: /monitor logs <id>" },
      { value: "list", description: "list all monitors" },
      { value: "clear", description: "clear stopped monitors" },
    ],
    approve: listShellApprovals().map((approval) => ({ value: approval.id, description: approval.reason })),
    deny: listShellApprovals().map((approval) => ({ value: approval.id, description: approval.reason })),
  };
  const options = optionGroups[command];
  if (!options) return null;
  const prefix = `/${command} `;
  const filtered = options.filter((option) => fuzzyMatch(option.value, query));
  return {
    title: `${prefix.trim()} choices`,
    replaceStart,
    replaceEnd,
    items: filtered.map((option) => ({
      label: option.value,
      description: option.description,
      replacement: `${prefix}${option.value}`,
      submitOnAccept: true,
    })),
  };
}

function findSlashToken(line: string, cursor: number): { start: number; end: number } | null {
  for (let start = Math.min(cursor, line.length) - 1; start >= 0; start--) {
    const char = line[start];
    if (char !== "/" && char !== "\\") continue;
    const before = start === 0 ? "" : line[start - 1];
    const after = line[start + 1] ?? "";
    if (before && !isWhitespace(before)) continue;
    if (after && !isWhitespace(after) && !/[A-Za-z0-9_-]/.test(after)) continue;
    const prefix = line.slice(start, cursor);
    const commandMatch = prefix.match(/^[\\/]([A-Za-z][\w-]*)?(?:\s+[^\s]*)?$/);
    if (!commandMatch) continue;
    let end = cursor;
    while (end < line.length && !isWhitespace(line[end])) end += 1;
    return { start, end };
  }
  return null;
}

function commandMatchScore(value: string, query: string): number {
  if (!query) return 0;
  const normalized = value.toLowerCase();
  if (normalized === query) return -100;
  if (normalized.startsWith(query)) return normalized.length;
  const index = normalized.indexOf(query);
  if (index !== -1) return 100 + index + normalized.length;
  return 1000 + normalized.length;
}

function fuzzyMatch(value: string, query: string): boolean {
  if (!query) return true;
  const normalized = value.toLowerCase();
  if (normalized.includes(query)) return true;
  let index = 0;
  for (const char of query) {
    index = normalized.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function isWhitespace(char: string | undefined): boolean {
  return !char || /\s/.test(char);
}

function printDoctor(config: Config, json = false, mcpManager?: MCPManager, autoRoute = false) {
  const configuredMcpServers = Object.keys(config.mcp_servers).length;
  const hasApiKey = Boolean(config.llm.api_key);
  const checks = validateConfig(config);
  const ok = !checks.some((check) => check.level === "error");
  const payload = {
    ok,
    version: VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    runtime: {
      model: config.llm.model,
      thinking: config.llm.thinking,
      reasoning_effort: config.llm.reasoning_effort,
      routing: autoRoute ? "auto" : "fixed",
    },
    endpoint: {
      configured: endpointConfigured(config.llm.base_url),
      host: endpointHost(config.llm.base_url),
    },
    paths: {
      cwd: process.cwd(),
      config_path: config.config_path ?? null,
      config_scope: config.config_scope ?? null,
      workspace_config_ignored: config.workspace_config_ignored ?? null,
      session_dir: sessionDir(),
      memory_outbox_dir: memoryDiagnostics().outbox_dir,
    },
    auth: {
      api_key: hasApiKey ? "configured" : "missing",
      source: hasApiKey ? config.llm.api_key_source : "missing",
    },
    cwd: process.cwd(),
    safety: {
      approval_mode: getApprovalMode(),
      write_mode: getWriteMode(),
      sandbox_mode: getSandboxMode(),
      workspace_config_trusted: isWorkspaceTrusted(process.cwd()),
    },
    memory: memoryDiagnostics(),
    mcp_servers: configuredMcpServers,
    mcp_configured: Object.keys(config.mcp_servers),
    mcp_diagnostics: mcpManager?.getDiagnostics() ?? [],
    builtin_tools: getToolDefs().map((tool) => tool.function.name),
    checks,
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function printModels(json = false) {
  const payload = {
    models: MODEL_PRESETS,
    aliases: {
      chat: "deepseek-v4-flash + thinking disabled",
      reasoner: "deepseek-v4-flash + thinking enabled",
      "deepseek-chat": "deepseek-v4-flash + thinking disabled",
      "deepseek-reasoner": "deepseek-v4-flash + thinking enabled",
    },
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log("Available DeepSeek model presets:\n");
  for (const preset of MODEL_PRESETS) {
    console.log(`  ${preset.name.padEnd(20)} ${preset.model.padEnd(22)} thinking=${preset.thinking}`);
    console.log(`  ${"".padEnd(20)} ${preset.description}`);
  }
  console.log("\nAliases: chat, reasoner, deepseek-chat, deepseek-reasoner");
}

function parseRuntimeArgs(args: string[]) {
  return {
    model: readFlag(args, "--model") ?? readFlag(args, "-m"),
    thinking: readFlag(args, "--thinking"),
    reasoning_effort: readFlag(args, "--reasoning-effort"),
  };
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    const prefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(prefix));
    if (!inline) return undefined;
    const value = inline.slice(prefix.length);
    if (!value) throw new Error(`${name} requires a value`);
    return value;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readPositionalTask(args: string[]): string | null {
  const valueFlags = new Set(["-t", "--task", "-m", "--model", "--thinking", "--reasoning-effort", "--cwd", "--workspace", "--session", "--resume", "--port", "--host"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--") || arg.startsWith("-")) continue;
    return args.slice(i).join(" ");
  }
  return null;
}

function printCliError(message: string, json = false) {
  message = safeErrorMessage(message);
  if (json) {
    console.error(JSON.stringify({ ok: false, error: { message } }, null, 2));
    return;
  }
  printError(`Error: ${message}`);
}

function changeDirectory(path: string) {
  try {
    process.chdir(path);
  } catch (err: any) {
    throw new Error(`Cannot use cwd ${path}: ${safeErrorMessage(err)}`);
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

main().catch((err) => {
  printCliError(safeErrorMessage(err), false);
  process.exit(1);
});
