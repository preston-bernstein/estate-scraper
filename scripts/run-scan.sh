#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/api"

export PATH="/home/estate-scraper/.local/share/fnm/node-versions/v24.12.0/installation/bin:/usr/local/bin:${PATH:-}"

# Load .env if present
set -a; [ -f .env ] && source .env; set +a

mkdir -p data
exec node dist/scan/index.js >> data/scan.log 2>&1
