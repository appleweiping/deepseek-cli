/**
 * A compact, deterministic repository map for the initial agent context.
 *
 * Inspired by Aider's repo-map idea, but intentionally dependency-light: we
 * use git's own ignore-aware file index when available and conservative
 * language-specific signature extraction instead of shipping a parser farm.
 * The map is orientation, never evidence; the prompt tells the model to open
 * files before relying on implementation details.
 */
import { spawnSync } from "child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { extname, isAbsolute, relative, resolve } from "path";
import fg from "fast-glob";

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_SIGNATURE_CHARS = 180;
const GIT_LIST_MAX_BYTES = 4 * 1024 * 1024;

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift",
]);

const ORIENTATION_FILES = new Set([
  "README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md",
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "requirements.txt", "Makefile", "Dockerfile", "docker-compose.yml",
]);

const SKIP_SEGMENTS = new Set([
  ".git", ".weiping-whale", "node_modules", "vendor", "target", "dist", "build",
  ".next", ".cache", ".venv", "venv", "__pycache__", "coverage",
]);

const SKIP_EXTENSIONS = new Set([
  ".lock", ".map", ".min.js", ".min.css", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".ico", ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf", ".mp3", ".mp4",
]);

export interface RepositoryMapOptions {
  maxChars?: number;
  maxFiles?: number;
}

export interface RepositoryMapResult {
  text: string;
  fileCount: number;
  candidateCount: number;
  truncated: boolean;
  source: "git" | "filesystem";
}

interface MapEntry {
  path: string;
  symbols: string[];
  score: number;
}

export function buildRepositoryMap(workspace: string, options: RepositoryMapOptions = {}): RepositoryMapResult {
  const root = resolve(workspace);
  const rootReal = safeRealpath(root);
  const maxChars = clampInt(options.maxChars, 1_000, 100_000, DEFAULT_MAX_CHARS);
  const maxFiles = clampInt(options.maxFiles, 10, 5_000, DEFAULT_MAX_FILES);
  const discovered = discoverFiles(root);
  const candidates = [...new Set(discovered.files.map(normalizeRelativePath).filter(Boolean) as string[])]
    .filter(isMapCandidate)
    // Apply the file budget only after a cheap path-level relevance sort.
    // `git ls-files` is lexicographic; truncating that order first lets a large
    // `a...` directory crowd out README/src entry points entirely.
    .sort((left, right) => rankPath(right, 0) - rankPath(left, 0) || left.localeCompare(right));

  const entries: MapEntry[] = [];
  for (const path of candidates) {
    if (entries.length >= maxFiles) break;
    const absolute = resolve(root, path);
    if (!safeRegularFile(absolute, rootReal)) continue;
    let symbols: string[] = [];
    if (CODE_EXTENSIONS.has(extname(path).toLowerCase())) {
      try {
        if (statSync(absolute).size <= MAX_FILE_BYTES) {
          const source = readFileSync(absolute, "utf-8");
          if (!source.includes("\0")) symbols = extractSymbols(path, source);
        }
      } catch {
        continue;
      }
    }
    entries.push({ path, symbols, score: rankPath(path, symbols.length) });
  }

  entries.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const header = [
    "## Repository Map",
    "Generated from ignore-aware workspace files. Use it for orientation only; open files before relying on details.",
  ];
  const lines = [...header];
  let used = lines.join("\n").length;
  let shown = 0;

  for (const entry of entries) {
    const block = [entry.path, ...entry.symbols.map((symbol) => `  ${symbol}`)].join("\n");
    // A symbol-heavy high-ranked file may not fit while later path-only or
    // smaller entries do. Skip the oversized block instead of abandoning the
    // remaining map budget.
    if (used + block.length + 1 > maxChars) continue;
    lines.push(block);
    used += block.length + 1;
    shown += 1;
  }

  const truncated = discovered.truncated || shown < entries.length || entries.length < candidates.length;
  if (truncated) {
    const note = `... map truncated (${shown}/${candidates.length} eligible files shown) ...`;
    if (used + note.length + 1 <= maxChars) lines.push(note);
  }

  return {
    text: lines.join("\n"),
    fileCount: shown,
    candidateCount: candidates.length,
    truncated,
    source: discovered.source,
  };
}

function discoverFiles(root: string): { files: string[]; source: "git" | "filesystem"; truncated: boolean } {
  const git = spawnSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf-8", timeout: 5_000, maxBuffer: GIT_LIST_MAX_BYTES, windowsHide: true },
  );
  if (git.status === 0 && typeof git.stdout === "string") {
    return { files: git.stdout.split("\0").filter(Boolean), source: "git", truncated: false };
  }
  // `spawnSync` preserves the bounded prefix when maxBuffer is exceeded. Use
  // that safe partial index instead of falling back to an unbounded full-tree
  // glob on exactly the repositories large enough to overflow the Git cap.
  if (["ENOBUFS", "ETIMEDOUT"].includes((git.error as NodeJS.ErrnoException | undefined)?.code ?? "") && typeof git.stdout === "string") {
    const completePrefix = git.stdout.slice(0, git.stdout.lastIndexOf("\0") + 1);
    return { files: completePrefix.split("\0").filter(Boolean), source: "git", truncated: true };
  }

  const files = fg.sync("**/*", {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: [...SKIP_SEGMENTS].map((part) => `**/${part}/**`),
  });
  return { files, source: "filesystem", truncated: false };
}

function normalizeRelativePath(value: string): string | null {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return path;
}

function isMapCandidate(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((part) => SKIP_SEGMENTS.has(part))) return false;
  const lower = path.toLowerCase();
  if ([...SKIP_EXTENSIONS].some((extension) => lower.endsWith(extension))) return false;
  const base = parts.at(-1) || path;
  return CODE_EXTENSIONS.has(extname(path).toLowerCase()) || ORIENTATION_FILES.has(base);
}

function safeRegularFile(path: string, rootReal: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const actual = realpathSync(path);
    const rel = relative(rootReal, actual);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function rankPath(path: string, symbolCount: number): number {
  const parts = path.split("/");
  const base = parts.at(-1) || path;
  let score = 100 - Math.min(60, parts.length * 4);
  if (ORIENTATION_FILES.has(base)) score += 80;
  if (parts.includes("src") || parts.includes("lib") || parts.includes("app")) score += 45;
  if (/^(index|main|app|cli)\.[^.]+$/i.test(base)) score += 35;
  if (/test|spec|fixture|generated|migration/i.test(path)) score -= 25;
  score += Math.min(symbolCount, 10) * 3;
  return score;
}

export function extractSymbols(path: string, source: string): string[] {
  const extension = extname(path).toLowerCase();
  const symbols: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of source.split(/\r?\n/)) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    const leading = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("/*") || line.startsWith("*")) continue;
    const symbol = matchSignature(extension, line, leading);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol.slice(0, MAX_SIGNATURE_CHARS));
  }
  return symbols;
}

function matchSignature(extension: string, line: string, leading: number): string | null {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    if (leading > 2) return null;
    const declaration = line.match(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|enum|type|namespace|function)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) return cleanSignature(line);
    const value = line.match(/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
    if (value && (/=>|function\b|\{/.test(line) || line.startsWith("export "))) return cleanSignature(line);
    return null;
  }
  if (extension === ".py") {
    if (leading > 0) return null;
    return /^(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/.test(line) ? cleanSignature(line) : null;
  }
  if (extension === ".rs") {
    if (leading > 0) return null;
    return /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+[A-Za-z_]\w*/.test(line)
      ? cleanSignature(line)
      : null;
  }
  if (extension === ".go") {
    if (leading > 0) return null;
    return /^(?:func|type|const|var)\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*/.test(line) ? cleanSignature(line) : null;
  }
  if ([".java", ".kt", ".kts", ".cs", ".swift"].includes(extension)) {
    if (leading > 2) return null;
    return /\b(class|interface|enum|record|struct|protocol|fun)\s+[A-Za-z_]\w*/.test(line) ? cleanSignature(line) : null;
  }
  if ([".c", ".h", ".cc", ".cpp", ".hpp"].includes(extension)) {
    if (leading > 0) return null;
    return /^(?:typedef\s+)?(?:struct|class|enum)\s+[A-Za-z_]\w*/.test(line) || /^[\w:*&<>\s]+\s+[A-Za-z_]\w*\s*\([^;]*\)\s*\{?$/.test(line)
      ? cleanSignature(line)
      : null;
  }
  if ([".rb", ".php"].includes(extension)) {
    if (leading > 0) return null;
    return /^(?:class|module|def|function)\s+[A-Za-z_]/.test(line) ? cleanSignature(line) : null;
  }
  return null;
}

function cleanSignature(line: string): string {
  return line.replace(/\s*\{\s*$/, "").replace(/\s*=>\s*\{?\s*$/, " =>").slice(0, MAX_SIGNATURE_CHARS);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}
