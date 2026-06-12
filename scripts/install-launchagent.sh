#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/scripts/com.estate-scraper.scan.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.estate-scraper.scan.plist"

sed "s|__PROJECT_ROOT__|$ROOT|g" "$PLIST_SRC" > "$PLIST_DST"
chmod +x "$ROOT/scripts/run-scan.sh"

launchctl bootout "gui/$(id -u)/com.estate-scraper.scan" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/com.estate-scraper.scan"

echo "Installed LaunchAgent: $PLIST_DST"
echo "Scan scheduled for Fridays at 1:00 AM."
