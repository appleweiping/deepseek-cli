/**
 * snapshot/repo.ts — Side-git workspace checkpointing for WEIPING_WHALE.
 *
 * Ported from CodeWhale's snapshot subsystem (Rust). The key safety invariant:
 * snapshots live in a SEPARATE git repository under the state root, and every
 * git invocation passes BOTH `--git-dir` (the side repo) AND `--work-tree`
 * (the user's workspace). The user's own `.git` is therefore never touched.
 *
 * A snapshot is a full tree commit created via `git add -A` -> `git write-tree`
 * -> `git commit-tree` -> `git update-ref`, which bypasses hooks and is fast and
 * deterministic. Restore is `git checkout <sha> -- :/` plus deletion of files
 * that existed in the snapshot's parent state but not the target.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, lstatSync, realpathSync } from "fs";
import { join, resolve, dirname, sep, isAbsolute, normalize } from "path";
import { createHash } from "crypto";
import { snapshotsRoot } from "../runtime/paths.js";

export interface Snapshot {
  id: string; // git commit SHA
  label: string; // e.g. "pre-turn:42"
  timestamp: number; // unix seconds
}

export interface SnapshotInitResult {
  ok: boolean;
  reason?: string;
}

const DEFAULT_MAX_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_RETENTION_DAYS = 7;

/**
 * Stable per-workspace namespace key: SHA-256 of the canonical workspace path.
 * SHA-256 (not FNV) avoids collisions for non-ASCII paths, which matters because
 * a collision would make two workspaces share one snapshot repo.
 */
export function workspaceKey(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 32);
}

/** Built-in exclude patterns written to the side repo's info/exclude. */
const BUILTIN_EXCLUDES = [
  // Never snapshot a real git dir into the side repo.
  ".git/",
  // Node
  "node_modules/", ".npm/", ".pnpm-store/", ".yarn/", ".bun/",
  // Rust
  "target/", ".cargo/", "vendor/",
  // Python
  "__pycache__/", ".venv/", "venv/", ".mypy_cache/", ".pytest_cache/", ".ruff_cache/",
  // Build / binary artifacts
  "*.exe", "*.dll", "*.o", "*.class", "*.wasm", "*.so", "*.dylib",
  // Media
  "*.mp4", "*.mov", "*.mp3", "*.wav", "*.avi", "*.mkv",
  // VCS / misc
  ".DS_Store",
];

/** Tree paths we refuse to delete during restore, regardless of tree contents. */
function isUnsafeTreePath(p: string): boolean {
  if (!p) return true;
  // Reject absolute, drive-qualified, UNC, and traversal forms.
  if (isAbsolute(p)) return true;
  if (/^[a-zA-Z]:/.test(p)) return true; // C:...
  if (p.startsWith("\\\\") || p.startsWith("//")) return true; // UNC
  const norm = normalize(p).replace(/\\/g, "/");
  if (norm.startsWith("../") || norm === ".." || norm.includes("/../")) return true;
  // Never touch a .git or state dir entry.
  const first = norm.split("/")[0];
  if (first === ".git" || first === ".weiping-whale") return true;
  return false;
}

export class SnapshotRepo {
  readonly workspace: string;
  readonly gitDir: string;
  private repoRoot: string;
  private available = false;
  private disabledReason?: string;
  private maxWorkspaceBytes: number;
  private retentionDays: number;

  constructor(workspace: string, opts: { maxWorkspaceBytes?: number; retentionDays?: number } = {}) {
    this.workspace = resolve(workspace);
    this.maxWorkspaceBytes = opts.maxWorkspaceBytes ?? DEFAULT_MAX_WORKSPACE_BYTES;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const key = workspaceKey(this.workspace);
    this.repoRoot = join(snapshotsRoot(), key);
    this.gitDir = join(this.repoRoot, ".git");
  }

  /** Path to the workspace-identity marker that guards against hash collisions. */
  private markerPath(): string {
    return join(this.repoRoot, "workspace.txt");
  }

  /** Verify (or create) the marker; returns false if it belongs to another workspace. */
  private verifyMarker(): boolean {
    const p = this.markerPath();
    try {
      if (existsSync(p)) {
        const recorded = readFileSync(p, "utf-8").trim();
        return recorded === this.workspace;
      }
      mkdirSync(this.repoRoot, { recursive: true });
      writeFileSync(p, this.workspace + "\n", "utf-8");
      return true;
    } catch {
      return true; // marker is best-effort; don't block snapshots on FS hiccups
    }
  }

  /**
   * Acquire a coarse interprocess lock for mutating ops (snapshot/restore/prune)
   * so concurrent sessions in the same workspace cannot interleave git index /
   * HEAD / checkout / delete steps. Uses atomic mkdir; stale locks (>60s) are
   * reclaimed. Returns a release function, or null if the lock could not be taken.
   */
  private acquireLock(timeoutMs = 5000): (() => void) | null {
    const lockDir = join(this.repoRoot, ".ww-lock");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        mkdirSync(lockDir); // throws if it exists -> held by someone else
        return () => {
          try {
            rmSync(lockDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        };
      } catch {
        // Reclaim a stale lock.
        try {
          const age = Date.now() - statSync(lockDir).mtimeMs;
          if (age > 60000) {
            rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // lock vanished; retry
        }
        if (Date.now() > deadline) return null;
        // brief spin
        const until = Date.now() + 50;
        while (Date.now() < until) { /* busy-wait briefly */ }
      }
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  reason(): string | undefined {
    return this.disabledReason;
  }

  /** Raw git invocation against the side repo + user workspace. Never throws. */
  private git(args: string[], timeoutMs = 60000, envOverride?: Record<string, string>): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "--work-tree", this.workspace, ...args],
      {
        cwd: this.workspace,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: envOverride ? { ...process.env, ...envOverride } : process.env,
      },
    );
    return {
      code: result.status ?? (result.error ? -1 : 0),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error?.message ?? ""),
    };
  }

  /** Initialize the side repo. Returns ok=false (non-fatal) if git missing or workspace too large. */
  init(): SnapshotInitResult {
    // git present?
    const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
    if ((probe.status ?? -1) !== 0) {
      this.disabledReason = "git not found on PATH";
      return { ok: false, reason: this.disabledReason };
    }

    // Guard against hash collision: the repo dir must belong to this workspace.
    if (!this.verifyMarker()) {
      this.disabledReason = "snapshot repo belongs to a different workspace (hash collision guard)";
      return { ok: false, reason: this.disabledReason };
    }

    const fresh = !existsSync(this.gitDir);
    if (fresh) {
      // Size guard before first init.
      const size = estimateWorkspaceSize(this.workspace, this.maxWorkspaceBytes);
      if (size > this.maxWorkspaceBytes) {
        this.disabledReason = `workspace exceeds snapshot size cap (${(size / 1e9).toFixed(1)} GB > ${(this.maxWorkspaceBytes / 1e9).toFixed(1)} GB)`;
        return { ok: false, reason: this.disabledReason };
      }
      mkdirSync(this.gitDir, { recursive: true });
      const initRes = this.git(["init", "-q"]);
      if (initRes.code !== 0) {
        this.disabledReason = `git init failed: ${initRes.stderr.trim()}`;
        return { ok: false, reason: this.disabledReason };
      }
      // Config: no autocrlf (byte fidelity), no auto-gc mid-turn, quiet identity.
      this.git(["config", "core.autocrlf", "false"]);
      this.git(["config", "gc.auto", "0"]);
      this.git(["config", "user.email", "snapshots@weiping-whale.local"]);
      this.git(["config", "user.name", "weiping-whale-snapshots"]);
      this.git(["config", "commit.gpgsign", "false"]);
    }

    // (Re)write the exclude file every init — cheap and keeps it current.
    try {
      const infoDir = join(this.gitDir, "info");
      mkdirSync(infoDir, { recursive: true });
      writeFileSync(join(infoDir, "exclude"), BUILTIN_EXCLUDES.join("\n") + "\n", "utf-8");
    } catch {
      // non-fatal
    }

    this.available = true;
    if (!fresh) this.pruneOlderThanDays(this.retentionDays);
    return { ok: true };
  }

  /**
   * Take a snapshot of the current workspace state. Returns the new commit SHA,
   * or null if snapshots are unavailable or the operation failed (non-fatal).
   */
  snapshot(label: string): string | null {
    if (!this.available) return null;
    const release = this.acquireLock();
    if (!release) return null;
    try {
      const add = this.git(["add", "-A"]);
      if (add.code !== 0) return null;

      const writeTree = this.git(["write-tree"]);
      if (writeTree.code !== 0) return null;
      const tree = writeTree.stdout.trim();
      if (!tree) return null;

      // Parent = current HEAD if any.
      const head = this.git(["rev-parse", "--verify", "-q", "HEAD"]);
      const parent = head.code === 0 ? head.stdout.trim() : "";

      const commitArgs = ["commit-tree", tree, "-m", label];
      if (parent) commitArgs.push("-p", parent);
      const commit = this.git(commitArgs);
      if (commit.code !== 0) return null;
      const sha = commit.stdout.trim();
      if (!sha) return null;

      const update = this.git(["update-ref", "HEAD", sha]);
      if (update.code !== 0) return null;

      return sha;
    } finally {
      release();
    }
  }

  /** List snapshots newest-first, parsed from the side repo's git log. */
  list(limit = 50): Snapshot[] {
    if (!this.available) return [];
    const log = this.git(["log", "--pretty=format:%H%x09%at%x09%s", `-n`, String(limit)]);
    if (log.code !== 0) return [];
    const out: Snapshot[] = [];
    for (const line of log.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [id, at, ...rest] = line.split("\t");
      if (!id) continue;
      out.push({ id, timestamp: Number(at) || 0, label: rest.join("\t") });
    }
    return out;
  }

  /** True if the workspace already byte-matches the given snapshot. */
  matches(sha: string): boolean {
    if (!this.available) return false;
    const release = this.acquireLock(2000);
    if (!release) return false;
    try {
      // Refresh the index so the diff reflects the current worktree, not whatever
      // the index held after the last snapshot/restore.
      this.git(["add", "-A"]);
      const diff = this.git(["diff", "--quiet", "--cached", sha, "--", ":/"]);
      return diff.code === 0;
    } finally {
      release();
    }
  }

  /**
   * Restore the workspace to the given snapshot tree. Files present in the
   * current HEAD tree but absent from the target are deleted.
   *
   * Fail-closed: both file lists are computed BEFORE the checkout, and any
   * ls-tree failure aborts the whole restore (we never proceed to deletion with
   * an unknown target file set). Deletions reject paths whose parents are
   * symlinks or that resolve outside the workspace.
   */
  restore(sha: string): { ok: boolean; error?: string } {
    if (!this.available) return { ok: false, error: this.disabledReason ?? "snapshots unavailable" };
    const release = this.acquireLock();
    if (!release) return { ok: false, error: "could not acquire snapshot lock; another session may be active" };
    try {
      const headBefore = this.git(["rev-parse", "--verify", "-q", "HEAD"]);
      const before = headBefore.code === 0 ? headBefore.stdout.trim() : "";

      // Compute file lists up front. If we cannot enumerate the target tree, we
      // must NOT delete anything (a transient ls-tree error must never be read as
      // "the target has no files").
      let oldFiles: string[] = [];
      let newFiles: Set<string> | null = null;
      if (before && before !== sha) {
        const oldList = this.lsTree(before);
        const newList = this.lsTree(sha);
        if (oldList === null || newList === null) {
          return { ok: false, error: "could not enumerate snapshot trees; restore aborted to avoid data loss" };
        }
        oldFiles = oldList;
        newFiles = new Set(newList);
      }

      const checkout = this.git(["checkout", sha, "--", ":/"]);
      if (checkout.code !== 0) return { ok: false, error: checkout.stderr.trim() || "git checkout failed" };

      // Delete files that existed before but not in the restored tree.
      let deleteFailures = 0;
      if (newFiles) {
        const wsReal = safeRealpath(this.workspace);
        for (const f of oldFiles) {
          if (newFiles.has(f)) continue;
          if (isUnsafeTreePath(f)) continue; // never delete .git/.weiping-whale/traversal/abs
          const target = join(this.workspace, f);
          if (!this.safeToDelete(target, wsReal)) continue;
          try {
            rmSync(target, { force: true });
          } catch {
            deleteFailures += 1;
          }
        }
      }
      // Point HEAD at the restored snapshot so subsequent diffs are correct.
      this.git(["update-ref", "HEAD", sha]);
      if (deleteFailures > 0) {
        return { ok: false, error: `${deleteFailures} file(s) could not be removed during restore; workspace may be partially restored` };
      }
      return { ok: true };
    } finally {
      release();
    }
  }

  /**
   * A path is safe to delete only if none of its parent components is a symlink
   * and the resolved location still lives inside the workspace. This prevents a
   * tracked path like `sub/file` from deleting outside the workspace when `sub`
   * was swapped for a symlink during the turn.
   */
  private safeToDelete(target: string, workspaceReal: string): boolean {
    // Walk each parent directory; if any is a symlink, refuse.
    let dir = dirname(target);
    const root = this.workspace;
    const seen = new Set<string>();
    while (dir.length >= root.length && !seen.has(dir)) {
      seen.add(dir);
      try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink()) return false;
      } catch {
        // parent doesn't exist -> nothing to delete under it anyway
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // The file itself must not be a symlink pointing elsewhere, and its real
    // location must stay under the real workspace root.
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) {
        // Deleting the link itself is fine; rmSync removes the link not target.
        return true;
      }
    } catch {
      return false; // doesn't exist
    }
    const real = safeRealpath(target);
    return real === workspaceReal || real.startsWith(workspaceReal + sep);
  }

  /** ls-tree file list, or null on failure (caller must fail-closed). */
  private lsTree(sha: string): string[] | null {
    const res = this.git(["ls-tree", "-r", "--name-only", "-z", sha]);
    if (res.code !== 0) return null;
    return res.stdout.split("\0").filter((s) => s.length > 0);
  }

  /** Prune snapshots older than N days. Best-effort. Holds the lock. */
  pruneOlderThanDays(days: number): void {
    if (!this.available || days <= 0) return;
    const release = this.acquireLock(2000);
    if (!release) return; // skip pruning if busy; it'll run next init
    try {
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const snaps = this.list(2000); // newest-first
      const survivors = snaps.filter((s) => s.timestamp > cutoff);
      if (survivors.length === snaps.length) return; // nothing to prune
      if (survivors.length === 0) {
        // All old: wipe refs to start fresh.
        this.git(["update-ref", "-d", "HEAD"]);
        try {
          rmSync(join(this.gitDir, "refs", "heads"), { recursive: true, force: true });
          rmSync(join(this.gitDir, "packed-refs"), { force: true });
        } catch {
          // ignore
        }
        this.git(["reflog", "expire", "--expire=now", "--all"]);
        this.git(["gc", "--prune=now", "-q"]);
        return;
      }
      // Rebuild survivors as a fresh orphan chain (oldest -> newest) so the kept
      // snapshots remain reachable while their pruned ancestors become garbage.
      // A single linear HEAD chain cannot drop old ancestors without this rewrite.
      const oldestFirst = [...survivors].reverse();
      let prevOrphan = "";
      for (const snap of oldestFirst) {
        const treeRes = this.git(["rev-parse", `${snap.id}^{tree}`]);
        if (treeRes.code !== 0) continue;
        const tree = treeRes.stdout.trim();
        const args = ["commit-tree", tree, "-m", snap.label];
        if (prevOrphan) args.push("-p", prevOrphan);
        // Preserve the original snapshot time so retention aging still works
        // and listed timestamps stay accurate after a prune rebuild.
        const iso = new Date(snap.timestamp * 1000).toISOString();
        const c = this.git(args, 60000, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
        if (c.code !== 0) continue;
        prevOrphan = c.stdout.trim();
      }
      if (prevOrphan) {
        this.git(["update-ref", "HEAD", prevOrphan]);
        this.git(["reflog", "expire", "--expire=now", "--all"]);
        this.git(["gc", "--prune=now", "-q"]);
      }
    } finally {
      release();
    }
  }

  private legacyPruneTail(): void {
    // (removed) superseded by the orphan-chain rebuild in pruneOlderThanDays.
  }
}

/** realpathSync that falls back to the input on error (deleted/missing paths). */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Estimate workspace size, stopping early once the cap is exceeded. */
function estimateWorkspaceSize(root: string, cap: number): number {
  let total = 0;
  const skip = new Set(["node_modules", ".git", "target", ".venv", "venv", "vendor", "__pycache__"]);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        continue;
      } else if (st.isDirectory()) {
        if (skip.has(name)) continue;
        stack.push(full);
      } else if (st.isFile()) {
        total += st.size;
        if (total > cap) return total; // early exit
      }
    }
  }
  return total;
}
