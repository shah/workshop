#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Ergonex Private Config Sync (Encrypted Archive <-> OneDrive Personal Vault)
#
# Why encrypted staging?
#   Microsoft's OneDrive Personal Vault API restricts automated background
#   Graph API writes unless unlocked interactively, and Linux OneDrive clients
#   cannot unlock Personal Vault natively.
#
# How this script solves it cleanly and securely:
#   1. `backup`: Bundles private machine configs (SSH keys, GPG keys, age keys,
#      env secrets, git credentials, gh/rclone/onedrive configs, custom Hyprland
#      overrides, Ente Auth exports) into a passphrase-encrypted `.tar.zst.age`
#      (or `.tar.gz.gpg`) archive inside `~/OneDrive/Vault-Staging/` (or a
#      local folder you drag into your unlocked Personal Vault in Edge).
#   2. `restore`: Decrypts the latest vault archive from `~/OneDrive/Vault-Staging/`
#      (or a path you pass) and restores permissions (0700/0600) cleanly.
#   3. `status`: Shows what private files exist locally and lists staged vault
#      snapshots.
# ==============================================================================

BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
RESET="\033[0m"

log()  { echo -e "${CYAN}${BOLD}[vault-sync]${RESET} $1"; }
ok()   { echo -e "${GREEN}${BOLD}[ok]${RESET} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[warn]${RESET} $1"; }
err()  { echo -e "${RED}${BOLD}[error]${RESET} $1" >&2; exit 1; }

ONEDRIVE_DIR="${ERGONEX_ONEDRIVE_DIR:-$HOME/OneDrive}"
STAGING_DIR="${ERGONEX_VAULT_STAGING:-$ONEDRIVE_DIR/Vault-Staging}"
MANIFEST_FILE="$HOME/.config/ergonex/vault-manifest.txt"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || echo omarchy)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$(dirname "$MANIFEST_FILE")" "$STAGING_DIR"

# Create default private-files manifest if missing
if [[ ! -f "$MANIFEST_FILE" ]]; then
  cat > "$MANIFEST_FILE" <<'EOF'
# Paths relative to $HOME to include in encrypted Personal Vault backups.
# Lines starting with # are ignored. Missing paths are safely skipped.
.ssh
.gnupg
.age
.gitconfig.local
.git-credentials
.npmrc
.pypirc
.aws
.config/gh
.config/onedrive
.config/rclone
.config/ente
.config/opencode/opencode.json
.config/hypr/monitors.conf
.config/hypr/input.conf
.config/hypr/envs.conf
.config/ergonex
.local/share/ergonex
EOF
fi

ensure_crypto_tool() {
  if command -v age >/dev/null 2>&1; then
    echo "age"
  elif command -v gpg >/dev/null 2>&1; then
    echo "gpg"
  else
    err "Neither 'age' nor 'gpg' is installed. Install age with: sudo pacman -S age"
  fi
}

cmd_backup() {
  local tool
  tool="$(ensure_crypto_tool)"

  local items=()
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    if [[ -e "$HOME/$line" ]]; then
      items+=("$line")
    fi
  done < "$MANIFEST_FILE"

  if [[ ${#items[@]} -eq 0 ]]; then
    warn "No matching private files found from $MANIFEST_FILE."
    exit 0
  fi

  log "Found ${#items[@]} private config paths to archive:"
  for item in "${items[@]}"; do
    echo "  - ~/$item"
  done

  local out_file
  if [[ "$tool" == "age" ]]; then
    out_file="$STAGING_DIR/ergonex-private-${HOSTNAME_SHORT}-${TIMESTAMP}.tar.gz.age"
    log "Encrypting with 'age' (you will be prompted to enter/confirm a strong passphrase)..."
    tar -C "$HOME" -czf - "${items[@]}" | age -p -o "$out_file"
  else
    out_file="$STAGING_DIR/ergonex-private-${HOSTNAME_SHORT}-${TIMESTAMP}.tar.gz.gpg"
    log "Encrypting with 'gpg' AES256 (you will be prompted for a strong passphrase)..."
    tar -C "$HOME" -czf - "${items[@]}" | gpg --symmetric --cipher-algo AES256 -o "$out_file"
  fi

  chmod 600 "$out_file"
  ok "Encrypted snapshot created: $out_file"

  if command -v onedrive >/dev/null 2>&1 && [[ -d "$ONEDRIVE_DIR" ]]; then
    log "Triggering OneDrive upload sync for Vault-Staging..."
    onedrive --sync --upload-only --single-directory "Vault-Staging" >/dev/null 2>&1 || \
      warn "OneDrive background daemon will sync $out_file automatically once authenticated."
  fi

  echo ""
  echo -e "${YELLOW}${BOLD}Next step (2FA Vault Lock):${RESET}"
  echo -e "  1. Open OneDrive Web (${CYAN}Super + Shift + O${RESET}) -> unlock ${BOLD}Personal Vault${RESET} with Microsoft Authenticator."
  echo -e "  2. Move ${BOLD}$(basename "$out_file")${RESET} from ${CYAN}Vault-Staging${RESET} into ${CYAN}Personal Vault${RESET}."
  echo -e "     (Even while in Vault-Staging, the file is end-to-end encrypted with your passphrase.)"
}

cmd_restore() {
  local archive="${1:-}"
  if [[ -z "$archive" ]]; then
    archive=$(ls -1t "$STAGING_DIR"/ergonex-private-*.tar.gz.* 2>/dev/null | head -n 1 || true)
  fi

  [[ -n "$archive" && -f "$archive" ]] || err "No encrypted archive found. Download your snapshot from Personal Vault into $STAGING_DIR or pass its path: vault-sync.sh restore /path/to/archive"

  log "Restoring private configs from: $archive"
  local tmp_tar
  tmp_tar="$(mktemp /tmp/ergonex-restore-XXXXXX.tar.gz)"
  trap 'rm -f "$tmp_tar"' EXIT

  if [[ "$archive" == *.age ]]; then
    command -v age >/dev/null 2>&1 || err "'age' is required to decrypt $archive (sudo pacman -S age)"
    age -d -o "$tmp_tar" "$archive"
  elif [[ "$archive" == *.gpg ]]; then
    command -v gpg >/dev/null 2>&1 || err "'gpg' is required to decrypt $archive"
    gpg -d -o "$tmp_tar" "$archive"
  else
    err "Unsupported archive extension: $archive"
  fi

  tar -C "$HOME" -xzf "$tmp_tar"

  # Harden permissions on sensitive directories
  [[ -d "$HOME/.ssh" ]] && chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/"* 2>/dev/null || true
  [[ -d "$HOME/.gnupg" ]] && chmod 700 "$HOME/.gnupg"
  [[ -d "$HOME/.age" ]] && chmod 700 "$HOME/.age"

  ok "Private configs restored into $HOME with hardened permissions."
}

cmd_status() {
  log "Manifest: $MANIFEST_FILE"
  log "Staging directory: $STAGING_DIR"
  echo ""
  echo -e "${BOLD}Tracked private paths present on this machine:${RESET}"
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    if [[ -e "$HOME/$line" ]]; then
      echo -e "  ${GREEN}[present]${RESET} ~/$line"
    else
      echo -e "  ${YELLOW}[absent] ${RESET} ~/$line"
    fi
  done < "$MANIFEST_FILE"

  echo ""
  echo -e "${BOLD}Encrypted archives in $STAGING_DIR:${RESET}"
  ls -lh "$STAGING_DIR"/ergonex-private-* 2>/dev/null || echo "  (none yet)"
}

case "${1:-status}" in
  backup)  cmd_backup ;;
  restore) cmd_restore "${2:-}" ;;
  status)  cmd_status ;;
  *)
    echo "Usage: $(basename "$0") {backup|restore [archive_path]|status}"
    exit 1
    ;;
esac
