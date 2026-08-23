import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

await import("../src/tools/file-read.ts");
const { Agent } = await import("../src/agent.ts");

const workspace = mkdtempSync(join(tmpdir(), "ww-agent-tool-errors-"));
const original = process.cwd();
try {
  process.chdir(workspace);
  const config = {
    llm: {
      model: "deepseek-v4-flash",
      api_key: "test",
      api_key_source: "test",
      base_url: "https://api.deepseek.com",
      temperature: 0.3,
      max_tokens: 100,
      request_timeout_ms: 1_000,
      thinking: "disabled",
      reasoning_effort: "high",
    },
    agent: { max_iterations: 1, workspace: ".", system_prompt: "test" },
    context: { repo_map_enabled: false },
    mcp_servers: {},
  };
  const mcp = { callTool: async () => null, getToolDefs: () => [] };
  const agent = new Agent(config, mcp, { isSubagent: true });
  assert.equal(agent.setModel("auto"), "deepseek-v4-flash", "auto is never forwarded as a provider model name");
  assert.equal(agent.isAutoRoute(), true, "Agent.setModel('auto') enables per-turn routing");
  assert.equal(agent.getRuntime().routing, "auto", "runtime reports auto routing separately from the real model");
  agent.setAutoRoute(false);
  const events = [];
  const callbacks = { onToolEnd: (_name, _elapsed, error) => events.push(error) };

  const badShape = await agent.executeTool(
    { id: "1", type: "function", function: { name: "read_file", arguments: "null" } },
    callbacks,
  );
  assert.match(badShape, /JSON object/);

  const handlerFailure = await agent.executeTool(
    { id: "2", type: "function", function: { name: "read_file", arguments: '{"path":null}' } },
    callbacks,
  );
  assert.match(handlerFailure, /Tool read_file failed/);
  assert.deepEqual(events, [true], "handler exceptions emit a failed tool-end event exactly once");
} finally {
  process.chdir(original);
  rmSync(workspace, { recursive: true, force: true });
}

console.log("agent tool-boundary e2e ok");
