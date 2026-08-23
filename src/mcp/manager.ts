import { MCPClient } from "./client.js";
import type { MCPServerConfig } from "../config.js";
import type { ToolDef } from "../llm/deepseek.js";
import type { ToolResult } from "../tools/registry.js";
import { errorType, safeErrorMessage } from "../runtime/safe-text.js";

export class MCPManager {
  private clients: MCPClient[] = [];
  private connectionStatus: Array<{ name: string; ok: boolean; tools: number; error?: string; error_type?: string }> = [];

  async connectAll(servers: Record<string, MCPServerConfig>): Promise<void> {
    await this.disconnectAll();
    this.connectionStatus = [];
    for (const [name, cfg] of Object.entries(servers)) {
      const client = new MCPClient(cfg.command, cfg.args || [], cfg.env || {}, name, {
        cwd: cfg.cwd,
        timeoutMs: cfg.timeout_ms,
        includeTools: cfg.include_tools,
        excludeTools: cfg.exclude_tools,
      });
      try {
        await client.connect();
        this.clients.push(client);
        this.connectionStatus.push({ name, ok: true, tools: client.getToolDefs().length });
        process.stderr.write(`[mcp] Connected: ${name} (${client.getToolDefs().length} tools)\n`);
      } catch (err: any) {
        const message = safeErrorMessage(err);
        this.connectionStatus.push({ name, ok: false, tools: 0, error: message, error_type: errorType(err) });
        process.stderr.write(`[mcp] Failed to connect ${name}: ${message}\n`);
      }
    }
  }

  getToolDefs(): ToolDef[] {
    return this.clients.flatMap((c) => c.getToolDefs());
  }

  getServerCount(): number {
    return this.clients.length;
  }

  getDiagnostics() {
    return this.connectionStatus;
  }

  async callTool(fullName: string, args: Record<string, any>): Promise<ToolResult | null> {
    for (const client of this.clients) {
      if (client.hasExposedTool(fullName)) return client.callExposedTool(fullName, args);
    }
    return null;
  }

  async disconnectAll(): Promise<void> {
    const clients = this.clients;
    this.clients = [];
    await Promise.all(clients.map((client) => client.disconnect()));
  }
}
