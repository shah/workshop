#!/usr/bin/env bun
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
  | { kind: "restore"; archive?: string }
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
  "Panel.auto.qml": `pragma ComponentBehavior: Bound
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui

Ui.Panel {
  id: root
  moduleName: "shah.workstation"
  ipcTarget: root.moduleName
  readonly property string cli: Quickshell.env("HOME") + "/.local/bin/snshah"
  property string statusText: "Checking Ollama…"
  property int selected: 0
  readonly property var actions: [
    { label: "Open Herdr", args: ["open", "herdr"] },
    { label: "Open Work 1", args: ["open", "work1", "browser"] },
    { label: "Open Work 2", args: ["open", "work2", "browser"] },
    { label: "Open Work 3", args: ["open", "work3", "browser"] }
  ]

  function activate(index) {
    const action = root.actions[index]
    if (action) {
      Quickshell.execDetached([root.cli].concat(action.args))
      root.close()
    }
  }

  onOpenedChanged: {
    if (root.opened) {
      selected = 0
      statusText = "Checking Ollama…"
      status.running = true
    }
  }

  Process {
    id: status
    command: [root.cli, "doctor", "--json"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.statusText = JSON.parse(text).ollama === true ? "Ollama online" : "Ollama offline"
        } catch (error) {
          root.statusText = "Ollama status unavailable"
        }
      }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.statusText = "Ollama status unavailable"
    }
  }

  Ui.BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰆍"
    onPressed: root.toggle()
  }

  Ui.KeyboardPanel {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: popup.loadedContent
    contentWidth: popup.fittedContentWidth(Style.space(280))
    contentHeight: popup.fittedContentHeight(popup.loadedContentHeight, Style.space(360))
    content: Ui.PanelKeyCatcher {
      implicitHeight: rows.implicitHeight
      onMoveRequested: function(dx, dy) {
        if (dy !== 0)
          root.selected = (root.selected + dy + root.actions.length) % root.actions.length
      }
      onActivateRequested: root.activate(root.selected)
      onCloseRequested: root.close()
      Column {
        id: rows
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(6)
        Text {
          text: root.statusText
          textFormat: Text.PlainText
          color: Commons.Color.foreground
        }
        Repeater {
          model: root.actions
          delegate: Ui.Button {
            required property int index
            required property var modelData
            width: rows.width
            text: modelData.label
            selected: index === root.selected
            onClicked: root.activate(index)
          }
        }
      }
    }
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
  vault status|backup|restore [archive]
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
  const temporary = await mkdtemp(join(dirname(path), ".snshah.auto.write-"));
  const draft = join(temporary, `draft.auto.${basename(path)}`);
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

async function shellCode(shell: "bash" | "zsh"): Promise<string> {
  const aliases = Object.entries(addedAliases).map(([name, value]) =>
    `alias ${name} >/dev/null 2>&1 || alias ${name}='${value}'`);
  const fnCheck = shell === "bash" ? "declare -F mkcd" : "whence -w mkcd";
  const lines = [...aliases, `${fnCheck} >/dev/null 2>&1 || mkcd() { mkdir -p -- "$1" && cd -- "$1"; }`];
  if (await exists(theme)) {
    const quoted = "'" + theme.replaceAll("'", "'\\''") + "'";
    lines.push(`if command -v oh-my-posh >/dev/null 2>&1; then eval "$(oh-my-posh init ${shell} --config ${quoted})"; fi`);
  }
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

async function workspaceRoot(override?: string): Promise<string> {
  if (override !== undefined) return override;
  const installed = await read(installConfig);
  if (!installed) return defaultWorkspaceRoot;
  const value: unknown = JSON.parse(installed);
  if (!object(value) || typeof value.workspacesRoot !== "string" || !isAbsolute(value.workspacesRoot))
    throw new Error(`Invalid workspace root in ${installConfig}`);
  return value.workspacesRoot;
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
  const root = await workspaceRoot(features.workspaceRoot);
  const checkout = checkoutPath(root);
  await file(installConfig, JSON.stringify({ workspacesRoot: root }, null, 2) + "\n", { private: true });
  if (!await exists(checkout)) steps.push({ kind: "checkout", path: checkout });
  else if (!await exists(join(checkout, ".git")) || !knownWorkstationRemote(capture(["git", "-C", checkout, "remote", "get-url", "origin"])))
    throw new Error(`Expected the workstation checkout at ${checkout}. Choose another --workspaces-root if this path is in use.`);

  if (!await exists(profileFile)) await file(profileFile, JSON.stringify(settings, null, 2) + "\n", { private: true });
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
  if (features.posh || await exists(theme) || shellFiles.some(file => file.hadLegacy)) {
    const source = await read(join(import.meta.dir, "snshah.omp.json")) ??
      await read(join(checkout, "snshah.omp.json")) ?? await read(theme) ?? await read(oldTheme);
    if (source === undefined) throw new Error("Run setup from the workstation checkout to install the Oh My Posh theme.");
    if (!available("oh-my-posh")) steps.push({ kind: "command", id: "install-oh-my-posh", argv: ["omarchy", "pkg", "aur", "add", "oh-my-posh-bin"] });
    await file(theme, source);
  }
  for (const entry of shellFiles) {
    if (entry.shell === "bash" || entry.hadLegacy)
      await file(entry.path, upsertBlock(entry.userContent, beginShell, endShell, shellBlock(entry.shell)));
  }
  const hypr = join(config, "hypr");
  if (!await exists(join(hypr, "hyprland.lua"))) throw new Error("This workstation profile requires Omarchy Quattro with Hyprland Lua.");
  const bindings = join(hypr, "bindings.lua");
  const bindingFile = join(hypr, "snshah.auto.lua");
  await file(bindingFile, `o.bind("SUPER + ALT + M", "${product}", "omarchy-launch-terminal snshah open menu")\n`);
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
  if (features.defaultEdge && capture(["xdg-settings", "get", "default-web-browser"], { ...process.env, XDG_CURRENT_DESKTOP: "" }) !== "microsoft-edge.desktop")
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
    await file(join(profileDir, "opencode.auto.json"), JSON.stringify({
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
  const settings = await profile();
  const result = {
    workspacesRoot: await workspaceRoot(),
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
      const child = Bun.spawn(["gum", "choose", "--header", product, ...actions.keys()], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
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
  const generated = join(profileDir, "opencode.auto.json");
  const localConfig = await exists(generated) ? generated : join(profileDir, "opencode.json");
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

const newVaultConfig = join(profileDir, "vault-manifest.txt");
const oldVaultConfig = join(config, "ergonex/vault-manifest.txt");
const vaultStaging = process.env.SNSHAH_VAULT_STAGING || process.env.ERGONEX_VAULT_STAGING ||
  join(process.env.SNSHAH_ONEDRIVE_DIR || process.env.ERGONEX_ONEDRIVE_DIR || join(home, "OneDrive"), "Vault-Staging");

async function vaultManifest(): Promise<string> {
  return !await exists(newVaultConfig) && await exists(oldVaultConfig) ? oldVaultConfig : newVaultConfig;
}

async function vaultPaths(manifest: string): Promise<string[]> {
  const contents = await read(manifest);
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
    .filter(file => file.isFile() && /^(ergonex|snshah)-private-.*\.tar\.gz\.(age|gpg)$/.test(file.name));
  const dated = await Promise.all(files.map(async file => {
    const path = join(vaultStaging, file.name);
    return { path, time: (await stat(path)).mtimeMs };
  }));
  return dated.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path, "en")).map(file => file.path);
}

async function vault(action: "status" | "backup"): Promise<void> {
  const vaultConfig = await vaultManifest();
  const paths = await vaultPaths(vaultConfig);
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
  const temporary = await mkdtemp(join(vaultStaging, ".snshah.auto.vault-"));
  try {
    const file = join(temporary, "backup.auto.encrypted");
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
    const destination = join(vaultStaging, `snshah-private-${host}-${date}.tar.gz.${crypto}`);
    await rename(file, destination);
    console.log(destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function restore(archive?: string): Promise<void> {
  const source = archive ? resolve(archive) : (await archives())[0];
  if (!source || !/\.(age|gpg)$/.test(source)) throw new Error("Supply an encrypted .age or .gpg vault archive.");
  const temporary = await mkdtemp(join(tmpdir(), "snshah.auto.restore-"));
  try {
    const file = join(temporary, "snapshot.auto.tar.gz");
    await run(source.endsWith(".age") ? ["age", "-d", "-o", file, source] : ["gpg", "-d", "-o", file, source]);
    await run(["tar", "-tzf", file]);
    await run(["tar", "--keep-old-files", "-C", home, "-xzf", file]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function plugin(action: "install" | "remove" | "toggle"): Promise<void> {
  if (config !== join(home, ".config")) throw new Error("Omarchy plugin management requires the default XDG_CONFIG_HOME.");
  const oldId = "shah.ergonex";
  const oldFolder = join(config, "omarchy/plugins", oldId);
  switch (action) {
    case "install":
      for (const [name, content] of Object.entries(pluginFiles)) await atomicFile(join(pluginDir, name), content);
      await run(["omarchy", "plugin", "validate", pluginDir]);
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
      await run(["omarchy-shell", pluginId, "toggle"]);
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
    await writeFile(join(tools, "age"), '#!/bin/sh\nif [ "$1" = "-d" ]; then cp "$4" "$3"; else cat > "$3"; fi\n', { mode: 0o755 });
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
    const archive = invoke("snshah", "vault", "backup").trim();
    assert.match(basename(archive), /^snshah-private-.*\.tar\.gz\.age$/);
    // Old snapshots remain discoverable even though new ones use the new prefix.
    const oldArchive = join(dirname(archive), "ergonex-private-example.tar.gz.age");
    await rename(archive, oldArchive);
    assert(JSON.parse(invoke("snshah", "vault", "status")).archives.includes(oldArchive));
    await rm(join(fixture, ".config/opencode/opencode.json"));
    assert.equal(Bun.spawnSync(["snshah", "vault", "restore", oldArchive], { env }).exitCode, 1);
    assert.equal(await readFile(join(fixture, ".config/opencode/opencode.json"), "utf8"), agentConfig);
    assert.equal(await readFile(join(fixture, ".bashrc"), "utf8"), rc);
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
