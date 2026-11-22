import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "snshah.ts");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("check CLI arity and stable shell output", () => {
  const invalid = Bun.spawnSync([process.execPath, cli, "open", "work4"]);
  expect(invalid.exitCode).toBe(2);
  const shell = Bun.spawnSync([process.execPath, cli, "shell"]);
  expect(shell.success).toBe(true);
  expect(decode(shell.stdout)).toContain("alias ll='ls -al'");
  expect(Bun.spawnSync(["bash", "-n"], { stdin: shell.stdout }).success).toBe(true);
});

test("bootstrap, rerun, shell migration, and separate tenant launch arguments", async () => {
  const home = await mkdtemp(join(tmpdir(), "snshah-test-"));
  try {
    const tools = join(home, "tools");
    const hypr = join(home, ".config/hypr");
    await mkdir(tools);
    await mkdir(hypr, { recursive: true });
    await mkdir(join(home, ".config/opencode"));
    await symlink(process.execPath, join(tools, "bun"));
    const userBashrc = "alias gs='git status'\nexport USER_SETTING=kept\n";
    const agentConfig = '{"myUserSetting":true}\n';
    const userBindings = "-- Existing user bindings\n";
    await writeFile(join(home, ".bashrc"), userBashrc);
    await writeFile(join(home, "AGENTS.md"), "# Existing instructions\n");
    await writeFile(join(home, ".config/opencode/opencode.json"), agentConfig);
    await writeFile(join(hypr, "hyprland.lua"), "");
    await writeFile(join(hypr, "bindings.lua"), userBindings);
    await writeFile(join(tools, "omarchy"), `#!/usr/bin/env bun
import {mkdirSync, writeFileSync} from "node:fs";
const [, , group, action, name, url, icon, exec] = Bun.argv;
if (group === "version") console.log("4.5.0");
else if (group === "default" && action === "browser" && name === "edge") {
  writeFileSync(process.env.HOME + "/default-browser", "microsoft-edge.desktop\\n");
} else if (group === "webapp" && action === "install") {
  const dir = process.env.HOME + "/.local/share/applications";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/" + name + ".desktop", "[Desktop Entry]\\nExec=" + exec + "\\n");
} else process.exitCode = 9;
`, { mode: 0o755 });
    await writeFile(join(tools, "xdg-settings"), '#!/bin/sh\ncat "$HOME/default-browser" 2>/dev/null\n', { mode: 0o755 });
    for (const executable of ["age", "gum", "herdr"])
      await writeFile(join(tools, executable), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(tools, "microsoft-edge-stable"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/browser.log"\n', { mode: 0o755 });

    const env = {
      HOME: home, PATH: `${tools}:${join(home, ".local/bin")}:/usr/bin:/bin`, TERM: "dumb",
    };
    const invoke = (...args: string[]) => {
      const result = Bun.spawnSync(args, { env, cwd: import.meta.dir });
      if (!result.success) throw new Error(`${args.join(" ")}: ${decode(result.stderr)}`);
      return decode(result.stdout);
    };
    const draft = invoke("bun", cli, "plan", "--json");
    expect(invoke("bun", cli, "plan", "--json")).toBe(draft);
    expect(JSON.parse(draft)).toContainEqual({ kind: "command", target: "default-browser" });
    const readme = await readFile(join(import.meta.dir, "README.md"), "utf8");
    const oneLiner = readme.split("\n").find(line => line.startsWith("curl ") && line.endsWith("| bash"));
    if (!oneLiner) throw new Error("README is missing the bootstrap one-liner.");
    const bootstrap = process.env.SNSHAH_TEST_PUBLISHED === "1"
      ? ["bash", "-o", "pipefail", "-c", oneLiner] : ["bash", "bootstrap.sh"];
    expect(invoke(...bootstrap)).toContain("Ergonex setup complete.");
    expect(invoke("snshah", "plan", "--json")).toBe("[]\n");

    const rc = await readFile(join(home, ".bashrc"), "utf8");
    expect(rc.startsWith(userBashrc)).toBe(true);
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe("# Existing instructions\n");
    expect(await readFile(join(home, ".config/opencode/opencode.json"), "utf8")).toBe(agentConfig);
    expect((await readFile(join(hypr, "bindings.lua"), "utf8")).startsWith(userBindings)).toBe(true);
    expect(invoke(...bootstrap)).toBe("No changes needed.\n");
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(rc);
    expect(invoke("bash", "--noprofile", "-ic", "alias ll; alias gs; type mkcd")).toContain("alias ll='ls -al'\nalias gs='git status'");
    expect(invoke("bash", "--noprofile", "-c", 'source "$HOME/.bashrc"; alias ll 2>/dev/null || true')).toBe("");

    for (const tenant of ["work1", "work2", "work3"]) {
      invoke("snshah", "open", tenant, "outlook");
      await Bun.sleep(50);
    }
    const launches = await readFile(join(home, "browser.log"), "utf8");
    for (const tenant of ["work1", "work2", "work3"]) expect(launches).toContain(`--user-data-dir=${home}/.local/share/snshah/edge/${tenant}`);
    expect(launches.match(/--app=https:\/\/outlook\.office\.com\/mail\//g)).toHaveLength(3);
    expect(JSON.parse(invoke("vault-sync.sh", "status")).present).toContain(".config/opencode/opencode.json");
    // Stand in for the encryption tool to exercise streaming and keep-old-files restore behavior.
    await writeFile(join(tools, "age"), '#!/bin/sh\nif [ "$1" = "-d" ]; then cp "$4" "$3"; else cat > "$3"; fi\n', { mode: 0o755 });
    const archive = invoke("snshah", "vault", "backup").trim();
    expect(archive).toEndWith(".tar.gz.age");
    await rm(join(home, ".config/opencode/opencode.json"));
    const restore = Bun.spawnSync(["snshah", "vault", "restore", archive], { env });
    expect(restore.exitCode).toBe(1);
    expect(await readFile(join(home, ".config/opencode/opencode.json"), "utf8")).toBe(agentConfig);
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(rc);
  } finally { await rm(home, { recursive: true, force: true }); }
});
