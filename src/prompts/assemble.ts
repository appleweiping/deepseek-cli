/**
 * prompts/assemble.ts — system-prompt composition with prefix-cache discipline.
 *
 * The prompt is assembled most-static -> most-volatile so DeepSeek's prefix
 * cache hits the longest stable prefix:
 *   1. Constitution (base.md)        — compile-time constant
 *   2. Runtime-switching guidance     — constant
 *   3. Project instructions           — workspace-static (<instructions> blocks)
 *   4. Repository map                 — workspace-static, bounded orientation
 *   5. User memory block              — session-stable
 *   6. Handoff relay                  — volatile (rewritten on /handoff and /compact)
 * The latest user message + tool results are appended by the agent loop after
 * this prompt, so they never bust the cached prefix.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { assertWritablePath, isInsidePath } from "../safety/sandbox.js";

let cachedBase: string | null = null;

/** Load the packaged Constitution (prompts/base.md). Cached after first read. */
export function loadConstitution(): string {
  if (cachedBase != null) return cachedBase;
  const candidates = constitutionCandidates();
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        cachedBase = readFileSync(p, "utf-8");
        return cachedBase;
      }
    } catch {
      // try next
    }
  }
  cachedBase = FALLBACK_CONSTITUTION;
  return cachedBase;
}

function constitutionCandidates(): string[] {
  // dist/index.js -> packageRoot is one level up; prompts/ sits at package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "..", "prompts", "base.md"), // from dist/ or src/prompts/
    join(here, "..", "..", "prompts", "base.md"),
    join(here, "prompts", "base.md"),
  ];
}

export interface PromptZones {
  runtimeGuidance?: string;
  projectInstructions?: { source: string; content: string }[];
  repositoryMap?: string;
  skills?: string;
  memory?: string;
  handoff?: string;
  modeSuffix?: string;
}

/** Assemble the full system prompt from static -> volatile zones. */
export function assembleSystemPrompt(zones: PromptZones): string {
  const parts: string[] = [loadConstitution()];

  if (zones.runtimeGuidance?.trim()) {
    parts.push(zones.runtimeGuidance.trim());
  }

  for (const inst of zones.projectInstructions ?? []) {
    const body = inst.content.slice(0, 100_000); // guard against pathological files
    parts.push(`<instructions source="${escapeAttr(inst.source)}">\n${body}\n</instructions>`);
  }

  if (zones.repositoryMap?.trim()) {
    parts.push(zones.repositoryMap.trim());
  }

  // Skills catalog (workspace-static): progressive disclosure, before memory.
  if (zones.skills?.trim()) {
    parts.push(zones.skills.trim());
  }

  if (zones.memory?.trim()) {
    parts.push(`## User Memory\n${zones.memory.trim()}`);
  }

  // Volatile last: handoff relay.
  if (zones.handoff?.trim()) {
    parts.push(
      `## Previous Session Relay\nThe previous session left this relay. Treat it as the first thing to read this turn; it is precedent (Tier 8), subordinate to live evidence.\n\n${zones.handoff.trim()}`,
    );
  }

  if (zones.modeSuffix?.trim()) {
    parts.push(`[MODE: ${zones.modeSuffix.trim()}]`);
  }

  return parts.join("\n\n");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, " ").slice(0, 200);
}

// ── Handoff relay file ────────────────────────────────────────────────────────

/** Path to the per-workspace handoff relay. */
export function handoffPath(workspace: string): string {
  return join(workspace, ".weiping-whale", "handoff.md");
}

export function readHandoff(workspace: string): string | undefined {
  const p = handoffPath(workspace);
  try {
    if (safeWorkspaceFile(p, workspace)) {
      const text = readFileSync(p, "utf-8").trim();
      return text || undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function writeHandoff(workspace: string, content: string): string {
  const p = handoffPath(workspace);
  assertWritablePath(p, workspace);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content.trim() + "\n", "utf-8");
  return p;
}

/** Discover project instruction files in the workspace (Local Law, Tier 4). */
export function discoverProjectInstructions(workspace: string): { source: string; content: string }[] {
  const names = [
    join(workspace, ".weiping-whale", "instructions.md"),
    join(workspace, "AGENTS.md"),
    join(workspace, "CLAUDE.md"),
  ];
  const out: { source: string; content: string }[] = [];
  for (const p of names) {
    try {
      if (existsSync(p)) {
        if (!safeWorkspaceFile(p, workspace)) continue;
        const content = readFileSync(p, "utf-8").trim();
        if (content) out.push({ source: relativeName(workspace, p), content });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function safeWorkspaceFile(path: string, workspace: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return isInsidePath(realpathSync(path), realpathSync(workspace));
  } catch {
    return false;
  }
}

function relativeName(workspace: string, p: string): string {
  return p.startsWith(workspace) ? p.slice(workspace.length).replace(/^[\\/]/, "") : p;
}

const FALLBACK_CONSTITUTION = `You are WEIPING_WHALE, a terminal-native coding agent.
Act, do not merely describe acting. Never fabricate file contents or command
output; report failures honestly. The user's current message outranks all but
truth and safety. Use your tools to gather evidence before answering, and verify
edits after making them. Mirror the user's language. Prefer prose and short lists
over tables; reference files as path:line.`;

/** Test-only: clear the cached base prompt. */
export function _resetConstitutionCache(): void {
  cachedBase = null;
}
