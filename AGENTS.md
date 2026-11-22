# Maintaining Shahid Shah Workstation

- The user-facing executable is `snshah.ts`. Keep command parsing, typed setup operations, launches, and vault behavior there. The thin bootstrap is the shell entry point. Embed generated configs, the plugin, and tests in the TypeScript file. Keep `snshah.omp.json` as the standalone theme. Use `.auto.` in generated and interim filenames when the consumer permits it.
- Target Omarchy Quattro with Lua-based Hyprland configuration. Verify native operations with `omarchy commands` on the installed version. Place workstation files in the user's config and data directories and preserve the rest of the user's configuration.
- Keep tenant IDs stable and isolated in browser and OneDrive routing. Use generic sample labels in Git. User labels, profiles, credentials, and encrypted archives belong outside the repository.
- Use `~/Work` as the default workspaces root, with a CLI override. Run `bun ./snshah.ts test`. Check that `plan --json` is stable for the same state and that a second apply is empty. The README describes the desktop acceptance test.
- Keep the plugin source in this repository. Publishing it to a registry is a separate release decision.
