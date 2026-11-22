# Maintaining Shahid Shah Workstation

## Resume after a reinstall

- Use the [README](README.md) as the setup and acceptance runbook. The canonical checkout is `~/Work/github.com/shah/workstation`. The user can choose a different root in the private config or override it for a run with `--workspaces-root`. If the checkout exists, fetch and review its status first.
- Target Omarchy Quattro with Lua-based Hyprland. Prefer native Omarchy commands and verify them with `omarchy commands` on the installed version. Preserve existing user configuration and review `snshah plan` before applying changes to a live desktop.
- Fresh installs start with no work tenants. Add tenants to the ordered `work` array in the private config. Tenant IDs stay stable across label and order changes because they determine browser and OneDrive paths. This fresh-install workflow does not require legacy config migration.

## Source and privacy

- Keep executable behavior, runtime config templates, the Omarchy menu and plugin, and self-tests in `snshah.ts`. `bootstrap.sh` is the thin native setup entry point. `snshah.omp.json` is the standalone optional theme. Use `.auto.` in generated and interim filenames where the consumer permits it.
- `~/.config/snshah.conf.ts` is the only user-editable workstation settings file. It is executable TypeScript, owned by the user and restricted to mode `0600`. Keep actual profile labels, email addresses, tokens, and archives out of Git, screenshots, tests, and diagnostics. The age vault encrypts only this config. Prefer command-scoped tokens and export to interactive shells only when explicitly configured.
- **Configuration → Edit in VS Code** and `snshah config edit` open a dedicated generated workspace, refresh the declarations, and watch for saves. Keep the embedded editor defaults and Bun recommendation in sync with `.vscode/`. Preserve built-in TypeScript formatting, semantic diagnostics, the manual config-check task, and the backup reminder. Keep the parent config directory outside the Explorer.
- The native Omarchy submenu exposes CLI actions. The optional plugin is a shortcut to that menu. Keep plugin source in this repository and leave registry publication to a separate release decision.

## Verify before shipping

- Run `bun --no-env-file ./snshah.ts test`. Check that planning is stable, that the second apply is empty, and that formatting keeps managed secret declarations compatible with hidden token entry. After pushing, `bun --no-env-file ./snshah.ts test --published` checks the README installer against GitHub.
- If editor behavior changes, verify TypeScript formatting and diagnostics using a fake config, and test the save notification in an isolated home. If menu labels or structure change, update the README and its screenshots using an isolated Omarchy session.
