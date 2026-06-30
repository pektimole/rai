#!/usr/bin/env bash
#
# deploy-mcp-connector.sh — deploy the RAI inbound MCP connector to the VPS (OL-404).
#
# Idempotent: pull -> install -> build core+connector -> pm2 reload -> health check.
# Run ON the VPS (the repo must already be cloned there). Safe to re-run.
#
#   RAI_DIR=~/rai RAI_MCP_PORT=3848 bash scripts/deploy/deploy-mcp-connector.sh
#
# Defaults: RAI_DIR = the repo this script lives in, RAI_MCP_PORT = 3848.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAI_DIR="${RAI_DIR:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}"
PORT="${RAI_MCP_PORT:-3848}"

echo "[deploy] repo : $RAI_DIR"
echo "[deploy] port : $PORT"
cd "$RAI_DIR"

echo "[deploy] branch: $(git rev-parse --abbrev-ref HEAD)"
git pull --ff-only

npm install
npm run build -w @rai/core
npm run build -w @rai/mcp-connector

echo "[deploy] (re)starting pm2 process rai-mcp..."
RAI_MCP_PORT="$PORT" pm2 startOrReload scripts/deploy/rai-mcp.ecosystem.cjs --update-env
pm2 save

# Give the listener a moment, then prove it answers.
sleep 1
echo "[deploy] health check:"
if curl -fsS "http://127.0.0.1:${PORT}/health"; then
  echo
  echo "[deploy] OK — rai-mcp live on :${PORT}"
else
  echo
  echo "[deploy] FAIL — /health did not respond. Check: pm2 logs rai-mcp" >&2
  exit 1
fi

echo "[deploy] pm2 status:"
pm2 status rai-mcp
