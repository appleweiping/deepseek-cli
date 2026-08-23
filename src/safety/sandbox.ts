import { existsSync, lstatSync, realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";

export type SandboxMode = "workspace-write" | "read-only" | "unrestricted";

export function getSandboxMode(): SandboxMode {
  const raw = (process.env.DEEPSEEK_SANDBOX_MODE || "workspace-write").toLowerCase();
  if (raw === "read-only" || raw === "unrestricted" || raw === "workspace-write") return raw;
  return "workspace-write";
}

export function setSandboxMode(mode: string): SandboxMode {
  const normalized = mode.trim().toLowerCase();
  if (normalized !== "workspace-write" && normalized !== "read-only" && normalized !== "unrestricted") {
    throw new Error("Sandbox mode must be workspace-write, read-only, or unrestricted");
  }
  process.env.DEEPSEEK_SANDBOX_MODE = normalized;
  return normalized;
}

export function assertWritablePath(path: string, workspace = process.cwd()): void {
  const mode = getSandboxMode();
  if (mode === "unrestricted") return;
  if (mode === "read-only") {
    throw new Error(`Write blocked by read-only sandbox: ${path}`);
  }
  const target = resolve(path);
  const root = resolve(workspace);
  if (!isInsidePath(target, root)) {
    throw new Error(`Write blocked outside workspace sandbox: ${target}`);
  }
  assertNoSymlinkEscape(target, root);
}

export function isInsidePath(targetPath: string, rootPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Lexical containment is not enough: `workspace/link/file` may traverse a
 * symlink or Windows junction whose target is outside the workspace. Reject
 * any linked path component and verify the closest existing ancestor against
 * the canonical workspace root before a write or patch is created/applied.
 */
function assertNoSymlinkEscape(target: string, root: string): void {
  const rootReal = safeRealpath(root);
  const relativeTarget = relative(root, target);
  const parts = relativeTarget ? relativeTarget.split(/[\\/]+/).filter(Boolean) : [];
  let cursor = root;

  for (const part of parts) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Write blocked through symbolic link or junction: ${cursor}`);
    }
  }

  let ancestor = existsSync(target) ? target : dirname(target);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const ancestorReal = safeRealpath(ancestor);
  if (!isInsidePath(ancestorReal, rootReal)) {
    throw new Error(`Write blocked through path resolving outside workspace: ${target}`);
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
