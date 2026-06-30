#!/usr/bin/env bash
# deploy-remote.sh — build locally, rsync to server via agent user, restart service
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-estate-scraper}"
REMOTE="agent@${DEPLOY_HOST:?DEPLOY_HOST is required}"
SSH_KEY="$HOME/.ssh/agent_ed25519"
SSH="ssh -i $SSH_KEY"
RSYNC="rsync -az --delete -e 'ssh -i $SSH_KEY'"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building locally..."
npm run build -w api --silent
npm run build -w ui --silent

echo "==> Syncing to $REMOTE:/tmp/estate-deploy/ ..."
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='.git' \
  --exclude='.venv' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='*.db' \
  --exclude='.env' \
  -e "ssh -i $SSH_KEY" \
  "$ROOT/" "$REMOTE:/tmp/estate-deploy/"

echo "==> Installing + restarting on server..."
DEPLOY_HOME="/home/$DEPLOY_USER"
$SSH $REMOTE "
  set -e
  sudo rsync -a --exclude='data' --exclude='node_modules' --exclude='.env' /tmp/estate-deploy/ $DEPLOY_HOME/estate-scraper/
  sudo chown -R $DEPLOY_USER:$DEPLOY_USER $DEPLOY_HOME/estate-scraper
  PUID=\$(id -u $DEPLOY_USER)
  sudo -u $DEPLOY_USER bash -c 'cd $DEPLOY_HOME/estate-scraper && npm install --silent'
  sudo -u $DEPLOY_USER XDG_RUNTIME_DIR=/run/user/\$PUID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\$PUID/bus systemctl --user restart estate-scraper
  sleep 2
  sudo -u $DEPLOY_USER XDG_RUNTIME_DIR=/run/user/\$PUID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\$PUID/bus systemctl --user is-active estate-scraper
"
echo "==> Done. https://estate-scraper.your-domain.example.com"
