import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = process.cwd();
const npm = "npm";
const temp = mkdtempSync(join(tmpdir(), "deepseek-cli-package-smoke-"));
let tarballPath = "";

try {
  const pack = spawn(npm, ["pack", "--json"], { cwd: root });
  const jsonStart = pack.stdout.indexOf("[");
  const entries = JSON.parse(pack.stdout.slice(jsonStart));
  assert.equal(entries.length, 1);
  tarballPath = resolve(root, entries[0].filename);

  spawn(npm, ["init", "-y"], { cwd: temp });
  spawn(npm, ["install", tarballPath, "--ignore-scripts"], { cwd: temp });

  const configPath = join(temp, "deepseek-cli.toml");
  writeFileSync(
    configPath,
    [
      "[llm]",
      'model = "flash"',
      'api_key_env = "DEEPSEEK_API_KEY"',
      'base_url = "https://api.deepseek.com"',
      "",
      "[agent]",
      'workspace = "."',
      "max_iterations = 3",
      "",
    ].join("\n"),
    "utf-8",
  );

  const bin = process.platform === "win32"
    ? join(temp, "node_modules", ".bin", "deepseek.cmd")
    : join(temp, "node_modules", ".bin", "deepseek");

  const version = spawn(bin, ["--version"], { cwd: temp, shell: process.platform === "win32" });
  assert.match(version.stdout, /0\.4\.0/);

  const doctor = spawn(bin, ["--json", "--doctor"], {
    cwd: temp,
    shell: process.platform === "win32",
    env: { ...process.env, DEEPSEEK_API_KEY: "test-key", DEEPSEEK_CONFIG: configPath },
  });
  const payload = JSON.parse(doctor.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.auth.api_key, "configured");
  assert.equal(payload.auth.source, "env:DEEPSEEK_API_KEY");
  assert.equal(payload.version, "0.4.0");
  assert.equal(payload.endpoint.host, "api.deepseek.com");
  assert.equal(payload.base_url, undefined);

  console.log(JSON.stringify({ ok: true, package: basename(tarballPath), version: payload.version }));
} finally {
  rmSync(temp, { recursive: true, force: true });
  if (tarballPath) {
    try { unlinkSync(tarballPath); } catch {}
  }
}

function spawn(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32" && command === npm,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result;
}
