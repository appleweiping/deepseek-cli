import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import TOML from "@iarna/toml";
import { endpointConfigured, endpointHost, safeErrorMessage } from "./runtime/safe-text.js";

export interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeout_ms?: number;
  include_tools?: string[];
  exclude_tools?: string[];
}

export interface Config {
  config_path?: string;
  config_scope?: "explicit" | "workspace" | "user" | "packaged";
  workspace_config_ignored?: string;
  llm: {
    model: string;
    api_key: string;
    api_key_env?: string;
    api_key_source: string;
    base_url: string;
    temperature: number;
    max_tokens: number;
    request_timeout_ms: number;
    thinking: ThinkingMode;
    reasoning_effort: ReasoningEffort;
  };
  agent: {
    max_iterations: number;
    workspace: string;
    system_prompt: string;
  };
  snapshots?: {
    enabled?: boolean;
    retention_days?: number;
  };
  pricing?: Record<string, { cache_hit_usd?: number; cache_miss_usd?: number; output_usd?: number }>;
  subagents?: {
    max_agents?: number;
    max_depth?: number;
  };
  lsp?: {
    enabled?: boolean;
    include_warnings?: boolean;
    poll_after_edit_ms?: number;
    max_per_file?: number;
  };
  context?: {
    repo_map_enabled?: boolean;
    repo_map_max_chars?: number;
    repo_map_max_files?: number;
  };
  mcp_servers: Record<string, MCPServerConfig>;
}

export type ThinkingMode = "auto" | "enabled" | "disabled";
export type ReasoningEffort = "high" | "max";

export interface RuntimeOverrides {
  model?: string;
  thinking?: string;
  reasoning_effort?: string;
}

export interface ModelPreset {
  name: string;
  model: string;
  thinking: ThinkingMode;
  description: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    name: "pro",
    model: "deepseek-v4-pro",
    thinking: "auto",
    description: "Highest-quality V4 model; best for complex coding, architecture, and debugging.",
  },
  {
    name: "pro-thinking",
    model: "deepseek-v4-pro",
    thinking: "enabled",
    description: "Pro with thinking explicitly enabled.",
  },
  {
    name: "pro-non-thinking",
    model: "deepseek-v4-pro",
    thinking: "disabled",
    description: "Pro with thinking explicitly disabled for lower latency.",
  },
  {
    name: "flash",
    model: "deepseek-v4-flash",
    thinking: "auto",
    description: "Fast, economical V4 model; good default for routine agent work.",
  },
  {
    name: "flash-thinking",
    model: "deepseek-v4-flash",
    thinking: "enabled",
    description: "Flash with thinking explicitly enabled.",
  },
  {
    name: "flash-non-thinking",
    model: "deepseek-v4-flash",
    thinking: "disabled",
    description: "Flash with thinking disabled; equivalent to the legacy deepseek-chat path.",
  },
];

const MODEL_ALIASES: Record<string, ModelOverride> = {
  pro: { model: "deepseek-v4-pro" },
  "v4-pro": { model: "deepseek-v4-pro" },
  flash: { model: "deepseek-v4-flash" },
  "v4-flash": { model: "deepseek-v4-flash" },
  chat: { model: "deepseek-v4-flash", thinking: "disabled" },
  reasoner: { model: "deepseek-v4-flash", thinking: "enabled" },
  "deepseek-chat": { model: "deepseek-v4-flash", thinking: "disabled" },
  "deepseek-reasoner": { model: "deepseek-v4-flash", thinking: "enabled" },
  "pro-thinking": { model: "deepseek-v4-pro", thinking: "enabled" },
  "pro-think": { model: "deepseek-v4-pro", thinking: "enabled" },
  "pro-non-thinking": { model: "deepseek-v4-pro", thinking: "disabled" },
  "pro-no-thinking": { model: "deepseek-v4-pro", thinking: "disabled" },
  "flash-thinking": { model: "deepseek-v4-flash", thinking: "enabled" },
  "flash-think": { model: "deepseek-v4-flash", thinking: "enabled" },
  "flash-non-thinking": { model: "deepseek-v4-flash", thinking: "disabled" },
  "flash-no-thinking": { model: "deepseek-v4-flash", thinking: "disabled" },
};

interface ModelOverride {
  model: string;
  thinking?: ThinkingMode;
}

const DEFAULT_CONFIG: Config = {
  config_path: undefined,
  llm: {
    model: "deepseek-v4-flash",
    api_key: "",
    api_key_env: "DEEPSEEK_API_KEY",
    api_key_source: "missing",
    base_url: "https://api.deepseek.com",
    temperature: 0.3,
    max_tokens: 4096,
    request_timeout_ms: 120000,
    thinking: "enabled",
    reasoning_effort: "high",
  },
  agent: {
    max_iterations: 50,
    workspace: ".",
    system_prompt: "",
  },
  snapshots: {
    enabled: true,
    retention_days: 7,
  },
  subagents: {
    max_agents: 4,
    max_depth: 2,
  },
  lsp: {
    enabled: true,
    include_warnings: false,
    poll_after_edit_ms: 2500,
    max_per_file: 20,
  },
  context: {
    repo_map_enabled: true,
    repo_map_max_chars: 12000,
    repo_map_max_files: 400,
  },
  mcp_servers: {},
};

export interface ConfigLoadOptions {
  /** Load cwd-local *.toml. False by default because it may redirect API keys or spawn MCP servers. */
  allowWorkspaceConfig?: boolean;
}

export function loadConfig(options: ConfigLoadOptions = {}): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  const explicitPaths = [process.env.WEIPING_WHALE_CONFIG, process.env.DEEPSEEK_CONFIG];
  const workspacePaths = [
    join(process.cwd(), "weiping-whale.toml"),
    join(process.cwd(), ".weiping-whale.toml"),
    join(process.cwd(), "deepseek-cli.toml"),
    join(process.cwd(), ".deepseek-cli.toml"),
  ];
  const userPaths = [
    join(homedir(), ".weiping-whale", "config.toml"),
    join(homedir(), ".deepseek-cli", "config.toml"),
  ];
  if (!options.allowWorkspaceConfig) {
    config.workspace_config_ignored = workspacePaths.find((path) => existsSync(path));
  }
  const configPaths: Array<{ path?: string; scope: NonNullable<Config["config_scope"]> }> = [
    ...explicitPaths.map((path) => ({ path, scope: "explicit" as const })),
    ...(options.allowWorkspaceConfig ? workspacePaths.map((path) => ({ path, scope: "workspace" as const })) : []),
    ...userPaths.map((path) => ({ path, scope: "user" as const })),
    { path: join(packageRoot, "config.toml"), scope: "packaged" },
  ];

  for (const candidate of configPaths) {
    const p = candidate.path;
    if (p && existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = TOML.parse(raw) as any;
        mergeConfig(config, parsed);
        assertConfigShape(config);
      } catch (error) {
        throw new Error(`Invalid config ${p}: ${safeErrorMessage(error)}`);
      }
      config.config_path = p;
      config.config_scope = candidate.scope;
      if (config.llm.api_key) config.llm.api_key_source = "config";
      break;
    }
  }

  applyModelOverride(config, config.llm.model);
  config.llm.thinking = normalizeThinkingMode(String(config.llm.thinking));
  config.llm.reasoning_effort = normalizeReasoningEffort(String(config.llm.reasoning_effort));

  // Environment variable overrides
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) {
    config.llm.api_key = envKey;
    config.llm.api_key_source = "env:DEEPSEEK_API_KEY";
  }

  const envModel = process.env.DEEPSEEK_MODEL;
  if (envModel) applyModelOverride(config, envModel);

  const envThinking = process.env.DEEPSEEK_THINKING;
  if (envThinking) applyThinkingOverride(config, envThinking);

  const envReasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT;
  if (envReasoningEffort) config.llm.reasoning_effort = normalizeReasoningEffort(envReasoningEffort);

  const envBase = process.env.DEEPSEEK_BASE_URL;
  if (envBase) config.llm.base_url = envBase;

  const envTimeout = process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
  if (envTimeout) config.llm.request_timeout_ms = normalizeRequestTimeout(envTimeout);

  // Resolve api_key_env indirection
  if (!config.llm.api_key && config.llm.api_key_env) {
    config.llm.api_key = process.env[config.llm.api_key_env] || "";
    config.llm.api_key_source = config.llm.api_key ? `env:${config.llm.api_key_env}` : "missing";
  }

  return config;
}

function normalizeRequestTimeout(input: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 1000) {
    throw new Error(`Invalid request timeout: ${input}. Use milliseconds >= 1000.`);
  }
  return Math.floor(value);
}

export function applyRuntimeOverrides(config: Config, overrides: RuntimeOverrides): Config {
  if (overrides.model) applyModelOverride(config, overrides.model);
  if (overrides.thinking) applyThinkingOverride(config, overrides.thinking);
  if (overrides.reasoning_effort) {
    config.llm.reasoning_effort = normalizeReasoningEffort(overrides.reasoning_effort);
  }
  return config;
}

export function normalizeModelName(input: string): string {
  return resolveModelOverride(input).model;
}

export function applyModelOverride(config: Config, input: string): Config {
  const override = resolveModelOverride(input);
  config.llm.model = override.model;
  if (override.thinking) config.llm.thinking = override.thinking;
  return config;
}

function resolveModelOverride(input: string): ModelOverride {
  const normalized = input.trim().toLowerCase();
  return MODEL_ALIASES[normalized] ?? { model: input.trim() };
}

export function normalizeThinkingMode(input: string): ThinkingMode {
  const normalized = input.trim().toLowerCase();
  if (["auto", "default"].includes(normalized)) return "enabled";
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalized)) return "enabled";
  if (["off", "false", "no", "0", "disable", "disabled"].includes(normalized)) return "disabled";
  if (["high", "max", "low", "medium", "xhigh"].includes(normalized)) return "enabled";
  throw new Error(`Invalid thinking mode: ${input}. Use auto, enabled, disabled, high, or max.`);
}

export function normalizeReasoningEffort(input: string): ReasoningEffort {
  const normalized = input.trim().toLowerCase();
  if (["high", "low", "medium"].includes(normalized)) return "high";
  if (["max", "xhigh"].includes(normalized)) return "max";
  throw new Error(`Invalid reasoning effort: ${input}. Use high or max.`);
}

export function applyThinkingOverride(config: Config, input: string): Config {
  const normalized = input.trim().toLowerCase();
  config.llm.thinking = normalizeThinkingMode(input);
  if (["high", "low", "medium", "max", "xhigh"].includes(normalized)) {
    config.llm.reasoning_effort = normalizeReasoningEffort(input);
  }
  return config;
}

export interface ConfigCheck {
  level: "ok" | "warn" | "error";
  code: string;
  message: string;
}

export function validateConfig(config: Config): ConfigCheck[] {
  const checks: ConfigCheck[] = [];
  const add = (level: ConfigCheck["level"], code: string, message: string) => checks.push({ level, code, message });

  add(config.llm.api_key ? "ok" : "error", "auth.api_key", config.llm.api_key ? "DeepSeek API key is configured" : "Set DEEPSEEK_API_KEY or llm.api_key_env");
  add(endpointConfigured(config.llm.base_url) && endpointHost(config.llm.base_url) !== "invalid-url" ? "ok" : "error", "llm.base_url", endpointHost(config.llm.base_url) === "invalid-url" ? "llm.base_url is not a valid URL" : "LLM endpoint is configured");
  add(config.llm.max_tokens > 0 ? "ok" : "error", "llm.max_tokens", config.llm.max_tokens > 0 ? "max_tokens is positive" : "max_tokens must be positive");
  add(config.llm.request_timeout_ms >= 1000 ? "ok" : "error", "llm.request_timeout_ms", config.llm.request_timeout_ms >= 1000 ? "request timeout is usable" : "request_timeout_ms must be >= 1000");
  add(config.agent.max_iterations >= 1 ? (config.agent.max_iterations <= 200 ? "ok" : "warn") : "error", "agent.max_iterations", config.agent.max_iterations < 1 ? "max_iterations must be at least 1" : config.agent.max_iterations <= 200 ? "max_iterations is bounded" : "max_iterations above 200 can cause long runaway sessions");

  if (config.llm.api_key_source === "config") {
    add("warn", "auth.api_key_in_config", "Prefer api_key_env over storing an API key directly in TOML");
  }
  try {
    const endpoint = new URL(config.llm.base_url);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
    if (endpoint.protocol === "http:" && !loopback) {
      add("warn", "llm.insecure_endpoint", "Non-loopback HTTP sends prompts and the API key without transport encryption");
    }
  } catch {
    // The normal base_url check above reports invalid URLs.
  }

  if (config.config_path && config.config_path.includes("\\_archive\\")) {
    add("warn", "config.packaged_archive", "Using the packaged fallback config from an archive checkout; install a user config for daily use");
  }
  if (config.workspace_config_ignored) {
    add("warn", "security.workspace_config_ignored", "Workspace-local config was ignored until this exact directory is explicitly trusted");
  }

  return checks;
}

function mergeConfig(target: any, source: any) {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`unsafe config key: ${key}`);
    }
    if (
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object"
    ) {
      mergeConfig(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

/** Runtime validation for TOML input; TypeScript types do not protect disk data. */
function assertConfigShape(value: unknown): asserts value is Config {
  const root = requireRecord(value, "config");
  const llm = requireRecord(root.llm, "llm");
  requireNonEmptyString(llm.model, "llm.model");
  requireString(llm.api_key, "llm.api_key");
  if (llm.api_key_env !== undefined) requireNonEmptyString(llm.api_key_env, "llm.api_key_env");
  requireNonEmptyString(llm.base_url, "llm.base_url");
  const endpoint = new URL(llm.base_url as string);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("llm.base_url must use http or https");
  }
  if (endpoint.username || endpoint.password) throw new Error("llm.base_url must not contain credentials");
  requireNumber(llm.temperature, "llm.temperature", { min: 0, max: 2 });
  requireInteger(llm.max_tokens, "llm.max_tokens", { min: 1, max: 10_000_000 });
  requireInteger(llm.request_timeout_ms, "llm.request_timeout_ms", { min: 1_000, max: 3_600_000 });
  requireString(llm.thinking, "llm.thinking");
  requireString(llm.reasoning_effort, "llm.reasoning_effort");

  const agent = requireRecord(root.agent, "agent");
  requireInteger(agent.max_iterations, "agent.max_iterations", { min: 1, max: 10_000 });
  requireString(agent.workspace, "agent.workspace");
  requireString(agent.system_prompt, "agent.system_prompt");

  validateOptionalSection(root.snapshots, "snapshots", (section) => {
    optionalBoolean(section.enabled, "snapshots.enabled");
    optionalInteger(section.retention_days, "snapshots.retention_days", { min: 0, max: 36_500 });
  });
  validateOptionalSection(root.subagents, "subagents", (section) => {
    optionalInteger(section.max_agents, "subagents.max_agents", { min: 0, max: 128 });
    optionalInteger(section.max_depth, "subagents.max_depth", { min: 0, max: 16 });
  });
  validateOptionalSection(root.lsp, "lsp", (section) => {
    optionalBoolean(section.enabled, "lsp.enabled");
    optionalBoolean(section.include_warnings, "lsp.include_warnings");
    optionalInteger(section.poll_after_edit_ms, "lsp.poll_after_edit_ms", { min: 0, max: 600_000 });
    optionalInteger(section.max_per_file, "lsp.max_per_file", { min: 1, max: 10_000 });
  });
  validateOptionalSection(root.context, "context", (section) => {
    optionalBoolean(section.repo_map_enabled, "context.repo_map_enabled");
    optionalInteger(section.repo_map_max_chars, "context.repo_map_max_chars", { min: 1_000, max: 100_000 });
    optionalInteger(section.repo_map_max_files, "context.repo_map_max_files", { min: 10, max: 5_000 });
  });

  if (root.pricing !== undefined) {
    const pricing = requireRecord(root.pricing, "pricing");
    for (const [model, raw] of Object.entries(pricing)) {
      const entry = requireRecord(raw, `pricing.${model}`);
      optionalNumber(entry.cache_hit_usd, `pricing.${model}.cache_hit_usd`, { min: 0 });
      optionalNumber(entry.cache_miss_usd, `pricing.${model}.cache_miss_usd`, { min: 0 });
      optionalNumber(entry.output_usd, `pricing.${model}.output_usd`, { min: 0 });
    }
  }

  const servers = requireRecord(root.mcp_servers, "mcp_servers");
  for (const [name, raw] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
      throw new Error(`mcp_servers.${name}: server name must use letters, digits, dot, underscore, or hyphen`);
    }
    const server = requireRecord(raw, `mcp_servers.${name}`);
    requireNonEmptyString(server.command, `mcp_servers.${name}.command`);
    if (server.args === undefined) server.args = [];
    if (server.env === undefined) server.env = {};
    requireStringArray(server.args, `mcp_servers.${name}.args`);
    const env = requireRecord(server.env, `mcp_servers.${name}.env`);
    for (const [key, envValue] of Object.entries(env)) {
      requireString(envValue, `mcp_servers.${name}.env.${key}`);
    }
    if (server.cwd !== undefined) requireNonEmptyString(server.cwd, `mcp_servers.${name}.cwd`);
    optionalInteger(server.timeout_ms, `mcp_servers.${name}.timeout_ms`, { min: 1_000, max: 3_600_000 });
    if (server.include_tools !== undefined) requireStringArray(server.include_tools, `mcp_servers.${name}.include_tools`);
    if (server.exclude_tools !== undefined) requireStringArray(server.exclude_tools, `mcp_servers.${name}.exclude_tools`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be a table`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
}

function requireNonEmptyString(value: unknown, path: string): asserts value is string {
  requireString(value, path);
  if (!value.trim()) throw new Error(`${path} must not be empty`);
}

function requireStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
}

function requireNumber(value: unknown, path: string, bounds: { min?: number; max?: number } = {}): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  if (bounds.min !== undefined && value < bounds.min) throw new Error(`${path} must be >= ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max) throw new Error(`${path} must be <= ${bounds.max}`);
}

function requireInteger(value: unknown, path: string, bounds: { min?: number; max?: number } = {}): asserts value is number {
  requireNumber(value, path, bounds);
  if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
}

function optionalNumber(value: unknown, path: string, bounds: { min?: number; max?: number } = {}): void {
  if (value !== undefined) requireNumber(value, path, bounds);
}

function optionalInteger(value: unknown, path: string, bounds: { min?: number; max?: number } = {}): void {
  if (value !== undefined) requireInteger(value, path, bounds);
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
}

function validateOptionalSection(value: unknown, path: string, validate: (section: Record<string, unknown>) => void): void {
  if (value !== undefined) validate(requireRecord(value, path));
}
