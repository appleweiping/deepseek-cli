# 2026-06-04 UUPF DEEPSEEK_CLI Upgrade

This repository was reviewed with a local Universal Upgrade Forge checkout. The
operator-specific tool location is deliberately not part of this public release.

Local audit run:

- The run stayed in an ignored local audit work area.
- 108 iteration records were generated from a Git archive snapshot to avoid
  copying `node_modules`, local sessions, logs, or config artifacts.
- UUPF produced an offline upgrade plan; public repository changes were
  materialized manually.

Materialized changes:

- Promoted the public project identity from `deepseek-cli` to `DEEPSEEK_CLI`.
- Updated README banner and naming text.
- Added this traceable upgrade note.

Safety boundary:

- Keep API keys, provider URLs, local session transcripts, agentmemory outbox
  data, MCP environment variables, and logs out of public commits.
