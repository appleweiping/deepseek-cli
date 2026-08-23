import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { assertWritablePath, isInsidePath } = await import("../src/safety/sandbox.ts");

const workspace = mkdtempSync(join(tmpdir(), "ww-sandbox-workspace-"));
const outside = mkdtempSync(join(tmpdir(), "ww-sandbox-outside-"));
const previous = process.env.DEEPSEEK_SANDBOX_MODE;
try {
  process.env.DEEPSEEK_SANDBOX_MODE = "workspace-write";
  mkdirSync(join(workspace, "safe"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "keep", "utf-8");

  assert.doesNotThrow(() => assertWritablePath(join(workspace, "safe", "new.txt"), workspace));
  assert.equal(isInsidePath(join(workspace, "safe"), workspace), true);
  assert.equal(isInsidePath(outside, workspace), false);
  assert.throws(() => assertWritablePath(join(outside, "escape.txt"), workspace), /outside workspace/);

  let linkCreated = false;
  try {
    symlinkSync(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    linkCreated = true;
  } catch {}
  if (linkCreated) {
    assert.throws(
      () => assertWritablePath(join(workspace, "linked", "secret.txt"), workspace),
      /symbolic link|junction|resolving outside/,
      "workspace-write rejects symlink/junction escape",
    );
  }

  process.env.DEEPSEEK_SANDBOX_MODE = "read-only";
  assert.throws(() => assertWritablePath(join(workspace, "safe", "blocked.txt"), workspace), /read-only/);

  // Unrestricted is an explicit escape hatch and retains its documented meaning.
  process.env.DEEPSEEK_SANDBOX_MODE = "unrestricted";
  assert.doesNotThrow(() => assertWritablePath(join(outside, "explicit.txt"), workspace));
} finally {
  if (previous === undefined) delete process.env.DEEPSEEK_SANDBOX_MODE;
  else process.env.DEEPSEEK_SANDBOX_MODE = previous;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

console.log("sandbox e2e ok");
