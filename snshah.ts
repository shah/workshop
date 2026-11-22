#!/usr/bin/env bun
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const tenants = ["work1", "work2", "work3"] as const;
type Tenant = typeof tenants[number];
const workApps = ["browser", "outlook", "calendar", "teams", "onedrive"] as const;
type WorkApp = typeof workApps[number];
const personalApps = ["gmail", "dot", "herdr", "menu"] as const;
type PersonalApp = typeof personalApps[number];
const agents = ["claude", "codex", "local"] as const;
type Agent = typeof agents[number];
type Features = { local: boolean; sync: boolean };
type Command =
  | { kind: "help" | "context" }
  | { kind: "plan" | "apply"; json: boolean; features: Features }
  | { kind: "doctor"; json: boolean }
  | { kind: "shell"; shell: "bash" | "zsh" }
  | { kind: "open"; app: PersonalApp }
  | { kind: "work"; tenant: Tenant; app: WorkApp }
  | { kind: "agent"; agent: Agent; directory: string }
  | { kind: "drive"; tenant: Tenant; action: "list" | "mount" }
  | { kind: "vault"; action: "status" | "backup" }
  | { kind: "restore"; archive?: string }
  | { kind: "plugin"; action: "install" | "remove" | "toggle" };

type Step =
  | { kind: "file"; path: string; content: string; executable?: boolean; private?: boolean }
  | { kind: "command"; id: string; argv: string[] }
  | { kind: "wait"; service: "ollama" };

const home = homedir();
const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
const bin = join(home, ".local/bin/snshah");
const profileDir = join(config, "snshah");
const profileFile = join(profileDir, "profile.json");
const assetDir = join(data, "snshah");
const pluginId = "shah.ergonex";
const pluginDir = join(config, "omarchy/plugins", pluginId);
const pluginFiles = ["manifest.json", "Panel.qml"] as const;
const ollamaUrl = "http://127.0.0.1:11434";
const defaultModel = "qwen3-coder:30b";
const defaults = { work1: "Work 1", work2: "Work 2", work3: "Work 3" } satisfies Record<Tenant, string>;
const urls: Record<WorkApp, string> = {
  browser: "https://www.microsoft365.com/",
  outlook: "https://outlook.office.com/mail/",
  calendar: "https://outlook.office.com/calendar/",
  teams: "https://teams.microsoft.com/",
  onedrive: "https://www.microsoft365.com/launch/onedrive",
};
const addedAliases = {
  ll: "ls -al", gs: "git status --short --branch", gd: "git diff",
  gds: "git diff --staged", gl: "git log --oneline --graph --decorate",
} as const;

class UsageError extends Error {}
const usage = `Usage: snshah <command>

  plan|apply [--local-ai] [--sync] [--json]
  doctor [--json]
  shell [bash|zsh]
  open gmail|dot|herdr|menu
  open work1|work2|work3 [browser|outlook|calendar|teams|onedrive]
  agent claude|codex|local [directory]
  drive list|mount work1|work2|work3
  vault status|backup|restore [archive]
  context
  plugin install|remove|toggle`;

function member<const T extends readonly string[]>(choices: T, value: string | undefined): value is T[number] {
  return value !== undefined && choices.some(choice => choice === value);
}

function parse(argv: string[]): Command {
  const [kind, first, second, ...rest] = argv;
  if (!kind || member(["help", "-h", "--help"], kind) && !first) return { kind: "help" };
  if (kind === "plan" || kind === "apply") {
    const flags = argv.slice(1);
    if (flags.every(flag => member(["--local-ai", "--sync", "--json"], flag)) && new Set(flags).size === flags.length)
      return { kind, json: flags.includes("--json"), features: { local: flags.includes("--local-ai"), sync: flags.includes("--sync") } };
  }
  if (kind === "doctor" && (!first || first === "--json") && !second) return { kind, json: !!first };
  if (kind === "shell" && !second && (!first || member(["bash", "zsh"], first))) return { kind, shell: first === "zsh" ? "zsh" : "bash" };
  if (kind === "context" && !first) return { kind };
  if (kind === "open" && !second && member(personalApps, first)) return { kind, app: first };
  if (kind === "open" && !rest.length && member(tenants, first) && (!second || member(workApps, second)))
    return { kind: "work", tenant: first, app: member(workApps, second) ? second : "outlook" };
  if (kind === "agent" && !rest.length && member(agents, first))
    return { kind, agent: first, directory: resolve(second ?? process.cwd()) };
  if (kind === "drive" && !rest.length && member(["list", "mount"], first) && member(tenants, second))
    return { kind, action: first, tenant: second };
  if (kind === "vault" && !second && member(["status", "backup"], first)) return { kind, action: first };
  if (kind === "vault" && first === "restore" && !rest.length) return { kind: "restore", archive: second };
  if (kind === "plugin" && !second && member(["install", "remove", "toggle"], first)) return { kind, action: first };
  throw new UsageError(`Invalid arguments.\n${usage}`);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function read(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function atomicFile(path: string, content: string, mode?: number): Promise<void> {
  const previous = await exists(path) ? await lstat(path) : undefined;
  if (previous && !previous.isFile()) throw new Error(`Expected a regular file at ${path}`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), ".snshah-"));
  const draft = join(temporary, basename(path));
  try {
    await writeFile(draft, content, { mode: mode ?? (previous && (previous.mode & 0o777)) ?? 0o644 });
    await rename(draft, path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function available(command: string): boolean { return Bun.which(command) !== null; }

async function run(argv: string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<void> {
  const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "inherit", stdout: options.quiet ? 2 : "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${argv[0]} exited with status ${code}`);
}

function capture(argv: string[], env = process.env): string | undefined {
  if (!available(argv[0])) return undefined;
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", timeout: 3000, env });
  return result.success ? result.stdout.toString().trim() : undefined;
}

function launch(argv: string[], cwd?: string): void {
  Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "ignore", stderr: "inherit" }).unref();
}

function print(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) for (const item of value) console.log(item);
  else console.log(value);
}

function shellCode(shell: "bash" | "zsh"): string {
  const aliases = Object.entries(addedAliases).map(([name, value]) =>
    `alias ${name} >/dev/null 2>&1 || alias ${name}='${value}'`);
  const fnCheck = shell === "bash" ? "declare -F mkcd" : "whence -w mkcd";
  return [...aliases, `${fnCheck} >/dev/null 2>&1 || mkcd() { mkdir -p -- "$1" && cd -- "$1"; }`].join("\n");
}

const beginShell = "# >>> snshah shell >>>";
const endShell = "# <<< snshah shell <<<";
const shellBlock = [
  beginShell,
  'if [[ $- == *i* && -x "$HOME/.local/bin/snshah" ]]; then',
  '  if _snshah_init=$("$HOME/.local/bin/snshah" shell bash); then',
  '    eval "$_snshah_init"',
  "  fi",
  "  unset _snshah_init",
  "fi",
  endShell,
].join("\n");

function upsertBlock(content: string, start: string, end: string, block: string): string {
  const lines = content.split("\n");
  const first = lines.indexOf(start);
  const last = lines.indexOf(end);
  if (first === -1 && last === -1) return `${content}${content && !content.endsWith("\n") ? "\n" : ""}${block}\n`;
  if (last <= first || first < 0 || lines.lastIndexOf(start) !== first || lines.lastIndexOf(end) !== last)
    throw new Error(`Invalid managed block: ${start}`);
  return [...lines.slice(0, first), block, ...lines.slice(last + 1)].join("\n");
}

type Profile = { labels: Record<Tenant, string>; model: string };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function profile(): Promise<Profile> {
  const contents = await read(profileFile);
  if (contents === undefined) return { labels: { ...defaults }, model: defaultModel };
  const value: unknown = JSON.parse(contents);
  if (!object(value) || !object(value.labels) || typeof value.model !== "string" || !/^[\w./:-]{1,100}$/.test(value.model) || value.model.startsWith("-"))
    throw new Error(`Invalid profile at ${profileFile}`);
  const labels = { ...defaults };
  for (const tenant of tenants) {
    const label = value.labels[tenant];
    if (typeof label !== "string" || !label.trim() || label.length > 48 || /[\x00-\x1f\x7f]/.test(label))
      throw new Error(`Invalid label for ${tenant} in ${profileFile}`);
    labels[tenant] = label;
  }
  return { labels, model: value.model };
}

function cliAsset(relative: string): Promise<string | undefined> {
  const source = join(import.meta.dir, relative);
  return read(source).then(content => content ?? read(join(assetDir, relative)));
}

const appEntries = [
  { name: "Ergonex Gmail", url: "https://mail.google.com/", icon: "mail-message-new", args: "open gmail" },
  { name: "Ergonex ChatGPT Dot", url: "https://chatgpt.com/dots", icon: "system-help", args: "open dot" },
  ...tenants.flatMap((tenant, i) => ([
    { name: `Ergonex Outlook Work ${i + 1}`, url: urls.outlook, icon: "mail-message-new", args: `open ${tenant} outlook` },
    { name: `Ergonex OneDrive Work ${i + 1}`, url: urls.onedrive, icon: "folder-remote", args: `open ${tenant} onedrive` },
  ])),
];

const defaultVaultItems = [
  ".ssh", ".gnupg", ".age", ".gitconfig.local", ".git-credentials", ".npmrc", ".pypirc", ".aws",
  ".config/gh", ".config/onedrive", ".config/rclone", ".config/ente", ".config/opencode/opencode.json",
  ".config/hypr/monitors.lua", ".config/hypr/input.lua", ".config/ergonex", ".config/snshah",
];

async function plan(features: Features): Promise<Step[]> {
  if (!available("omarchy")) throw new Error("Run setup on Omarchy with omarchy on PATH.");
  const settings = await profile();
  const steps: Step[] = [];
  async function file(path: string, content: string, options: { executable?: boolean; private?: boolean } = {}) {
    const mode = await exists(path) ? await lstat(path) : undefined;
    if (mode && !mode.isFile()) throw new Error(`Expected a regular file at ${path}`);
    if (await read(path) !== content || (options.executable && !(mode && mode.mode & constants.S_IXUSR)) ||
        (options.private && !!(mode && mode.mode & 0o077)))
      steps.push({ kind: "file", path, content, ...options });
  }

  const source = await read(import.meta.path);
  if (source === undefined) throw new Error("Cannot locate the snshah TypeScript script.");
  await file(bin, source, { executable: true });
  for (const name of pluginFiles) {
    const content = await cliAsset(`plugin/${name}`);
    if (content === undefined) throw new Error(`Missing bundled plugin asset: ${name}`);
    await file(join(assetDir, "plugin", name), content);
  }
  if (!await exists(profileFile)) await file(profileFile, JSON.stringify(settings, null, 2) + "\n", { private: true });
  const bashrc = join(home, ".bashrc");
  await file(bashrc, upsertBlock(await read(bashrc) ?? "", beginShell, endShell, shellBlock));
  const hypr = join(config, "hypr");
  if (!await exists(join(hypr, "hyprland.lua"))) throw new Error("Ergonex requires Omarchy Quattro with Hyprland Lua.");
  const bindings = join(hypr, "bindings.lua");
  const bindingFile = join(hypr, "snshah.lua");
  await file(bindingFile, 'o.bind("SUPER + ALT + M", "Ergonex Workstation", "omarchy-launch-terminal snshah open menu")\n');
  const bindingBlock = [
    "-- >>> snshah workstation >>>",
    'dofile((os.getenv("XDG_CONFIG_HOME") or os.getenv("HOME") .. "/.config") .. "/hypr/snshah.lua")',
    "-- <<< snshah workstation <<<",
  ];
  await file(bindings, upsertBlock(await read(bindings) ?? "", bindingBlock[0], bindingBlock[2], bindingBlock.join("\n")));
  for (const [id, path, command] of [
    ["vault", join(home, ".local/bin/vault-sync.sh"), 'vault "$@"'],
    ["herdr", join(home, ".local/bin/herdr-workspace.sh"), "open herdr"],
  ] as const) {
    const previous = await read(path);
    if (previous === undefined || previous.includes("# Ergonex") || previous.includes("# Managed by snshah"))
      await file(path, `#!/bin/sh\n# Managed by snshah (${id})\n${id === "vault" ? 'if [ "$#" -eq 0 ]; then set -- status; fi\n' : ""}exec "$HOME/.local/bin/snshah" ${command}\n`, { executable: true });
  }
  if (!available("microsoft-edge-stable"))
    steps.push({ kind: "command", id: "install-edge", argv: ["omarchy", "install", "browser", "edge"] });
  if (capture(["xdg-settings", "get", "default-web-browser"], { ...process.env, XDG_CURRENT_DESKTOP: "" }) !== "microsoft-edge.desktop")
    steps.push({ kind: "command", id: "default-browser", argv: ["omarchy", "default", "browser", "edge"] });
  for (const [executable, pkg] of [["age", "age"], ["gum", "gum"], ["herdr", "herdr"]] as const) {
    if (!available(executable)) steps.push({ kind: "command", id: `install-${pkg}`, argv: ["omarchy", "pkg", "add", pkg] });
  }
  const apps = join(data, "applications");
  if (data !== join(home, ".local/share")) throw new Error("Omarchy web app installation requires the default XDG_DATA_HOME.");
  for (const app of appEntries) {
    const command = `snshah ${app.args}`;
    const desktop = await read(join(apps, `${app.name}.desktop`));
    if (!desktop?.split("\n").includes(`Exec=${command}`))
      steps.push({ kind: "command", id: app.args, argv: ["omarchy", "webapp", "install", app.name, app.url, app.icon, command, ""] });
  }

  if (features.sync) {
    if (!available("rclone")) steps.push({ kind: "command", id: "install-rclone", argv: ["omarchy", "pkg", "add", "rclone", "fuse3"] });
    else if (!available("fusermount3")) steps.push({ kind: "command", id: "install-fuse3", argv: ["omarchy", "pkg", "add", "fuse3"] });
  }
  if (features.local) {
    if (!available("ollama"))
      steps.push({ kind: "command", id: "install-ollama", argv: ["omarchy", "pkg", "add", "ollama"] });
    if (!await ollamaOnline()) {
      steps.push({ kind: "command", id: "start-ollama", argv: ["sudo", "systemctl", "enable", "--now", "ollama.service"] });
      steps.push({ kind: "wait", service: "ollama" });
    }
    if (!capture(["ollama", "show", settings.model]))
      steps.push({ kind: "command", id: "pull-model", argv: ["ollama", "pull", settings.model] });
    await file(join(profileDir, "opencode.json"), JSON.stringify({
      default_agent: "plan", model: `ollama/${settings.model}`,
      provider: { ollama: { npm: "@ai-sdk/openai-compatible", name: "Ollama", options: { baseURL: `${ollamaUrl}/v1` },
        models: { [settings.model]: { name: settings.model } } } },
    }, null, 2) + "\n");
  }
  return steps;
}

async function ollamaOnline(): Promise<boolean> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch { return false; }
}

async function apply(features: Features, json: boolean): Promise<void> {
  await mkdir(assetDir, { recursive: true });
  const lock = join(assetDir, "apply.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Setup is locked: ${lock}. If the previous run was interrupted and has stopped, remove this empty directory.`);
    throw error;
  }
  try {
    const steps = await plan(features);
    for (const step of steps) {
      if (!json) console.log(stepLabel(step));
      switch (step.kind) {
        case "file": await atomicFile(step.path, step.content, step.private ? 0o600 : step.executable ? 0o755 : undefined); break;
        case "command": await run(step.argv, { quiet: json }); break;
        case "wait": await waitForOllama(); break;
      }
    }
    if (json) print({ completed: describe(steps) }, true);
    else console.log(steps.length ? "Ergonex setup complete." : "No changes needed.");
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function waitForOllama(): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    if (await ollamaOnline()) return;
    await Bun.sleep(300);
  } while (Date.now() < deadline);
  throw new Error("Ollama did not become reachable on port 11434. Check journalctl -u ollama.service.");
}

function stepLabel(step: Step): string {
  switch (step.kind) {
    case "command": return step.argv.join(" ");
    case "wait": return `Wait for ${step.service}`;
    case "file": return `file: ${step.path}`;
  }
}

function describe(steps: Step[]): Array<{ kind: string; target: string }> {
  return steps.map(step => ({ kind: step.kind, target: step.kind === "command" ? step.id : step.kind === "wait" ? step.service : step.path }));
}

async function doctor(json: boolean): Promise<void> {
  const settings = await profile();
  const result = {
    omarchy: capture(["omarchy", "version"]) ?? null,
    shell: (await read(join(home, ".bashrc")))?.includes(beginShell) ?? false,
    edge: available("microsoft-edge-stable"),
    herdr: available("herdr"),
    plugin: await exists(join(pluginDir, "manifest.json")),
    ollama: await ollamaOnline(),
    model: settings.model,
    rclone: available("rclone"),
  };
  print(json ? result : Object.entries(result).map(([key, value]) => `${key}: ${value ?? "unavailable"}`), json);
}

async function browser(url: string, tenant?: Tenant, app = true): Promise<void> {
  const args = ["microsoft-edge-stable"];
  if (tenant) {
    const previous = join(home, ".local/share/edge-work-profile");
    const directory = tenant === "work1" && await exists(previous) ? previous : join(data, "snshah/edge", tenant);
    args.push(`--user-data-dir=${directory}`);
  }
  args.push(app ? `--app=${url}` : url);
  launch(args);
}

async function openApp(app: PersonalApp): Promise<void> {
  switch (app) {
    case "gmail": await browser("https://mail.google.com/"); return;
    case "dot": await browser("https://chatgpt.com/dots"); return;
    case "herdr":
      if (available("herdr-app")) launch(["herdr-app"]);
      else launch(["omarchy-launch-terminal", "herdr"]);
      return;
    case "menu": {
      const { labels } = await profile();
      const actions = new Map<string, Command>([
        ["Gmail · Personal", { kind: "open", app: "gmail" }],
        ["ChatGPT Dot", { kind: "open", app: "dot" }],
        ["Herdr", { kind: "open", app: "herdr" }],
      ]);
      for (const [i, tenant] of tenants.entries()) {
        for (const [label, app] of [["Outlook", "outlook"], ["Calendar", "calendar"], ["Teams", "teams"], ["OneDrive", "onedrive"]] as const)
          actions.set(`${i + 1} · ${labels[tenant]} · ${label}`, { kind: "work", tenant, app });
      }
      const child = Bun.spawn(["gum", "choose", "--header", "Ergonex", ...actions.keys()], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
      const [selection, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code === 130 || code === 1) return;
      if (code !== 0) throw new Error(`gum exited with status ${code}`);
      const action = actions.get(selection.trimEnd());
      if (!action) throw new Error("The launcher returned an unknown action.");
      await execute(action);
    }
  }
}

async function runAgent(agent: Agent, directory: string): Promise<void> {
  if (!(await stat(directory)).isDirectory()) throw new Error(`Expected a workspace directory: ${directory}`);
  if (agent !== "local") {
    await run([agent], { cwd: directory });
    return;
  }
  const localConfig = join(profileDir, "opencode.json");
  if (!await exists(localConfig)) throw new Error("Set up the local agent with snshah apply --local-ai.");
  const child = Bun.spawn(["opencode"], {
    cwd: directory, env: { ...process.env, OPENCODE_CONFIG: localConfig },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

async function drive(action: "list" | "mount", tenant: Tenant): Promise<void> {
  const remote = `snshah-${tenant}:`;
  if (action === "list") {
    await run(["rclone", "lsf", remote]);
    return;
  }
  const mount = join(home, "OneDrive", tenant);
  await mkdir(mount, { recursive: true, mode: 0o700 });
  await run(["rclone", "mount", remote, mount, "--read-only"]);
}

const vaultConfig = join(config, "ergonex/vault-manifest.txt");
const vaultStaging = process.env.ERGONEX_VAULT_STAGING || join(process.env.ERGONEX_ONEDRIVE_DIR || join(home, "OneDrive"), "Vault-Staging");

async function vaultPaths(): Promise<string[]> {
  const contents = await read(vaultConfig);
  const paths = contents === undefined ? defaultVaultItems : contents.split("\n").map(line => line.split("#", 1)[0].trim()).filter(Boolean);
  for (const name of paths) {
    if (isAbsolute(name) || name.split("/").some(part => part === ".." || part === "."))
      throw new Error(`Vault manifest path must be relative to home: ${name}`);
  }
  return [...new Set(paths)];
}

async function archives(): Promise<string[]> {
  if (!await exists(vaultStaging)) return [];
  const files = (await readdir(vaultStaging, { withFileTypes: true }))
    .filter(file => file.isFile() && /^ergonex-private-.*\.tar\.gz\.(age|gpg)$/.test(file.name));
  const dated = await Promise.all(files.map(async file => {
    const path = join(vaultStaging, file.name);
    return { path, time: (await stat(path)).mtimeMs };
  }));
  return dated.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path, "en")).map(file => file.path);
}

async function vault(action: "status" | "backup"): Promise<void> {
  const paths = await vaultPaths();
  const present = (await Promise.all(paths.map(async path => await exists(join(home, path)) ? path : null))).filter(path => path !== null);
  if (action === "status") {
    print({ manifest: vaultConfig, staging: vaultStaging, present, archives: await archives() }, true);
    return;
  }
  if (!present.length) throw new Error("No matching files in the vault manifest.");
  const crypto = available("age") ? "age" : "gpg";
  if (!available(crypto)) throw new Error("Install age or GnuPG before backing up.");
  if (!await exists(vaultConfig)) await atomicFile(vaultConfig, defaultVaultItems.join("\n") + "\n", 0o600);
  await mkdir(vaultStaging, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(vaultStaging, ".snshah-vault-"));
  try {
    const file = join(temporary, "backup");
    const pipeline = [
      'destination=$1; crypto=$2; directory=$3; shift 3',
      'tar -C "$directory" -czf - -- "$@" | case "$crypto" in',
      '  age) age -p -o "$destination" ;;',
      '  gpg) gpg --symmetric --cipher-algo AES256 -o "$destination" ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join("\n");
    await run(["bash", "-o", "pipefail", "-c", pipeline, "snshah-vault", file, crypto, home, ...present]);
    await chmod(file, 0o600);
    const host = hostname().replace(/[^a-zA-Z0-9._-]/g, "-");
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(vaultStaging, `ergonex-private-${host}-${date}.tar.gz.${crypto}`);
    await rename(file, destination);
    console.log(destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function restore(archive?: string): Promise<void> {
  const source = archive ? resolve(archive) : (await archives())[0];
  if (!source || !/\.(age|gpg)$/.test(source)) throw new Error("Supply an encrypted .age or .gpg vault archive.");
  const temporary = await mkdtemp(join(tmpdir(), "snshah-restore-"));
  try {
    const file = join(temporary, "snapshot.tar.gz");
    await run(source.endsWith(".age") ? ["age", "-d", "-o", file, source] : ["gpg", "-d", "-o", file, source]);
    await run(["tar", "-tzf", file]);
    await run(["tar", "--keep-old-files", "-C", home, "-xzf", file]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function plugin(action: "install" | "remove" | "toggle"): Promise<void> {
  if (config !== join(home, ".config")) throw new Error("Omarchy plugin management requires the default XDG_CONFIG_HOME.");
  switch (action) {
    case "install":
      for (const name of pluginFiles) {
        const content = await cliAsset(`plugin/${name}`);
        if (content === undefined) throw new Error(`Missing plugin asset: ${name}`);
        await atomicFile(join(pluginDir, name), content);
      }
      await run(["omarchy", "plugin", "validate", pluginDir]);
      await run(["omarchy-shell", "shell", "rescanPlugins"]);
      await run(["omarchy", "plugin", "enable", pluginId]);
      return;
    case "remove":
      if (await exists(pluginDir)) await run(["omarchy", "plugin", "remove", pluginId, "--yes"]);
      return;
    case "toggle":
      await run(["omarchy-shell", pluginId, "toggle"]);
  }
}

async function execute(command: Command): Promise<void> {
  switch (command.kind) {
    case "help": console.log(usage); return;
    case "shell": console.log(shellCode(command.shell)); return;
    case "context":
      console.log(process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX || process.env.CLAUDECODE || process.env.OPENCODE ? "AGENT" :
        process.env.HERDR_PANE_ID || process.env.HERDR_SESSION_ID || process.env.HERDR ? "HERDR" : "HUMAN");
      return;
    case "doctor": await doctor(command.json); return;
    case "open": await openApp(command.app); return;
    case "work": await browser(urls[command.app], command.tenant, command.app !== "browser"); return;
    case "agent": await runAgent(command.agent, command.directory); return;
    case "drive": await drive(command.action, command.tenant); return;
    case "vault": await vault(command.action); return;
    case "restore": await restore(command.archive); return;
    case "plugin": await plugin(command.action); return;
    case "plan": {
      const steps = await plan(command.features);
      if (command.json) print(describe(steps), true);
      else print(steps.length ? steps.map(stepLabel) : "No changes needed.", false);
      return;
    }
    case "apply": {
      if (process.getuid?.() === 0) throw new Error("Run snshah apply as your desktop user.");
      try { await apply(command.features, command.json); } catch (error) { throw new Error(`Setup stopped: ${errorMessage(error)}. Run snshah plan to see what remains.`); }
      return;
    }
  }
  const exhaustive: never = command;
  throw new Error(`Unhandled command: ${exhaustive}`);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

try { await execute(parse(Bun.argv.slice(2))); }
catch (error) {
  console.error(`snshah: ${errorMessage(error)}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
