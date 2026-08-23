import { DeepSeekClient, type Message, type ToolDef, type ToolCall, type Usage, type ContentBlock } from "./llm/deepseek.js";
import {
  planCompaction,
  shouldCompact,
  buildSummaryInput,
  SUMMARY_SYSTEM_PROMPT,
  type CompactionPlan,
} from "./compaction.js";
import {
  assembleSystemPrompt,
  discoverProjectInstructions,
  readHandoff,
} from "./prompts/assemble.js";
import { route } from "./router.js";
import { discoverSkills, renderSkillsBlock } from "./skills/index.js";
import { getToolDefs, getTool, registerTool } from "./tools/registry.js";
import { MCPManager } from "./mcp/manager.js";
import {
  applyModelOverride,
  applyThinkingOverride,
  normalizeReasoningEffort,
  type Config,
} from "./config.js";
import { safeErrorMessage } from "./runtime/safe-text.js";
import { buildRepositoryMap } from "./context/repo-map.js";

export class Agent {
  private client: DeepSeekClient;
  private mcpManager: MCPManager;
  private config: Config;
  private messages: Message[] = [];
  private maxIterations: number;
  private autoRoute = false;
  private lastRoute?: string;

  constructor(config: Config, mcpManager: MCPManager, opts: { isSubagent?: boolean } = {}) {
    // Sub-agents get an isolated copy of config so their runtime mutations never
    // bleed into the parent (or sibling) agents that share the original object.
    this.config = opts.isSubagent ? structuredClone(config) : config;
    const configuredAuto = this.config.llm.model.trim().toLowerCase() === "auto";
    if (configuredAuto) applyModelOverride(this.config, "flash");
    this.autoRoute = configuredAuto;
    this.client = new DeepSeekClient(this.config.llm);
    this.mcpManager = mcpManager;
    this.maxIterations = this.config.agent.max_iterations;

    // Only the primary agent owns the global configure_deepseek_runtime tool.
    // Sub-agents must not re-register it, or the last-constructed child would
    // hijack the parent's runtime control (shared global tool registry).
    if (!opts.isSubagent) this.registerRuntimeTool();

    const workspace = process.cwd();
    const repositoryMap = this.config.context?.repo_map_enabled === false
      ? undefined
      : buildRepositoryMap(workspace, {
          maxChars: this.config.context?.repo_map_max_chars,
          maxFiles: this.config.context?.repo_map_max_files,
        }).text;
    const systemPrompt = this.config.agent.system_prompt
      ? `${this.config.agent.system_prompt}\n\n${RUNTIME_SWITCHING_PROMPT}`
      : assembleSystemPrompt({
          runtimeGuidance: RUNTIME_SWITCHING_PROMPT,
          projectInstructions: discoverProjectInstructions(workspace),
          repositoryMap,
          skills: renderSkillsBlock(discoverSkills(workspace)),
          handoff: readHandoff(workspace),
        });
    this.messages.push({ role: "system", content: systemPrompt });
  }

  setModel(model: string): string {
    if (model.trim().toLowerCase() === "auto") {
      this.setAutoRoute(true);
      return this.client.getModel();
    }
    applyModelOverride(this.config, model);
    const resolvedModel = this.config.llm.model;
    this.client.setModel(resolvedModel);
    this.client.setThinking(this.config.llm.thinking, this.config.llm.reasoning_effort);
    return resolvedModel;
  }

  setThinking(thinking: string, reasoningEffort?: string): { mode: string; effort: string } {
    applyThinkingOverride(this.config, thinking);
    if (reasoningEffort) {
      this.config.llm.reasoning_effort = normalizeReasoningEffort(reasoningEffort);
    }
    this.client.setThinking(this.config.llm.thinking, this.config.llm.reasoning_effort);
    return this.client.getThinking();
  }

  getRuntime() {
    return {
      model: this.client.getModel(),
      thinking: this.client.getThinking().mode,
      reasoning_effort: this.client.getThinking().effort,
      routing: this.autoRoute ? "auto" : "fixed",
      ...(this.lastRoute ? { last_route: this.lastRoute } : {}),
    };
  }


  setSystemSuffix(suffix: string): void {
    const sys = this.messages[0];
    if (!sys || sys.role !== "system") return;
    const marker = "\n\n[MODE:";
    const base = sys.content ? (sys.content as string).split(marker)[0] : "";
    sys.content = suffix ? base + "\n\n[MODE: " + suffix + "]" : base;
  }
  getMessages(): Message[] {
    return this.messages;
  }

  getLastUserMessage(): string | null {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message.role === "user" && message.content) {
        return typeof message.content === "string"
          ? message.content
          : message.content.map((b) => (b.type === "text" ? b.text : "[image]")).join(" ");
      }
    }
    return null;
  }

  restoreMessages(messages: Message[]) {
    this.messages = messages;
  }

  /**
   * Generate a session handoff relay from the current conversation, WITHOUT
   * mutating the conversation. Returns markdown suitable for handoff.md.
   */
  async generateHandoff(): Promise<string> {
    const transcript = this.messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const calls = m.tool_calls?.map((t) => t.function.name).join(",");
        const body = typeof m.content === "string" ? m.content.slice(0, 1200) : "";
        return `[${m.role}${calls ? ` calls=${calls}` : ""}] ${body}`;
      })
      .join("\n")
      .slice(-16000);
    const prompt =
      "Write a concise session handoff relay in markdown with these sections: " +
      "## Open Issues, ## In-Flight Changes, ## Next Steps, ## Key Decisions. " +
      "Base it strictly on the transcript below. Be specific (file paths, choices). " +
      "Output only the markdown.\n\n" +
      transcript;
    const result = await this.client.complete({
      messages: [
        { role: "system", content: "You write succinct, factual engineering handoffs." },
        { role: "user", content: prompt },
      ],
    });
    return (result.content ?? "").trim() || "## Open Issues\n(none recorded)\n";
  }

  /**
   * Heuristic compaction (no API call): pin recent tail + errors/patches/working
   * set, fold the rest into a concise extractive summary. Tool-call pairs kept.
   */
  compactContext(keepRecent = 12): string {
    if (this.messages.length <= Math.max(keepRecent, 6) + 1) {
      return "Context is already compact.";
    }
    const plan = planCompaction(this.messages);
    if (!shouldCompact(plan)) {
      return "Context is already compact.";
    }
    const summaryBody = summarizeMessages(plan.summarize.map((i) => this.messages[i]));
    this.messages = this.assembleCompacted(plan, `Conversation summary before compaction:\n${summaryBody}`);
    return `Compacted ${plan.summarize.length} messages; pinned ${plan.pinned.length}.`;
  }

  /**
   * Model-driven compaction: same plan, but the folded messages are summarized
   * by a real LLM call for higher fidelity. Falls back to heuristic on error.
   */
  async compactWithSummary(): Promise<string> {
    const plan = planCompaction(this.messages);
    if (!shouldCompact(plan)) return "Context is already compact.";
    const largeContext = /1m|1000k|pro/i.test(this.client.getModel());
    const input = buildSummaryInput(this.messages, plan.summarize, largeContext);
    let summary: string;
    try {
      const result = await this.client.complete({
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
      });
      summary = (result.content ?? "").trim() || summarizeMessages(plan.summarize.map((i) => this.messages[i]));
    } catch {
      summary = summarizeMessages(plan.summarize.map((i) => this.messages[i]));
    }
    this.messages = this.assembleCompacted(plan, `## Compaction Relay\n${summary}`);
    return `Compacted ${plan.summarize.length} messages via model summary; pinned ${plan.pinned.length}.`;
  }

  /** Rebuild the message list: system prompt, summary block, then pinned messages in order. */
  private assembleCompacted(plan: CompactionPlan, summaryContent: string): Message[] {
    const out: Message[] = [];
    const pinnedSet = new Set(plan.pinned);
    // Leading system prompt (index 0) stays first if present.
    let startPinned = 0;
    if (this.messages[0]?.role === "system" && pinnedSet.has(0)) {
      out.push(this.messages[0]);
      startPinned = 1;
    }
    out.push({ role: "system", content: summaryContent });

    // First pass: which tool_call ids have BOTH a pinned assistant call and a
    // pinned tool result? Only those pairs survive intact.
    const pinnedCallIds = new Set<string>();
    const pinnedResultIds = new Set<string>();
    for (let i = startPinned; i < this.messages.length; i++) {
      if (!pinnedSet.has(i)) continue;
      const m = this.messages[i];
      if (m.tool_calls?.length) for (const tc of m.tool_calls) pinnedCallIds.add(tc.id);
      if (m.role === "tool" && m.tool_call_id) pinnedResultIds.add(m.tool_call_id);
    }

    for (let i = startPinned; i < this.messages.length; i++) {
      if (!pinnedSet.has(i)) continue;
      const m = this.messages[i];

      // Drop an orphan tool result whose assistant call won't be kept — a tool
      // message with no preceding call is rejected by the provider.
      if (m.role === "tool") {
        if (!m.tool_call_id || !pinnedCallIds.has(m.tool_call_id)) continue;
        out.push(m);
        continue;
      }

      // Strip dangling tool_calls whose result is not kept, so the provider never
      // sees an assistant tool_calls message without its matching result.
      if (m.role === "assistant" && m.tool_calls?.length) {
        const live = m.tool_calls.filter((tc) => pinnedResultIds.has(tc.id));
        if (live.length !== m.tool_calls.length) {
          out.push({ ...m, tool_calls: live.length ? live : undefined });
          continue;
        }
      }
      out.push(m);
    }
    return out;
  }

  /** Enable/disable per-turn auto routing of model + thinking effort. */
  setAutoRoute(on: boolean): void {
    this.autoRoute = on;
    if (!on) this.lastRoute = undefined;
  }
  isAutoRoute(): boolean {
    return this.autoRoute;
  }
  lastRouteReason(): string | undefined {
    return this.lastRoute;
  }

  async run(userMessage: string, events: AgentEvents = {}, images: ImageAttachment[] = []): Promise<string> {
    // Attach images as OpenAI-compatible content blocks when present.
    if (images.length > 0) {
      const blocks: ContentBlock[] = [{ type: "text", text: userMessage }];
      for (const img of images) {
        blocks.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
      }
      this.messages.push({ role: "user", content: blocks });
    } else {
      this.messages.push({ role: "user", content: userMessage });
    }
    if (this.autoRoute) {
      const decision = route({ lastUserMessage: userMessage });
      this.setModel(decision.model);
      this.setThinking(decision.thinking === "enabled" ? "enabled" : "disabled", decision.reasoning_effort);
      this.lastRoute = `${decision.effort} (${decision.model}/${decision.thinking}; ${decision.reason})`;
      events.onRoute?.(this.lastRoute);
    }
    return this.complete(events);
  }

  async retryLast(events: AgentEvents = {}): Promise<string> {
    const lastUser = this.getLastUserMessage();
    if (!lastUser) throw new Error("No previous user message to retry.");
    while (this.messages.length > 0 && this.messages[this.messages.length - 1].role !== "user") {
      this.messages.pop();
    }
    return this.complete(events);
  }

  private async complete(events: AgentEvents = {}): Promise<string> {

    const allTools = [...getToolDefs(), ...this.mcpManager.getToolDefs()];

    for (let i = 0; i < this.maxIterations; i++) {
      events.onThinking?.(i + 1);
      const result = await this.client.complete({
        messages: this.messages,
        tools: allTools.length > 0 ? allTools : undefined,
      });
      events.onUsage?.(this.client.getModel(), result.usage);

      if (result.tool_calls.length === 0) {
        const reply = result.content || "";
        this.messages.push({
          role: "assistant",
          content: reply,
          reasoning_content: result.reasoning_content,
        });
        return reply;
      }

      this.messages.push({
        role: "assistant",
        content: result.content || "",
        reasoning_content: result.reasoning_content,
        tool_calls: result.tool_calls,
      });

      for (const tc of result.tool_calls) {
        const toolResult = await this.executeTool(tc, events);
        this.messages.push({
          role: "tool",
          content: toolResult,
          tool_call_id: tc.id,
        });
      }
    }

    return "[max iterations reached]";
  }

  private async executeTool(tc: ToolCall, events: AgentEvents): Promise<string> {
    const name = tc.function.name;
    let args: Record<string, any>;
    try {
      args = JSON.parse(tc.function.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return "Error: tool arguments must be a JSON object";
      }
    } catch {
      return "Error: invalid JSON arguments";
    }

    const startedAt = Date.now();
    events.onToolStart?.(name, args);

    try {
      const mcpResult = await this.mcpManager.callTool(name, args);
      if (mcpResult) {
        events.onToolEnd?.(name, Date.now() - startedAt, Boolean(mcpResult.error));
        return mcpResult.output;
      }

      const tool = getTool(name);
      if (!tool) {
        events.onToolEnd?.(name, Date.now() - startedAt, true);
        return `Unknown tool: ${name}`;
      }

      const result = await tool.handler(args);
      events.onToolEnd?.(name, Date.now() - startedAt, Boolean(result.error));
      return result.output;
    } catch (error) {
      events.onToolEnd?.(name, Date.now() - startedAt, true);
      return `Tool ${name} failed: ${safeErrorMessage(error)}`;
    }
  }

  private registerRuntimeTool() {
    registerTool(
      "configure_deepseek_runtime",
      "Switch the DeepSeek model and thinking mode for subsequent calls. Use this before harder reasoning tasks or switch back to flash/chat for routine work.",
      {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Model or alias: auto, pro, flash, chat, reasoner, or a full DeepSeek model name",
          },
          thinking: {
            type: "string",
            enum: ["auto", "enabled", "disabled", "high", "max"],
            description: "Thinking mode. high/max enable thinking and set reasoning effort.",
          },
          reasoning_effort: {
            type: "string",
            enum: ["high", "max"],
            description: "Reasoning effort when thinking is enabled.",
          },
        },
      },
      async ({ model, thinking, reasoning_effort }) => {
        try {
          if (typeof model === "string" && model.trim()) {
            this.setModel(model);
          }
          if (typeof thinking === "string" && thinking.trim()) {
            this.setThinking(thinking, typeof reasoning_effort === "string" ? reasoning_effort : undefined);
          } else if (typeof reasoning_effort === "string" && reasoning_effort.trim()) {
            this.config.llm.reasoning_effort = normalizeReasoningEffort(reasoning_effort);
            this.client.setThinking(this.config.llm.thinking, this.config.llm.reasoning_effort);
          }
          return { output: JSON.stringify(this.getRuntime()) };
        } catch (err: any) {
          return { output: `Error: ${safeErrorMessage(err)}`, error: true };
        }
      }
    );
  }
}

const RUNTIME_SWITCHING_PROMPT = `Runtime switching:
- You may call configure_deepseek_runtime to switch between auto/pro/flash/chat/reasoner and thinking modes.
- Use flash or chat for routine text, search, and simple file tasks.
- Use pro or enabled thinking for complex debugging, architecture review, or multi-step reasoning.
- The official V4 matrix supports both pro and flash with thinking enabled or disabled.
- Switch only when it materially improves quality or cost; otherwise keep the current runtime.`;

function summarizeMessages(messages: Message[]): string {
  return messages
    .map((message, index) => {
      const content = message.content || "";
      const toolCalls = message.tool_calls?.map((call) => call.function.name).join(", ");
      const suffix = toolCalls ? ` tool_calls=[${toolCalls}]` : "";
      return `${index + 1}. ${message.role}${suffix}: ${content.slice(0, 500)}`;
    })
    .join("\n");
}

export interface AgentEvents {
  onThinking?: (iteration: number) => void;
  onToolStart?: (name: string, args: Record<string, any>) => void;
  onToolEnd?: (name: string, elapsedMs: number, error: boolean) => void;
  onUsage?: (model: string, usage: Usage) => void;
  onRoute?: (decision: string) => void;
}

export interface ImageAttachment {
  path: string;
  base64: string;
  mimeType: string;
}
