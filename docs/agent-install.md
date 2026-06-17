# WebBridge Agent Installer Prompt

Copy/paste this file into a coding agent, or ask the agent to fetch it from:

```text
https://raw.githubusercontent.com/cgarrot/WebBridge/main/docs/agent-install.md
```

---

You are setting up WebBridge browser automation for me.

## Goal

- Install or update WebBridge from the latest prebuilt GitHub release.
- Do not require me to install Node.js, npm, pnpm, or build tools when a release asset exists.
- Install the reusable WebBridge Skill for the AI agent/tool I am using.
- Enable WebBridge to start automatically when my machine/session starts, when supported by my OS.
- Start the daemon if possible.
- End by explaining exactly how I load the Chrome extension and verify the connection.

## Safety rules

- Do not use sudo, delete unrelated files, edit shell profiles, or commit changes unless I explicitly ask.
- Do not handle secrets or browser cookies directly.
- Download installer scripts from the official fork URL below; inspect them briefly before running if your environment allows it.
- If you are unsure where my agent stores skills, ask me for the skills directory instead of guessing.
- It is OK if Chrome extension connection is false until I manually load/reload the extension.

## Release-first install

Use the prebuilt installer for my OS.

### macOS / Linux

Download the installer script, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/cgarrot/WebBridge/main/scripts/install-user.sh -o /tmp/install-webbridge.sh
bash /tmp/install-webbridge.sh
```

The script downloads the right GitHub Release asset for the current OS/CPU, installs WebBridge to:

```text
~/.webbridge/WebBridge
```

It includes a bundled Node.js runtime, so Node.js/pnpm are not required for normal user install.

### Windows PowerShell

Download the installer script, then run it:

```powershell
$script = Join-Path $env:TEMP "install-webbridge.ps1"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/cgarrot/WebBridge/main/scripts/install-user.ps1" -OutFile $script
powershell -ExecutionPolicy Bypass -File $script
```

The script downloads the right GitHub Release asset and installs WebBridge to:

```text
%USERPROFILE%\.webbridge\WebBridge
```

## What the installer should do

- Download the latest matching release bundle from `https://github.com/cgarrot/WebBridge/releases/latest`.
- Install the portable bundle into the user install directory.
- Configure autostart when supported:
  - macOS: `~/Library/LaunchAgents/com.webbridge.daemon.plist`
  - Linux: `~/.config/systemd/user/webbridge.service`
  - Windows: user Scheduled Task named `WebBridge Daemon`
- Start the daemon or fall back to a manual `webbridge start` command.
- Print the Chrome extension folder to load manually.
- Print Skill source file paths.

## Install the Skill

After the release installer finishes, copy the matching Skill from the installed WebBridge folder.

Default installed Skill sources:

```text
~/.webbridge/WebBridge/skills/cursor/SKILL.md
~/.webbridge/WebBridge/skills/claude-code/SKILL.md
~/.webbridge/WebBridge/skills/codex/SKILL.md
~/.webbridge/WebBridge/skills/openclaw/SKILL.md
```

Windows equivalent:

```text
%USERPROFILE%\.webbridge\WebBridge\skills\...
```

Pick the best match for the agent I am using:

- Cursor: copy `skills/cursor/SKILL.md` to `.cursor/skills/webbridge-browser/SKILL.md` in the project where I want to use browser automation.
- Claude Code: copy `skills/claude-code/SKILL.md` to `~/.claude/skills/webbridge-browser/SKILL.md`, unless I give another Claude Code skills directory.
- Codex: copy `skills/codex/SKILL.md` to `~/.codex/skills/webbridge-browser/SKILL.md`, unless I give another Codex skills directory.
- OpenClaw / OpenCode-like tools: use `skills/openclaw/SKILL.md` only if that tool supports that skills format; otherwise ask me for the exact skills directory/format.

Create parent directories as needed. After copying, print the destination path.

## Chrome extension step, still manual

Chrome does not allow a normal script to silently install an unpacked extension into my regular logged-in Chrome profile.

Explain this step clearly:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the installed extension folder:

   macOS/Linux:

   ```text
   ~/.webbridge/WebBridge/extension
   ```

   Windows:

   ```text
   %USERPROFILE%\.webbridge\WebBridge\extension
   ```

5. Re-run the status command and confirm the extension is connected.

## Verify

macOS/Linux:

```bash
~/.webbridge/WebBridge/bin/webbridge status
curl -s http://127.0.0.1:10087/health
```

Windows PowerShell:

```powershell
& "$HOME\.webbridge\WebBridge\bin\webbridge.cmd" status
Invoke-RestMethod http://127.0.0.1:10087/health
```

Test navigation:

```bash
curl -s -X POST http://127.0.0.1:10087/api/tool \
  -H "Content-Type: application/json" \
  -d '{"name":"navigate","args":{"url":"https://example.com"}}'
```

## Source-build fallback only if no release exists

If the release asset is missing, explain that this fork may not have a release yet. Then use the developer fallback only if I approve installing developer prerequisites:

```bash
git clone https://github.com/cgarrot/WebBridge.git "$HOME/.webbridge/WebBridge"
cd "$HOME/.webbridge/WebBridge"
corepack enable
pnpm install
pnpm build
node packages/daemon/dist/cli/index.js start
```

This fallback requires Node.js >= 18 and pnpm >= 8, unlike the release installer.

## Final response format

- Installed/updated WebBridge at: `<path>`
- Release asset used: `<asset name or source-build fallback>`
- Skill installed at: `<path or needs-user-input>`
- Autostart: `<configured / skipped / failed with reason>`
- Daemon status: `<health summary>`
- Chrome extension step: `<exact folder to load>`
- Next command/test: `<one short command>`
