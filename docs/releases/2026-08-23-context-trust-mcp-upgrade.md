# 2026-08-23 Context, Trust, and MCP Upgrade

This upgrade strengthens WEIPING_WHALE as a compact but production-minded coding
agent. It was implemented from public interfaces and documented design patterns;
no upstream source was copied into this repository.

## Upstream references

- [Aider](https://github.com/Aider-AI/aider), Apache-2.0 — budgeted repository-map
  context for navigating large codebases.
- [OpenAI Codex](https://github.com/openai/codex), Apache-2.0 — explicit workspace
  boundaries and scoped project guidance.
- [Gemini CLI](https://github.com/google-gemini/gemini-cli), Apache-2.0 — explicit
  trust before repository-controlled configuration can activate powerful features.
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk),
  MIT/Apache-2.0 — official protocol negotiation, transports, pagination, schemas,
  cancellation/timeouts, and process shutdown.

## Materialized changes

- Added a deterministic, ignore-aware repository map with strict file/character
  budgets, multi-language symbol extraction, and symlink containment.
- Trust-gated workspace-local TOML so an unreviewed repository cannot redirect the
  API endpoint or launch MCP servers simply by being opened.
- Replaced the hand-written MCP transport with the official v2 client SDK and added
  tool allow/deny filters plus provider-compatible exposed names.
- Closed symlink/junction write escapes and related instruction/handoff/snapshot
  traversal paths.
- Added runtime config validation, tool exception containment, HTTP/SSE hardening,
  two-OS CI, and production dependency auditing.
- Bound trust records to their grant-time canonical identity, made exposed MCP names
  collision-resistant across servers, and made SDK child shutdown awaitable.
- Ranked repository-map candidates before truncation, kept filling character budgets
  after oversized entries, and avoided unbounded filesystem fallback after a bounded
  Git listing times out or exceeds its output cap.
- Exposed `routing=auto` separately from the real provider model and verified
  keep-alive reuse after HTTP 400/405/413 responses.
- Upgraded `js-yaml` from 4.2.0 to 4.3.1 to remove two high-severity CPU-exhaustion
  advisories.
- Upgraded the build runner and its transitive toolchain, resulting in a clean full
  dependency audit; the supported runtime floor is now Node.js 22.18.

## Verification boundary

The full suite exercises the CLI, official MCP stdio transport, paginated discovery,
structured/tool-error results, repository maps, workspace trust, Windows-safe path
containment, snapshots, sessions, skills, sub-agents, vision payloads, real TypeScript
LSP diagnostics, HTTP/SSE behavior, packed installation, and release scanning.

Live DeepSeek inference is intentionally not part of CI because it would require a
real secret and introduce nondeterministic network/cost dependencies. The project has
no browser UI, so browser automation is not applicable; the optional HTTP/SSE surface
is validated directly through end-to-end HTTP requests.
