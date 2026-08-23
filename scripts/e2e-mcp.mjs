import assert from "node:assert/strict";
import { join } from "node:path";

const { MCPClient } = await import("../src/mcp/client.ts");
const server = join(process.cwd(), "scripts", "fake-mcp-server.mjs");
const client = new MCPClient(
  process.execPath,
  [server],
  { MCP_TEST_MODE: "advanced" },
  "advanced.server",
  { timeoutMs: 1_000 },
);

try {
  await client.connect();
  const definitions = client.getToolDefs();
  assert.equal(definitions.length, 6, "official SDK aggregates paginated tools/list responses");
  assert.ok(definitions.every((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name)), "exposed names satisfy provider limits");
  assert.equal(new Set(definitions.map((tool) => tool.function.name)).size, definitions.length, "one server exposes unique names");

  const structuredName = definitions.find((tool) => tool.function.description.includes("structured MCP"))?.function.name;
  assert.ok(structuredName, "structured tool discovered");
  const structured = await client.callExposedTool(structuredName, { value: "hello" });
  assert.equal(structured.error, false);
  assert.match(structured.output, /echo: hello/);
  assert.match(structured.output, /structured_content:.*"echoed":"hello"/);

  const errorName = definitions.find((tool) => tool.function.description.includes("tool-level error"))?.function.name;
  assert.ok(errorName, "error tool discovered");
  const failure = await client.callExposedTool(errorName, {});
  assert.equal(failure.error, true, "MCP isError propagates to the agent");
  assert.match(failure.output, /expected failure/);

  const invalidOutputName = definitions.find((tool) => tool.function.description.includes("violates outputSchema"))?.function.name;
  assert.ok(invalidOutputName, "output-schema probe discovered");
  const invalidOutput = await client.callExposedTool(invalidOutputName, {});
  assert.equal(invalidOutput.error, true, "official SDK rejects structured output that violates outputSchema");
  assert.match(invalidOutput.output, /MCP error:/);

  const hugeOutputName = definitions.find((tool) => tool.function.description.includes("larger than the client cap"))?.function.name;
  assert.ok(hugeOutputName, "large-output probe discovered");
  const hugeOutput = await client.callExposedTool(hugeOutputName, {});
  assert.equal(hugeOutput.error, false);
  assert.ok(hugeOutput.output.length < 101_000, `MCP output is capped, got ${hugeOutput.output.length} chars`);
  assert.match(hugeOutput.output, /MCP output truncated/);

  const timeoutName = definitions.find((tool) => tool.function.description.includes("Never answer"))?.function.name;
  assert.ok(timeoutName, "timeout probe discovered");
  const timeoutStarted = Date.now();
  const timedOut = await client.callExposedTool(timeoutName, {});
  assert.equal(timedOut.error, true, "hung MCP tool call fails");
  assert.match(timedOut.output, /timed out|timeout/i);
  assert.ok(Date.now() - timeoutStarted < 4_000, "configured MCP timeout is enforced");

  // Sanitized server/tool components must remain globally distinct. These two
  // server names collided in the previous `mcp_<server>_<tool>` mapping.
  const colliding = new MCPClient(
    process.execPath,
    [server],
    { MCP_TEST_MODE: "advanced" },
    "advanced_server",
    { timeoutMs: 1_000 },
  );
  try {
    await colliding.connect();
    const otherNames = new Set(colliding.getToolDefs().map((tool) => tool.function.name));
    assert.ok(
      definitions.every((tool) => !otherNames.has(tool.function.name)),
      "MCP exposed names do not collide across sanitized server names",
    );
  } finally {
    await colliding.disconnect();
  }

  const filtered = new MCPClient(
    process.execPath,
    [server],
    { MCP_TEST_MODE: "advanced" },
    "filtered",
    { timeoutMs: 5_000, includeTools: ["structured.probe"] },
  );
  try {
    await filtered.connect();
    assert.equal(filtered.getToolDefs().length, 1, "include_tools allowlist filters discovery");
  } finally {
    await filtered.disconnect();
  }

  const endless = new MCPClient(
    process.execPath,
    [server],
    { MCP_TEST_MODE: "endless-pages" },
    "endless",
    { timeoutMs: 1_000 },
  );
  await assert.rejects(
    () => endless.connect(),
    /listMaxPages|pagination|exceeded/i,
    "official SDK caps non-terminating unique-cursor pagination",
  );
  await endless.disconnect();
} finally {
  await client.disconnect();
}

console.log("mcp SDK e2e ok");
