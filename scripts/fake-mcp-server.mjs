import { writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.env.MCP_ENV_REPORT) {
  writeFileSync(
    process.env.MCP_ENV_REPORT,
    JSON.stringify({
      saw_deepseek_api_key: Boolean(process.env.DEEPSEEK_API_KEY),
      saw_agentmemory_secret: Boolean(process.env.AGENTMEMORY_SECRET),
      saw_explicit_allowed: process.env.EXPLICIT_ALLOWED === "yes",
    }),
    "utf-8",
  );
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    if (process.env.MCP_TEST_MODE === "endless-pages") {
      const page = Number(message.params?.cursor ?? 0);
      respond(message.id, {
        tools: [],
        nextCursor: String(page + 1),
      });
      return;
    }
    if (process.env.MCP_TEST_MODE === "advanced") {
      const cursor = message.params?.cursor;
      if (!cursor) {
        respond(message.id, {
          tools: [
            {
              name: "structured.probe",
              description: "Return structured MCP output",
              inputSchema: { type: "object", properties: { value: { type: "string" } } },
              outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
            },
            {
              name: "error_probe",
              description: "Return a tool-level error",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "invalid_output_probe",
              description: "Return structured output that violates outputSchema",
              inputSchema: { type: "object", properties: {} },
              outputSchema: { type: "object", properties: { required_value: { type: "string" } }, required: ["required_value"] },
            },
            {
              name: "huge_output_probe",
              description: "Return output larger than the client cap",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "timeout_probe",
              description: "Never answer a tool call",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          nextCursor: "page-2",
        });
      } else if (cursor === "page-2") {
        respond(message.id, {
          tools: [
            {
              name: `very_long_tool_${"x".repeat(90)}`,
              description: "Exercise provider-compatible exposed names",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      } else {
        respond(message.id, { tools: [] });
      }
      return;
    }
    respond(message.id, {
      tools: [
        {
          name: "env_probe",
          description: "Probe MCP env inheritance for tests",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    if (process.env.MCP_TEST_MODE === "advanced") {
      if (message.params?.name === "structured.probe") {
        const echoed = String(message.params?.arguments?.value ?? "");
        respond(message.id, {
          content: [{ type: "text", text: `echo: ${echoed}` }],
          structuredContent: { echoed },
        });
        return;
      }
      if (message.params?.name === "error_probe") {
        respond(message.id, { content: [{ type: "text", text: "expected failure" }], isError: true });
        return;
      }
      if (message.params?.name === "invalid_output_probe") {
        respond(message.id, { content: [], structuredContent: { wrong: true } });
        return;
      }
      if (message.params?.name === "huge_output_probe") {
        respond(message.id, { content: [{ type: "text", text: "x".repeat(150_000) }] });
        return;
      }
      if (message.params?.name === "timeout_probe") return;
      respond(message.id, { content: [{ type: "text", text: "long-name ok" }] });
      return;
    }
    respond(message.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            saw_deepseek_api_key: Boolean(process.env.DEEPSEEK_API_KEY),
            saw_agentmemory_secret: Boolean(process.env.AGENTMEMORY_SECRET),
            saw_explicit_allowed: process.env.EXPLICIT_ALLOWED === "yes",
          }),
        },
      ],
    });
    return;
  }
  respond(message.id, null);
});

function respond(id, result) {
  if (id === undefined || id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
