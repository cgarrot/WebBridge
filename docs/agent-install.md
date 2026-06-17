# WebBridge Agent Installer Prompt

Copy/paste this file into a coding agent, or ask the agent to fetch it from:

```text
https://raw.githubusercontent.com/cgarrot/WebBridge/main/docs/agent-install.md
```

---

You are setting up WebBridge browser automation for me.

## Goal

- Install or update WebBridge locally.
- Build the daemon and Chrome extension.
- Install the reusable WebBridge Skill for the AI agent/tool I am using.
- Start the daemon if possible.
- End by explaining exactly how I load the Chrome extension and verify the connection.

## Safety rules

- Do not use sudo, delete unrelated files, edit shell profiles, or commit changes unless I explicitly ask.
- Do not handle secrets or browser cookies directly.
- If you are unsure where my agent stores skills, ask me for the skills directory instead of guessing.
- It is OK if Chrome extension connection is false until I manually load/reload the extension.

## Steps

1. Detect whether the current directory is already the WebBridge repo. If not, install it under:

   ```bash
   $HOME/.webbridge/WebBridge
   ```

   using:

   ```bash
   git clone https://github.com/cgarrot/WebBridge.git "$HOME/.webbridge/WebBridge"
   ```

   If the directory already exists, pull or fetch only after checking for local changes.

2. Check prerequisites:

   ```bash
   node --version  # must be >= 18
   pnpm --version  # must be >= 8
   ```

   If `pnpm` is missing and `corepack` exists, run:

   ```bash
   corepack enable
   ```

   Otherwise tell me how to install pnpm.

3. Build/install WebBridge from the repo root:

   ```bash
   bash scripts/install-local.sh
   ```

4. Install the Skill. Pick the best match for the agent I am using:

   - Cursor: copy `skills/cursor/SKILL.md` to `.cursor/skills/webbridge-browser/SKILL.md` in the project where I want to use browser automation.
   - Claude Code: copy `skills/claude-code/SKILL.md` to `~/.claude/skills/webbridge-browser/SKILL.md`, unless I give another Claude Code skills directory.
   - Codex: copy `skills/codex/SKILL.md` to `~/.codex/skills/webbridge-browser/SKILL.md`, unless I give another Codex skills directory.
   - OpenClaw / OpenCode-like tools: use `skills/openclaw/SKILL.md` only if that tool supports that skills format; otherwise ask me for the exact skills directory/format.

   Create parent directories as needed. After copying, print the destination path.

5. Start the daemon:

   ```bash
   node packages/daemon/dist/cli/index.js start
   ```

   Then check:

   ```bash
   curl -s http://127.0.0.1:10087/health
   ```

6. Explain the manual Chrome extension install step clearly:

   - Open `chrome://extensions`
   - Enable `Developer mode`
   - Click `Load unpacked`
   - Select `<WebBridge repo>/packages/extension/dist`
   - Re-run `curl -s http://127.0.0.1:10087/health` and confirm `extension_connected: true`

7. Show me how to use it next:

   - Tell my agent: "Use WebBridge to control my Chrome browser."
   - Test navigation with:

     ```bash
     curl -s -X POST http://127.0.0.1:10087/api/tool \
       -H "Content-Type: application/json" \
       -d '{"name":"navigate","args":{"url":"https://example.com"}}'
     ```

## Final response format

- Installed/updated WebBridge at: `<path>`
- Skill installed at: `<path or needs-user-input>`
- Daemon status: `<health summary>`
- Chrome extension step: `<exact folder to load>`
- Next command/test: `<one short command>`
