#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_FILE="$ROOT_DIR/.webbridge-data/runtime.json"
OUTPUT_DIR="${WEBBRIDGE_PDF_DIR:-/tmp/webbridge-pdfs}"
OUTPUT_PATH=""
PRINT_BACKGROUND="true"
API_PORT="${WEBBRIDGE_HTTP_PORT:-10087}"

usage() {
  cat <<EOF
Usage: scripts/save-pdf.sh [options]

Options:
  -o PATH   Output file path (default: /tmp/webbridge-pdfs/{timestamp}.pdf)
  -p PORT   WebBridge HTTP port (default: runtime.json or 10087)
  -B        Disable print background
  -h        Show help
EOF
}

while getopts "o:p:Bh" opt; do
  case "$opt" in
    o) OUTPUT_PATH="$OPTARG" ;;
    p) API_PORT="$OPTARG" ;;
    B) PRINT_BACKGROUND="false" ;;
    h) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

if [[ -f "$RUNTIME_FILE" && -z "${WEBBRIDGE_HTTP_PORT:-}" ]]; then
  API_PORT="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(r.httpPort || r.apiPort || 10087)" "$RUNTIME_FILE")"
fi

if [[ -z "$OUTPUT_PATH" ]]; then
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_PATH="$OUTPUT_DIR/$(date +%Y%m%d_%H%M%S).pdf"
fi

BODY="$(PRINT_BACKGROUND="$PRINT_BACKGROUND" node -e '
const args = { printBackground: process.env.PRINT_BACKGROUND !== "false" };
console.log(JSON.stringify({ name: "save_as_pdf", args }));
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
  if (typeof b64 !== "string" || b64.length === 0) throw new Error("No PDF base64 data in response");
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  const stat = fs.statSync(out);
  console.log(JSON.stringify({ path: out, sizeBytes: stat.size, format: "pdf" }));
});
' "$OUTPUT_PATH"
