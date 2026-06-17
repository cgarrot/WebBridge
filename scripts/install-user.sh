#!/usr/bin/env bash
set -euo pipefail

REPO="${WEBBRIDGE_REPO:-cgarrot/WebBridge}"
VERSION="${WEBBRIDGE_VERSION:-latest}"
INSTALL_DIR="${WEBBRIDGE_INSTALL_DIR:-$HOME/.webbridge/WebBridge}"
AUTOSTART=1
START_DAEMON=1
PLATFORM=""
ARCH=""

usage() {
  cat <<'EOF'
Usage: bash scripts/install-user.sh [options]

Installs a prebuilt WebBridge release bundle for non-developer users.
No Node.js, pnpm, or local build is required.

Options:
  --install-dir <dir>  Install directory (default: ~/.webbridge/WebBridge)
  --repo <owner/repo>   GitHub repo (default: cgarrot/WebBridge)
  --version <tag>      Release tag (default: latest)
  --no-autostart       Do not configure login/startup service
  --no-start           Do not start the daemon after install
  -h, --help           Show this help

Environment overrides:
  WEBBRIDGE_REPO, WEBBRIDGE_VERSION, WEBBRIDGE_INSTALL_DIR
EOF
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

file_contains() {
  local file="$1"
  local needle="$2"
  [[ -f "$file" ]] || return 1
  case "$(cat "$file")" in
    *"$needle"*) return 0 ;;
    *) return 1 ;;
  esac
}

is_webbridge_install_dir() {
  local dir="$1"
  if file_contains "$dir/RELEASE-MANIFEST.json" '"schema": "webbridge.release-bundle.v1"' && file_contains "$dir/RELEASE-MANIFEST.json" '"name": "WebBridge"'; then
    return 0
  fi
  if file_contains "$dir/package.json" '"name": "webbridge"' && file_contains "$dir/packages/daemon/package.json" '"name": "@webbridge/daemon"'; then
    return 0
  fi
  return 1
}

configure_macos_autostart() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist="$plist_dir/com.webbridge.daemon.plist"
  mkdir -p "$plist_dir" "$INSTALL_DIR/.webbridge-data"
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || launchctl unload "$plist" >/dev/null 2>&1 || true
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.webbridge.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/bin/webbridge</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/.webbridge-data/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/.webbridge-data/launchd.err.log</string>
</dict>
</plist>
EOF
  if launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || launchctl load -w "$plist" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.webbridge.daemon" >/dev/null 2>&1 || true
    echo 1
  else
    echo "Could not configure macOS LaunchAgent; falling back to manual start." >&2
    echo 0
  fi
}

configure_linux_autostart() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found; skipping Linux autostart." >&2
    echo 0
    return
  fi
  local systemd_dir="$HOME/.config/systemd/user"
  local service="$systemd_dir/webbridge.service"
  mkdir -p "$systemd_dir"
  cat > "$service" <<EOF
[Unit]
Description=WebBridge local browser automation daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/bin/webbridge serve
Restart=on-failure
RestartSec=3
Environment=WEBBRIDGE_ROOT=$INSTALL_DIR

[Install]
WantedBy=default.target
EOF
  if systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now webbridge.service >/dev/null 2>&1; then
    echo 1
  else
    echo "Could not configure systemd user service; falling back to manual start." >&2
    echo 0
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:?Missing value for --install-dir}"; shift ;;
    --repo) REPO="${2:?Missing value for --repo}"; shift ;;
    --version) VERSION="${2:?Missing value for --version}"; shift ;;
    --no-autostart) AUTOSTART=0 ;;
    --no-start) START_DAEMON=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

need_cmd curl
need_cmd tar
need_cmd uname

case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux) PLATFORM="linux" ;;
  *) echo "Unsupported OS: $(uname -s). Use Windows PowerShell installer on Windows." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="webbridge-${PLATFORM}-${ARCH}.tar.gz"
if [[ "$VERSION" == "latest" ]]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$ASSET"
EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"

echo "Downloading WebBridge release bundle: $URL"
if ! curl -fL --retry 3 --retry-delay 2 -o "$ARCHIVE" "$URL"; then
  cat >&2 <<EOF

Could not download a prebuilt WebBridge release asset:
  $URL

If this is a new fork or no release exists yet, ask your agent to use the source-build fallback from docs/agent-install.md.
EOF
  exit 1
fi

tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"
BUNDLE_DIR="$EXTRACT_DIR/webbridge"
if [[ ! -x "$BUNDLE_DIR/bin/webbridge" ]]; then
  echo "Invalid release bundle: missing executable bin/webbridge" >&2
  exit 1
fi

if [[ -e "$INSTALL_DIR" ]]; then
  if ! is_webbridge_install_dir "$INSTALL_DIR"; then
    echo "Refusing to replace directory without a WebBridge release/source marker: $INSTALL_DIR" >&2
    exit 1
  fi
  if [[ -x "$INSTALL_DIR/bin/webbridge" ]]; then
    "$INSTALL_DIR/bin/webbridge" stop >/dev/null 2>&1 || true
  fi
fi

PARENT_DIR="$(dirname "$INSTALL_DIR")"
STAGING_DIR="$PARENT_DIR/.WebBridge.install.$$"
mkdir -p "$PARENT_DIR"
rm -rf "$STAGING_DIR"
cp -R "$BUNDLE_DIR" "$STAGING_DIR"
rm -rf "$INSTALL_DIR"
mv "$STAGING_DIR" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/bin/webbridge" "$INSTALL_DIR/bin/webbridge-daemon" 2>/dev/null || true

AUTOSTART_CONFIGURED=0
if [[ "$AUTOSTART" -eq 1 ]]; then
  if [[ "$PLATFORM" == "macos" ]]; then
    AUTOSTART_CONFIGURED="$(configure_macos_autostart || echo 0)"
  elif [[ "$PLATFORM" == "linux" ]]; then
    AUTOSTART_CONFIGURED="$(configure_linux_autostart || echo 0)"
  fi
fi

if [[ "$START_DAEMON" -eq 1 ]]; then
  if [[ "$AUTOSTART_CONFIGURED" != "1" ]]; then
    "$INSTALL_DIR/bin/webbridge" start || true
  else
    sleep 1
  fi
fi

cat <<EOF

✅ WebBridge installed.

Installed at:
  $INSTALL_DIR

Daemon status command:
  $INSTALL_DIR/bin/webbridge status

Agent Skill source files:
  $INSTALL_DIR/skills/cursor/SKILL.md
  $INSTALL_DIR/skills/claude-code/SKILL.md
  $INSTALL_DIR/skills/codex/SKILL.md
  $INSTALL_DIR/skills/openclaw/SKILL.md

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  One manual Chrome step remains
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Chrome does not let scripts install this unpacked extension automatically.
Do this once in the Chrome browser you want agents to control:

1. Open Chrome and go to:
   chrome://extensions

2. Turn on:
   Developer mode

3. Click:
   Load unpacked

4. When Chrome asks for a folder, select EXACTLY this folder:
   $INSTALL_DIR/extension

   Tip: select the folder named "extension" itself.
   Do NOT select manifest.json or any file inside the folder.

5. Verify connection:
   $INSTALL_DIR/bin/webbridge status

Expected after loading the extension:
  Extension: Connected

If you see "Extension: Not connected", reload the extension in chrome://extensions
or make sure you loaded the folder shown above.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF

if [[ "$START_DAEMON" -eq 1 ]]; then
  echo
  "$INSTALL_DIR/bin/webbridge" status || true
fi
