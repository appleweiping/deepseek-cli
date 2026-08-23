/**
 * skills/install.ts — install a skill from GitHub into the global skills dir.
 *
 * Uses `git clone --depth 1` (no extra tar dependency). Validates that the
 * cloned tree contains a SKILL.md, records provenance in `.installed-from`, and
 * refuses sources that don't look like `owner/repo` or a GitHub URL.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, readdirSync, statSync, lstatSync } from "fs";
import { join, resolve, dirname } from "path";
import { skillsDir } from "../runtime/paths.js";

export interface InstallResult {
  ok: boolean;
  name?: string;
  path?: string;
  error?: string;
}

/** Parse a source spec into a clone URL + a default install name. */
export function resolveSource(spec: string): { url: string; name: string } | null {
  const s = spec.trim();
  // Reject anything containing path-traversal segments outright.
  if (/(^|[\/\\])\.\.([\/\\]|$)/.test(s)) return null;
  // github:owner/repo  or  owner/repo
  const shorthand = s.replace(/^github:/, "");
  if (/^[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?$/.test(shorthand)) {
    const [, repo] = shorthand.split("/");
    return { url: `https://github.com/${shorthand}.git`, name: repo.replace(/\.git$/, "") };
  }
  // full https URL
  if (/^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(\.git)?$/.test(s)) {
    const name = s.replace(/\.git$/, "").split("/").pop()!;
    return { url: s.endsWith(".git") ? s : s + ".git", name };
  }
  return null;
}

/** Strict skill-name allowlist: leading alnum, then alnum/._-, max 80 chars. */
function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) && name !== "." && name !== "..";
}

/** Install a skill from GitHub. Returns the installed skill name + path. */
export function installSkill(spec: string, opts: { name?: string; force?: boolean } = {}): InstallResult {
  const resolved = resolveSource(spec);
  if (!resolved) {
    return { ok: false, error: `unrecognized skill source '${spec}'. Use owner/repo or a github.com URL.` };
  }
  const installName = opts.name || resolved.name;
  if (!validName(installName)) {
    return { ok: false, error: `invalid skill name '${installName}' (allowed: letters, digits, . _ -, max 80 chars)` };
  }

  const root = skillsDir();
  mkdirSync(root, { recursive: true });
  const dest = join(root, installName);

  // Containment: dest must resolve directly under the skills root.
  if (dirname(resolve(dest)) !== resolve(root)) {
    return { ok: false, error: "refusing to install outside the skills directory" };
  }
  // Refuse to clobber an existing skill unless force, and never delete through a symlink.
  if (existsSync(dest)) {
    if (isSymlinkish(dest)) return { ok: false, error: `'${installName}' exists as a symlink; refusing to touch it` };
    if (!opts.force) return { ok: false, error: `skill '${installName}' already exists; pass force to overwrite` };
  }

  // Exclusive temp dir inside the skills root (mkdtemp avoids predictable names).
  const tmp = mkdtempSync(join(root, ".tmp-skill-"));

  // git clone (no remote hooks run on clone; the real risk is symlinks in the tree).
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "--quiet", "--config", "core.symlinks=false", resolved.url, tmp],
    { encoding: "utf8", timeout: 120000 },
  );
  if ((clone.status ?? -1) !== 0) {
    safeRm(tmp);
    return { ok: false, error: `git clone failed: ${(clone.stderr || clone.error?.message || "").trim().slice(0, 200)}` };
  }

  // Reject any symlink/reparse point anywhere in the cloned tree — a malicious
  // repo could otherwise smuggle references that point outside the install.
  if (containsSymlink(tmp)) {
    safeRm(tmp);
    return { ok: false, error: "cloned repository contains symbolic links; refusing to install" };
  }

  const skillMd = findShallowSkillMd(tmp, 0);
  if (!skillMd) {
    safeRm(tmp);
    return { ok: false, error: "no SKILL.md found in the cloned repository" };
  }

  // Drop the cloned .git and record provenance.
  safeRm(join(tmp, ".git"));
  writeFileSync(
    join(tmp, ".installed-from"),
    JSON.stringify({ spec, url: resolved.url, installed_at: new Date().toISOString() }, null, 2),
    "utf-8",
  );

  // Atomic-ish swap with rollback: move any existing dest aside first.
  let backup: string | undefined;
  if (existsSync(dest)) {
    backup = `${dest}.bak-${Date.now()}`;
    try {
      renameSync(dest, backup);
    } catch {
      safeRm(tmp);
      return { ok: false, error: "could not move the existing skill aside" };
    }
  }
  try {
    renameSync(tmp, dest);
  } catch {
    // Roll back the backup if the move failed.
    if (backup) {
      try { renameSync(backup, dest); } catch { /* leave backup in place */ }
    }
    safeRm(tmp);
    return { ok: false, error: "failed to move skill into place" };
  }
  if (backup) safeRm(backup);

  return { ok: true, name: installName, path: dest };
}

/** True if the path is a symlink/junction (lstat, does not follow). */
function isSymlinkish(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Recursively detect any symbolic link within a tree (depth-bounded). */
function containsSymlink(dir: string, depth = 0): boolean {
  // Fail closed on pathological depth: an uninspected subtree is not safe to
  // install merely because it exceeded our traversal budget.
  if (depth > 32) return true;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) return true;
    if (st.isDirectory() && containsSymlink(full, depth + 1)) return true;
  }
  return false;
}

function findShallowSkillMd(dir: string, depth: number): string | null {
  if (depth > 3) return null;
  const direct = join(dir, "SKILL.md");
  if (existsSync(direct)) return direct;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === ".git") continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) {
        const found = findShallowSkillMd(full, depth + 1);
        if (found) return found;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function safeRm(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
