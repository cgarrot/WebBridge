#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTTP_PORT="${WEBBRIDGE_HTTP_PORT:-10087}"
WS_PORT="${WEBBRIDGE_WS_PORT:-10088}"
START_NOW=1
UNINSTALL=0
LABEL="com.webbridge.daemon"

usage() {
  cat <<'EOF'
Usage: bash scripts/install-autostart.sh [options]

Configures WebBridge source checkout autostart for the current user.

Options:
  --no-start     Configure autostart but do not start/kickstart now
  --uninstall    Remove the current user's WebBridge autostart service
  -h, --help     Show this help

Environment overrides:
  WEBBRIDGE_HTTP_PORT, WEBBRIDGE_WS_PORT
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start) START_NOW=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Missing required command: node" >&2
  exit 1
fi

DAEMON_CLI="$ROOT_DIR/packages/daemon/dist/cli/index.js"
if [[ ! -f "$DAEMON_CLI" ]]; then
  need_cmd pnpm
  echo "WebBridge daemon build missing; running pnpm build:daemon..."
  (cd "$ROOT_DIR" && pnpm build:daemon)
fi

if [[ ! -f "$DAEMON_CLI" ]]; then
  echo "Daemon CLI build not found after build: $DAEMON_CLI" >&2
  exit 1
fi

DATA_DIR="$ROOT_DIR/.webbridge-data"
mkdir -p "$DATA_DIR"

configure_macos() {
  local uid plist out_log err_log
  uid="$(id -u)"
  plist="$HOME/Library/LaunchAgents/${LABEL}.plist"
  out_log="$DATA_DIR/launchd.out.log"
  err_log="$DATA_DIR/launchd.err.log"
  mkdir -p "$(dirname "$plist")" "$DATA_DIR"

  if [[ "$UNINSTALL" -eq 1 ]]; then
    launchctl bootout "gui/${uid}/${LABEL}" >/dev/null 2>&1 || launchctl bootout "gui/${uid}" "$plist" >/dev/null 2>&1 || true
    rm -f "$plist"
    echo "Removed macOS LaunchAgent: $plist"
    return
  fi

  # Stop a previously-started detached daemon to avoid port conflicts with launchd.
  if [[ -f "$DAEMON_CLI" ]]; then
    "$NODE_BIN" "$DAEMON_CLI" stop >/dev/null 2>&1 || true
  fi
  launchctl bootout "gui/${uid}/${LABEL}" >/dev/null 2>&1 || launchctl bootout "gui/${uid}" "$plist" >/dev/null 2>&1 || true

  /usr/bin/python3 - "$plist" "$LABEL" "$NODE_BIN" "$DAEMON_CLI" "$ROOT_DIR" "$HTTP_PORT" "$WS_PORT" "$out_log" "$err_log" <<'PY'
import plistlib
import sys

plist_path, label, node_bin, daemon_cli, root_dir, http_port, ws_port, out_log, err_log = sys.argv[1:]
plist = {
    "Label": label,
    "ProgramArguments": [node_bin, daemon_cli, "serve"],
    "WorkingDirectory": root_dir,
    "EnvironmentVariables": {
        "WEBBRIDGE_ROOT": root_dir,
        "WEBBRIDGE_HTTP_PORT": http_port,
        "WEBBRIDGE_WS_PORT": ws_port,
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "StandardOutPath": out_log,
    "StandardErrorPath": err_log,
}
with open(plist_path, "wb") as fh:
    plistlib.dump(plist, fh, sort_keys=False)
PY

  plutil -lint "$plist" >/dev/null
  launchctl bootstrap "gui/${uid}" "$plist"
  launchctl enable "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
  if [[ "$START_NOW" -eq 1 ]]; then
    launchctl kickstart -k "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
  fi

  echo "Configured macOS LaunchAgent: $plist"
  echo "Logs:"
  echo "  $out_log"
  echo "  $err_log"
}

configure_linux() {
  local service_dir service
  service_dir="$HOME/.config/systemd/user"
  service="$service_dir/webbridge.service"
  mkdir -p "$service_dir" "$DATA_DIR"

  if [[ "$UNINSTALL" -eq 1 ]]; then
    systemctl --user disable --now webbridge.service >/dev/null 2>&1 || true
    rm -f "$service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    echo "Removed systemd user service: $service"
    return
  fi

  cat > "$service" <<EOF
[Unit]
Description=WebBridge local browser automation daemon
After=default.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
ExecStart=$NODE_BIN $DAEMON_CLI serve
Restart=always
RestartSec=3
Environment=WEBBRIDGE_ROOT=$ROOT_DIR
Environment=WEBBRIDGE_HTTP_PORT=$HTTP_PORT
Environment=WEBBRIDGE_WS_PORT=$WS_PORT
StandardOutput=append:$DATA_DIR/systemd.out.log
StandardError=append:$DATA_DIR/systemd.err.log

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  if [[ "$START_NOW" -eq 1 ]]; then
    systemctl --user enable --now webbridge.service
  else
    systemctl --user enable webbridge.service
  fi
  echo "Configured systemd user service: $service"
}

case "$(uname -s)" in
  Darwin)
    need_cmd launchctl
    need_cmd plutil
    configure_macos
    ;;
  Linux)
    need_cmd systemctl
    configure_linux
    ;;
  *)
    echo "Unsupported OS for this script: $(uname -s)" >&2
    exit 1
    ;;
esac

if [[ "$UNINSTALL" -eq 0 && "$START_NOW" -eq 1 ]]; then
  sleep 1
  "$NODE_BIN" "$DAEMON_CLI" status || true
fi
