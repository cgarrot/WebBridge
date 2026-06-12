#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTTP_PORT="${WEBBRIDGE_HTTP_PORT:-10087}"
WS_PORT="${WEBBRIDGE_WS_PORT:-10088}"
OPEN_URL="about:blank"
TIMEOUT_SECONDS=20
DEV_PROFILE=0
RELOAD_EXTENSION=0
START_DAEMON=1
BUILD_IF_MISSING=1
PROFILE_DIR="$ROOT_DIR/.webbridge-data/chrome-profile"

usage() {
  cat <<'EOF'
Usage: bash scripts/launch-local.sh [options]

Starts WebBridge, opens Chrome, and waits for the extension to connect.

Options:
  --url <url>           Page to open after launching Chrome (default: about:blank)
  --timeout <seconds>   Time to wait for extension connection (default: 20)
  --dev-profile         Launch a dedicated Chrome profile with --load-extension.
                        This guarantees the unpacked extension is loaded, but does
                        NOT reuse your normal Chrome login/session cookies.
  --profile-dir <dir>   Profile directory for --dev-profile
  --reload-extension    If already connected, ask the extension to reload from disk
  --no-daemon           Do not start the daemon
  --no-build            Do not auto-build when dist files are missing
  -h, --help            Show this help

What this can and cannot do:
  - Can start the local daemon and open Chrome.
  - Can auto-load the unpacked extension only in --dev-profile mode.
  - Can reload the extension only when it is already connected and exposes the
    reload_extension tool.
  - Cannot silently install/reload an unpacked extension in your normal Chrome
    profile; Chrome requires manual user action at chrome://extensions.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) OPEN_URL="${2:?--url requires a value}"; shift ;;
    --timeout) TIMEOUT_SECONDS="${2:?--timeout requires a value}"; shift ;;
    --dev-profile) DEV_PROFILE=1 ;;
    --profile-dir) PROFILE_DIR="${2:?--profile-dir requires a value}"; shift ;;
    --reload-extension) RELOAD_EXTENSION=1 ;;
    --no-daemon) START_DAEMON=0 ;;
    --no-build) BUILD_IF_MISSING=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

cd "$ROOT_DIR"

DAEMON_CLI="$ROOT_DIR/packages/daemon/dist/cli/index.js"
EXT_DIR="$ROOT_DIR/packages/extension/dist"

if [[ ! -f "$DAEMON_CLI" || ! -f "$EXT_DIR/manifest.json" ]]; then
  if [[ "$BUILD_IF_MISSING" -eq 1 ]]; then
    echo "WebBridge build artifacts missing; running pnpm build..."
    pnpm build
  else
    echo "Missing build artifacts. Run: pnpm build" >&2
    exit 1
  fi
fi

if [[ "$START_DAEMON" -eq 1 ]]; then
  node "$DAEMON_CLI" start --http-port "$HTTP_PORT" --ws-port "$WS_PORT"
fi

health_json() {
  curl -fsS "http://127.0.0.1:$HTTP_PORT/health" 2>/dev/null || true
}

is_connected() {
  local json
  json="$(health_json)"
  [[ -n "$json" ]] && node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.exit(j.extension_connected?0:1)}catch{process.exit(1)}})' <<<"$json"
}

has_reload_tool() {
  local json
  json="$(health_json)"
  [[ -n "$json" ]] && node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.exit((j.capabilities||[]).includes("reload_extension")?0:1)}catch{process.exit(1)}})' <<<"$json"
}

open_chrome_url() {
  local url="$1"
  if [[ "$OSTYPE" == darwin* ]]; then
    open -a "Google Chrome" "$url"
    return
  fi

  local chrome_bin=""
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      chrome_bin="$candidate"
      break
    fi
  done
  if [[ -n "$chrome_bin" ]]; then
    "$chrome_bin" "$url" >/dev/null 2>&1 &
  fi
}

open_chrome() {
  if [[ "$OSTYPE" == darwin* ]]; then
    if [[ "$DEV_PROFILE" -eq 1 ]]; then
      mkdir -p "$PROFILE_DIR"
      open -na "Google Chrome" --args \
        --user-data-dir="$PROFILE_DIR" \
        --load-extension="$EXT_DIR" \
        --disable-extensions-except="$EXT_DIR" \
        --no-first-run \
        --no-default-browser-check \
        "$OPEN_URL"
    else
      open_chrome_url "$OPEN_URL"
    fi
    return
  fi

  local chrome_bin=""
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      chrome_bin="$candidate"
      break
    fi
  done
  if [[ -z "$chrome_bin" ]]; then
    echo "Could not find Google Chrome/Chromium on PATH." >&2
    return 1
  fi

  if [[ "$DEV_PROFILE" -eq 1 ]]; then
    mkdir -p "$PROFILE_DIR"
    "$chrome_bin" \
      --user-data-dir="$PROFILE_DIR" \
      --load-extension="$EXT_DIR" \
      --disable-extensions-except="$EXT_DIR" \
      --no-first-run \
      --no-default-browser-check \
      "$OPEN_URL" >/dev/null 2>&1 &
  else
    "$chrome_bin" "$OPEN_URL" >/dev/null 2>&1 &
  fi
}

if [[ "$RELOAD_EXTENSION" -eq 1 ]]; then
  if is_connected && has_reload_tool; then
    echo "Requesting extension reload..."
    curl -fsS -X POST "http://127.0.0.1:$HTTP_PORT/api/tool" \
      -H 'Content-Type: application/json' \
      -d '{"name":"reload_extension","args":{"delayMs":250}}' >/dev/null || true
    sleep 1
  else
    echo "Extension is not connected or does not expose reload_extension yet; opening Chrome instead."
  fi
fi

open_chrome

echo "Waiting for WebBridge extension connection on ws://127.0.0.1:$WS_PORT ..."
for ((i=0; i<TIMEOUT_SECONDS; i++)); do
  if is_connected; then
    echo "WebBridge ready."
    curl -fsS "http://127.0.0.1:$HTTP_PORT/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({extension_connected:j.extension_connected,connections:j.connections,ports:j.ports,capabilities:(j.capabilities||[]).length},null,2))})'
    exit 0
  fi
  sleep 1
done

if [[ "$DEV_PROFILE" -eq 0 ]]; then
  open_chrome_url "chrome://extensions"
fi

cat <<EOF
WebBridge daemon is running, but the extension did not connect within ${TIMEOUT_SECONDS}s.

If you want to use your normal Chrome profile/login sessions:
  1. Open chrome://extensions (the launcher opened it when possible)
  2. Enable or reload the WebBridge unpacked extension
  3. Extension path: $EXT_DIR

If you want a guaranteed local dev launch without normal profile cookies:
  bash scripts/launch-local.sh --dev-profile --url "$OPEN_URL"

Health:
$(health_json)
EOF

exit 1
