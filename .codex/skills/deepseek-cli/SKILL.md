# DeepSeek CLI Skill

Use this skill for non-trivial work on `WEIPING_WHALE` (including its legacy
`deepseek` CLI alias), especially release-level improvements, runtime honesty,
safety, MCP, memory, terminal UX, packaging, or documentation.

## Purpose

Keep DeepSeek CLI honest, small, useful, and release-ready. The project is a terminal-native coding agent, not a web app and not a toy demo. Every substantial change should improve a complete lifecycle:

planning -> design -> development -> testing -> release -> maintenance -> monitoring -> upgrade iteration

## Phase 1 - Plan

1. Inspect the current git status and protect user changes.
2. Read `README.md`, `package.json`, `config.toml`, `src/index.ts`, `src/agent.ts`, `src/config.ts`, `src/llm/deepseek.ts`, `src/memory.ts`, `src/session.ts`, `src/safety/*`, `src/tools/*`, `src/mcp/*`, `.github/workflows/ci.yml`, and the relevant tests/scripts.
3. Identify the project relationship:
   - `WEIPING_COUNCIL`: orchestration and cross-model review.
   - `WEIPING_WHALE`: terminal worker and fast local coding agent.
   - `WEIPING_LAB`: experiment/workbench surface.
   - `WEIPING_WIKI`: public route map, not a runtime dependency.
   - `AGENT_RESOURCE`: optional shared skill library, not a required checkout.
4. Define a version-level batch. Do not ship only typo fixes unless the user explicitly asks for a tiny change.

## Phase 2 - Design

For non-trivial upgrades, inspect concrete source files from active open-source agent CLIs. Do not rely only on READMEs.

Recommended references:

- Google Gemini CLI: config validation, storage/session paths, retry/error handling, tool execution tests.
- Aider: command running, model metadata, IO and regression tests.
- OpenCode: config schema, permission model, provider status, session and error structure.

Record the specific modules inspected in the README, release notes, or handoff when they shape the change.

## Phase 3 - Develop

Prefer small internal modules with clear responsibilities:

- runtime version constants
- safe error redaction
- config diagnostics
- session storage
- memory outbox
- MCP diagnostics
- safety gates

Rules:

- No raw API keys, bearer tokens, provider response bodies, or private paths in user-facing diagnostics.
- Do not depend on retired Agent Hub mailbox/state paths.
- Use active agentmemory when reachable; otherwise write only to the local DeepSeek CLI outbox.
- Keep the default permission model safe: preview writes, workspace sandbox, shell approvals on request.
- Keep runtime claims measurable. If the bundle size changes, remove stale size slogans.

## Phase 4 - Test

Before review, run the full local gate:

```bash
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` must build, run no-network E2E checks, and run the release scan.

For changes touching API, memory, sessions, safety, MCP, or config, add or update E2E coverage. Test offline/failed-service behavior, not only the happy path.

## Phase 5 - Release

1. Update `package.json`, runtime version constants, README, and package-lock when the change is version-level.
2. Ensure `config.toml` is safe as a packaged fallback.
3. Verify `npm pack --dry-run` contains only intended release files.
4. After verification and review, commit and push to the repo remote.

## Phase 6 - Maintenance

Keep these surfaces current:

- `README.md`
- `.github/workflows/ci.yml`
- `scripts/e2e.mjs`
- `scripts/release-scan.mjs`
- `config.toml`
- this skill file

Remove stale claims instead of layering corrections underneath them.

## Phase 7 - Monitoring

Use these checks when diagnosing user reports:

```bash
wwhale --doctor --json
wwhale --models --json
npm test
npm pack --dry-run
```

Inspect whether failures are in auth, endpoint config, MCP startup, session loading, memory save, shell approval, or file sandboxing.

## Phase 8 - Upgrade Iteration

For each substantial upgrade:

1. Re-read this skill and live project files.
2. Inspect at least one concrete source module from a mature open-source CLI relevant to the upgrade.
3. Implement the full batch.
4. Run all verification.
5. Only after the batch is complete, ask parallel reviewers to score architecture, safety, UX, tests, documentation, release readiness, and honesty.
6. Iterate until the score is 10/10 before commit and push.
