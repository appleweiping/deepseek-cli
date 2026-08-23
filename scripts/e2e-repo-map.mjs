import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildRepositoryMap, extractSymbols } = await import("../src/context/repo-map.ts");

const symbols = extractSymbols("src/example.ts", [
  "export interface Options { value: string }",
  "export class Engine {",
  "  private hidden() {}",
  "}",
  "export async function run(value: string) {",
  "  return value;",
  "}",
].join("\n"));
assert.ok(symbols.some((line) => line.includes("interface Options")), "extracts TypeScript interface");
assert.ok(symbols.some((line) => line.includes("class Engine")), "extracts TypeScript class");
assert.ok(symbols.some((line) => line.includes("function run")), "extracts exported function");
assert.ok(!symbols.some((line) => line.includes("hidden")), "does not dump class internals");

const ws = mkdtempSync(join(tmpdir(), "ww-repo-map-"));
const outside = mkdtempSync(join(tmpdir(), "ww-repo-map-outside-"));
try {
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "ignored"), { recursive: true });
  writeFileSync(join(ws, "README.md"), "# Demo\n", "utf-8");
  writeFileSync(join(ws, "src", "main.ts"), "export function launch(): void {}\n", "utf-8");
  writeFileSync(join(ws, "src", "worker.py"), "class Worker:\n    pass\n", "utf-8");
  writeFileSync(join(ws, "ignored", "secret.ts"), "export const LEAKED_SECRET = true;\n", "utf-8");
  writeFileSync(join(ws, ".gitignore"), "ignored/\n", "utf-8");
  writeFileSync(join(outside, "outside.ts"), "export const OUTSIDE_SECRET = true;\n", "utf-8");

  execFileSync("git", ["init", "-q", ws]);
  execFileSync("git", ["-C", ws, "add", "README.md", "src/main.ts", "src/worker.py", ".gitignore"]);

  // A workspace symlink/junction must never cause content outside the root to
  // enter the context map. Skip only when the platform denies link creation.
  try {
    symlinkSync(outside, join(ws, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch {}

  const map = buildRepositoryMap(ws, { maxChars: 4_000, maxFiles: 100 });
  assert.equal(map.source, "git", "uses git's ignore-aware file list");
  assert.match(map.text, /src\/main\.ts/);
  assert.match(map.text, /function launch/);
  assert.match(map.text, /src\/worker\.py/);
  assert.doesNotMatch(map.text, /LEAKED_SECRET|ignored\/secret/);
  assert.doesNotMatch(map.text, /OUTSIDE_SECRET|linked\/outside/);
  assert.ok(map.text.length <= 4_000, "honors map character budget");

  const tiny = buildRepositoryMap(ws, { maxChars: 1_000, maxFiles: 10 });
  assert.ok(tiny.text.length <= 1_000, "clamps and honors the minimum budget");

  // File selection must be relevance-ranked before maxFiles is applied. Git's
  // lexicographic order otherwise lets a*/ files evict a core src entry.
  for (let index = 0; index < 20; index++) {
    writeFileSync(join(ws, `aaaa-${String(index).padStart(2, "0")}.ts`), `export const filler${index} = ${index};\n`, "utf-8");
  }
  writeFileSync(join(ws, "src", "core.ts"), "export function importantCore(): void {}\n", "utf-8");
  execFileSync("git", ["-C", ws, "add", "."]);
  const ranked = buildRepositoryMap(ws, { maxChars: 4_000, maxFiles: 10 });
  assert.match(ranked.text, /src\/core\.ts/, "core source survives a tight file budget");

  // A symbol-heavy first entry that cannot fit must not prevent smaller later
  // entries from using the remaining character budget.
  const hugeSignatures = Array.from(
    { length: 12 },
    (_, index) => `export function extremelyLongSignature${index}(${`argument${index}: string, `.repeat(10)}): void {}`,
  ).join("\n");
  writeFileSync(join(ws, "src", "index.ts"), `${hugeSignatures}\n`, "utf-8");
  writeFileSync(join(ws, "src", "small.ts"), "export const small = true;\n", "utf-8");
  execFileSync("git", ["-C", ws, "add", "."]);
  const packed = buildRepositoryMap(ws, { maxChars: 1_000, maxFiles: 100 });
  assert.match(packed.text, /src\/small\.ts/, "smaller entries fill the map after an oversized block is skipped");
} finally {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

console.log("repo-map e2e ok");
