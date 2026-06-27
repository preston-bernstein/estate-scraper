#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="~/.local/share/fnm/node-versions/v24.12.0/installation/bin:/usr/local/bin:${PATH:-}"

# Load .env if present
set -a; [ -f "$ROOT/api/.env" ] && source "$ROOT/api/.env"; set +a

mkdir -p "$ROOT/api/data"
exec npm run scan -w api >>"$ROOT/api/data/scan.log" 2>&1
