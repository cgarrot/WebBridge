# WebBridge

Browser automation toolkit for AI tools. Consists of three components:

- **Chrome Extension** — MV3 extension that controls the browser via Chrome DevTools Protocol (CDP)
- **Daemon** — Local Node.js service that bridges AI tools with the extension
- **Skills** — Integration files for Claude Code, Codex, OpenClaw, etc.

## Architecture

```
AI Tool (Claude Code / Codex / OpenClaw)
  │
  │  HTTP POST /api/tool
  ▼
Daemon (Node.js)
  │
  │  Native Messaging (local) or WebSocket (remote)
  ▼
Chrome Extension (MV3 Service Worker)
  │
  │  chrome.debugger (CDP)
  ▼
Browser Tabs
```

The extension supports **dual transport**: Native Messaging for secure local communication, and WebSocket for remote or development scenarios. Both use the same JSON message protocol.

## Quick Start

### Prerequisites

- Node.js >= 18
- pnpm >= 8
- Google Chrome

### Install

```bash
git clone <repo-url>
cd webbridge
pnpm install
```

### Build

```bash
# Build all packages
pnpm build

# Or build individually
pnpm build:shared
pnpm build:daemon
pnpm build:extension
```

### Load the Extension

1. Build the extension: `pnpm build:extension`
2. Open Chrome → `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" → select `packages/extension/dist`

### Start the Daemon

```bash
# Development (with auto-reload)
pnpm dev:daemon

# Production
pnpm build:daemon
cd packages/daemon && pnpm start
```

### Install Native Messaging Host (optional)

For Native Messaging support:

```bash
cd packages/daemon
pnpm install-host
```

Then update `allowed_origins` in the generated manifest with your extension ID.

### Verify

```bash
curl http://127.0.0.1:10087/api/status
# {"status":"ok","connections":1,"version":"0.1.0"}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `navigate` | Navigate a tab to a URL |
| `screenshot` | Capture page screenshot (base64) |
| `click` | Click at page coordinates |
| `fill` | Fill a form field |
| `evaluate` | Execute JavaScript |
| `snapshot` | Get DOM or accessibility tree |
| `list_tabs` | List all open tabs |
| `find_tab` | Find tabs by title/URL |
| `close_tab` | Close a tab |
| `send_keys` | Send keyboard events |
| `save_as_pdf` | Export page as PDF |
| `upload` | Upload files to file input |

## AI Tool Integration

Copy the appropriate skill file to your AI tool's skill directory:

- **Claude Code / Cursor**: `skills/claude-code/SKILL.md`
- **Codex**: `skills/codex/SKILL.md`
- **OpenClaw**: `skills/openclaw/SKILL.md`

## Project Structure

```
webbridge/
├── packages/
│   ├── shared/      # Shared types and protocol definitions
│   ├── daemon/      # Local daemon service
│   └── extension/   # Chrome MV3 extension
├── skills/          # AI tool skill files
└── docs/            # Documentation
```

## Configuration

The daemon is configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBBRIDGE_WS_HOST` | `127.0.0.1` | WebSocket listen host |
| `WEBBRIDGE_WS_PORT` | `10086` | WebSocket listen port |
| `WEBBRIDGE_HTTP_PORT` | `10087` | HTTP API listen port |
| `WEBBRIDGE_LOG_LEVEL` | `info` | Log level |
| `WEBBRIDGE_TOOL_TIMEOUT_MS` | `60000` | Tool call timeout |
| `WEBBRIDGE_NATIVE_HOST` | `0` | Set to `1` for native host mode |

## License

MIT
