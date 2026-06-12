#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/usr/local/bin:/opt/homebrew/bin:${PATH:-}"

mkdir -p "$ROOT/api/data"
exec npm run scan -w api >>"$ROOT/api/data/scan.log" 2>&1
