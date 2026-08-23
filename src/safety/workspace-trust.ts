/** Persisted trust decisions for workspace-local configuration files. */
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { stateRoot } from "../runtime/paths.js";

interface TrustStore {
  version: 1;
  trusted: string[];
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function workspaceTrustPath(): string {
  return resolve(stateRoot(), "trusted-workspaces.json");
}

/**
 * Session env override wins; otherwise require an exact canonical path in the
 * central trust store. Parent-directory trust is deliberately not inferred.
 */
export function isWorkspaceTrusted(workspace: string): boolean {
  const override = process.env.WEIPING_WHALE_TRUST_WORKSPACE?.trim().toLowerCase();
  if (TRUE_VALUES.has(override ?? "")) return true;
  if (FALSE_VALUES.has(override ?? "")) return false;
  const key = pathKey(canonicalWorkspace(workspace));
  return readTrustStore().trusted.some((item) => pathKey(item) === key);
}

export function trustWorkspace(workspace: string): string {
  const canonical = canonicalWorkspace(workspace);
  const store = readTrustStore();
  if (!store.trusted.some((item) => pathKey(item) === pathKey(canonical))) {
    store.trusted.push(canonical);
    store.trusted.sort((a, b) => a.localeCompare(b));
    writeTrustStore(store);
  }
  return canonical;
}

export function untrustWorkspace(workspace: string): boolean {
  const key = pathKey(canonicalWorkspace(workspace));
  const store = readTrustStore();
  const next = store.trusted.filter((item) => pathKey(item) !== key);
  if (next.length === store.trusted.length) return false;
  writeTrustStore({ version: 1, trusted: next });
  return true;
}

export function listTrustedWorkspaces(): string[] {
  return [...readTrustStore().trusted];
}

function readTrustStore(): TrustStore {
  const path = workspaceTrustPath();
  try {
    if (!existsSync(path)) return { version: 1, trusted: [] };
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { version: 1, trusted: [] };
    const trusted = (parsed as { trusted?: unknown }).trusted;
    if (!Array.isArray(trusted)) return { version: 1, trusted: [] };
    return {
      version: 1,
      trusted: trusted
        // Entries are canonicalized when the user grants trust. Do not
        // realpath them again here: if a trusted directory is later replaced
        // by a symlink/junction, re-canonicalizing the stored identity would
        // silently transfer trust to the link's new target.
        .filter((item): item is string => typeof item === "string" && item.length > 0 && isAbsolute(item))
        .map((item) => resolve(item))
        .slice(0, 10_000),
    };
  } catch {
    // Malformed or unreadable trust state fails closed.
    return { version: 1, trusted: [] };
  }
}

function writeTrustStore(store: TrustStore): void {
  const path = workspaceTrustPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { rmSync(temp, { force: true }); } catch {}
  }
}

function canonicalWorkspace(workspace: string): string {
  const absolute = resolve(workspace);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function pathKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
