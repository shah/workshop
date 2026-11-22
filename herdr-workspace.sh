#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Ergonex Herdr Workspace Launcher
# Provisions a clean multi-agent workspace with pre-arranged tabs and panes:
#   Tab 1 ("orchestrator"): Local Ollama agent (left) + Vault/System shell (right)
#   Tab 2 ("workspaces"):   ~/workspaces/github.com/shah/ergonex
#   Tab 3 ("cloud-agents"): Dedicated panes for Claude Code (cx) & Codex (cy)
# ==============================================================================

if ! command -v herdr >/dev/null 2>&1; then
  echo "[error] herdr is not installed or not in PATH (~/.local/bin)." >&2
  exit 1
fi

ERGONEX_DIR="$HOME/workspaces/github.com/shah/ergonex"
mkdir -p "$ERGONEX_DIR" "$HOME/workspaces"

# Ensure herdr-core daemon is running
herdr session list >/dev/null 2>&1 || true

# Create or reuse 'ergonex' workspace
WS_ID=$(herdr workspace list 2>/dev/null | awk '/ergonex/ {print $1; exit}')
if [[ -z "${WS_ID:-}" ]]; then
  WS_ID=$(herdr workspace create --name "ergonex" --cwd "$HOME" 2>/dev/null | awk '{print $1; exit}')
fi

echo "[ergonex] Launching Herdr Desktop..."
if command -v herdr-app >/dev/null 2>&1; then
  nohup herdr-app >/dev/null 2>&1 &
  disown || true
else
  exec herdr
fi
