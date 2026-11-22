#!/usr/bin/env -S bun --no-env-file
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
type Features = { local: boolean; sync: boolean; defaultEdge: boolean; posh: boolean; workspaceRoot?: string };
type Command =
  | { kind: "help" | "context" }
  | { kind: "workspace"; root?: string }
  | { kind: "test"; published: boolean }
  | { kind: "plan" | "apply"; json: boolean; features: Features }
  | { kind: "doctor"; json: boolean }
  | { kind: "shell"; shell: "bash" | "zsh" }
  | { kind: "open"; app: PersonalApp }
  | { kind: "work"; tenant: Tenant; app: WorkApp }
  | { kind: "agent"; agent: Agent; directory: string }
  | { kind: "drive"; tenant: Tenant; action: "list" | "mount" }
  | { kind: "vault"; action: "status" | "backup" }
  | { kind: "restore" | "verify"; archive?: string; overwrite: boolean }
  | { kind: "config"; action: "edit" | "check" | "setup" }
  | { kind: "set-secret"; variable: string }
  | { kind: "menu"; id?: string; terminal: boolean }
  | { kind: "shell-env" }
  | { kind: "plugin"; action: "install" | "remove" | "toggle" };

type Step =
  | { kind: "file"; path: string; content: string; executable?: boolean; private?: boolean }
  | { kind: "command"; id: string; argv: string[] }
  | { kind: "wait"; service: "ollama" }
  | { kind: "checkout"; path: string }
  | { kind: "remove"; path: string; previous: string };

const home = homedir();
const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
const bin = join(home, ".local/bin/snshah");
const profileDir = join(config, "snshah");
const profileFile = join(profileDir, "profile.json");
const assetDir = join(data, "snshah");
const product = "Shahid Shah Workstation";
const remote = "https://github.com/shah/workstation.git";
const defaultWorkspaceRoot = join(home, "Work");
const installConfig = join(profileDir, "install.auto.json");
const theme = join(config, "oh-my-posh/snshah.auto.omp.json");
const oldTheme = join(config, "oh-my-posh/ergonex.omp.json");
const pluginId = "shah.workstation";
const pluginDir = join(config, "omarchy/plugins", pluginId);
const pluginFiles = {
  "manifest.json": `{
  "schemaVersion": 1,
  "id": "shah.workstation",
  "name": "Shahid Shah Workstation",
  "version": "0.1.0",
  "author": "shah",
  "description": "Workstation shortcuts and local Ollama status",
  "kinds": ["bar-widget"],
  "entryPoints": { "barWidget": "Panel.auto.qml" },
  "barWidget": {
    "displayName": "Shahid Shah Workstation",
    "description": "Open Herdr or your work browser and check Ollama",
    "category": "AI",
    "allowMultiple": false
  }
}
`,
  "Panel.auto.qml": `import QtQuick
import Quickshell
import qs.Ui as Ui

Ui.Panel {
  id: root
  moduleName: "shah.workstation"
  Ui.BarIconButton {
    anchors.fill: parent
    bar: root.bar
    text: "󰆍"
    onPressed: Quickshell.execDetached([Quickshell.env("HOME") + "/.local/bin/snshah", "menu"])
  }
}
`,
} as const;
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

  plan|apply [--workspaces-root PATH] [--local-ai] [--sync] [--default-edge] [--posh] [--json]
  workspace [--workspaces-root PATH]
  test [--published]
  doctor [--json]
  shell [bash|zsh]
  open gmail|dot|herdr|menu
  open work1|work2|work3 [browser|outlook|calendar|teams|onedrive]
  agent claude|codex|local [directory]
  drive list|mount work1|work2|work3
  vault status|backup|verify|restore [archive] [--overwrite]
  config setup|check|edit|set-secret [VARIABLE]
  menu
  context
  plugin install|remove|toggle`;

function member<const T extends readonly string[]>(choices: T, value: string | undefined): value is T[number] {
  return value !== undefined && choices.some(choice => choice === value);
}

function parse(argv: string[]): Command {
  const [kind, first, second, ...rest] = argv;
  if (!kind || member(["help", "-h", "--help"], kind) && !first) return { kind: "help" };
  if (kind === "plan" || kind === "apply" || kind === "workspace") {
    const flags = new Set<string>();
    let root: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (flags.has(flag)) throw new UsageError(`Duplicate option: ${flag}`);
      flags.add(flag);
      if (flag === "--workspaces-root") {
        const path = argv[++i];
        if (!path || path.startsWith("--")) throw new UsageError("--workspaces-root requires a path.");
        root = resolve(path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
      } else if (kind === "workspace" || !member(["--local-ai", "--sync", "--default-edge", "--posh", "--json"], flag)) {
        throw new UsageError(`Unknown option: ${flag}`);
      }
    }
    if (kind === "workspace") return { kind, root };
    return { kind, json: flags.has("--json"), features: {
      local: flags.has("--local-ai"), sync: flags.has("--sync"),
      defaultEdge: flags.has("--default-edge"), posh: flags.has("--posh"), workspaceRoot: root,
    } };
  }
  if (kind === "test" && (!first || first === "--published") && !second) return { kind, published: !!first };
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
  if (kind === "vault" && (first === "restore" || first === "verify")) {
    const overwrite = argv.at(-1) === "--overwrite";
    const args = argv.slice(2, overwrite ? -1 : undefined);
    if (args.length <= 1 && (!overwrite || first === "restore") && !args[0]?.startsWith("--"))
      return { kind: first, archive: args[0], overwrite };
  }
  if (kind === "config" && !second && member(["edit", "check", "setup"], first)) return { kind, action: first };
  if (kind === "config" && first === "set-secret" && second && !rest.length) return { kind: "set-secret", variable: second };
  if (kind === "menu" && !first) return { kind, terminal: false };
  if (kind === "menu" && first === "run" && second && (!rest.length || rest.length === 1 && rest[0] === "--terminal"))
    return { kind, id: second, terminal: rest.length === 1 };
  if (kind === "shell-env" && !first) return { kind };
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
  const temporary = await mkdtemp(join(dirname(path), ".snshah.auto.write-"));
  const draft = join(temporary, `draft.auto.${basename(path)}`);
  try {
    await writeFile(draft, content, { mode: mode ?? (previous && (previous.mode & 0o777)) ?? 0o644 });
    await rename(draft, path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function available(command: string): boolean { return Bun.which(command) !== null; }

async function run(argv: string[], options: { cwd?: string; quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const child = Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdin: "inherit", stdout: options.quiet ? 2 : "inherit", stderr: "inherit" });
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

async function shellCode(shell: "bash" | "zsh"): Promise<string> {
  const aliases = Object.entries(addedAliases).map(([name, value]) =>
    `alias ${name} >/dev/null 2>&1 || alias ${name}='${value}'`);
  const fnCheck = shell === "bash" ? "declare -F mkcd" : "whence -w mkcd";
  const lines = [...aliases, `${fnCheck} >/dev/null 2>&1 || mkcd() { mkdir -p -- "$1" && cd -- "$1"; }`];
  if (await exists(theme)) {
    const quoted = "'" + theme.replaceAll("'", "'\\''") + "'";
    lines.push(`if command -v oh-my-posh >/dev/null 2>&1; then eval "$(oh-my-posh init ${shell} --config ${quoted})"; fi`);
  }
  if (await exists(conf)) lines.push(
    'if [[ -x "$HOME/.local/bin/snshah" ]]; then',
    '  { case $- in *x*) _snshah_trace=1; set +x;; esac; } 2>/dev/null',
    '  if _snshah_exports=$("$HOME/.local/bin/snshah" shell-env); then eval "$_snshah_exports"; fi',
    '  unset _snshah_exports',
    '  if [[ ${_snshah_trace:-} == 1 ]]; then unset _snshah_trace; set -x; fi',
    'fi',
  );
  return lines.join("\n");
}

const beginShell = "# >>> snshah shell >>>";
const endShell = "# <<< snshah shell <<<";
const shellBlock = (shell: "bash" | "zsh") => [
  beginShell,
  'if [[ $- == *i* && -x "$HOME/.local/bin/snshah" ]]; then',
  `  if _snshah_init=$("$HOME/.local/bin/snshah" shell ${shell}); then`,
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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const conf = join(home, ".config/snshah.conf.ts");
const declarations = join(dirname(conf), "snshah.auto.d.ts");
const menuPath = join(home, ".config/omarchy/extensions/omarchy-menu.jsonc");
const menuId = "shahid-workstation";
const commandScopes = ["claude", "codex", "local", "drive"] as const;
type Scope = typeof commandScopes[number];
const configTypes = `export type Secret =
  | { variable: string; value: string; scope: "shell" }
  | { variable: string; value: string; scope: "command"; commands: readonly ("claude" | "codex" | "local" | "drive")[] };
export type WorkstationConfig = {
  personal: string;
  work: Record<"work1" | "work2" | "work3",
    { label: string; files: { kind: "web" } | { kind: "rclone"; remote: string } }>;
  workspacesRoot: string;
  prompt: { kind: "starship" } | { kind: "posh" };
  browser: { kind: "omarchy" } | { kind: "edge-default" };
  localAI: { kind: "off" } | { kind: "ollama"; model: string };
  secrets: readonly Secret[];
};
`;

type Secret =
  | { variable: string; value: string; scope: "shell" }
  | { variable: string; value: string; scope: "command"; commands: readonly Scope[] };
type WorkstationConfig = {
  personal: string;
  work: Record<Tenant, { label: string; files: { kind: "web" } | { kind: "rclone"; remote: string } }>;
  workspacesRoot: string;
  prompt: { kind: "starship" } | { kind: "posh" };
  browser: { kind: "omarchy" } | { kind: "edge-default" };
  localAI: { kind: "off" } | { kind: "ollama"; model: string };
  secrets: readonly Secret[];
};
const beginSecrets = "// >>> snshah secrets >>>";
const endSecrets = "// <<< snshah secrets <<<";
function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f/]/.test(value);
}
function validateConfig(v: unknown): asserts v is WorkstationConfig {
  if (!object(v)) throw new Error("Export a WorkstationConfig object.");
  if (!validLabel(v.personal)) throw new Error("Invalid personal profile label.");
  if (!object(v.work)) throw new Error("Missing work profiles.");
  for (const id of tenants) {
    const p = v.work[id];
    if (!object(p) || !validLabel(p.label) || !object(p.files) || !(p.files.kind === "web" ||
      p.files.kind === "rclone" && typeof p.files.remote === "string" && /^[\w][\w .-]{0,63}$/.test(p.files.remote)))
      throw new Error(`Invalid work profile: ${id}.`);
  }
  if (new Set(tenants.map(id => (v.work as Record<Tenant, { label: string }>)[id].label)).size !== tenants.length)
    throw new Error("Work profile labels must be distinct.");
  if (typeof v.workspacesRoot !== "string" || !isAbsolute(v.workspacesRoot) || /[\x00-\x1f]/.test(v.workspacesRoot))
    throw new Error("workspacesRoot must be an absolute path.");
  if (!object(v.prompt) || !member(["starship", "posh"], typeof v.prompt.kind === "string" ? v.prompt.kind : undefined))
    throw new Error("Invalid prompt choice.");
  if (!object(v.browser) || (v.browser.kind !== "omarchy" && v.browser.kind !== "edge-default"))
    throw new Error("Invalid default browser choice.");
  if (!object(v.localAI) || !(v.localAI.kind === "off" ||
    v.localAI.kind === "ollama" && typeof v.localAI.model === "string" && /^[\w][\w./:-]{0,99}$/.test(v.localAI.model)))
    throw new Error("Invalid local AI choice or model.");
  if (!Array.isArray(v.secrets)) throw new Error("Expected a list of secrets.");
  const seen = new Set<string>();
  for (const [i, item] of v.secrets.entries()) {
    if (!object(item) || typeof item.variable !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(item.variable) ||
      /^(PATH|HOME|SHELL|IFS|PWD|OLDPWD|ENV|BASH.*|ZDOTDIR|LD_.*|DYLD_.*|NODE_OPTIONS|BUN_OPTIONS|XDG_.*|SNSHAH_.*)$/.test(item.variable) ||
      seen.has(item.variable) || typeof item.value !== "string" || item.value.includes("\0") ||
      !(item.scope === "shell" || item.scope === "command" && Array.isArray(item.commands) && item.commands.length &&
        item.commands.every(action => member(commandScopes, action as string)) && new Set(item.commands).size === item.commands.length))
      throw new Error(`Invalid or duplicate secret declaration at index ${i}.`);
    seen.add(item.variable);
  }
}

async function privateConfigBytes(): Promise<string> {
  const { open } = await import("node:fs/promises");
  const file = await open(conf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new Error("Cannot open the private workstation config. Run snshah apply to create it.");
  });
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 256 * 1024)
      throw new Error("Workstation config must be a regular file you own with mode 0600 and at most 256 KiB.");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

async function interpretConfig(text: string): Promise<WorkstationConfig> {
  let result: unknown;
  try {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
    result = (await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"))).default;
  } catch { throw new Error("The workstation config could not be loaded. Check its TypeScript syntax and use only type imports."); }
  validateConfig(result);
  return result;
}

async function initialConfig(features?: Features): Promise<WorkstationConfig> {
  const legacy = await read(profileFile);
  const old = legacy ? JSON.parse(legacy) as { labels?: Record<Tenant, string>; model?: string } : {};
  const legacyInstall = await read(installConfig);
  const oldRoot = legacyInstall ? (JSON.parse(legacyInstall) as { workspacesRoot?: string }).workspacesRoot : undefined;
  const work = Object.fromEntries(tenants.map(id => [id, {
    label: old.labels?.[id] ?? defaults[id],
    files: features?.sync ? { kind: "rclone", remote: `snshah-${id}` } : { kind: "web" },
  }])) as WorkstationConfig["work"];
  const hadLegacyPrompt = (await Promise.all([".bashrc", ".zshrc"].map(name => read(join(home, name)))))
    .some(text => text?.includes("~/.config/oh-my-posh/ergonex.omp.json"));
  return { personal: "Personal", work, workspacesRoot: features?.workspaceRoot ?? oldRoot ?? defaultWorkspaceRoot,
    prompt: { kind: features?.posh || hadLegacyPrompt || await exists(theme) ? "posh" : "starship" },
    browser: { kind: features?.defaultEdge ? "edge-default" : "omarchy" },
    localAI: features?.local || await exists(join(profileDir, "opencode.auto.json")) ? { kind: "ollama", model: old.model ?? defaultModel } : { kind: "off" },
    secrets: [] };
}

function configSource(settings: WorkstationConfig): string {
  const { secrets, ...preferences } = settings;
  return [
    'import type { WorkstationConfig } from "./snshah.auto";',
    "// This private TypeScript file is the workstation configuration. Keep mode 0600.",
    beginSecrets, `const secrets = ${JSON.stringify(secrets, null, 2)} satisfies WorkstationConfig["secrets"];`, endSecrets,
    `const preferences = ${JSON.stringify(preferences, null, 2)};`.replace(/;$/, " as const;"),
    "export default { ...preferences, secrets } satisfies WorkstationConfig;",
    "",
  ].join("\n");
}

async function settings(): Promise<WorkstationConfig> {
  return await exists(conf) ? interpretConfig(await privateConfigBytes()) : initialConfig();
}

function shellQuote(input: string): string { return "'" + input.replaceAll("'", "'\\''") + "'"; }

async function secretEnvironment(scope: Scope): Promise<NodeJS.ProcessEnv> {
  const current = await settings();
  const env = { ...process.env };
  for (const secret of current.secrets)
    if (secret.value && secret.scope === "command" && secret.commands.includes(scope)) env[secret.variable] = secret.value;
  return env;
}

async function promptInput(title: string, hidden = false): Promise<string> {
  const result = Bun.spawn(["gum", "input", "--header", title, ...(hidden ? ["--password"] : [])],
    { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const value = await new Response(result.stdout).text();
  if (await result.exited !== 0) throw new Error("Input cancelled.");
  return value.replace(/\r?\n$/, "");
}

async function notify(message: string, backup = false): Promise<void> {
  if (available("omarchy-notification-send")) launch(["omarchy-notification-send", product, message,
    ...(backup ? ["--action", "Back Up Now", "omarchy-launch-terminal", bin, "menu", "run", "vault.backup", "--terminal"] : []),
  ]);
  else if (available("notify-send")) await run(["notify-send", product, message]);
}

async function editConfig(): Promise<void> {
  let previous = await privateConfigBytes();
  const { watch } = await import("node:fs");
  const watcher = watch(dirname(conf), (_event, name) => {
    if (name === basename(conf)) {
      clearTimeout(timer);
      timer = setTimeout(() => { void saved(); }, 220);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function saved() {
    try {
      const next = await privateConfigBytes();
      if (next === previous) return;
      await interpretConfig(next);
      previous = next;
      if (digest(next) !== await read(backupStamp))
        await notify("Workstation config changed since its last encrypted backup.", true);
    } catch { await notify("The workstation config could not be validated. Run Configuration → Check.").catch(() => {}); }
  }
  try { await run(["code", "--wait", conf]); }
  finally { watcher.close(); clearTimeout(timer); await saved(); }
}

async function setSecret(variable: string): Promise<void> {
  const text = await privateConfigBytes();
  const current = await interpretConfig(text);
  const existing = current.secrets.find(secret => secret.variable === variable);
  if (!existing) throw new Error("Declare this variable and its scope in the config before setting its value.");
  const lines = text.split("\n");
  const first = lines.indexOf(beginSecrets);
  const last = lines.indexOf(endSecrets);
  const section = lines.slice(first + 1, last).join("\n");
  const literal = /^const secrets = ([\s\S]+) satisfies WorkstationConfig\["secrets"\];$/.exec(section)?.[1];
  let managed = false;
  try { managed = literal !== undefined && JSON.stringify(JSON.parse(literal)) === JSON.stringify(current.secrets); }
  catch { /* A custom expression should be edited directly. */ }
  if (first < 0 || last <= first || !managed)
    throw new Error("The secret declarations were edited as code. Set the value directly in VS Code, or format the marked declarations as generated JSON literals.");
  const value = await promptInput("New token value", true);
  const updated = current.secrets.map(entry => entry.variable === variable ? { ...entry, value } : entry);
  const block = [beginSecrets, `const secrets = ${JSON.stringify(updated, null, 2)} satisfies WorkstationConfig["secrets"];`, endSecrets].join("\n");
  const next = upsertBlock(text, beginSecrets, endSecrets, block);
  await interpretConfig(next);
  if (await privateConfigBytes() !== text) throw new Error("The config changed while the prompt was open.");
  await atomicFile(conf, next, 0o600);
  await notify("Secret updated. Back up the workstation config.", true).catch(() => {});
}

async function workspaceRoot(override?: string): Promise<string> {
  return override ?? (await settings()).workspacesRoot;
}

function checkoutPath(root: string): string { return join(root, "github.com/shah/workstation"); }

function knownWorkstationRemote(url: string | undefined): boolean {
  return /^((https|ssh):\/\/(git@)?github\.com\/|git@github\.com:)shah\/(workstation|ergonex)(\.git)?$/.test(url ?? "");
}

async function createCheckout(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = await mkdtemp(join(dirname(path), ".workstation.auto.clone-"));
  try {
    const checkout = join(staging, "checkout.auto.git");
    await run(["git", "clone", "--", remote, checkout], { quiet: true });
    await rename(checkout, path);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

const appEntries = [
  { name: `${product} Gmail`, url: "https://mail.google.com/", icon: "mail-message-new", args: "open gmail" },
  { name: `${product} ChatGPT Dot`, url: "https://chatgpt.com/dots", icon: "system-help", args: "open dot" },
  ...tenants.flatMap((tenant, i) => ([
    { name: `${product} Outlook Work ${i + 1}`, url: urls.outlook, icon: "mail-message-new", args: `open ${tenant} outlook` },
    { name: `${product} OneDrive Work ${i + 1}`, url: urls.onedrive, icon: "folder-remote", args: `open ${tenant} onedrive` },
  ])),
];

const defaultVaultItems = [
  ".ssh", ".gnupg", ".age", ".gitconfig.local", ".git-credentials", ".npmrc", ".pypirc", ".aws",
  ".config/gh", ".config/onedrive", ".config/rclone", ".config/ente", ".config/opencode/opencode.json",
  ".config/hypr/monitors.lua", ".config/hypr/input.lua", ".config/ergonex", ".config/snshah",
];

async function plan(features: Features): Promise<Step[]> {
  if (!available("omarchy")) throw new Error("Run setup on Omarchy with omarchy on PATH.");
  const current = await exists(conf) ? await settings() : await initialConfig(features);
  validateConfig(current);
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
  const root = features.workspaceRoot ?? current.workspacesRoot;
  const checkout = checkoutPath(root);
  await file(declarations, configTypes);
  if (!await exists(conf)) await file(conf, configSource(current), { private: true });
  if (!await exists(checkout)) steps.push({ kind: "checkout", path: checkout });
  else if (!await exists(join(checkout, ".git")) || !knownWorkstationRemote(capture(["git", "-C", checkout, "remote", "get-url", "origin"])))
    throw new Error(`Expected the workstation checkout at ${checkout}. Choose another --workspaces-root if this path is in use.`);


  const shellFiles = await Promise.all((["bash", "zsh"] as const).map(async shell => {
    const path = join(home, `.${shell}rc`);
    const content = await read(path) ?? "";
    const legacy = 'export PATH="$HOME/.local/bin:$PATH"; eval "$(oh-my-posh init ' +
      shell + ' --config ~/.config/oh-my-posh/ergonex.omp.json)"';
    const lines = content.split("\n");
    const legacyComment = "# Ergonex Oh My Posh (Human / Herdr / Agent aware)";
    return { shell, path, hadLegacy: lines.includes(legacy),
      userContent: lines.filter((line, i) => line !== legacy && !(line === legacyComment && lines[i + 1] === legacy)).join("\n") };
  }));
  if (features.posh || current.prompt.kind === "posh" || shellFiles.some(file => file.hadLegacy)) {
    const source = await read(join(import.meta.dir, "snshah.omp.json")) ??
      await read(join(checkout, "snshah.omp.json")) ?? await read(theme) ?? await read(oldTheme);
    if (source === undefined) throw new Error("Run setup from the workstation checkout to install the Oh My Posh theme.");
    if (!available("oh-my-posh")) steps.push({ kind: "command", id: "install-oh-my-posh", argv: ["omarchy", "pkg", "aur", "add", "oh-my-posh-bin"] });
    await file(theme, source);
  } else {
    const previous = await read(theme);
    if (previous !== undefined) steps.push({ kind: "remove", path: theme, previous });
  }
  for (const entry of shellFiles) {
    if (entry.shell === "bash" || entry.hadLegacy)
      await file(entry.path, upsertBlock(entry.userContent, beginShell, endShell, shellBlock(entry.shell)));
  }
  const hypr = join(config, "hypr");
  if (!await exists(join(hypr, "hyprland.lua"))) throw new Error("This workstation profile requires Omarchy Quattro with Hyprland Lua.");
  const bindings = join(hypr, "bindings.lua");
  const bindingFile = join(hypr, "snshah.auto.lua");
  await file(bindingFile, `o.bind("SUPER + ALT + M", "${product}", "snshah menu")\n`);
  const bindingBlock = [
    "-- >>> snshah workstation >>>",
    'dofile((os.getenv("XDG_CONFIG_HOME") or os.getenv("HOME") .. "/.config") .. "/hypr/snshah.auto.lua")',
    "-- <<< snshah workstation <<<",
  ];
  await file(bindings, upsertBlock(await read(bindings) ?? "", bindingBlock[0], bindingBlock[2], bindingBlock.join("\n")));
  const oldBinding = join(hypr, "snshah.lua");
  const previousBinding = await read(oldBinding);
  if (previousBinding === 'o.bind("SUPER + ALT + M", "Ergonex Workstation", "omarchy-launch-terminal snshah open menu")\n')
    steps.push({ kind: "remove", path: oldBinding, previous: previousBinding });
  if (!available("microsoft-edge-stable"))
    steps.push({ kind: "command", id: "install-edge", argv: ["omarchy", "install", "browser", "edge"] });
  if ((features.defaultEdge || current.browser.kind === "edge-default") && capture(["xdg-settings", "get", "default-web-browser"], { ...process.env, XDG_CURRENT_DESKTOP: "" }) !== "microsoft-edge.desktop")
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
    const oldDesktop = join(apps, app.name.replace(product, "Ergonex") + ".desktop");
    const previous = await read(oldDesktop);
    const oldName = app.name.replace(product, "Ergonex");
    if (previous?.includes(`\nName=${oldName}\n`) && previous.includes(`\nExec=${command}\n`))
      steps.push({ kind: "remove", path: oldDesktop, previous });
  }

  if (features.sync || tenants.some(id => current.work[id].files.kind === "rclone")) {
    if (!available("rclone")) steps.push({ kind: "command", id: "install-rclone", argv: ["omarchy", "pkg", "add", "rclone", "fuse3"] });
    else if (!available("fusermount3")) steps.push({ kind: "command", id: "install-fuse3", argv: ["omarchy", "pkg", "add", "fuse3"] });
  }
  if (features.local || current.localAI.kind === "ollama") {
    const model = current.localAI.kind === "ollama" ? current.localAI.model : defaultModel;
    if (!available("ollama"))
      steps.push({ kind: "command", id: "install-ollama", argv: ["omarchy", "pkg", "add", "ollama"] });
    if (!await ollamaOnline()) {
      steps.push({ kind: "command", id: "start-ollama", argv: ["sudo", "systemctl", "enable", "--now", "ollama.service"] });
      steps.push({ kind: "wait", service: "ollama" });
    }
    if (!capture(["ollama", "show", model]))
      steps.push({ kind: "command", id: "pull-model", argv: ["ollama", "pull", model] });
    await file(join(profileDir, "opencode.auto.json"), JSON.stringify({
      default_agent: "plan", model: `ollama/${model}`,
      provider: { ollama: { npm: "@ai-sdk/openai-compatible", name: "Ollama", options: { baseURL: `${ollamaUrl}/v1` },
        models: { [model]: { name: model } } } },
    }, null, 2) + "\n");
  }
  await file(menuPath, await menuContent());
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
  const lock = join(assetDir, "apply.auto.lock");
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
        case "checkout": await createCheckout(step.path); break;
        case "remove":
          if (await read(step.path) === step.previous) await rm(step.path);
          break;
      }
    }
    if (json) print({ completed: describe(steps) }, true);
    else console.log(steps.length ? `${product} setup complete.` : "No changes needed.");
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
    case "file":
    case "checkout":
    case "remove": return `${step.kind}: ${step.path}`;
  }
}

function describe(steps: Step[]): Array<{ kind: string; target: string }> {
  return steps.map(step => ({ kind: step.kind, target: step.kind === "command" ? step.id : step.kind === "wait" ? step.service : step.path }));
}

async function doctor(json: boolean): Promise<void> {
  const current = await settings();
  const result = {
    workspacesRoot: await workspaceRoot(),
    omarchy: capture(["omarchy", "version"]) ?? null,
    shell: (await read(join(home, ".bashrc")))?.includes(beginShell) ?? false,
    edge: available("microsoft-edge-stable"),
    herdr: available("herdr"),
    plugin: await exists(join(pluginDir, "manifest.json")),
    ollama: await ollamaOnline(),
    localAI: current.localAI.kind,
    rclone: available("rclone"),
  };
  print(json ? result : Object.entries(result).map(([key, value]) => `${key}: ${value ?? "unavailable"}`), json);
}

async function browser(url: string, tenant: Tenant, app: boolean): Promise<void> {
  const previous = join(home, ".local/share/edge-work-profile");
  const directory = tenant === "work1" && await exists(previous) ? previous : join(data, "snshah/edge", tenant);
  launch(["microsoft-edge-stable", `--user-data-dir=${directory}`, app ? `--app=${url}` : url]);
}

async function openApp(app: PersonalApp): Promise<void> {
  switch (app) {
    case "gmail": launch(["omarchy-launch-webapp", "https://mail.google.com/"]); return;
    case "dot": launch(["omarchy-launch-webapp", "https://chatgpt.com/dots"]); return;
    case "herdr":
      if (available("herdr-app")) launch(["herdr-app"]);
      else launch(["omarchy-launch-terminal", "herdr"]);
      return;
    case "menu": {
      const current = await settings();
      const actions = new Map<string, Command>([
        [`Gmail · ${current.personal}`, { kind: "open", app: "gmail" }],
        ["ChatGPT Dot", { kind: "open", app: "dot" }],
        ["Herdr", { kind: "open", app: "herdr" }],
      ]);
      for (const [i, tenant] of tenants.entries()) {
        for (const [label, app] of [["Outlook", "outlook"], ["Calendar", "calendar"], ["Teams", "teams"], ["OneDrive", "onedrive"]] as const)
          actions.set(`${i + 1} · ${current.work[tenant].label} · ${label}`, { kind: "work", tenant, app });
      }
      const argv = available("omarchy-menu-select")
        ? ["omarchy-menu-select", "Workstation accounts", ...actions.keys()]
        : ["gum", "choose", "--header", product, ...actions.keys()];
      const child = Bun.spawn(argv, { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
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
    await run([agent], { cwd: directory, env: await secretEnvironment(agent) });
    return;
  }
  const generated = join(profileDir, "opencode.auto.json");
  const localConfig = await exists(generated) ? generated : join(profileDir, "opencode.json");
  if (!await exists(localConfig)) throw new Error("Set up the local agent with snshah apply --local-ai.");
  const child = Bun.spawn(["opencode"], {
    cwd: directory, env: { ...await secretEnvironment(agent), OPENCODE_CONFIG: localConfig },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

async function drive(action: "list" | "mount", tenant: Tenant): Promise<void> {
  const files = (await settings()).work[tenant].files;
  if (files.kind !== "rclone") throw new Error("Set this profile's files.kind to rclone in the workstation config.");
  const remote = `${files.remote}:`;
  const env = await secretEnvironment("drive");
  if (action === "list") {
    await run(["rclone", "lsf", remote], { env });
    return;
  }
  const mount = join(home, "OneDrive", tenant);
  await mkdir(mount, { recursive: true, mode: 0o700 });
  await run(["rclone", "mount", remote, mount, "--read-only"], { env });
}

const vaultStaging = join(home, "OneDrive/Vault-Staging");
const vaultMagic = "SNSHAH-CONFIG-1\n";
const backupStamp = join(assetDir, "vault.auto.sha256");

async function archives(): Promise<string[]> {
  if (!await exists(vaultStaging)) return [];
  return (await readdir(vaultStaging, { withFileTypes: true }))
    .filter(file => file.isFile() && /^snshah-config-.*\.ts\.age$/.test(file.name))
    .map(file => join(vaultStaging, file.name)).sort().reverse();
}
function digest(text: string): string { return new Bun.CryptoHasher("sha256").update(text).digest("hex"); }

async function vault(action: "status" | "backup"): Promise<void> {
  if (action === "status") {
    const text = await exists(conf) ? await privateConfigBytes() : undefined;
    print({ config: conf, staging: vaultStaging, backedUp: text !== undefined && digest(text) === await read(backupStamp), archives: await archives() }, true);
    return;
  }
  const text = await privateConfigBytes();
  await interpretConfig(text);
  await mkdir(vaultStaging, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(vaultStaging, ".snshah.auto.vault-"));
  try {
    const encrypted = join(temporary, "backup.auto.age");
    const child = Bun.spawn(["age", "-p", "-o", encrypted], {
      stdin: new Blob([vaultMagic, text]), stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error("Vault encryption failed.");
    await chmod(encrypted, 0o600);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(vaultStaging, `snshah-config-${stamp}.ts.age`);
    await rename(encrypted, destination);
    await atomicFile(backupStamp, digest(text), 0o600);
    console.log(destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function restore(command: Extract<Command, { kind: "restore" | "verify" }>): Promise<void> {
  const source = command.archive ? resolve(command.archive) : (await archives())[0];
  if (!source) throw new Error("Supply a single-config vault snapshot.");
  const existing = await exists(conf) ? await privateConfigBytes() : undefined;
  if (command.kind === "restore" && existing !== undefined && !command.overwrite)
    throw new Error("Config already exists. Verify the snapshot and use --overwrite to replace it.");
  const child = Bun.spawn(["age", "-d", "--", source], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const fragments: Uint8Array[] = [];
  let length = 0;
  for await (const fragment of child.stdout) {
    length += fragment.byteLength;
    if (length > 256 * 1024 + vaultMagic.length) {
      child.kill();
      await child.exited;
      throw new Error("Snapshot is too large.");
    }
    fragments.push(fragment);
  }
  if (await child.exited !== 0) throw new Error("Vault decryption failed.");
  const bytes = Buffer.concat(fragments).toString("utf8");
  if (!bytes.startsWith(vaultMagic)) throw new Error("Snapshot must contain exactly one workstation config.");
  const text = bytes.slice(vaultMagic.length);
  // Treat restored TypeScript as code. Verify syntax without evaluating it.
  try { new Bun.Transpiler({ loader: "ts" }).transformSync(text); }
  catch { throw new Error("Snapshot contains invalid TypeScript."); }
  if (command.kind === "verify") {
    console.log("Snapshot format and TypeScript syntax verified. Review its code before loading.");
    return;
  }
  if (await exists(conf) ? existing === undefined || await privateConfigBytes() !== existing : existing !== undefined)
    throw new Error("Config changed during restore.");
  await atomicFile(conf, text, 0o600);
  console.log("Config restored. Review its code before running snshah config check.");
}

type MenuArgs =
  | [kind: "help" | "plan" | "apply" | "doctor" | "workspace" | "context" | "shell" | "menu"]
  | ["plan" | "apply" | "doctor", "--json"] | ["test", ...[] | ["--published"]]
  | ["open", PersonalApp] | ["open", Tenant, WorkApp]
  | ["agent", Agent] | ["drive", "list" | "mount", Tenant]
  | ["config", "edit" | "check" | "setup" | "set-secret"]
  | ["vault", "status" | "backup" | "verify" | "restore"]
  | ["plugin", "install" | "remove" | "toggle"];
type MenuAction = { id: string; label: string; args: MenuArgs; terminal?: true };
type MenuSection = { id: string; label: string; actions: MenuAction[] };

function menuSections(): MenuSection[] {
  return [
    { id: "open", label: "Open", actions: [
      { id: "gmail", label: "Personal mail", args: ["open", "gmail"] },
      { id: "dot", label: "ChatGPT Dot", args: ["open", "dot"] },
      { id: "herdr", label: "Herdr", args: ["open", "herdr"] },
      { id: "chooser", label: "Accounts by name", args: ["open", "menu"] },
    ] },
    ...tenants.map((id): MenuSection => ({ id, label: `Tenant ${id.at(-1)}`, actions: [
      ...workApps.map((app): MenuAction => ({
        id: app, label: { browser: "Edge browser", outlook: "Outlook", calendar: "Calendar", teams: "Teams", onedrive: "OneDrive on the web" }[app],
        args: ["open", id, app],
      })),
      { id: "list", label: "List OneDrive files", args: ["drive", "list", id], terminal: true },
      { id: "mount", label: "Mount OneDrive read-only", args: ["drive", "mount", id], terminal: true },
    ] })),
    { id: "agents", label: "Agents", actions: [
      ...agents.map((agent): MenuAction => ({ id: agent, label: { claude: "Claude Code", codex: "Codex", local: "Local OpenCode" }[agent],
        args: ["agent", agent], terminal: true })),
    ] },
    { id: "config", label: "Configuration", actions: [
      { id: "edit", label: "Edit in VS Code", args: ["config", "edit"] },
      { id: "check", label: "Check configuration", args: ["config", "check"], terminal: true },
      { id: "setup", label: "Name my profiles", args: ["config", "setup"], terminal: true },
      { id: "secret", label: "Set a declared secret", args: ["config", "set-secret"], terminal: true },
      { id: "shell", label: "Shell integration", args: ["shell"], terminal: true },
    ] },
    { id: "setup", label: "Setup & Diagnostics", actions: [
      { id: "plan", label: "Preview changes", args: ["plan"], terminal: true },
      { id: "planjson", label: "Preview changes (JSON)", args: ["plan", "--json"], terminal: true },
      { id: "apply", label: "Apply changes", args: ["apply"], terminal: true },
      { id: "applyjson", label: "Apply changes (JSON)", args: ["apply", "--json"], terminal: true },
      { id: "doctor", label: "Diagnostics", args: ["doctor"], terminal: true },
      { id: "json", label: "Diagnostics (JSON)", args: ["doctor", "--json"], terminal: true },
      { id: "workspace", label: "Workspace path", args: ["workspace"], terminal: true },
      { id: "context", label: "Shell context", args: ["context"], terminal: true },
      { id: "test", label: "Self-test", args: ["test"], terminal: true },
      { id: "published", label: "Test published installer", args: ["test", "--published"], terminal: true },
      { id: "help", label: "CLI help & flags", args: ["help"], terminal: true },
    ] },
    { id: "vault", label: "Vault", actions: [
      { id: "status", label: "Backup status", args: ["vault", "status"], terminal: true },
      { id: "backup", label: "Back up now", args: ["vault", "backup"], terminal: true },
      { id: "verify", label: "Verify snapshot", args: ["vault", "verify"], terminal: true },
      { id: "restore", label: "Restore snapshot", args: ["vault", "restore"], terminal: true },
    ] },
    { id: "plugin", label: "Plugin", actions: [
      { id: "install", label: "Install or refresh bar shortcut", args: ["plugin", "install"], terminal: true },
      { id: "toggle", label: "Open workstation menu", args: ["plugin", "toggle"] },
      { id: "remove", label: "Remove bar shortcut", args: ["plugin", "remove"], terminal: true },
    ] },
  ];
}
const menuStart = "  // >>> snshah menu >>>";
const menuEnd = "  // <<< snshah menu <<<";
async function menuContent(): Promise<string> {
  const source = await read(menuPath) ?? "{\n}\n";
  const open = source.indexOf("{");
  if (open < 0 || !source.trimEnd().endsWith("}")) throw new Error("Expected an Omarchy menu JSONC object.");
  const rows: Record<string, { label: string; icon?: string; action?: string }> = {
    [menuId]: { label: product, icon: "󰆍" },
  };
  for (const section of menuSections()) {
    rows[`${menuId}.${section.id}`] = { label: section.label };
    for (const action of section.actions) {
      const id = `${section.id}.${action.id}`;
      rows[`${menuId}.${id}`] = { label: action.label, action: `${shellQuote(bin)} menu run ${id}` };
    }
  }
  const entries = Object.entries(rows).map(([key, row]) => `  ${JSON.stringify(key)}: ${JSON.stringify(row)},`);
  const block = [menuStart, ...entries, menuEnd].join("\n");
  if (source.includes(menuStart) || source.includes(menuEnd)) return upsertBlock(source, menuStart, menuEnd, block);
  return source.slice(0, open + 1) + "\n" + block + "\n" + source.slice(open + 1).replace(/^\r?\n/, "");
}

async function menu(command: Extract<Command, { kind: "menu" }>): Promise<void> {
  if (!command.id) { await run(["omarchy", "menu", "summon", menuId]); return; }
  const action = menuSections().flatMap(section => section.actions.map(item => ({ ...item, id: `${section.id}.${item.id}` })))
    .find(item => item.id === command.id);
  if (!action) throw new Error("Unknown workstation menu action.");
  if (action.terminal && !command.terminal) {
    launch(["omarchy-launch-terminal", bin, "menu", "run", action.id, "--terminal"]);
    return;
  }
  const argv: string[] = [...action.args];
  if (command.id === "config.shell") { console.log('Load the aliases and exports in your current shell with eval "$(snshah shell)".'); }
  else {
    if (argv[0] === "agent") {
      const directory = await promptInput("Workspace directory (blank for the current directory)");
      if (directory) argv.push(directory);
    }
    if (command.id === "config.secret") argv.push(await promptInput("Declared environment variable name"));
    if ((command.id === "setup.apply" || command.id === "setup.applyjson")) {
      await execute(parse(["plan"]));
      if (!await confirm("Apply these changes?")) return;
    }
    if (command.id === "vault.verify" || command.id === "vault.restore") {
      const archive = await promptInput("Snapshot path (blank for the latest)");
      if (archive) argv.push(archive);
      if (command.id === "vault.restore" && await exists(conf)) {
        if (!await confirm("Back up the current config before replacing it?")) return;
        await vault("backup");
        argv.push("--overwrite");
      }
    }
    if (command.id === "plugin.remove" && !await confirm("Remove the workstation bar shortcut?")) return;
    await execute(parse(argv));
  }
  if (action.terminal && process.stdin.isTTY) await promptInput("Press Enter to close").catch(() => {});
}
async function confirm(title: string): Promise<boolean> {
  return await Bun.spawn(["gum", "confirm", title], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited === 0;
}

async function configure(action: "edit" | "check" | "setup"): Promise<void> {
  if (action === "edit") return editConfig();
  const previous = await privateConfigBytes();
  const current = await interpretConfig(previous);
  if (action === "check") { console.log("Workstation config is valid."); return; }
  const personal = await promptInput("Personal profile display name");
  if (personal) current.personal = personal;
  for (const id of tenants) {
    const label = await promptInput(`Display name for ${id} (blank keeps its name)`);
    if (label) current.work[id].label = label;
  }
  validateConfig(current);
  if (!await confirm("Replace the config with these settings? Comments and custom expressions will be regenerated.")) return;
  if (await privateConfigBytes() !== previous) throw new Error("Config changed during setup.");
  await atomicFile(conf, configSource(current), 0o600);
  await atomicFile(menuPath, await menuContent());
  await notify("Profile names updated. Back up the workstation config.", true).catch(() => {});
}

async function plugin(action: "install" | "remove" | "toggle"): Promise<void> {
  if (config !== join(home, ".config")) throw new Error("Omarchy plugin management requires the default XDG_CONFIG_HOME.");
  const oldId = "shah.ergonex";
  const oldFolder = join(config, "omarchy/plugins", oldId);
  switch (action) {
    case "install":
      for (const [name, content] of Object.entries(pluginFiles)) await atomicFile(join(pluginDir, name), content);
      await run(["omarchy", "plugin", "validate", pluginDir]);
      await atomicFile(menuPath, await menuContent());
      await run(["omarchy-shell", "shell", "rescanPlugins"]);
      await run(["omarchy", "plugin", "enable", pluginId]);
      if (await read(join(oldFolder, "manifest.json")) === pluginFiles["manifest.json"]
          .replaceAll(pluginId, oldId).replaceAll(product, "Ergonex").replaceAll("Panel.auto.qml", "Panel.qml") &&
          await read(join(oldFolder, "Panel.qml")) === pluginFiles["Panel.auto.qml"].replaceAll(pluginId, oldId))
        await run(["omarchy", "plugin", "remove", oldId, "--yes"]);
      return;
    case "remove":
      if (await exists(pluginDir)) await run(["omarchy", "plugin", "remove", pluginId, "--yes"]);
      return;
    case "toggle":
      await run(["omarchy", "menu", "summon", menuId]);
  }
}

async function execute(command: Command): Promise<void> {
  switch (command.kind) {
    case "help": console.log(usage); return;
    case "shell": console.log(await shellCode(command.shell)); return;
    case "workspace": console.log(checkoutPath(await workspaceRoot(command.root))); return;
    case "test": await selfTest(command.published); return;
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
    case "restore":
    case "verify": await restore(command); return;
    case "config": await configure(command.action); return;
    case "set-secret": await setSecret(command.variable); return;
    case "menu": await menu(command); return;
    case "shell-env":
      if (process.stdout.isTTY) throw new Error("Load these exports via snshah shell.");
      for (const secret of (await settings()).secrets)
        if (secret.value && secret.scope === "shell") console.log(`export ${secret.variable}=${shellQuote(secret.value)}`);
      return;
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

async function selfTest(published: boolean): Promise<void> {
  const fixture = await mkdtemp(join(tmpdir(), "workstation.auto.test-"));
  try {
    const tools = join(fixture, "tools.auto.bin");
    const hypr = join(fixture, ".config/hypr");
    const legacy = join(fixture, ".local/share/edge-work-profile");
    const desktop = join(fixture, ".local/share/applications");
    const root = join(fixture, "Team Work");
    const source = await exists(join(import.meta.dir, "bootstrap.sh")) ? import.meta.dir : checkoutPath(await workspaceRoot());
    await mkdir(tools);
    await mkdir(hypr, { recursive: true });
    await mkdir(join(fixture, ".config/opencode"));
    await mkdir(legacy, { recursive: true });
    await mkdir(desktop, { recursive: true });
    await symlink(process.execPath, join(tools, "bun"));
    const legacyInit = 'export PATH="$HOME/.local/bin:$PATH"; eval "$(oh-my-posh init bash --config ~/.config/oh-my-posh/ergonex.omp.json)"';
    const bashrc = 'alias gs="git status"\nexport USER_SETTING=kept\n';
    const agentConfig = '{"userSetting":true}\n';
    const bindings = "-- User bindings\n";
    await writeFile(join(fixture, ".bashrc"), bashrc + legacyInit + "\n");
    await writeFile(join(fixture, "AGENTS.md"), "# Existing instructions\n");
    await writeFile(join(fixture, ".config/opencode/opencode.json"), agentConfig);
    await writeFile(join(hypr, "hyprland.lua"), "");
    await writeFile(join(hypr, "bindings.lua"), bindings);
    await writeFile(join(hypr, "snshah.lua"), 'o.bind("SUPER + ALT + M", "Ergonex Workstation", "omarchy-launch-terminal snshah open menu")\n');
    const oldDesktop = join(desktop, "Ergonex Gmail.desktop");
    await writeFile(oldDesktop, "[Desktop Entry]\nName=Ergonex Gmail\nExec=snshah open gmail\n");
    await writeFile(join(tools, "omarchy"), `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
const [, , group, action, name, , , exec] = Bun.argv;
if (group === "version") console.log("4.5.0");
else if (group === "webapp" && action === "install") {
  const dir = process.env.HOME + "/.local/share/applications";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/" + name + ".desktop", "[Desktop Entry]\\nName=" + name + "\\nExec=" + exec + "\\n");
} else if (group === "plugin" && action === "validate") {
  const manifest = await Bun.file(name + "/manifest.json").json();
  if (manifest.id !== "shah.workstation" || !await Bun.file(name + "/" + manifest.entryPoints.barWidget).exists())
    process.exitCode = 9;
  if (Bun.which("omarchy-plugin-validate"))
    process.exitCode = Bun.spawnSync(["omarchy-plugin-validate", name], { stderr: "inherit" }).exitCode ?? 1;
} else if (group === "plugin" && action === "enable" && name === "shah.workstation") {
  // No live shell in the fixture.
} else process.exitCode = 9;
`, { mode: 0o755 });
    const git = Bun.which("git");
    assert(git, "git is required for the self-test");
    await writeFile(join(tools, "git"), `#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
const argv = Bun.argv.slice(2);
if (argv[0] === "clone") mkdirSync(argv.at(-1) + "/.git", { recursive: true });
else if (argv[0] === "-C" && argv[2] === "remote") console.log("https://github.com/shah/workstation.git");
else process.exitCode = Bun.spawnSync([${JSON.stringify(git)}, ...argv], { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
`, { mode: 0o755 });
    for (const tool of ["gum", "herdr", "oh-my-posh", "omarchy-shell"])
      await writeFile(join(tools, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(tools, "age"), '#!/bin/sh\nif [ "$1" = "-d" ]; then cat "$3"; else cat > "$3"; fi\n', { mode: 0o755 });
    await writeFile(join(tools, "microsoft-edge-stable"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/browser.auto.log"\n', { mode: 0o755 });
    const env = { HOME: fixture, PATH: `${tools}:${join(fixture, ".local/bin")}:${process.env.PATH}`, TERM: "dumb" };
    const invoke = (...argv: string[]) => {
      const result = Bun.spawnSync(argv, { env, cwd: source });
      if (!result.success) throw new Error(`${argv.join(" ")}: ${result.stderr.toString()}`);
      return result.stdout.toString();
    };
    assert.equal(invoke("bun", import.meta.path, "workspace"), checkoutPath(join(fixture, "Work")) + "\n");
    const flags = ["--workspaces-root", root];
    const draft = invoke("bun", import.meta.path, "plan", "--json", ...flags);
    assert.equal(invoke("bun", import.meta.path, "plan", ...flags, "--json"), draft);
    assert(JSON.parse(draft).some((step: { kind: string; target: string }) => step.kind === "checkout" && step.target === checkoutPath(root)));
    assert(!JSON.parse(draft).some((step: { target: string }) => step.target === "default-browser"));
    const bootstrap = published
      ? ["bash", "-o", "pipefail", "-c", 'curl -fsSL https://raw.githubusercontent.com/shah/workstation/main/bootstrap.sh | bash -s -- "$@"', "--", ...flags]
      : ["bash", "bootstrap.sh", ...flags];
    assert.match(invoke(...bootstrap), /Shahid Shah Workstation setup complete/);
    assert.equal(invoke("snshah", "workspace"), checkoutPath(root) + "\n");
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    assert.equal(invoke(...bootstrap), "No changes needed.\n");
    const rc = await readFile(join(fixture, ".bashrc"), "utf8");
    assert(rc.startsWith(bashrc) && !rc.includes(legacyInit));
    assert.equal(rc.match(/>>> snshah shell >>>/g)?.length, 1);
    assert.equal(await readFile(join(fixture, "AGENTS.md"), "utf8"), "# Existing instructions\n");
    assert.equal(await readFile(join(fixture, ".config/opencode/opencode.json"), "utf8"), agentConfig);
    assert((await readFile(join(hypr, "bindings.lua"), "utf8")).startsWith(bindings));
    assert(await exists(join(hypr, "snshah.auto.lua")));
    assert(!await exists(join(hypr, "snshah.lua")));
    assert(!await exists(oldDesktop));
    assert(await exists(join(desktop, "Shahid Shah Workstation Gmail.desktop")));
    assert.match(invoke("snshah", "shell"), /snshah\.auto\.omp\.json/);
    assert.match(invoke("bash", "--noprofile", "-ic", "alias ll; alias gs; type mkcd"), /alias ll='ls -al'\nalias gs='git status'/);
    assert.equal(invoke("bash", "--noprofile", "-c", 'source "$HOME/.bashrc"; alias ll 2>/dev/null || true'), "");
    for (const tenant of tenants) invoke("snshah", "open", tenant, "outlook");
    const log = join(fixture, "browser.auto.log");
    const deadline = Date.now() + 1500;
    let launches = "";
    while (Date.now() < deadline) {
      launches = await read(log) ?? "";
      if ((launches.match(/--app=https:\/\/outlook\.office\.com\/mail\//g)?.length ?? 0) === 3) break;
      await Bun.sleep(30);
    }
    for (const directory of [legacy, ...tenants.slice(1).map(tenant => join(fixture, ".local/share/snshah/edge", tenant))])
      assert(launches.includes(`--user-data-dir=${directory}`));
    invoke("snshah", "plugin", "install");
    const generatedPlugin = join(fixture, ".config/omarchy/plugins/shah.workstation");
    assert(await exists(join(generatedPlugin, "manifest.json")));
    assert(await exists(join(generatedPlugin, "Panel.auto.qml")));
    const fixtureConf = join(fixture, ".config/snshah.conf.ts");
    assert.equal((await stat(fixtureConf)).mode & 0o777, 0o600);
    const baseline = await readFile(fixtureConf, "utf8");
    const fake = "fixture-only-token";
    const configured = baseline.replace("const secrets = []", `const secrets = [
      {variable:"SNSH_TEST_SHELL",value:"${fake}",scope:"shell"},
      {variable:"SNSH_TEST_COMMAND",value:"${fake}",scope:"command",commands:["codex"]}
    ]`);
    await writeFile(fixtureConf, configured);
    assert.match(invoke("snshah", "config", "check"), /valid/);
    assert(!invoke("snshah", "shell").includes(fake));
    assert(invoke("snshah", "shell-env").includes(fake));
    assert(!invoke("snshah", "shell-env").includes("SNSH_TEST_COMMAND"));
    assert(!invoke("snshah", "doctor", "--json").includes(fake));
    await writeFile(join(tools, "codex"), '#!/bin/sh\ntest -n "$SNSH_TEST_COMMAND" && test -z "$SNSH_TEST_SHELL"\n', { mode: 0o755 });
    invoke("snshah", "agent", "codex", fixture);
    await writeFile(join(tools, "check-shell.auto"), '#!/bin/sh\ntest -n "$SNSH_TEST_SHELL" && test -z "$SNSH_TEST_COMMAND"\n', { mode: 0o755 });
    const exportCheck = Bun.spawnSync(["bash", "-xc", 'eval "$(snshah shell)"; check-shell.auto'], { env });
    assert(exportCheck.success);
    assert(!exportCheck.stderr.toString().includes(fake));
    for (const section of menuSections()) {
      assert.equal(new Set(section.actions.map(action => action.id)).size, section.actions.length);
      for (const action of section.actions) parse(action.args.join(" ") === "config set-secret"
        ? [...action.args, "SNSH_TEST_COMMAND"] : action.args);
    }
    const menuText = await readFile(join(fixture, ".config/omarchy/extensions/omarchy-menu.jsonc"), "utf8");
    assert(menuText.includes("Edit in VS Code") && menuText.includes("Restore snapshot") && !menuText.includes(fake));
    await chmod(fixtureConf, 0o644);
    const insecure = Bun.spawnSync(["snshah", "shell-env"], { env });
    assert.equal(insecure.exitCode, 1);
    assert(!insecure.stdout.toString().includes(fake));
    await chmod(fixtureConf, 0o600);
    const archive = invoke("snshah", "vault", "backup").trim();
    assert.match(basename(archive), /^snshah-config-.*\.ts\.age$/);
    assert.match(invoke("snshah", "vault", "verify", archive), /verified/);
    assert.equal(Bun.spawnSync(["snshah", "vault", "restore", archive], { env }).exitCode, 1);
    await rm(fixtureConf);
    invoke("snshah", "vault", "restore", archive);
    assert.equal(await readFile(fixtureConf, "utf8"), configured);
    assert.equal((await stat(fixtureConf)).mode & 0o777, 0o600);
    assert.equal(await readFile(join(fixture, ".bashrc"), "utf8"), rc);
    await writeFile(join(tools, "code"),
      '#!/bin/sh\nprintf "\\n// saved from fixture editor\\n" >> "$2"\nsleep 0.4\n', { mode: 0o755 });
    await writeFile(join(tools, "omarchy-notification-send"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/notification.auto.log"\n', { mode: 0o755 });
    invoke("snshah", "config", "edit");
    for (let i = 0; i < 10 && !await exists(join(fixture, "notification.auto.log")); i++) await Bun.sleep(40);
    const notification = await readFile(join(fixture, "notification.auto.log"), "utf8");
    assert(notification.includes("Back Up Now") && !notification.includes(fake));
    const fresh = join(fixture, "home.auto.fresh");
    await mkdir(join(fresh, ".config/hypr"), { recursive: true });
    await writeFile(join(fresh, ".config/hypr/hyprland.lua"), "");
    env.HOME = fresh;
    assert.match(invoke("bun", import.meta.path, "apply"), /Shahid Shah Workstation setup complete/);
    assert(await exists(checkoutPath(join(fresh, "Work"))));
    assert(!await exists(join(fresh, ".config/oh-my-posh/snshah.auto.omp.json")));
    const freshBin = join(fresh, ".local/bin/snshah");
    assert.equal(invoke(freshBin, "plan", "--json"), "[]\n");
    console.log("Workstation self-test passed.");
  } finally { await rm(fixture, { recursive: true, force: true }); }
}
