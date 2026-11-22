#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Ergonex Bootstrap for Omarchy
# Repo: https://github.com/shah/ergonex
# ==============================================================================

BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
RESET="\033[0m"

log()  { echo -e "${CYAN}${BOLD}[ergonex]${RESET} $1"; }
ok()   { echo -e "${GREEN}${BOLD}[ok]${RESET} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[warn]${RESET} $1"; }
err()  { echo -e "${RED}${BOLD}[error]${RESET} $1" >&2; exit 1; }

REPO_URL="https://github.com/shah/ergonex.git"
RAW_BASE="https://raw.githubusercontent.com/shah/ergonex/main"
ERGONEX_WS="$HOME/workspaces/github.com/shah/ergonex"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------------------------------------------------------------------------------
# 1. Verify Omarchy Environment
# ------------------------------------------------------------------------------
log "Checking for Omarchy environment..."

OMARCHY_DIR="${OMARCHY_PATH:-$HOME/.local/share/omarchy}"
if ! command -v omarchy >/dev/null 2>&1 && [[ ! -d "$OMARCHY_DIR" ]]; then
  err "Omarchy was not detected on this system. Please run this script inside an active Omarchy installation."
fi

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  err "Do not run bootstrap.sh as root. Run as your normal desktop user (sudo will be invoked only when required)."
fi

ok "Omarchy detected at $OMARCHY_DIR"

mkdir -p "$HOME/.local/bin" "$HOME/.config/ergonex" "$HOME/workspaces"
export PATH="$HOME/.local/bin:$PATH"

# ------------------------------------------------------------------------------
# 2. Install Oh My Posh (Binary Distribution) & Harness-Aware Theme
# ------------------------------------------------------------------------------
log "Installing Oh My Posh binary distribution to ~/.local/bin..."

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  OMP_BIN="posh-linux-amd64" ;;
  aarch64|arm64) OMP_BIN="posh-linux-arm64" ;;
  *) err "Unsupported CPU architecture for Oh My Posh: $ARCH" ;;
esac

curl -fsSL "https://github.com/JanDeDobbeleer/oh-my-posh/releases/latest/download/${OMP_BIN}" -o "$HOME/.local/bin/oh-my-posh"
chmod +x "$HOME/.local/bin/oh-my-posh"

mkdir -p "$HOME/.config/oh-my-posh"
if [[ -f "$SCRIPT_DIR/ergonex.omp.json" ]]; then
  cp "$SCRIPT_DIR/ergonex.omp.json" "$HOME/.config/oh-my-posh/ergonex.omp.json"
else
  curl -fsSL "${RAW_BASE}/ergonex.omp.json" -o "$HOME/.config/oh-my-posh/ergonex.omp.json"
fi

# Wire Oh My Posh into Bash and Zsh idempotently
OMP_INIT_LINE='export PATH="$HOME/.local/bin:$PATH"; eval "$(oh-my-posh init bash --config ~/.config/oh-my-posh/ergonex.omp.json)"'
if [[ -f "$HOME/.bashrc" ]] && ! grep -q "ergonex.omp.json" "$HOME/.bashrc"; then
  printf '\n# Ergonex Oh My Posh (Human / Herdr / Agent aware)\n%s\n' "$OMP_INIT_LINE" >> "$HOME/.bashrc"
fi

OMP_ZSH_LINE='export PATH="$HOME/.local/bin:$PATH"; eval "$(oh-my-posh init zsh --config ~/.config/oh-my-posh/ergonex.omp.json)"'
if [[ -f "$HOME/.zshrc" ]] && ! grep -q "ergonex.omp.json" "$HOME/.zshrc"; then
  printf '\n# Ergonex Oh My Posh (Human / Herdr / Agent aware)\n%s\n' "$OMP_ZSH_LINE" >> "$HOME/.zshrc"
fi

ok "Oh My Posh installed ($(oh-my-posh --version)) with harness-aware theme."

# ------------------------------------------------------------------------------
# 3. Detect Hardware & Select the Best Local Coding Model
# ------------------------------------------------------------------------------
log "Inspecting GPU VRAM and system RAM to select the optimal local LLM..."

VRAM_MB=0
if command -v nvidia-smi >/dev/null 2>&1; then
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | awk '{sum+=$1} END {print sum+0}')
elif command -v rocm-smi >/dev/null 2>&1; then
  VRAM_BYTES=$(rocm-smi --showmeminfo vram 2>/dev/null | awk '/Total Memory/ {print $NF; exit}')
  if [[ -n "${VRAM_BYTES:-}" && "$VRAM_BYTES" -gt 0 ]]; then
    VRAM_MB=$((VRAM_BYTES / 1024 / 1024))
  fi
elif [[ -r /sys/class/drm/card0/device/mem_info_vram_total ]]; then
  VRAM_BYTES=$(cat /sys/class/drm/card0/device/mem_info_vram_total 2>/dev/null || echo 0)
  VRAM_MB=$((VRAM_BYTES / 1024 / 1024))
fi

SYS_RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
EFFECTIVE_MEM_MB=$(( VRAM_MB > 0 ? VRAM_MB : SYS_RAM_MB ))

if [[ "$EFFECTIVE_MEM_MB" -ge 22000 ]]; then
  BEST_MODEL="qwen3-coder:30b"
elif [[ "$EFFECTIVE_MEM_MB" -ge 15000 ]]; then
  BEST_MODEL="qwen3.8:27b"
elif [[ "$EFFECTIVE_MEM_MB" -ge 10000 ]]; then
  BEST_MODEL="gpt-oss:20b"
else
  BEST_MODEL="qwen2.5-coder:7b"
fi

ok "Detected VRAM: ${VRAM_MB} MB | System RAM: ${SYS_RAM_MB} MB -> Selected model: ${BOLD}${BEST_MODEL}${RESET}"

# ------------------------------------------------------------------------------
# 4. Install & Start Ollama, Pull Best Local Model
# ------------------------------------------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
  log "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
else
  ok "Ollama is already installed."
fi

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  log "Starting Ollama service..."
  if systemctl list-unit-files | grep -q '^ollama\.service'; then
    sudo systemctl enable --now ollama.service
  else
    nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
  fi
  for _ in {1..15}; do
    curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi

log "Pulling ${BEST_MODEL} via Ollama..."
ollama pull "$BEST_MODEL"
ok "Model ${BEST_MODEL} is ready locally."

# ------------------------------------------------------------------------------
# 5. Pre-install Claude Code & OpenAI Codex via Omarchy's Native mise Wrappers
# ------------------------------------------------------------------------------
log "Pre-installing Claude Code and OpenAI Codex via Omarchy's native mise integration..."
if command -v mise >/dev/null 2>&1; then
  MISE_MINIMUM_RELEASE_AGE=0 mise use -g --quiet claude@latest codex@latest || warn "mise pre-install deferred; first run of 'claude' or 'codex' will install automatically."
  ok "Claude Code and OpenAI Codex registered via Omarchy's mise setup."
else
  warn "mise not found; skipping Claude/Codex pre-install."
fi

# ------------------------------------------------------------------------------
# 6. Configure Local Agent Harness (OpenCode) & Link Omarchy Skills
# ------------------------------------------------------------------------------
log "Configuring OpenCode to use local Ollama (${BEST_MODEL})..."

mkdir -p "$HOME/.config/opencode" "$HOME/.agents/skills" "$HOME/.claude" "$HOME/.codex"

cat > "$HOME/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "default_agent": "plan",
  "model": "ollama/${BEST_MODEL}",
  "instructions": [
    "${HOME}/AGENTS.md"
  ],
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (Local)",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      },
      "models": {
        "${BEST_MODEL}": {
          "name": "${BEST_MODEL}"
        }
      }
    }
  }
}
EOF

if [[ -d "$OMARCHY_DIR/default/skills" ]]; then
  for skill in "$OMARCHY_DIR"/default/skills/*; do
    [[ -e "$skill" ]] && ln -sfn "$skill" "$HOME/.agents/skills/$(basename "$skill")"
  done
fi

ok "OpenCode configured with local model ollama/${BEST_MODEL}."

# ------------------------------------------------------------------------------
# 7. Install Herdr, Herdr Desktop, and Custom Ergonex Layout
# ------------------------------------------------------------------------------
log "Installing Herdr and Herdr Desktop..."
curl -fsSL https://releases.herdr.dev/app/install.sh | sh

if command -v herdr >/dev/null 2>&1; then
  herdr integration install opencode 2>/dev/null || true
  herdr integration install claude.code 2>/dev/null || true
  herdr integration install codex 2>/dev/null || true
  ok "Herdr installed ($(herdr --version 2>/dev/null || echo 'ready'))."
fi

# Seed default Herdr config with clean workspace defaults
mkdir -p "$HOME/.config/herdr"
if [[ ! -f "$HOME/.config/herdr/config.toml" ]]; then
  cat > "$HOME/.config/herdr/config.toml" <<'EOF'
# Ergonex Herdr Configuration
[server]
headless_cols = 160
headless_rows = 50
EOF
fi

# Install helper scripts (vault-sync.sh & herdr-workspace.sh) into ~/.local/bin
for helper in vault-sync.sh herdr-workspace.sh; do
  if [[ -f "$SCRIPT_DIR/$helper" ]]; then
    cp "$SCRIPT_DIR/$helper" "$HOME/.local/bin/$helper"
  else
    curl -fsSL "${RAW_BASE}/${helper}" -o "$HOME/.local/bin/$helper" 2>/dev/null || true
  fi
  [[ -f "$HOME/.local/bin/$helper" ]] && chmod +x "$HOME/.local/bin/$helper"
done

# ------------------------------------------------------------------------------
# 8. Install Microsoft Edge (Default Browser), Work Profile, Native Apps & 2FA
# ------------------------------------------------------------------------------
log "Installing Microsoft Edge and setting it as the default browser..."
if command -v omarchy >/dev/null 2>&1; then
  omarchy install browser edge 2>/dev/null || yay -S --noconfirm --needed microsoft-edge-stable-bin
  omarchy default browser microsoft-edge 2>/dev/null || xdg-settings set default-web-browser microsoft-edge.desktop 2>/dev/null || true
else
  yay -S --noconfirm --needed microsoft-edge-stable-bin
  xdg-settings set default-web-browser microsoft-edge.desktop 2>/dev/null || true
fi

# Create isolated Microsoft Edge Work Profile directory and desktop launcher
EDGE_WORK_DIR="$HOME/.local/share/edge-work-profile"
mkdir -p "$EDGE_WORK_DIR" "$HOME/.local/share/applications"

cat > "$HOME/.local/share/applications/microsoft-edge-work.desktop" <<EOF
[Desktop Entry]
Version=1.0
Name=Microsoft Edge (Work)
GenericName=Work Web Browser
Comment=Isolated Microsoft Edge profile for Work M365, Teams, and Outlook
Exec=microsoft-edge-stable --user-data-dir=${EDGE_WORK_DIR} %U
Terminal=false
Icon=microsoft-edge
Type=Application
Categories=Network;WebBrowser;
EOF

log "Installing native desktop apps, OneDrive client, encryption tools, and Ente Auth (2FA)..."
NATIVE_PKGS=(
  age
  visual-studio-code-bin
  discord
  spotify-launcher
  onedrive-abraunegg
  ente-auth-bin
  claude-desktop
)

for pkg in "${NATIVE_PKGS[@]}"; do
  if ! pacman -Qi "$pkg" >/dev/null 2>&1; then
    log "Installing $pkg..."
    yay -S --noconfirm --needed "$pkg" || warn "Could not auto-install $pkg (install manually later with: yay -S $pkg)"
  else
    ok "$pkg already installed."
  fi
done

# ------------------------------------------------------------------------------
# 9. Install Omarchy Web Apps (Personal & Isolated Work)
# ------------------------------------------------------------------------------
log "Installing Omarchy Web Apps..."

install_webapp() {
  local name="$1"
  local url="$2"
  local extra_args="${3:-}"
  if command -v omarchy-webapp-install >/dev/null 2>&1; then
    omarchy-webapp-install "$name" "$url" "" "" "$extra_args" 2>/dev/null || true
  else
    local slug
    slug=$(echo "$name" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')
    cat > "$HOME/.local/share/applications/webapp-${slug}.desktop" <<EOF
[Desktop Entry]
Version=1.0
Name=${name}
Exec=microsoft-edge-stable --app=${url} ${extra_args}
Terminal=false
Type=Application
Categories=Network;
EOF
  fi
}

# Personal Web Apps
install_webapp "Gmail" "https://mail.google.com"
install_webapp "Outlook Personal" "https://outlook.live.com"
install_webapp "Cloudflare" "https://dash.cloudflare.com"
install_webapp "UniFi Site Manager" "https://unifi.ui.com"
install_webapp "UniFi Network" "https://unifi.ui.com/network"
install_webapp "UniFi Protect" "https://unifi.ui.com/protect"
install_webapp "WhatsApp" "https://web.whatsapp.com"
install_webapp "ChatGPT" "https://chatgpt.com"

# Isolated Work Profile Web Apps
install_webapp "Outlook Work" "https://outlook.office.com" "--user-data-dir=${EDGE_WORK_DIR}"
install_webapp "Microsoft Teams" "https://teams.microsoft.com" "--user-data-dir=${EDGE_WORK_DIR}"
install_webapp "OneDrive" "https://onedrive.live.com"

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
ok "Web apps installed (available in Super + Space launcher)."

# ------------------------------------------------------------------------------
# 10. Configure Custom Hyprland Keybindings
# ------------------------------------------------------------------------------
HYPR_BINDINGS="$HOME/.config/hypr/bindings.conf"
if [[ -d "$HOME/.config/hypr" ]]; then
  touch "$HYPR_BINDINGS"
  # Remove existing block if re-running bootstrap.sh
  sed -i '/# >>> ERGONEX KEYBINDINGS >>>/,/# <<< ERGONEX KEYBINDINGS <<</d' "$HYPR_BINDINGS"

  cat >> "$HYPR_BINDINGS" <<EOF

# >>> ERGONEX KEYBINDINGS >>>
# Personal & Native Apps (Super + Shift + Key)
bindd = SUPER SHIFT, B, Microsoft Edge (Personal), exec, microsoft-edge-stable
bindd = SUPER SHIFT, E, VS Code, exec, code
bindd = SUPER SHIFT, H, Herdr Desktop, exec, herdr-workspace.sh
bindd = SUPER SHIFT, G, Gmail, exec, microsoft-edge-stable --app=https://mail.google.com
bindd = SUPER SHIFT, O, Outlook Personal, exec, microsoft-edge-stable --app=https://outlook.live.com
bindd = SUPER SHIFT, F, Cloudflare, exec, microsoft-edge-stable --app=https://dash.cloudflare.com
bindd = SUPER SHIFT, U, UniFi Site Manager, exec, microsoft-edge-stable --app=https://unifi.ui.com
bindd = SUPER SHIFT, D, Discord, exec, discord
bindd = SUPER SHIFT, S, Spotify, exec, spotify-launcher
bindd = SUPER SHIFT, W, WhatsApp, exec, microsoft-edge-stable --app=https://web.whatsapp.com
bindd = SUPER SHIFT, A, ChatGPT, exec, microsoft-edge-stable --app=https://chatgpt.com
bindd = SUPER SHIFT, C, Claude Desktop, exec, claude-desktop
bindd = SUPER SHIFT, K, Ente Auth (2FA), exec, ente_auth

# Isolated Work Profile Apps (Super + Alt + Key)
bindd = SUPER ALT, B, Microsoft Edge (Work), exec, microsoft-edge-stable --user-data-dir=${EDGE_WORK_DIR}
bindd = SUPER ALT, O, Outlook Work, exec, microsoft-edge-stable --user-data-dir=${EDGE_WORK_DIR} --app=https://outlook.office.com
bindd = SUPER ALT, T, Microsoft Teams, exec, microsoft-edge-stable --user-data-dir=${EDGE_WORK_DIR} --app=https://teams.microsoft.com
bindd = SUPER ALT, D, OneDrive Web, exec, microsoft-edge-stable --app=https://onedrive.live.com
# <<< ERGONEX KEYBINDINGS <<<
EOF

  if ! grep -q "bindings.conf" "$HOME/.config/hypr/hyprland.conf" 2>/dev/null; then
    echo "source = ~/.config/hypr/bindings.conf" >> "$HOME/.config/hypr/hyprland.conf"
  fi
  hyprctl reload >/dev/null 2>&1 || true
  ok "Custom Hyprland keybindings added to ~/.config/hypr/bindings.conf"
fi

# ------------------------------------------------------------------------------
# 11. Clone Ergonex Repo into Managed Workspace Layout
# ------------------------------------------------------------------------------
if [[ ! -d "$ERGONEX_WS/.git" ]]; then
  log "Cloning $REPO_URL into $ERGONEX_WS..."
  mkdir -p "$(dirname "$ERGONEX_WS")"
  git clone "$REPO_URL" "$ERGONEX_WS" 2>/dev/null || warn "Could not clone $REPO_URL yet (ensure repo is reachable)."
fi

# ------------------------------------------------------------------------------
# 12. Generate $HOME/AGENTS.md (Master System Orchestration Blueprint)
# ------------------------------------------------------------------------------
log "Generating $HOME/AGENTS.md..."

cat > "$HOME/AGENTS.md" <<EOF
# Ergonex — Omarchy Local-First Autonomous Workstation Blueprint

Repository: https://github.com/shah/ergonex  
Host OS: Omarchy (Arch Linux + Hyprland)  
Primary Local Engine: Ollama (\`${BEST_MODEL}\` at \`http://127.0.0.1:11434/v1\`)  
Primary Local Harness: OpenCode (\`opencode\` / \`c\`)  
Workspace Multiplexer: Herdr & Herdr Desktop (\`herdr\`)

---

## 1. Managed Git Workspace Layout (Strictly Enforced)

Whenever cloning, initializing, or organizing Git repositories (GitHub, GitLab, self-hosted Git servers, etc.), **always** place them inside \`~/workspaces\` using a deterministic directory tree that mirrors the exact remote host and namespace hierarchy:

\`\`\`text
~/workspaces/
├── github.com/
│   ├── shah/
│   │   └── ergonex/
│   └── <org-or-user>/
│       └── <repo>/
└── <git-host>/                  # e.g., gitlab.com or self-hosted git.domain.com
    └── <group>/
        └── <subgroup>/          # preserve arbitrary subgroup nesting depth
            └── <repo>/
\`\`\`

### Rules for Repository Operations
1. **Never clone repositories directly into \`~\`, \`~/Desktop\`, or \`~/Downloads\`.** Always resolve the canonical host + path and clone into \`~/workspaces/<host>/<namespace>/<repo>\`.
2. **Multi-Repo `.code-workspace` Monorepos:** When grouping multiple repositories across GitHub or GitLab into a single VS Code workspace, store `<name>.code-workspace` at \`~/workspaces/<name>.code-workspace\` using relative paths (e.g., \`github.com/shah/ergonex\`) so workspaces remain 100% portable.
3. **Verify Before Cloning:** Check if \`~/workspaces/<host>/<namespace>/<repo>\` already exists; if present, run \`git fetch --all --prune\` and report status rather than duplicating clones.

---

## 2. Public Repo vs. Private Vault Security Split

- **Public GitHub (\`~/workspaces/github.com/shah/ergonex\`):** Stores reproducible scripts (\`bootstrap.sh\`, \`vault-sync.sh\`, \`herdr-workspace.sh\`), \`ergonex.omp.json\`, \`README.md\`, and sanitized config templates. **Never commit secrets, API tokens, SSH keys, or personal identifiers here.**
- **Private Configs (\`vault-sync.sh\` -> OneDrive Personal Vault):** Machine-specific secrets and private files (\`~/.ssh\`, \`~/.gnupg\`, \`~/.age\`, \`~/.config/gh\`, \`~/.config/onedrive\`, \`~/.config/ente\`, \`~/.gitconfig.local\`) are tracked in \`~/.config/ergonex/vault-manifest.txt\` and encrypted locally with \`age\` before syncing to \`~/OneDrive/Vault-Staging/\` and locking inside Microsoft OneDrive Personal Vault.

---

## 3. Core Operating Principles & Omarchy Native Commands

1. **Omarchy-Native First:** Always prefer Omarchy's built-in CLI (\`omarchy\`), \`mise\`, and official Arch/AUR helpers (\`pacman\`, \`yay\`) over ad-hoc scripts.
2. **Plan Before Mutating System State:** Propose a clear plan and confirm with the user before editing \`~/.config/hypr/\`, \`~/.config/waybar/\`, services, or system packages.
3. **Recovery Commands:**
   - Reset user dotfiles to Omarchy defaults: \`omarchy reinstall configs\`
   - Restore default Omarchy packages & configs: \`omarchy reinstall\`
   - Update Omarchy, packages, and managed AI harnesses: \`omarchy update\`
   - System diagnostics: \`omarchy debug\`

---

## 4. Agent Harness Management (Omarchy Native)

- **Never use external installers (\`curl | sh\`, \`npm i -g\`, or \`pacman\`) for \`claude\` or \`codex\`.** Omarchy manages both via \`mise\` lazy wrappers in \`~/.local/bin/\`.
- **Install / Pre-warm:** \`MISE_MINIMUM_RELEASE_AGE=0 mise use -g --quiet claude@latest codex@latest\`
- **Update:** Always update harnesses via \`omarchy update\` or \`mup\` (never run \`claude update\` or \`codex update\`).
- **Set Omarchy's Default Harness:** \`omarchy default agent <claude|codex|opencode>\`
- **Launch Shortcuts:**
  - \`c\` / \`opencode\` — OpenCode (default local Ollama model \`${BEST_MODEL}\`)
  - \`cx\` / \`claude\` — Claude Code (optional cloud agent)
  - \`cy\` / \`codex\` — OpenAI Codex (optional cloud agent)
- **Prompt Context Indicator:** Oh My Posh displays \`HUMAN\` in direct shells, \`HERDR\` inside Herdr panes, and \`AGENT\` inside active AI CLI sessions.

---

## 5. Installed Browser Profiles, Apps & Hyprland Keybindings

- **Default Browser:** Microsoft Edge (\`microsoft-edge-stable\`) — Personal profile synced via Microsoft Account.
- **Isolated Work Browser:** Microsoft Edge Work (\`~/.local/share/edge-work-profile\`) — Isolated Entra ID / M365 session for Outlook Work and Teams.
- **Local 2FA Authenticator:** Ente Auth (\`ente_auth\`) for desktop TOTP codes alongside mobile Microsoft Authenticator.
- **OneDrive Sync:** \`onedrive\` (\`onedrive-abraunegg\`) for local \`~/OneDrive\` folder synchronization + \`vault-sync.sh\` for encrypted private config snapshots.
- **Hyprland Shortcuts (\`~/.config/hypr/bindings.conf\`):**
  - \`Super + Shift + B\` Edge (Personal) | \`Super + Alt + B\` Edge (Work)
  - \`Super + Shift + E\` VS Code | \`Super + Shift + H\` Herdr Desktop
  - \`Super + Shift + G\` Gmail | \`Super + Shift + O\` Outlook Personal | \`Super + Alt + O\` Outlook Work
  - \`Super + Alt + T\` Microsoft Teams | \`Super + Alt + D\` OneDrive Web
  - \`Super + Shift + F\` Cloudflare | \`Super + Shift + U\` UniFi Site Manager
  - \`Super + Shift + D\` Discord | \`Super + Shift + S\` Spotify | \`Super + Shift + W\` WhatsApp
  - \`Super + Shift + A\` ChatGPT | \`Super + Shift + C\` Claude Desktop | \`Super + Shift + K\` Ente Auth

---

## 6. Machine Preparation Checklist (Execute with User Confirmation)

When asked to prepare this PC using \`~/AGENTS.md\`, work through these phases sequentially:

1. **Audit & Verify:** Run \`omarchy debug\`, \`ollama list\`, and \`oh-my-posh --version\`; verify \`~/workspaces/github.com/shah/ergonex\` is synced.
2. **Developer & Publisher Toolchain:** Verify Git identity (\`git config --global user.name\` / \`user.email\`), GitHub CLI (\`gh auth status\`), and \`mise list\`.
3. **Browser, 2FA & OneDrive Vault Setup:** Walk the user through signing into Microsoft Edge (Personal & Work profiles), configuring Ente Auth, authenticating \`onedrive\`, and restoring/creating their first encrypted snapshot with \`vault-sync.sh\`.
4. **Herdr Workspace Tuning:** Read \`~/.config/herdr-app/AGENTS.md\` and organize Herdr workspaces/tabs for \`~/workspaces\`.
5. **Optional Cloud Harnesses:** Assist with interactive login for \`claude\` (\`cx\`) and \`codex\` (\`cy\`) if requested.
EOF

ln -sf "$HOME/AGENTS.md" "$HOME/.claude/CLAUDE.md"
ln -sf "$HOME/AGENTS.md" "$HOME/.codex/AGENTS.md"

ok "Generated $HOME/AGENTS.md and linked it for OpenCode, Claude Code, and Codex."

# ------------------------------------------------------------------------------
# 13. Final Handoff Instructions
# ------------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}==============================================================================${RESET}"
echo -e "${GREEN}${BOLD}  Ergonex Bootstrap Complete!${RESET}"
echo -e "${GREEN}${BOLD}==============================================================================${RESET}"
echo ""
echo -e "  ${BOLD}1. Launch Herdr Desktop:${RESET}"
echo -e "     Press ${CYAN}Super + Shift + H${RESET} (or ${CYAN}Super + Space${RESET} -> ${BOLD}Herdr${RESET})."
echo ""
echo -e "  ${BOLD}2. Start your local AI agent inside a Herdr pane:${RESET}"
echo -e "     Run: ${CYAN}opencode${RESET}   (or Omarchy's alias ${CYAN}c${RESET})"
echo -e "     Your Oh My Posh prompt will automatically show ${CYAN}HERDR${RESET} / ${RED}AGENT${RESET}."
echo ""
echo -e "  ${BOLD}3. Paste this exact prompt to your local agent to finish setting up your PC:${RESET}"
echo -e "${YELLOW}------------------------------------------------------------------------------${RESET}"
cat <<'PROMPT'
Read ~/AGENTS.md and ~/.config/herdr-app/AGENTS.md. Using Omarchy's native CLI tools (`omarchy`), `mise`, and our local Ollama model, audit my machine and walk me step-by-step through Phase 1 to Phase 5 of the Machine Preparation Checklist in ~/AGENTS.md. Start in plan mode and ask for my confirmation before applying system changes.
PROMPT
echo -e "${YELLOW}------------------------------------------------------------------------------${RESET}"
echo ""
