import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
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

assertReleaseScanRejects(
  (fixture) => {
    const privatePath = ["D:", "AGENTIC_SCIENCE", "secret", "run.json"].join("\\");
    appendFileSync(
      join(fixture, "docs", "releases", "2026-08-23-context-trust-mcp-upgrade.md"),
      `\nPrivate fixture: ${privatePath}\n`,
      "utf8",
    );
  },
  /absolute-private-windows-path: docs[\\/]releases[\\/]/,
  "a private path in a packed release note",
);

assertReleaseScanRejects(
  (fixture) => {
    const escapedSeparator = "\\".repeat(2);
    const escapedPrivatePath = ["D:", "Research", "private", "run.json"].join(escapedSeparator);
    appendFileSync(
      join(fixture, "docs", "releases", "2026-08-23-context-trust-mcp-upgrade.md"),
      `\nEscaped private fixture: ${escapedPrivatePath}\n`,
      "utf8",
    );
  },
  /absolute-private-windows-path: docs[\\/]releases[\\/]/,
  "a JSON/JavaScript-escaped private path in a packed release note",
);

assertReleaseScanRejects(
  (fixture) => {
    appendFileSync(join(fixture, "README.md"), "\n```bash\nnpm install -g weiping-whale\n```\n", "utf8");
  },
  /readme-claims-unpublished-registry-install/,
  "an install command for the unpublished registry package",
);

for (const command of [
  "npm install weiping-whale --global",
  "npm --global install weiping-whale",
  "npm install --location global weiping-whale",
  "npm install --global=true weiping-whale",
  "npm add -g weiping-whale",
  "pnpm add -g weiping-whale",
  "yarn global add weiping-whale",
  "bun add --global weiping-whale",
  "npx weiping-whale",
  "pnpm dlx weiping-whale",
  "yarn dlx weiping-whale",
  "bunx weiping-whale",
  "npm exec --package=weiping-whale -- weiping-whale",
]) {
  assertReleaseScanRejects(
    (fixture) => {
      appendFileSync(join(fixture, "README.md"), `\n\`\`\`bash\n${command}\n\`\`\`\n`, "utf8");
    },
    /readme-claims-unpublished-registry-install/,
    `the equivalent unpublished registry command: ${command}`,
  );
}

assertReleaseScanRejects(
  (fixture) => {
    const readme = join(fixture, "README.md");
    const text = readFileSync(readme, "utf8").replace(
      "## First Run",
      "```bash\nweiping-whale --doctor\n```\n\n## First Run",
    );
    writeFileSync(readme, text, "utf8");
  },
  /readme-install-runs-doctor-before-auth/,
  "doctor before authentication is configured",
);

assertReleaseScanRejects(
  (fixture) => {
    const workflow = join(fixture, ".github", "workflows", "ci.yml");
    const text = readFileSync(workflow, "utf8").replace(
      /actions\/checkout@[0-9a-f]{40}/,
      "actions/checkout@v6",
    );
    writeFileSync(workflow, text, "utf8");
  },
  /ci-action-not-full-sha: actions\/checkout@v6/,
  "a floating GitHub Action reference",
);

assertReleaseScanRejects(
  (fixture) => {
    const workflow = join(fixture, ".github", "workflows", "ci.yml");
    const text = readFileSync(workflow, "utf8").replace(
      /\s*- uses: actions\/setup-node@[0-9a-f]{40}/,
      "\n      - name: Set up Node\n        uses: actions/setup-node@v6",
    );
    writeFileSync(workflow, text, "utf8");
  },
  /ci-action-not-full-sha: actions\/setup-node@v6/,
  "a floating action ref on a named step",
);

assertReleaseScanRejects(
  (fixture) => {
    const workflow = join(fixture, ".github", "workflows", "ci.yml");
    const text = readFileSync(workflow, "utf8").replace(
      "persist-credentials: false",
      "persist-credentials: true # persist-credentials: false",
    );
    writeFileSync(workflow, text, "utf8");
  },
  /ci-checkout-persists-credentials/,
  "checkout credentials enabled behind a misleading comment",
);

assertReleaseScanRejects(
  (fixture) => {
    const workflow = join(fixture, ".github", "workflows", "ci.yml");
    const checkoutSha = readFileSync(workflow, "utf8").match(
      /actions\/checkout@([0-9a-f]{40})/,
    )?.[1];
    assert.ok(checkoutSha);
    const text = readFileSync(workflow, "utf8").replace(
      "      # actions/setup-node",
      `      - uses: Actions/checkout@${checkoutSha}\n      # actions/setup-node`,
    );
    writeFileSync(workflow, text, "utf8");
  },
  /ci-checkout-persists-credentials/,
  "case-variant checkout without disabled credential persistence",
);

console.log("release-scan e2e ok");

function assertReleaseScanRejects(mutate, expected, label) {
  const fixture = mkdtempSync(join(tmpdir(), "weiping-whale-release-scan-"));
  try {
    for (const entry of entries) {
      cpSync(join(root, entry), join(fixture, entry), { recursive: true });
    }
    mutate(fixture);
    const result = spawnSync(process.execPath, [join(root, "scripts", "release-scan.mjs")], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `release scan must reject ${label}`);
    assert.match(`${result.stdout}\n${result.stderr}`, expected);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
