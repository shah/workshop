# Ergonex

An opinionated Omarchy Quattro workstation for someone coming from Windows and Outlook Desktop. **`snshah`** is the command that sets it up, opens your mail and files, and starts the coding agent you choose.

Ergonex gives you a keyboard-driven launcher for Gmail, three separate Microsoft 365 work tenants, ChatGPT Dot, and Herdr. Omarchy handles package installation, browser defaults, web app launchers, and desktop integration. Your local profile gives the work tenants names you recognize.

## Install

Use an Omarchy Quattro desktop with Lua-based Hyprland config. Run as your regular user. Package installation and system service setup can ask for sudo.

To preview changes, clone into the canonical workspace path and run:

```bash
mkdir -p ~/workspaces/github.com/shah
git clone https://github.com/shah/ergonex.git ~/workspaces/github.com/shah/ergonex
cd ~/workspaces/github.com/shah/ergonex
# If Bun is missing, install it with Omarchy before previewing.
omarchy pkg add bun || omarchy pkg aur add bun-bin
bun ./snshah.ts plan
bun ./snshah.ts apply
```

If the checkout already exists, run `git fetch --all --prune` in it and review its status before updating it.

For a fresh machine, the bootstrap installs Bun if needed and applies the profile from a single Git revision:

```bash
curl -fsSL https://raw.githubusercontent.com/shah/ergonex/main/bootstrap.sh | bash
```

Run `snshah plan` to see outstanding changes. If setup stops partway through, fix the reported error and rerun `snshah apply`. The first apply sets Edge as the default browser and adds a workstation hotkey. The optional Ollama and OneDrive tools are enabled by `snshah apply --local-ai` and `snshah apply --sync`, respectively. You can combine both flags.

## Mail, calendar, meetings, and files

Press **Super + Alt + M** for the Ergonex chooser, or use **Super + Space** and search for an Ergonex launcher. The chooser includes:

| Account | Available actions |
| --- | --- |
| Personal | Gmail in your regular Edge profile |
| Work 1 | Outlook, Calendar, Teams, and OneDrive in the Work 1 profile |
| Work 2 | Outlook, Calendar, Teams, and OneDrive in the Work 2 profile |
| Work 3 | Outlook, Calendar, Teams, and OneDrive in the Work 3 profile |

Rename the work slots locally in `~/.config/snshah/profile.json`. The fixed IDs `work1`, `work2`, and `work3` keep browser and storage routing stable when you rename a slot. For example:

```json
{
  "labels": { "work1": "Company A", "work2": "Company B", "work3": "Company C" },
  "model": "qwen3-coder:30b"
}
```

Open the full browser for each slot once and sign in to the corresponding tenant. Then use its app windows for day-to-day work:

```bash
snshah open work1 browser
snshah open work2 outlook
snshah open work3 calendar
snshah open work3 onedrive
```

The three work profiles have separate Edge data directories and sign-ins. If you used the original Ergonex work profile, Work 1 reuses that directory. Check which account is active before sending mail or moving files. Outlook is the web app in its own window. For Edge's installed PWA experience, use **Apps → Install this site as an app** from within the corresponding profile. Tenant sign-in, device-compliance requirements, and feature availability are controlled by Microsoft and your organization. [Microsoft Outlook web app guide](https://support.microsoft.com/en-us/outlook/use-the-web-version-of-outlook-like-a-desktop-app)

### OneDrive in the file manager

The OneDrive web launchers work after tenant sign-in. For local file browsing, install the optional rclone and FUSE packages and set up three distinct OneDrive remotes:

```bash
snshah apply --sync
rclone config
# Name the remotes snshah-work1, snshah-work2, and snshah-work3.
snshah drive list work2
snshah drive mount work2
```

In rclone, select the OneDrive backend and complete authentication for the matching tenant. Verify the remote with `drive list` before mounting it. A mount appears at `~/OneDrive/work2` while the command runs. Open that folder in Omarchy's file manager, and press Ctrl+C in the mount terminal to unmount. Ergonex mounts read-only. Use the tenant's web app for moves, uploads, and edits. [rclone OneDrive setup](https://rclone.org/onedrive/)

## ChatGPT Dot and engineering

- **ChatGPT Dot** opens `chatgpt.com/dots` through `snshah open dot`. Connect apps and select the correct ChatGPT workspace inside ChatGPT. Dot access and local desktop capabilities depend on the account and supported client. [OpenAI Dot setup](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)
- **Herdr** opens through `snshah open herdr`. It uses Herdr Desktop when present and the Omarchy terminal launcher for native Herdr otherwise. Open separate panes for Claude Code and Codex. Give agents that will edit concurrently separate Git worktrees under your workspace and run each from its own checkout.
- **Claude Code and Codex** use your existing Omarchy-managed runtimes and sign-ins. Run `snshah agent claude /path/to/worktree` or `snshah agent codex /path/to/worktree` in a terminal or Herdr pane.
- **Local OpenCode** is optional. Run `snshah plan --local-ai` before applying. Setup installs Ollama when needed, starts its system service, pulls the configured model, and writes a dedicated OpenCode config. Change the model in the local profile before pulling if your machine needs a smaller model. Run `snshah agent local` to launch OpenCode with that config.
- **Agent usage** can be surfaced through Omarchy’s built-in Agents widget where available. The Ergonex panel focuses on launching work and checking local Ollama.

## Shell and desktop integration

`snshah apply` adds one interactive-only block to the user’s `~/.bashrc`, after the existing startup code. New terminals load the shell additions automatically. Existing aliases and functions take precedence.

| Shortcut | Command |
| --- | --- |
| `ll` | `ls -al`, including Omarchy’s usual `ls` alias |
| `gs` | `git status --short --branch` |
| `gd` / `gds` | Unstaged / staged diff |
| `gl` | Compact decorated Git graph |
| `mkcd DIR` | Create a directory and enter it |

Use `snshah shell bash` to inspect the generated code. Zsh users can opt in with `eval "$(snshah shell zsh)"` in their interactive `.zshrc`. Use `snshah context` to print a best-effort `HUMAN`, `HERDR`, or `AGENT` indicator for prompt customization.

The workstation hotkey loads from `~/.config/hypr/snshah.lua`. Check the active bindings with `omarchy menu keybindings --print` if you already use Super + Alt + M.

### Optional Ergonex panel

```bash
snshah plugin install
snshah plugin toggle
snshah plugin remove
```

The Quickshell panel opens Herdr or one of the work browser profiles and checks local Ollama status when opened. It supports arrow keys and Enter. The plugin source lives under [`plugin/`](plugin/). Installation validates and enables the local copy through Omarchy.

## Encrypted Personal Vault

```bash
snshah vault status
snshah vault backup
snshah vault restore /path/to/ergonex-private-snapshot.tar.gz.age
```

Backups use age passphrase encryption, with symmetric GnuPG as a fallback. The manifest at `~/.config/ergonex/vault-manifest.txt` lists paths relative to your home. Review it before backing up. It can include credentials, so keep the manifest and archive private. Encrypted snapshots go to `~/OneDrive/Vault-Staging` by default. After opening your **personal** OneDrive and unlocking Personal Vault interactively, upload or move the encrypted snapshot there. The read-only business mounts are independent of this workflow.

Restore accepts the previous Bash version’s age and GPG archives and preserves existing files. Restore into a clean home when possible. If existing files conflict, the command can restore missing files and report a failure for the conflicts. The old `vault-sync.sh` and `herdr-workspace.sh` entry points forward to `snshah`.

## Maintenance and acceptance

`snshah.ts` is the executable TypeScript source and runs from its Bun shebang. Keep user-facing behavior in that file and keep the bootstrap and compatibility scripts small. The installer preserves existing home agent instructions, the stock OpenCode config, and existing shell and Hyprland user lines. Legacy launchers and prompt settings remain available during migration.

```bash
bun test
bun ./snshah.ts plan --json
omarchy plugin validate plugin
```

The automated test uses a temporary home, covers first apply and rerun, and checks shell startup, existing settings, and the three tenant launch arguments. On an Omarchy test desktop, run the README installer twice. Confirm the second run reports **No changes needed**, start a new terminal and run `alias ll`, then use the chooser to open each tenant. If testing the plugin, install it, open the panel, exercise its actions, and remove it. Run `hyprctl configerrors` to check the active Hyprland configuration. Use `snshah doctor --json` to capture a machine-readable diagnostic summary.

Keep repository changes under the canonical workspace tree. Store local tenant names, sign-ins, browser profiles, and vault contents outside Git.
