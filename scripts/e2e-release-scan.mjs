import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), "weiping-whale-release-scan-"));
const entries = [
  ".codex",
  ".github",
  "bin",
  "dist",
  "docs",
  "prompts",
  "scripts",
  "src",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "config.toml",
  "package-lock.json",
  "package.json",
];

try {
  for (const entry of entries) {
    cpSync(join(root, entry), join(fixture, entry), { recursive: true });
  }

  appendFileSync(
    join(fixture, "docs", "releases", "2026-08-23-context-trust-mcp-upgrade.md"),
    "\nPrivate fixture: D:\\AGENTIC_SCIENCE\\secret\\run.json\n",
    "utf8",
  );
  const result = spawnSync(process.execPath, ["scripts/release-scan.mjs"], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "release scan must reject a private path in a packed release note");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /absolute-private-windows-path: docs[\\/]releases[\\/]/,
  );
  console.log("release-scan e2e ok");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
