# Maintaining Shahid's AI Agents Workshop

## Set up a fresh PC

- Use the [README](README.md) as the setup and acceptance runbook. The canonical checkout is `~/Work/github.com/shah/workshop`. The user can choose a different root in the private config or override it for a run with `--workspaces-root`. If the checkout exists, fetch and review its status first.
- Check GitHub access from the PC's shell even if your harness can read the repo through a connector. Run package installs from a regular Omarchy terminal when sudo needs a password. Report any steps that remain pending.
- Target Omarchy Quattro with Lua-based Hyprland. Prefer native Omarchy commands and verify them with `omarchy commands` on the installed version. Preserve existing user configuration and review `snshah plan` before applying changes to a live desktop.
- Fresh installs start OpenSSH on port 22 and enable it at boot. Validate that only the Workshop account can authenticate from the selected private IPv4 LAN, with either a key or password, and that root SSH login is disabled. When UFW is installed, add a rule for that subnet only. Workshop is designed for private LAN setup. Keep SSH off the public internet and document first-time key installation with the standard OpenSSH client.
- Fresh installs use native Omarchy installers for VS Code, Edge, Oh My Posh, shared tools, Spotify, and missing web app launchers. Edge and Oh My Posh are the Workshop defaults. The README lists the exact installation paths.
- Personal OneDrive is prepared by default at `~/OneDrive/<username>`. Work mounts are opt-in via a tagged rclone profile. Keep mount directories unique, preserve read-only mounts, and let Microsoft sign-in happen interactively.
- Fresh installs start with no work tenants. Add tenants to the ordered `work` array in the private config. Tenant IDs stay stable across label and order changes because they determine browser directories. Mount usernames determine OneDrive paths. This fresh-install workflow does not require legacy config migration.

## Source and privacy

- Keep executable behavior, along with runtime config templates, the Omarchy menu and plugin, and self-tests in `snshah.ts`. `bootstrap.sh` is the thin native setup entry point. `snshah.omp.json` is the standalone optional theme. Use `.auto.` in generated and interim filenames where the consumer permits it.
- Proceed without asking for permission for routine work an experienced engineer would do in their own sandbox. Keep the generated Codex and Claude Code defaults and user-level guidance in sync with the README. Preserve explicit user settings and unrelated instructions.
- Keep command definitions in Commander, terminal prompts in Clack, and color in Chalk. Keep the Bun dependency versions pinned in `snshah.ts`. Preserve clean JSON and shell output and use human-readable colors and labels for terminal output.
- Keep update and bootstrap pinned to the resolved `shah/workshop` commit. Preserve the installed executable until the candidate finishes applying its setup steps. Cover preview, successful installation, download failure, and apply failure in the self-test.
- `~/.config/snshah.conf.ts` is the only user-editable Workshop settings file. It is executable TypeScript, owned by the user and restricted to mode `0600`. Keep actual profile labels, email addresses, tokens, and archives out of Git, screenshots, tests, and diagnostics. The age vault encrypts only this config. Prefer command-scoped tokens and export to interactive shells only when explicitly configured.
- **Configuration → Edit in VS Code** and `snshah config edit` open a dedicated generated workspace, refresh the declarations, and watch for saves. Keep the embedded editor defaults and Bun recommendation in sync with `.vscode/`. Preserve built-in TypeScript formatting, semantic diagnostics, the manual config-check task, and the backup reminder. Keep the parent config directory outside the Explorer.
- The native Omarchy submenu exposes CLI actions. The optional Workshop bar widget uses Omarchy components and the typed `snshah status` response. Keep its compact state free of account identifiers and only fetch panel labels while open. Keep plugin source in this repository and leave registry publication to a separate release decision.

## Verify before shipping

- Before each push to `main`, run `bun fmt` from the repository root and require `bun fmt --check` to pass. Include formatter changes in the same push. Use Bun 1.4.4 or newer.
- Use `bun fmt` when generating or updating `snshah.conf.ts`, its type declarations, and its editor workspace. Pipe private settings to the formatter and preserve quoted secret keys so hidden secret entry continues to work.

- Every push to GitHub `main` publishes a new CLI version. Check the version on remote `main` and advance `cliVersion` in `snshah.ts` before each push. The first version is `0.1.0`. While the CLI is in `0.x`, bump the patch for fixes and docs-only pushes, and the minor for new features or breaking changes. Starting at `1.0.0`, use the major version for breaking changes. Verify that `snshah --version` shows the new version.

- Run `bun --no-env-file ./snshah.ts test`. Check that planning is stable, that the second apply is empty, and that formatting keeps managed secret declarations compatible with hidden token entry. After pushing, `bun --no-env-file ./snshah.ts test --published` checks the README installer against GitHub.
- If editor behavior changes, verify TypeScript formatting and diagnostics using a fake config, and test the save notification in an isolated home. If the menu or bar changes, update the README screenshots from an isolated Omarchy session with sample accounts.
