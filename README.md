# Ergonex

**Shahid's AI-Native Workstation Nexus for Omarchy**

Ergonex turns a clean [Omarchy](https://omarchy.org/) installation into a local-first, multi-agent engineering and publishing workstation orchestrated through [Herdr](https://herdr.dev/), [Ollama](https://ollama.com/), [OpenCode](https://opencode.ai/), and [Oh My Posh](https://ohmyposh.dev/)—with a clean separation between **public reproducible infrastructure** (in this GitHub repository) and **private encrypted machine secrets** (stored in Microsoft OneDrive Personal Vault).

---

## One-Line Bootstrap

Run this on a fresh or factory-reset Omarchy installation (`Super + Alt + Space` → **Setup > Reset Computer**):

```bash
curl -fsSL https://raw.githubusercontent.com/shah/ergonex/main/bootstrap.sh | bash
```

### Bootstrap acceptance test

On a fresh Omarchy test machine, run the command above as your normal desktop user. Confirm it exits successfully and prints **Ergonex Bootstrap Complete!**. Run the same command again and confirm it completes without adding duplicate prompt initialization lines, Hyprland bindings, or desktop launchers. The second run should reuse the installed Oh My Posh binary and downloaded Ollama model.

You can also run `bash bootstrap.sh` from a local checkout to test the file-based entry point.

---

## What `bootstrap.sh` Configures

1. **Omarchy Verification:** Confirms `$OMARCHY_PATH` / `omarchy` is present before touching system files.
2. **Oh My Posh Binary & Context-Aware Prompt (`ergonex.omp.json`):**
   - Installs the latest `oh-my-posh` binary into `~/.local/bin/oh-my-posh`.
   - Displays a dynamic context badge on the far left of your prompt:
     - `HUMAN` (slate) — Direct interactive shell session
     - `HERDR` (blue) — Running inside a Herdr workspace pane
     - `AGENT` (red) — Executed inside an AI CLI harness (`opencode`, `claude`, `codex`)
3. **Hardware-Aware Local LLM (Ollama):**
   - Inspects GPU VRAM and system RAM and pulls the strongest local coding model (`qwen3-coder:30b`, `qwen3.8:27b`, `gpt-oss:20b`, or `qwen2.5-coder:7b`).
4. **Omarchy-Native AI Harnesses:**
   - Configures **OpenCode** (`c` / `opencode`) to run locally against Ollama (`http://127.0.0.1:11434/v1`) in `plan` mode by default.
   - Pre-installs **Claude Code** (`cx` / `claude`) and **OpenAI Codex** (`cy` / `codex`) using Omarchy's native `mise` lazy-installation wrappers.
5. **Herdr & Herdr Desktop (`herdr-workspace.sh`):**
   - Installs `herdr-app` and `herdr-core`, registers agent lifecycle hooks, configures headless terminal dimensions (`160x50`), and provides `herdr-workspace.sh` (`Super + Shift + H`).
6. **Master `$HOME/AGENTS.md` Blueprint:**
   - Enforces the `~/workspaces/<host>/<namespace>/<repo>` directory convention across all agents.
   - Documents Omarchy-native update/recovery rules and a 5-phase Machine Preparation Checklist.
7. **Browsers, Apps & Hyprland Keybindings:**
   - Installs **Microsoft Edge** as the default browser, provisions an isolated **Edge Work Profile**, installs native desktop apps + Omarchy web apps, and writes shortcuts to the active Hyprland bindings file.

---

## Public Repo vs. OneDrive Personal Vault (`vault-sync.sh`)

Ergonex splits your workstation state into two tiers:

| Tier | Where It Lives | What Goes Here |
| :--- | :--- | :--- |
| **Public & Reproducible** | `~/workspaces/github.com/shah/ergonex` (GitHub) | `bootstrap.sh`, `vault-sync.sh`, `herdr-workspace.sh`, `ergonex.omp.json`, `README.md` |
| **Private & Irreplaceable** | **OneDrive Personal Vault** (via `vault-sync.sh`) | `~/.ssh`, `~/.gnupg`, `~/.age`, `~/.config/gh`, `~/.config/onedrive`, `~/.config/ente`, `~/.gitconfig.local`, custom monitor/input overrides |

### Why `vault-sync.sh` Uses Local `age` Encryption + `Vault-Staging`
Microsoft's OneDrive API prevents background Linux daemons from unlocking **Personal Vault** automatically because Personal Vault requires interactive 2FA verification (Microsoft Authenticator) and auto-locks after inactivity.

`vault-sync.sh` solves this securely:
1. It reads `~/.config/ergonex/vault-manifest.txt` and bundles your private files into a passphrase-encrypted `.tar.gz.age` archive inside `~/OneDrive/Vault-Staging/`.
2. Your local `onedrive` daemon syncs that encrypted blob to OneDrive automatically.
3. You unlock **Personal Vault** in OneDrive Web (`Super + Alt + D`) with Microsoft Authenticator and move the encrypted archive into **Personal Vault** for two-factor hardware/biometric protection on top of your `age` passphrase.

### Daily Usage (`vault-sync.sh`)
```bash
# Check which private configs exist locally and list staged encrypted snapshots
vault-sync.sh status

# Create a new passphrase-encrypted backup and push to ~/OneDrive/Vault-Staging
vault-sync.sh backup

# Restore private configs on a freshly reset Omarchy PC (hardens ~/.ssh and ~/.gnupg permissions)
vault-sync.sh restore
```
*(Edit `~/.config/ergonex/vault-manifest.txt` at any time to add or remove private files/folders.)*

---

## Setting Up Microsoft Apps & Isolated Work Profile

### 1. Personal Microsoft Edge & Password Sync
1. Press `Super + Shift + B` to launch **Microsoft Edge (Personal)**.
2. Sign in with your **personal Microsoft Account** and enable **Sync** (Passwords, Favorites, Extensions, Settings).
3. All personal web apps (**Gmail**, **Outlook Personal**, **Cloudflare**, **UniFi**, **WhatsApp**, **ChatGPT**) inherit this profile automatically.

### 2. Isolated Microsoft Edge Work Profile (M365 / Entra ID)
1. Press `Super + Alt + B` (or launch **Microsoft Edge (Work)** from `Super + Space`).
2. Because it uses `--user-data-dir=~/.local/share/edge-work-profile`, your corporate Entra ID / Microsoft 365 cookies and Conditional Access tokens stay completely separate from personal browsing.
3. **Outlook Work** (`Super + Alt + O`) and **Microsoft Teams** (`Super + Alt + T`) automatically launch inside this isolated profile.

### 3. OneDrive Local Folder Sync (`onedrive-abraunegg`)
1. Open a terminal and run:
   ```bash
   onedrive
   ```
2. Open the printed Microsoft login URL in Edge, sign in, and paste the resulting redirect URI back into the terminal.
3. Test with `onedrive --synchronize --dry-run`, then enable automatic background syncing:
   ```bash
   systemctl --user enable --now onedrive
   ```

---

## Setting Up Local 2FA (Ente Auth) Alongside Microsoft Authenticator

Microsoft does not publish a native Linux desktop client for **Microsoft Authenticator** and retired its legacy Edge Autofill extension. To have fast desktop TOTP codes on Omarchy while keeping Microsoft Authenticator on your phone:

### Option A: Mirror Existing TOTP Accounts into Ente Auth (Recommended)
1. Launch **Ente Auth** (`Super + Shift + K` or `ente_auth`) and create/sign in to an end-to-end encrypted Ente account (or use offline mode).
2. **Transferring codes from Microsoft Authenticator:**
   - Microsoft Authenticator does not offer a direct unencrypted JSON/CSV export button.
   - For accounts where you saved your **2FA setup QR code or secret key** in OneDrive Personal Vault, scan the QR code or enter the setup key directly into **Ente Auth** (`+` → *Enter setup key*). Both Microsoft Authenticator and Ente Auth will generate identical 6-digit codes.
   - For critical accounts without a saved seed, visit the service's security settings → *Reconfigure 2FA*, scan the new QR code in **both** Microsoft Authenticator (phone) and **Ente Auth** (desktop) before confirming.
3. **Note on Microsoft Account Passwordless Push Approvals:** Microsoft's own 2-digit number-matching push prompts still require the mobile **Microsoft Authenticator** app; all standard TOTP codes work seamlessly in **Ente Auth**.

### Option B: Migrate Saved Passwords from Microsoft Authenticator to Edge
1. On your phone, open **Microsoft Authenticator** → **Settings** → **Export passwords** (saves a CSV file).
2. In **Microsoft Edge** (`Super + Shift + B`), go to `edge://settings/passwords` → click **`...`** (More actions) → **Import passwords** → select **Passwords CSV file**, then securely delete the temporary CSV file.

---

## Custom Hyprland Keybindings

Configured in `~/.config/hypr/bindings.lua` on current Omarchy installations, or `~/.config/hypr/bindings.conf` on legacy installations.

### Personal & Native Apps (`Super + Shift + <Key>`)
| Shortcut | Application |
| :--- | :--- |
| `Super + Shift + B` | Microsoft Edge (Personal) |
| `Super + Shift + E` | Visual Studio Code |
| `Super + Shift + H` | Herdr Desktop (`herdr-workspace.sh`) |
| `Super + Shift + G` | Gmail (Web App) |
| `Super + Shift + O` | Outlook Personal (Web App) |
| `Super + Shift + F` | Cloudflare Dashboard (Web App) |
| `Super + Shift + U` | UniFi Site Manager (`unifi.ui.com`) |
| `Super + Shift + D` | Discord |
| `Super + Shift + S` | Spotify |
| `Super + Shift + W` | WhatsApp (Web App) |
| `Super + Shift + A` | ChatGPT (Web App) |
| `Super + Shift + C` | Claude Desktop |
| `Super + Shift + K` | Ente Auth (Desktop 2FA) |

### Isolated Work Profile Apps (`Super + Alt + <Key>`)
| Shortcut | Application |
| :--- | :--- |
| `Super + Alt + B` | Microsoft Edge (Work Profile) |
| `Super + Alt + O` | Outlook Work (Office 365 Web App) |
| `Super + Alt + T` | Microsoft Teams (Web App) |
| `Super + Alt + D` | OneDrive Web |

---

## Repository Layout

```text
ergonex/
├── bootstrap.sh          # Full Omarchy workstation bootstrapper
├── ergonex.omp.json      # Harness-aware Oh My Posh v3 theme (HUMAN / HERDR / AGENT)
├── herdr-workspace.sh    # Herdr Desktop session & workspace launcher
├── vault-sync.sh         # Encrypted private config backup/restore for OneDrive Personal Vault
└── README.md             # Setup, vault workflow, Microsoft apps, and 2FA guide
```
