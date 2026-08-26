import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import yaml from "js-yaml";

const root = process.cwd();
const releaseRoots = [
  ".gitignore",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "config.toml",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "bin",
  "docs",
  "prompts",
  "src",
  "scripts",
  "dist",
  ".github",
  ".codex",
].filter((item) => existsSync(join(root, item)));

const blocked = [
  { code: "retired-agent-hub", pattern: new RegExp(["agent", "hub"].join("-"), "i") },
  { code: "retired-mailbox", pattern: new RegExp(`${["messages", "deepseek"].join("-")}\\.json`, "i") },
  { code: "legacy-markdown-memory", pattern: /D:[\\/](research|Research)[\\/].*memory/i },
  { code: "legacy-session-dump", pattern: /memory[\\/]sessions/i },
  { code: "raw-secret-looking-key", pattern: /sk-[A-Za-z0-9_-]{12,}/ },
  {
    code: "absolute-private-windows-path",
    pattern: /[A-Za-z]:[\\/](?:Users|Research|devtools|agent-resources|AGENT_RESOURCE|AGENTIC_SCIENCE)(?:[\\/]|$)/i,
  },
  { code: "absolute-private-posix-path", pattern: /\/(?:home|Users)\/[^/\s]+(?:\/|$)/ },
  { code: "stale-20kb-claim", pattern: new RegExp(`\\b${"20"}${"KB"}\\b`, "i") },
  { code: "stale-three-deps-claim", pattern: new RegExp(["three", "runtime", "dependencies"].join(" "), "i") },
  { code: "mirror-registry-lock", pattern: /registry\.npmmirror\.com/i },
];

const failures = [];
const scannedFiles = listFiles(releaseRoots);
const scannedFileSet = new Set(scannedFiles.map((file) => relative(root, file).replace(/\\/g, "/")));
for (const file of scannedFiles) {
  const text = readFileSync(file, "utf-8");
  // Packed Markdown may contain JSON/JavaScript-escaped Windows paths. Scan a
  // de-escaped view as well so `D:\\\\Research\\\\...` cannot bypass the same
  // policy that rejects `D:\\Research\\...`.
  const scanViews = [text, text.replace(/\\\\/g, "\\")];
  for (const rule of blocked) {
    if (scanViews.some((view) => rule.pattern.test(view))) {
      failures.push(`${rule.code}: ${relative(root, file)}`);
    }
  }
}

const packFiles = npmPackDryRunFiles();
const packFileSet = new Set(packFiles);
for (const packedFile of packFiles) {
  if (!scannedFileSet.has(packedFile)) failures.push(`pack-file-not-scanned: ${packedFile}`);
}
for (const expected of [
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "config.toml",
  "package.json",
  "dist/index.js",
  "prompts/base.md",
  "docs/releases/2026-06-04-uupf-deepseek-cli-upgrade.md",
  "docs/releases/2026-08-23-context-trust-mcp-upgrade.md",
  "docs/releases/2026-08-27-distribution-ci-hardening.md",
]) {
  if (!packFileSet.has(expected)) failures.push(`pack-missing-required-file: ${expected}`);
}
for (const unexpected of packFiles) {
  if (/^(src|scripts|\.codex|\.github|node_modules|assets)\//.test(unexpected)) {
    failures.push(`pack-unexpected-source-file: ${unexpected}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf-8"));
const lockRoot = packageLock.packages?.[""];
for (const [name, target] of Object.entries(packageJson.bin ?? {})) {
  const normalizedTarget = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!packFileSet.has(normalizedTarget)) failures.push(`pack-bin-target-missing: ${name} -> ${target}`);
}
if (packageJson.version !== "0.4.1") failures.push(`package-version-mismatch: ${packageJson.version}`);
if (packageLock.version !== packageJson.version || lockRoot?.version !== packageJson.version) {
  failures.push(`package-lock-version-mismatch: package=${packageJson.version} lock=${packageLock.version} root=${lockRoot?.version}`);
}
if (packageJson.engines?.node !== ">=22.18.0" || lockRoot?.engines?.node !== packageJson.engines.node) {
  failures.push(`node-engine-mismatch: package=${packageJson.engines?.node} lock=${lockRoot?.engines?.node}`);
}
if (lockRoot?.dependencies?.["@modelcontextprotocol/client"] !== packageJson.dependencies?.["@modelcontextprotocol/client"]) {
  failures.push("package-lock-mcp-version-mismatch");
}

const ciWorkflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8");
if (!/node-version:\s*['"]22\.18\.0['"]/.test(ciWorkflow)) failures.push("ci-does-not-test-minimum-node");
if (!/os:\s*\[ubuntu-latest, windows-latest\]/.test(ciWorkflow)) failures.push("ci-platform-matrix-missing");
if (!/\brun:\s*npm ci\b/.test(ciWorkflow)) failures.push("ci-does-not-use-npm-ci");
validateWorkflowActions(ciWorkflow, failures);

const packagedConfig = readFileSync(join(root, "config.toml"), "utf-8");
for (const pattern of [/D:[\\/]/i, /agent-resources/i, /ARIS/i, /Vipin/i, /agent hub/i]) {
  if (pattern.test(packagedConfig)) failures.push(`packaged-config-private-reference: ${pattern}`);
}

const windowsLauncher = readFileSync(join(root, "bin", "deepseek.cmd"), "utf-8");
if (!windowsLauncher.includes("%~dp0")) failures.push("windows-launcher-not-repo-relative");
if (!/\bwhere\s+wwhale\b/i.test(windowsLauncher)) failures.push("windows-launcher-missing-npm-bin-fallback");

validateReadmeLinks(packFileSet, failures);

const readme = readFileSync(join(root, "README.md"), "utf-8");
if (!/not currently published to the npm registry/i.test(readme)) {
  failures.push("readme-missing-unpublished-registry-boundary");
}
if (readmeClaimsRegistryInstall(readme)) {
  failures.push("readme-claims-unpublished-registry-install");
}
const installSection = readme.match(/^## Install\s*$[\s\S]*?(?=^##\s)/m)?.[0] ?? "";
if (/--doctor\b/.test(installSection)) {
  failures.push("readme-install-runs-doctor-before-auth");
}

assert.deepEqual(failures, [], `Release scan failed:\n${failures.join("\n")}`);

const distPath = join(root, "dist", "index.js");
if (existsSync(distPath)) {
  const bytes = statSync(distPath).size;
  assert.ok(bytes > 10_000, "dist/index.js looks unexpectedly small");
  const maxDistBytes = 256 * 1024;
  assert.ok(bytes < maxDistBytes, `dist/index.js is ${bytes} bytes (cap ${maxDistBytes}); revisit the package surface`);
  console.log(JSON.stringify({ ok: true, dist_bytes: bytes }));
} else {
  console.log(JSON.stringify({ ok: true, dist_missing: true }));
}

function listFiles(entries) {
  const files = [];
  for (const entry of entries) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isFile()) {
      files.push(full);
      continue;
    }
    walk(full, files);
  }
  return files.filter((file) => {
    if (/[\\\/](node_modules|assets|\.git)[\\\/]/.test(file)) return false;
    return relative(root, file) !== join("scripts", "release-scan.mjs");
  });
}

function validateWorkflowActions(source, failures) {
  let workflow;
  try {
    workflow = yaml.load(source);
  } catch (error) {
    failures.push(`ci-yaml-invalid: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    failures.push("ci-jobs-missing");
    return;
  }
  const actionSteps = [];
  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    if ("uses" in job) actionSteps.push(job);
    if (Array.isArray(job.steps)) {
      for (const step of job.steps) {
        if (step && typeof step === "object" && !Array.isArray(step) && "uses" in step) {
          actionSteps.push(step);
        }
      }
    }
  }
  const checkoutSteps = [];
  for (const step of actionSteps) {
    const uses = step.uses;
    if (typeof uses !== "string") {
      failures.push("ci-action-uses-must-be-string");
      continue;
    }
    if (uses.startsWith("./")) continue;
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(uses)) {
      failures.push(`ci-action-not-full-sha: ${uses}`);
    }
    if (uses.toLowerCase().startsWith("actions/checkout@")) checkoutSteps.push(step);
  }
  if (checkoutSteps.length === 0) failures.push("ci-checkout-step-missing");
  for (const step of checkoutSteps) {
    if (step.with?.["persist-credentials"] !== false) {
      failures.push("ci-checkout-persists-credentials");
    }
  }
}

function readmeClaimsRegistryInstall(source) {
  const logicalLines = source
    .replace(/\\\r?\n\s*/g, " ")
    .replace(/`\r?\n\s*/g, " ")
    .split(/\r?\n/);
  for (const rawLine of logicalLines) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const tokens = (line.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((token) =>
      token.replace(/^['"]|['"]$/g, "").replace(/[;,]$/, "").toLowerCase()
    );
    const clientIndex = tokens.findIndex((token) =>
      [
        "npm", "npm.cmd", "npm.exe",
        "npx", "npx.cmd", "npx.exe",
        "pnpm", "pnpm.cmd", "pnpm.exe", "pnpx",
        "yarn", "yarn.cmd", "yarn.exe",
        "bun", "bun.exe", "bunx", "bunx.exe",
      ].includes(token)
    );
    if (clientIndex < 0) continue;
    const client = tokens[clientIndex].replace(/(?:\.cmd|\.exe)$/i, "");
    const command = tokens.slice(clientIndex + 1);
    const installs = command.some((token) => ["install", "i", "add"].includes(token));
    const global = command.some((token, index) =>
      token === "-g" ||
      token === "--global" ||
      /^(?:-g|--global)=(?:true|1|yes|on)$/.test(token) ||
      token === "--location=global" ||
      (token === "--location" && command[index + 1] === "global")
    );
    const packageName = command.some((token) =>
      token === "weiping-whale" ||
      token.startsWith("weiping-whale@") ||
      /^(?:--package|-p)=weiping-whale(?:@|$)/.test(token)
    );
    const executes =
      ["npx", "pnpx", "bunx"].includes(client) ||
      (["npm", "pnpm"].includes(client) && command.some((token) => ["exec", "x", "dlx"].includes(token))) ||
      (client === "yarn" && command.some((token) => token === "dlx")) ||
      (client === "bun" && command.some((token) => token === "x"));
    const yarnGlobalAdd = client === "yarn" && command[0] === "global" && command.includes("add");
    if (packageName && ((installs && global) || yarnGlobalAdd || executes)) return true;
  }
  return false;
}

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (["node_modules", "assets", ".git"].includes(name)) continue;
      walk(full, files);
    } else if (stat.isFile()) {
      files.push(full);
    }
  }
}

function npmPackDryRunFiles() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const jsonStart = result.stdout.indexOf("[");
  const entries = JSON.parse(result.stdout.slice(jsonStart));
  return entries[0].files.map((file) => file.path.replace(/\\/g, "/"));
}

function validateReadmeLinks(packFileSet, failures) {
  const readme = readFileSync(join(root, "README.md"), "utf-8");
  const refs = [
    ...Array.from(readme.matchAll(/<img\s+[^>]*src="([^"]+)"/gi), (match) => match[1]),
    ...Array.from(readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), (match) => match[1]),
    ...Array.from(readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), (match) => match[1]),
  ];
  for (const ref of refs) {
    const target = ref.split("#")[0].trim();
    if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
    if (!existsSync(join(root, target))) failures.push(`readme-link-missing-file: ${ref}`);
    if (!packFileSet.has(target.replace(/\\/g, "/"))) failures.push(`readme-link-not-in-package: ${ref}`);
  }
}
