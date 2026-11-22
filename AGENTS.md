# Maintaining Ergonex

- The user-facing executable is `snshah.ts`. Keep command parsing, typed setup operations, launches, and vault behavior there. Shell scripts are entry points or compatibility shims. Keep Quickshell code presentational and invoke the CLI with argument arrays.
- Target Omarchy Quattro with Lua-based Hyprland configuration. Verify native operations with `omarchy commands` on the installed version. Place Ergonex files in the user's config and data directories and preserve the rest of the user's configuration.
- Keep tenant IDs stable and isolated in browser and OneDrive routing. Use generic sample labels in Git. User labels, profiles, credentials, and encrypted archives belong outside the repository.
- Run `bun test` and `omarchy plugin validate plugin`. Check that `plan --json` is stable for the same state and that a second apply is empty. The README describes the desktop acceptance test.
- Keep the plugin source in this repository. Publishing it to a registry is a separate release decision.
