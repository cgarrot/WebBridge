#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_DAEMON=0
SKIP_INSTALL=0

usage() {
  cat <<'EOF'
Usage: bash scripts/install-local.sh [--start] [--skip-install]

Builds WebBridge for local use:
  - checks Node.js and pnpm
  - installs workspace dependencies unless --skip-install is passed
  - builds shared, daemon, and extension packages
  - prints Chrome extension and daemon start instructions

Options:
  --start         Start the local daemon after building
  --skip-install  Do not run pnpm install
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --start) START_DAEMON=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 18 is required: https://nodejs.org/" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js >= 18 is required; found $(node -v)" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "pnpm not found; enabling Corepack..."
    corepack enable
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm >= 8 is required: https://pnpm.io/installation" >&2
  exit 1
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  if [[ -f pnpm-lock.yaml ]]; then
    pnpm install --frozen-lockfile
  else
    pnpm install
  fi
fi

pnpm build

cat <<EOF

WebBridge build complete.

1) Load the Chrome extension:
   chrome://extensions -> Developer mode -> Load unpacked
   $ROOT_DIR/packages/extension/dist

2) Start the daemon:
   node $ROOT_DIR/packages/daemon/dist/cli/index.js start

3) Check status:
   curl -s http://127.0.0.1:10087/health

Ports:
   HTTP API: http://127.0.0.1:10087
   Extension WebSocket: ws://127.0.0.1:10088
EOF

if [[ "$START_DAEMON" -eq 1 ]]; then
  node "$ROOT_DIR/packages/daemon/dist/cli/index.js" start
fi
