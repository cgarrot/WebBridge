# AGENTS.md — WebBridge

Instructions for AI coding agents working in this repository.

## Project Overview

WebBridge is a **browser automation bridge for AI tools**. Three components:

| Component | Path | Role |
|-----------|------|------|
| Chrome Extension | `packages/extension/` | MV3 extension; controls tabs via CDP (`chrome.debugger`) |
| Daemon | `packages/daemon/` | Local Node.js service; HTTP API + WebSocket + Native Messaging |
| Shared | `packages/shared/` | Protocol types, tool names, constants |

AI agents call the daemon at `http://127.0.0.1:10087/api/tool` — they do **not** talk to the extension directly.

## Build & Run Commands

```bash
pnpm install
pnpm build                    # build all packages
pnpm build:shared             # types only
pnpm build:daemon             # daemon bundle
pnpm build:extension          # extension → packages/extension/dist
pnpm dev:daemon               # daemon with watch mode
```

Verify daemon + extension connection:

```bash
curl -s http://127.0.0.1:10087/api/status
# {"status":"ok","connections":1,"version":"0.1.0"}
```

Call a tool:

```bash
curl -s -X POST http://127.0.0.1:10087/api/tool \
  -H "Content-Type: application/json" \
  -d '{"name":"navigate","args":{"url":"https://example.com"}}'
```

## Architecture (short)

```
AI Tool → HTTP POST /api/tool → Daemon → Native Messaging | WebSocket → Extension → CDP → Browser
```

- Tool registry uses Strategy pattern in `packages/extension/src/background/tools/`
- New tools: add type in `packages/shared/src/tools.ts`, implement class, register in `tools/index.ts`
- Dual transport: Native Messaging (local, secure) or WebSocket (remote/dev)

## Code Conventions

- TypeScript strict mode; monorepo with pnpm workspaces
- Shared types live in `@webbridge/shared` — never duplicate protocol types
- Config via environment variables (see README Configuration table), not hardcoded
- Tool names are snake_case strings matching `TOOL_NAMES` in `packages/shared/src/tools.ts`

## Testing & Verification

No automated test suite yet. After changes:

1. `pnpm build` — must succeed
2. Load extension from `packages/extension/dist` in Chrome
3. `pnpm dev:daemon` and `curl` status + one tool call

## Tab Lifecycle (no infinite windows)

Tab creation is centralized in `sessionManager.acquireTab()` (create-or-reuse):

- `navigate`/`preload_navigate` with `newTab:true` **reuse** an existing session tab by default (preferring one on the same site). Use `forceNewTab:true` only when a genuinely new tab is needed.
- Hard cap `MAX_AGENT_TABS` (8, in `@webbridge/shared`): the oldest non-primary agent tab is auto-closed when exceeded — runaway tab creation is impossible.
- Load waits honor `waitUntil` via CDP with short bounded timeouts (`load`≈6s, `networkidle`≈10s, `domcontentloaded`=none, omitted≈1.5s settle). SPAs that never "complete" still return fast with `loaded:false`.
- The daemon collapses identical in-flight/recent `navigate`/`new_tab` calls (idempotent retries).
- `trackedTabs` self-heal via `chrome.tabs.onRemoved`; `list_tabs` reports `tracked`/`primary`.

Smoke test: `node scripts/test-tab-lifecycle.mjs` (requires running daemon + connected extension).

## Boundaries — Do Not Touch

- Do not commit `.env`, credentials, or API keys
- Do not hardcode ports, timeouts, or paths — use env vars / config module
- Do not bypass `ToolRegistry` to call CDP directly from daemon
- `scripts/` at repo root are local dev scripts, not part of the published API

## Skills Distribution

Pre-built agent skills for end users live in `skills/`:

- `skills/cursor/SKILL.md` — Cursor
- `skills/claude-code/SKILL.md` — Claude Code
- `skills/codex/SKILL.md` — Codex
- `skills/openclaw/SKILL.md` — OpenClaw

When adding or renaming tools, update the relevant skill files.

## Key Docs

- `README.md` — human-facing overview
- `docs/architecture.md` — detailed design (Chinese)
- `docs/protocol.md` — message protocol (Chinese)
