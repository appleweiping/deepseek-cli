<p align="center">
  <img src="https://raw.githubusercontent.com/appleweiping/WEIPING_WHALE/master/assets/banner.png" alt="WEIPING_WHALE" width="720" />
</p>

<p align="center">
  <strong>WEIPING_WHALE — a terminal-native DeepSeek coding agent.</strong>
</p>

<p align="center">
  Budgeted repo maps · side-git snapshots · session fork/backtrack · auto model routing ·
  skills · sub-agents · LSP diagnostics · official MCP SDK · optional local HTTP/SSE API.
</p>

WEIPING_WHALE is a focused coding-agent CLI for people who want a small, honest
terminal tool rather than a web app. It inspects files, searches with glob/grep,
runs shell commands behind approval gates, previews edits as patches, checkpoints
your workspace around every turn so you can `/undo`, routes between DeepSeek models
per turn, supplies an ignore-aware map of the repository, connects MCP servers through
the official SDK, and can expose a localhost HTTP/SSE control surface.

> **Based on [CodeWhale](https://github.com/Hmbown/CodeWhale) (MIT).** WEIPING_WHALE
> re-implements CodeWhale's feature set in TypeScript. CodeWhale is the mature Rust
> implementation of the same idea; this is a smaller, hackable TS sibling.
> Not affiliated with DeepSeek Inc.

## Install

Requires Node.js 22.18 or newer.

```bash
npm install -g weiping-whale
```

Or run from source:

```bash
git clone https://github.com/appleweiping/WEIPING_WHALE.git
cd WEIPING_WHALE
npm ci
npm run build
node dist/index.js --doctor
```

The CLI installs three binaries: `weiping-whale`, `wwhale`, and `deepseek` (a
back-compat alias). State lives in `~/.weiping-whale/` (falling back to a legacy
`~/.deepseek-cli/` if present, so existing sessions keep working).

## First Run

```bash
export DEEPSEEK_API_KEY="<your-key>"
wwhale --doctor
wwhale
```

Useful invocations:

```bash
wwhale -t "summarize the architecture of this repo"
wwhale --model auto -t "find and fix the failing test"
wwhale --model pro --thinking max -t "review this change for security gaps"
wwhale --last
wwhale --serve --port 7878
```

## Features

| Area | What it does |
| --- | --- |
| Model runtime | DeepSeek V4 Pro/Flash presets, thinking controls, `--model auto` per-turn routing |
| Repository context | ignore-aware, budgeted file/symbol map for large-codebase orientation |
| File work | `read_file`, `write_file`, `edit_file`, `glob`, `grep` |
| Shell work | `execute_bash` with blocked-command rules, approval queue, bounded timeout |
| Patch safety | writes default to preview; apply with `/apply <id>` |
| Snapshots | side-git checkpoints each turn; `/snapshots`, `/restore`, `/undo`, `revert_turn` |
| Sessions | named sessions, `/fork`, `/backtrack`, `--last`, resume by id/prefix |
| Cost | live cost + prefix-cache-hit footer chip; `/cost` |
| Compaction | `/compact` (model summary) and `/compact fast` (offline), tool-call-safe |
| Skills | workspace + global `SKILL.md` discovery; `/skills install owner/repo` |
| Sub-agents | `agent_open` / `agent_eval` bounded background workers |
| LSP | post-edit diagnostics from TypeScript + Python language servers |
| Vision | attach images with `/image`; sent as `image_url` content blocks |
| MCP | official MCP TypeScript SDK v2: current/legacy negotiation, pagination, schemas, timeouts, clean shutdown |
| HTTP API | optional `--serve` localhost control surface with bearer-token auth |
| Memory | agentmemory REST when reachable; local outbox when offline |

## Repository map

At session start, WEIPING_WHALE builds a deterministic map of git-visible source
and project files. It extracts concise top-level symbols for common languages and
keeps the map within a strict character/file budget. Gitignored files, build output,
binary assets, and symlink escapes are excluded. The map is orientation only—the
agent is explicitly told to open files before relying on implementation details.

```toml
[context]
repo_map_enabled = true
repo_map_max_chars = 12000
repo_map_max_files = 400
```

## Snapshots & undo

Every turn is checkpointed into a **separate** git repository under
`~/.weiping-whale/snapshots/` — your own `.git` is never touched. If a turn makes
a mess, `/undo` rolls the workspace back, `/restore <id>` jumps to a specific
snapshot, and the model can call `revert_turn` to undo its own edits.

## Auto routing

With `--model auto` (or `/model auto`), a fast zero-cost keyword heuristic picks
the model and thinking level for each turn: hard signals (debug, error, 调试, デバッグ)
route to `pro` + max thinking, light ones (search, format, 格式化) to `flash`, and
everything else to a sensible default.

## Skills

Drop a folder containing a `SKILL.md` (YAML frontmatter `name` + `description`)
into `.weiping-whale/skills/` (workspace) or `~/.weiping-whale/skills/` (global).
WEIPING_WHALE also discovers `.claude/skills` and `.agents/skills` for cross-tool
reuse, and can install from GitHub:

```bash
# inside the REPL
/skills list
/skills install owner/repo
```

## LSP diagnostics

After a direct file write or `/apply`, WEIPING_WHALE asks a language server for
diagnostics and feeds errors back to the model. Install the servers you want:

```bash
npm install -g typescript-language-server typescript   # TypeScript/JavaScript
npm install -g pyright                                  # Python
```

Diagnostics are best-effort: if a server isn't installed, it's skipped silently.

## HTTP/SSE API (optional, off by default)

`wwhale --serve` starts a control surface bound to `127.0.0.1` that requires a
bearer token (auto-generated and printed once at startup):

```
GET  /health                      # unauthenticated liveness
GET  /v1/cost                     # session cost snapshot
POST /v1/message  {"message":"…"} # run a turn, returns { reply }
POST /v1/stream   {"message":"…"} # Server-Sent Events: start / reply / done
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"list the open TODOs"}' \
  http://127.0.0.1:7878/v1/message
```

Turns are serialized with the interactive REPL, in-flight turns and SSE
connections are capped, and the prompt is sent in the request body (never the
URL). Binding to a non-localhost host prints a loud warning — anyone who can
reach the host and token can drive the agent.

## Safety profiles

Use `/permission-model <mode>` or the equivalent environment variables.

| Profile | Writes | Sandbox | Shell |
| --- | --- | --- | --- |
| `safe` | preview | workspace only | ask for risky commands |
| `read-only` | blocked | read-only | ask for risky commands |
| `trusted` | direct | unrestricted | auto-run except blocked patterns |
| `locked` | preview | read-only | never run risky commands |

The default is `safe`. Broadly destructive shell commands stay blocked even in
permissive modes. Workspace writes reject lexical escapes and symlink/junction
traversal. This is approval-gating and path containment, **not** an OS sandbox.

## Workspace config trust

A repository can place `weiping-whale.toml` in its root. That file can redirect
the provider endpoint (and therefore an API key) or launch MCP child processes, so
workspace-local TOML is ignored until that exact canonical directory is trusted:

```bash
wwhale --cwd path/to/repo --trust-workspace --doctor
```

The decision is stored in `~/.weiping-whale/trusted-workspaces.json`. Explicit
`WEIPING_WHALE_CONFIG` / `DEEPSEEK_CONFIG` paths and user-level config remain
available without workspace trust because choosing them is already an explicit
user action. `--doctor` reports the active config scope and any ignored local file.

## Configuration

WEIPING_WHALE loads the first eligible config file it finds:

1. `WEIPING_WHALE_CONFIG` / `DEEPSEEK_CONFIG`
2. trusted `./weiping-whale.toml` / `./.weiping-whale.toml`
3. trusted `./deepseek-cli.toml` / `./.deepseek-cli.toml`
4. `~/.weiping-whale/config.toml` / `~/.deepseek-cli/config.toml`
5. the packaged fallback `config.toml`

```toml
[llm]
model = "flash"
api_key_env = "DEEPSEEK_API_KEY"
base_url = "https://api.deepseek.com"

[agent]
workspace = "."
max_iterations = 50

[snapshots]
enabled = true
retention_days = 7

[subagents]
max_agents = 4
max_depth = 2

[lsp]
enabled = true
include_warnings = false

[context]
repo_map_enabled = true
repo_map_max_chars = 12000
repo_map_max_files = 400

# MCP servers use the official SDK. Optional include_tools is an allowlist;
# exclude_tools removes individual tools after paginated discovery.
[mcp_servers.example]
command = "node"
args = ["server.mjs"]
timeout_ms = 60000
include_tools = ["search", "read"]
```

## Diagnostics

`wwhale --doctor --json` prints a structured report (runtime, endpoint host, auth
source, paths, safety modes, MCP state) and exits non-zero on required-check
failures. It never prints API keys, tokens, or full provider URLs.

## Development

```bash
npm ci
npm run typecheck
npm test          # build + e2e suites + package smoke + release scan
npm run audit:prod
```

CI runs the full gate on both Ubuntu and Windows.

## Relationship to Neighbor Projects

- `WEIPING_WHALE` is the terminal coding worker. It owns its local sessions,
  checkpoints, `.weiping-whale/handoff.md`, tools, and optional HTTP/SSE surface.
- `WEIPING_COUNCIL` owns multi-model deliberation and its own council-session JSON
  contract; Whale does not reinterpret those files as native Whale sessions.
- `WEIPING_LAB` owns research-workbench artifacts. Paths or redacted summaries can be
  handed over explicitly, but neither project is a runtime dependency of the other.
- `WEIPING_WIKI` is the public route map and `AGENT_RESOURCE` is an optional shared
  skill library. Whale remains usable without either checkout or any private local path.

## Upstream design references

This release re-implements compatible patterns rather than copying source:

- [Aider](https://github.com/Aider-AI/aider) (Apache-2.0): budgeted repository maps.
- [OpenAI Codex](https://github.com/openai/codex) (Apache-2.0): explicit workspace boundaries and project instructions.
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Apache-2.0): trust-gating repository-local configuration.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT/Apache-2.0): the official client is used directly as a dependency.

## Relationship to CodeWhale

CodeWhale (formerly `deepseek-tui`) is a large, mature Rust coding agent.
WEIPING_WHALE is an independent TypeScript project that ports CodeWhale's ideas
at a much smaller scale, keeping the core hackable. Where CodeWhale ships OS
sandboxing and a 7-language LSP stack, WEIPING_WHALE stays honest about being a
TS tool: approval-gated shell (no OS sandbox) and a TypeScript/Python LSP subset.

## License

MIT
