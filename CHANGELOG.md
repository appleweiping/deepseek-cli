# Changelog

## 0.4.0 - Context, trust, and protocol hardening

### Added

- Ignore-aware, character-budgeted repository maps with concise symbol extraction
  for TypeScript/JavaScript, Python, Rust, Go, JVM, C/C++, C#, Ruby, PHP, and Swift.
- Persisted exact-directory trust for workspace-local TOML. Untrusted local config
  cannot redirect the API key to another endpoint or launch an MCP process;
  `--trust-workspace` records an explicit decision and `--doctor` reports scope.
- Official `@modelcontextprotocol/client` v2 integration with modern/legacy protocol
  negotiation, paginated discovery, output-schema validation, request deadlines,
  bounded stdio frames, provider-safe tool names, allow/deny filters, and ordered
  child-process shutdown.
- Windows + Ubuntu CI matrix and a production dependency audit gate.

### Fixed

- Blocked workspace-write escapes through file symlinks and Windows junctions.
- Stopped instruction, handoff, repository-map, and snapshot-size traversal from
  following linked content outside the workspace.
- Contained malformed tool arguments/handler exceptions so one bad call no longer
  tears down the entire agent turn.
- Added runtime TOML type/range validation, prototype-pollution key rejection, and
  field-specific startup errors.
- Hardened HTTP/SSE responses with no-store/nosniff headers, stable 400/413/405
  semantics, bounded-body draining, keep-alive reuse after rejected requests, and
  redacted streamed errors.
- Kept persisted workspace trust bound to the original canonical identity when a
  trusted pathname is later replaced by a symlink or junction.
- Made MCP tool names collision-resistant across servers, capped pathological
  pagination/output/latency paths in regression tests, and awaited SDK shutdown.
- Ranked repo-map candidates before applying the file cap and continued packing
  smaller entries when a symbol-heavy block exceeds the remaining character budget.
- Reported auto routing explicitly alongside the real provider model, and pinned CI
  to the declared Node.js 22.18.0 compatibility floor.
- Upgraded `js-yaml` to 4.3.1, fixing the high-severity quadratic CPU advisories
  GHSA-52cp-r559-cp3m and GHSA-5p4m-2wfm-xmqj.
- Upgraded the TypeScript build runner/toolchain, removed all remaining audited
  development vulnerabilities, and made the required Node.js 22.18 floor explicit.

### Verification

- `npm run typecheck`
- `npm test` (build + 17 focused E2E suites + package install smoke + release scan)
- `npm run audit:prod` (0 production vulnerabilities)
- `npm audit --audit-level=low` (0 known vulnerabilities across all dependencies)

### Design references

- Aider (Apache-2.0): repository-map context budgeting.
- OpenAI Codex and Gemini CLI (Apache-2.0): workspace boundaries, instruction and
  trust patterns.
- Official MCP TypeScript SDK (MIT/Apache-2.0): protocol implementation.

## 0.3.0 - WEIPING_WHALE (CodeWhale-parity port)

The project was renamed from **DEEPSEEK_CLI** to **WEIPING_WHALE** and grew a large
set of features ported from [CodeWhale](https://github.com/Hmbown/CodeWhale) (MIT),
re-implemented in TypeScript. State now lives under `~/.weiping-whale` with automatic
fallback to the legacy `~/.deepseek-cli` so existing sessions/config keep working.
Each feature group was built behind a tri-agent review gate (Opus lead + Opus#2 +
Codex GPT-5.5), which caught and fixed real data-loss and security bugs before merge.

### Added

- **Side-git snapshots** — a separate git repo under the state root (never touches
  your `.git`) checkpoints the workspace around every turn. `/snapshots`, `/restore <id>`,
  `/undo`, and a `revert_turn` tool. Fail-closed restore with symlink/traversal/`.git`
  guards, SHA-256 workspace keying, interprocess lock, 7-day prune.
- **Session fork & backtrack** — `/fork` branches a session, `/backtrack [n]` rewinds
  user-turns, `--last` and `--resume <id|prefix>` resume; richer session schema with
  title, parent lineage, token/cost bookkeeping.
- **Live cost + prefix-cache tracking** — per-model pricing, cache-hit vs miss billing,
  a footer chip (red <40%, yellow <80%), and `/cost`.
- **Stronger compaction** — `/compact` (model summary) and `/compact fast` (offline
  heuristic): pins recent/errors/patches/working-set, preserves tool-call pairing.
- **Constitution prompt** — an authority-tiered system prompt assembled most-static →
  most-volatile for prefix-cache efficiency; project `<instructions>`, skills catalog,
  and a `/handoff` session relay (`.weiping-whale/handoff.md`).
- **Auto routing ("Fin")** — `--model auto` / `/model auto`: a zero-cost keyword
  heuristic picks model + thinking level per turn (multilingual, word-boundary aware).
- **Skills** — discovers `SKILL.md` across workspace + global roots (cross-tool with
  `.claude`/`.agents`), injects a budgeted catalog; `/skills install owner/repo`
  installs from GitHub with symlink/traversal defenses and atomic overwrite.
- **Bounded sub-agents** — `agent_open`/`agent_eval` run background child agents
  (pool cap 4, depth cap 2, per-child timeout, isolated config).
- **LSP diagnostics** — post-edit diagnostics from `typescript-language-server` and
  `pyright-langserver`, fed back as an escaped `<diagnostics>` block; servers resolved
  to trusted absolute paths, best-effort and silent when absent.
- **Vision** — attach images (`/image`) sent as OpenAI-compatible `image_url` blocks.
- **Optional HTTP/SSE API** — `--serve` starts a localhost-only, bearer-token-protected
  control surface (`/health`, `POST /v1/message`, `POST /v1/stream` SSE, `/v1/cost`)
  with in-flight/SSE caps and turns serialized with the REPL. Off by default.

### Attribution

WEIPING_WHALE is based on CodeWhale (https://github.com/Hmbown/CodeWhale), MIT-licensed.
Features were re-implemented in TypeScript rather than copied; CodeWhale remains the
mature Rust implementation of the same idea.

### Verification

- `npm run typecheck`
- `npm test` (build + 12 focused e2e suites + package smoke + release scan)

### Known Limitations

- No OS sandbox: shell safety is pattern-based approval gates, not OS-level isolation.
- LSP requires the language servers to be installed; absent servers degrade silently.
- E2E tests do not make live DeepSeek API calls.

## 0.2.0 - Honest Runtime Release

This release turns DeepSeek CLI from a useful local prototype into a more honest, release-gated terminal agent.

### Added

- Structured `deepseek --doctor --json` diagnostics with version, runtime, auth source, endpoint host, paths, safety modes, memory state, MCP state, tools, and config checks.
- Safe runtime helpers for redacting secret-looking text in errors.
- Local memory outbox under `~/.deepseek-cli/memory-outbox` or `DEEPSEEK_MEMORY_OUTBOX_DIR` when agentmemory is unavailable.
- Corrupt-session tolerance for session listing and resume checks.
- Release scan for stale local paths, secret-looking values, README/package mismatches, and package manifest expectations.
- Package install smoke test that packs the project, installs the tarball in a temp app, and runs the installed `deepseek` binary.
- Project maintenance skill at `.codex/skills/deepseek-cli/SKILL.md`.

### Changed

- Removed old Agent Hub mailbox and repo-local markdown memory assumptions.
- Packaged fallback config is now public-safe and generic.
- Provider and MCP errors are redacted by default.
- MCP subprocesses receive a minimal environment plus explicitly configured server env.
- `/monitor start` now respects shell risk classification and approval mode.
- README was rewritten around measurable behavior and current package size rather than stale bundle-size slogans.

### Verification

- `npm run typecheck`
- `npm test`
- `npm pack --dry-run`

### Known Limitations

- E2E tests do not make live DeepSeek API calls.
- Shell safety is pattern-based and should not be treated as a hardened OS sandbox.
- MCP server trust remains user-configured; only environment inheritance is minimized by default.

## 0.1.0

Initial public terminal-agent baseline.
