import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const node = process.execPath;
const cli = join(process.cwd(), "dist", "index.js");
const homeDir = mkdtempSync(join(tmpdir(), "deepseek-cli-home-"));
const configDir = mkdtempSync(join(tmpdir(), "deepseek-cli-config-"));
const outboxDir = mkdtempSync(join(tmpdir(), "deepseek-cli-memory-outbox-"));
const configPath = join(configDir, "config.toml");
const mcpConfigPath = join(configDir, "mcp-config.toml");
const mcpEnvReport = join(configDir, "mcp-env-report.json");
writeFileSync(configPath, "[llm]\nmodel = \"deepseek-v4-flash\"\napi_key_env = \"DEEPSEEK_API_KEY\"\nbase_url = \"https://api.deepseek.com\"\n\n[agent]\nworkspace = \".\"\nmax_iterations = 3\n");
writeFileSync(
  mcpConfigPath,
  [
    "[llm]",
    'model = "deepseek-v4-flash"',
    'api_key_env = "DEEPSEEK_API_KEY"',
    'base_url = "https://api.deepseek.com"',
    "",
    "[agent]",
    'workspace = "."',
    "max_iterations = 3",
    "",
    "[mcp_servers.fake]",
    'command = "node"',
    `args = ["${tomlPath(join(process.cwd(), "scripts", "fake-mcp-server.mjs"))}"]`,
    "",
    "[mcp_servers.fake.env]",
    `MCP_ENV_REPORT = "${tomlPath(mcpEnvReport)}"`,
    'EXPLICIT_ALLOWED = "yes"',
    "",
  ].join("\n"),
  "utf-8",
);

function run(args, options = {}) {
  return spawnSync(node, [cli, ...args], {
    cwd: process.cwd(),
    input: options.input,
    encoding: "utf8",
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CONFIG: configPath,
      DEEPSEEK_APPROVAL_MODE: "on-request",
      DEEPSEEK_WRITE_MODE: "preview",
      DEEPSEEK_SANDBOX_MODE: "workspace-write",
      AGENTMEMORY_URL: "http://127.0.0.1:9",
      DEEPSEEK_MEMORY_OUTBOX_DIR: outboxDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...options.env,
    },
  });
}

function json(args, options) {
  const result = run(["--json", ...args], options);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return JSON.parse(result.stdout);
}

try {
  const version = run(["--version"]);
  assert.equal(version.status, 0, version.error?.message || version.stderr || version.stdout);
  assert.match(version.stdout, /0\.4\.0/);

  const doctor = json(["--doctor"]);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.runtime.model, "deepseek-v4-flash");
  assert.equal(doctor.endpoint.configured, true);
  assert.equal(doctor.endpoint.host, "api.deepseek.com");
  assert.equal(doctor.base_url, undefined);
  assert.equal(doctor.auth.api_key, "configured");
  assert.equal(doctor.safety.write_mode, "preview");
  assert.equal(doctor.safety.approval_mode, "on-request");
  assert.equal(doctor.safety.sandbox_mode, "workspace-write");
  assert.equal(doctor.memory.legacy_shared_memory_disabled, true);
  assert.equal(doctor.paths.memory_outbox_dir, outboxDir);
  assert.deepEqual(doctor.mcp_diagnostics, []);
  assert.ok(doctor.checks.every((check) => ["ok", "warn"].includes(check.level)));

  const autoDoctor = json(["--doctor", "--model", "auto"]);
  assert.equal(autoDoctor.runtime.model, "deepseek-v4-flash", "auto starts on the real fast provider model");
  assert.equal(autoDoctor.runtime.routing, "auto", "doctor reports routing mode instead of pretending 'auto' is a provider model");

  const models = json(["--models"]);
  assert.ok(models.models.some((model) => model.name === "pro"));
  assert.equal(models.aliases.chat, "deepseek-v4-flash + thinking disabled");

  const badFlag = run(["--json", "--model="]);
  assert.equal(badFlag.status, 1, badFlag.error?.message || badFlag.stderr || badFlag.stdout);
  assert.equal(JSON.parse(badFlag.stderr).ok, false);

  const editorSelfTest = run(["--self-test-editor"]);
  assert.equal(editorSelfTest.status, 0, editorSelfTest.stderr || editorSelfTest.stdout || editorSelfTest.error?.message);
  const editorSelfTestJson = JSON.parse(editorSelfTest.stdout.match(/\{.*\}/s)?.[0] ?? "{}");
  assert.deepEqual(editorSelfTestJson, {
    ok: true,
    slash: true,
    backslash: true,
    nested: true,
    mcp_nested: true,
    memory_nested: true,
    selection_delete: true,
    vertical_cursor: true,
    mouse_swallow: true,
    split_mouse_swallow: true,
    menu_mouse_click: true,
    scroll_wheel: true,
    rapid_scroll: true,
    menu_scroll: true,
  });

  const runtimeSelfTest = run(["--self-test-runtime"]);
  assert.equal(runtimeSelfTest.status, 0, runtimeSelfTest.stderr || runtimeSelfTest.stdout || runtimeSelfTest.error?.message);
  const runtimeSelfTestJson = JSON.parse(runtimeSelfTest.stdout.match(/\{.*\}/s)?.[0] ?? "{}");
  assert.equal(runtimeSelfTestJson.ok, true);
  assert.equal(runtimeSelfTestJson.patch, true);
  assert.equal(runtimeSelfTestJson.monitor_safety, true);
  assert.equal(runtimeSelfTestJson.memory_outbox, true);

  const mcpDoctor = json(["--doctor"], {
    env: {
      DEEPSEEK_CONFIG: mcpConfigPath,
      AGENTMEMORY_SECRET: "agentmemory-secret-should-not-leak",
    },
  });
  assert.equal(mcpDoctor.ok, true);
  assert.equal(mcpDoctor.mcp_diagnostics[0].ok, true);
  assert.equal(mcpDoctor.mcp_diagnostics[0].tools, 1);
  const mcpEnv = JSON.parse(readFileSync(mcpEnvReport, "utf8"));
  assert.equal(mcpEnv.saw_deepseek_api_key, false);
  assert.equal(mcpEnv.saw_agentmemory_secret, false);
  assert.equal(mcpEnv.saw_explicit_allowed, true);

  const workspaceDir = mkdtempSync(join(tmpdir(), "deepseek-cli-workspace-"));
  try {
    writeFileSync(join(workspaceDir, "deepseek-cli.toml"), "[agent]\nworkspace = \".\"\n");
    const cwdDoctor = json(["--cwd", workspaceDir, "--doctor"]);
    assert.equal(cwdDoctor.cwd, workspaceDir);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  const interactive = run(["--session", "e2e-session"], {
    input: [
      "/session",
      "/sessions 5",
      "/doctor",
      "/tools",
      "/mcp status",
      "/memory save",
      "/patches",
      "/approvals",
      "/permissions status",
      "/permission-model trusted",
      "/model pro",
      "/thinking max",
      "/status",
      "/model auto",
      "/status",
      "\\permission-model safe",
      "/approval never",
      "/sandbox read-only",
      "/write-mode direct",
      "/status",
      "please /permissions",
      "/exit",
    ].join("\n") + "\n",
  });
  assert.equal(interactive.status, 0, interactive.stderr || interactive.stdout || interactive.error?.message);
  assert.match(interactive.stdout, /session: e2e-session/);
  assert.match(interactive.stdout, /Tools/);
  assert.match(interactive.stdout, /builtin_tools/);
  assert.match(interactive.stderr + interactive.stdout, /saved session summary/);
  assert.match(interactive.stdout, /No pending file patches/);
  assert.match(interactive.stdout, /No pending shell approvals/);
  assert.match(interactive.stdout, /permission_model: safe/);
  assert.match(interactive.stdout, /permission_model: trusted/);
  assert.match(interactive.stdout, /model:\s+deepseek-v4-pro/);
  assert.match(interactive.stdout, /thinking:\s+enabled/);
  assert.match(interactive.stdout, /reasoning_effort:\s+max/);
  assert.match(interactive.stdout, /routing:\s+auto/);
  assert.match(interactive.stdout, /approval_mode:\s+never/);
  assert.match(interactive.stdout, /sandbox_mode:\s+read-only/);
  assert.match(interactive.stdout, /write_mode:\s+direct/);

  const resumed = run(["--resume", "e2e-session"], { input: "/session\n/exit\n" });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout || resumed.error?.message);
  assert.match(resumed.stdout, /session: e2e-session/);

  const sessionDir = join(homeDir, ".weiping-whale", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "broken.json"), "{not-json", "utf8");
  const sessionsWithCorruptFile = run([], { input: "/sessions 20\n/exit\n" });
  assert.equal(sessionsWithCorruptFile.status, 0, sessionsWithCorruptFile.stderr || sessionsWithCorruptFile.stdout || sessionsWithCorruptFile.error?.message);
  assert.match(sessionsWithCorruptFile.stdout, /e2e-session/);
} finally {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(outboxDir, { recursive: true, force: true });
}

console.log("e2e ok");

function tomlPath(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
