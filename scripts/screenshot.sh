#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_FILE="$ROOT_DIR/.webbridge-data/runtime.json"
OUTPUT_DIR="${WEBBRIDGE_SCREENSHOT_DIR:-/tmp/webbridge-screenshots}"
OUTPUT_PATH=""
FORMAT="png"
QUALITY=""
API_PORT="${WEBBRIDGE_HTTP_PORT:-10087}"

usage() {
  cat <<EOF
Usage: scripts/screenshot.sh [options]

Options:
  -o PATH     Output file path (default: /tmp/webbridge-screenshots/{timestamp}.{format})
  -f FORMAT   Image format: png, jpeg, or webp (default: png)
  -q QUALITY  Image quality 0-100 for jpeg/webp
  -p PORT     WebBridge HTTP port (default: runtime.json or 10087)
  -h          Show help
EOF
}

while getopts "o:f:q:p:h" opt; do
  case "$opt" in
    o) OUTPUT_PATH="$OPTARG" ;;
    f) FORMAT="$OPTARG" ;;
    q) QUALITY="$OPTARG" ;;
    p) API_PORT="$OPTARG" ;;
    h) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

if [[ -f "$RUNTIME_FILE" && -z "${WEBBRIDGE_HTTP_PORT:-}" ]]; then
  API_PORT="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(r.httpPort || r.apiPort || 10087)" "$RUNTIME_FILE")"
fi

if [[ -z "$OUTPUT_PATH" ]]; then
  mkdir -p "$OUTPUT_DIR"
  timestamp="$(date +%Y%m%d_%H%M%S)"
  ext="$FORMAT"
  [[ "$ext" == "jpeg" ]] && ext="jpg"
  OUTPUT_PATH="$OUTPUT_DIR/$timestamp.$ext"
fi

BODY="$(FORMAT="$FORMAT" QUALITY="$QUALITY" node -e '
const args = { format: process.env.FORMAT || "png" };
if (process.env.QUALITY) args.quality = Number(process.env.QUALITY);
console.log(JSON.stringify({ name: "screenshot", args }));
')"

RESPONSE="$(curl -sS -X POST "http://127.0.0.1:${API_PORT}/api/tool" \
  -H 'Content-Type: application/json' \
  -d "$BODY")"

printf '%s' "$RESPONSE" | node -e '
const fs = require("fs");
const out = process.argv[1];
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const json = JSON.parse(raw);
  if (json.error) throw new Error(json.error.message || json.error);
  const b64 = json.data && json.data.data;
  if (typeof b64 !== "string" || b64.length === 0) throw new Error("No screenshot base64 data in response");
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  const stat = fs.statSync(out);
  console.log(JSON.stringify({ path: out, sizeBytes: stat.size, format: (json.data && json.data.format) || "png" }));
});
' "$OUTPUT_PATH"
