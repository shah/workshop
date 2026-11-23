#!/usr/bin/env -S bun --no-env-file
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, userInfo, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type OneDriveProfile = { username: string; remote: string };
type TenantFiles = { kind: "web" } | ({ kind: "rclone" } & OneDriveProfile);
type Tenant = { id: string; label: string; username?: string; files: TenantFiles };
const workApps = ["browser", "outlook", "calendar", "teams", "onedrive"] as const;
type WorkApp = typeof workApps[number];
const everyday = {
  gmail: { name: "Gmail", url: "https://mail.google.com/", icon: "mail-message-new", entries: ["Gmail", "Google Mail"] },
  voice: { name: "Google Voice", url: "https://voice.google.com/", icon: "call-start", entries: ["Google Voice"] },
  cloudflare: { name: "Cloudflare Admin", url: "https://dash.cloudflare.com/", icon: "network-server", entries: ["Cloudflare Admin", "Cloudflare"] },
  unifi: { name: "UniFi Admin", url: "https://unifi.ui.com/", icon: "network-workgroup", entries: ["UniFi Admin", "UniFi"] },
  whatsapp: { name: "WhatsApp", url: "https://web.whatsapp.com/", icon: "whatsapp", entries: ["WhatsApp", "whatsapp"] },
  discord: { name: "Discord", url: "https://discord.com/channels/@me", icon: "omarchy-discord", entries: ["Discord", "discord", "com.discordapp.Discord"] },
} as const;
const everydayIds = ["gmail", "voice", "cloudflare", "unifi", "whatsapp", "discord"] as const;
const personalApps = [...everydayIds, "spotify", "dot", "herdr", "menu", "hints"] as const;
type PersonalApp = typeof personalApps[number];
const agents = ["claude", "codex", "local"] as const;
type Agent = typeof agents[number];
type Features = { local: boolean; workspaceRoot?: string };
type Command =
  | { kind: "help" | "context" }
  | { kind: "workspace"; root?: string }
  | { kind: "test"; published: boolean }
  | { kind: "plan" | "apply"; json: boolean; features: Features }
  | { kind: "doctor"; json: boolean }
  | { kind: "status"; details: boolean }
  | { kind: "shell"; shell: "bash" | "zsh" }
  | { kind: "open"; app: PersonalApp }
  | { kind: "work"; tenant: string; app: WorkApp }
  | { kind: "agent"; agent: Agent; directory: string }
  | { kind: "drive"; tenant: string; action: "list" | "mount" | "connect" | "folder" }
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
  | { kind: "directory"; path: string }
  | { kind: "mount"; id: string; path: string; remote: string }
  | { kind: "editor" }
  | { kind: "remove"; path: string; previous: string };

const home = homedir();
const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
const bin = join(home, ".local/bin/snshah");
const profileDir = join(config, "snshah");
const assetDir = join(data, "snshah");
const product = "Shahid's Workstation";
const remote = "https://github.com/shah/workstation.git";
const defaultWorkspaceRoot = join(home, "Work");
const theme = join(config, "oh-my-posh/snshah.auto.omp.json");
const pluginId = "shah.workstation";
const pluginDir = join(config, "omarchy/plugins", pluginId);
const pluginFiles = {
  "manifest.json": `{
  "schemaVersion": 1,
  "id": "shah.workstation",
  "name": "Shahid's Workstation",
  "version": "0.2.0",
  "author": "shah",
  "description": "Workstation shortcuts and local Ollama status",
  "kinds": ["bar-widget"],
  "entryPoints": { "barWidget": "Panel.auto.qml" },
  "barWidget": {
    "displayName": "Shahid's Workstation",
    "description": "Drive mounts, local AI, config backup, and app shortcuts",
    "category": "AI",
    "allowMultiple": false
  }
}
`,
  "Panel.auto.qml": `pragma ComponentBehavior: Bound
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons as Commons
import qs.Ui as Ui

Ui.Panel {
  id: root
  moduleName: "shah.workstation"
  ipcTarget: root.moduleName
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  readonly property string cli: Quickshell.env("HOME") + "/.local/bin/snshah"
  property var summary: ({})
  property var details: ({})
  property int selected: 0
  readonly property bool compact: button.vertical || Quickshell.screens.some(screen => screen.width < 1050)
  readonly property string summaryText: summary.total === undefined ? "Shahid’s Workstation" :
    "Shahid’s Workstation · " + summary.mounted + "/" + summary.total + " drives · " +
    (summary.ai === "online" ? "AI ready" : summary.ai === "offline" ? "AI offline" : "AI off") +
    (summary.backup === "due" ? " · Backup due" : "")
  readonly property string narrowText: summary.total === undefined ? "Shahid’s Workstation" :
    "Shahid’s Workstation · " + summary.mounted + "/" + summary.total +
    (summary.ai === "online" ? " · AI" : summary.ai === "offline" ? " · AI ↓" : "") +
    (summary.backup === "due" ? " · !" : "")
  readonly property var actions: {
    const rows = [
      { label: "Workstation menu", args: ["menu"] },
      { label: "Apps and accounts", args: ["open", "menu"] }
    ]
    for (const drive of (root.details.drives || [])) {
      const state = { "mounted": "Mounted", "configured": "Ready to mount",
        "needs-sign-in": "Sign-in required", "occupied": "Mount path in use" }[drive.state]
      if (!state) continue
      const section = drive.id === "personal" ? "drive" : "tenant-" + drive.id
      const action = drive.state === "mounted" ? "folder" : drive.state === "configured" ? "mount" :
        drive.state === "needs-sign-in" ? "connect" : ""
      rows.push({ label: drive.label + " · " + state,
        args: action ? ["menu", "run", section + "." + action] : null })
    }
    rows.push({ label: "Herdr", args: ["open", "herdr"] })
    rows.push({ label: "Claude Code", args: ["menu", "run", "agents.claude"] })
    rows.push({ label: "Codex", args: ["menu", "run", "agents.codex"] })
    if (root.summary.ai !== "off")
      rows.push({ label: "Local OpenCode", args: ["menu", "run", "agents.local"] })
    rows.push({ label: root.summary.backup === "current" ? "Back up config again" : "Back up config",
      args: ["menu", "run", "vault.backup"] })
    rows.push({ label: "Edit config in VS Code", args: ["config", "edit"] })
    return rows
  }

  function refresh() {
    if (root.opened) {
      if (!detailJob.running) detailJob.running = true
    } else if (!statusJob.running) statusJob.running = true
  }
  function acceptStatus(text, detailed) {
    try {
      const value = JSON.parse(text)
      root.summary = value
      if (detailed && root.opened) root.details = value
    } catch (error) {
      if (detailed && root.opened) root.details = ({})
    }
  }
  function activate(index) {
    const row = root.actions[index]
    if (!row || !row.args) return
    Quickshell.execDetached([root.cli].concat(row.args))
    root.close()
  }

  onOpenedChanged: {
    if (root.opened) {
      root.selected = 0
      root.refresh()
    } else root.details = ({})
  }
  Component.onCompleted: refresh()
  Timer {
    interval: 30000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }
  Process {
    id: statusJob
    command: [root.cli, "status"]
    stdout: StdioCollector { onStreamFinished: root.acceptStatus(text, false) }
  }
  Process {
    id: detailJob
    command: [root.cli, "status", "--details"]
    stdout: StdioCollector { onStreamFinished: root.acceptStatus(text, true) }
  }

  Ui.WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.compact ? "󰆍" : root.narrowText
    tooltipText: root.summaryText
    active: root.opened
    useActiveColor: false
    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) Quickshell.execDetached([root.cli, "menu"])
      else root.toggle()
    }
  }

  Ui.KeyboardPanel {
    id: panel
    bar: root.bar
    anchorItem: button
    owner: root
    open: root.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Commons.Style.space(390))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Commons.Style.space(540))
    content: Ui.PanelKeyCatcher {
      implicitHeight: rows.implicitHeight
      onCloseRequested: root.close()
      onMoveRequested: function(dx, dy) {
        if (dy === 0) return
        let i = root.selected
        for (let n = 0; n < root.actions.length; n++) {
          i = (i + dy + root.actions.length) % root.actions.length
          if (root.actions[i].args) break
        }
        root.selected = i
        const row = rowItems.itemAt(i)
        if (row) scroll.contentY = Math.max(0, Math.min(scroll.contentHeight - scroll.height,
          row.y < scroll.contentY ? row.y : Math.max(scroll.contentY, row.y + row.height - scroll.height)))
      }
      onActivateRequested: root.activate(root.selected)
      Flickable {
        id: scroll
        anchors.fill: parent
        clip: true
        contentWidth: width
        contentHeight: rows.implicitHeight
        Column {
          id: rows
          width: scroll.width
          spacing: Commons.Style.space(4)
          Ui.PanelSectionHeader {
            width: parent.width
            text: "Shahid’s Workstation"
          }
          Text {
            width: parent.width
            text: root.summary.ai === "online" ? "Ollama online · " + (root.details.model || "Local AI") :
              root.summary.ai === "offline" ? "Ollama offline" : "Local AI off"
            color: Commons.Color.foreground
            textFormat: Text.PlainText
            elide: Text.ElideRight
          }
          Repeater {
            id: rowItems
            model: root.actions
            delegate: Ui.Button {
              required property int index
              required property var modelData
              width: rows.width
              text: modelData.label
              enabled: !!modelData.args
              selected: index === root.selected
              leftAlign: true
              onClicked: root.activate(index)
            }
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

  plan|apply [--workspaces-root PATH] [--local-ai] [--json]
  workspace [--workspaces-root PATH]
  test [--published]
  doctor [--json]
  shell [bash|zsh]
  open gmail|voice|cloudflare|unifi|whatsapp|discord|spotify|dot|herdr|menu|hints
  open TENANT [browser|outlook|calendar|teams|onedrive]
  agent claude|codex|local [directory]
  drive list|mount|connect|folder PERSONAL_OR_TENANT
  status [--details]
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
      } else if (kind === "workspace" || !member(["--local-ai", "--json"], flag)) {
        throw new UsageError(`Unknown option: ${flag}`);
      }
    }
    if (kind === "workspace") return { kind, root };
    return { kind, json: flags.has("--json"), features: {
      local: flags.has("--local-ai"), workspaceRoot: root,
    } };
  }
  if (kind === "test" && (!first || first === "--published") && !second) return { kind, published: !!first };
  if (kind === "status" && (!first || first === "--details") && !second) return { kind, details: !!first };
  if (kind === "doctor" && (!first || first === "--json") && !second) return { kind, json: !!first };
  if (kind === "shell" && !second && (!first || member(["bash", "zsh"], first))) return { kind, shell: first === "zsh" ? "zsh" : "bash" };
  if (kind === "context" && !first) return { kind };
  if (kind === "open" && !second && member(personalApps, first)) return { kind, app: first };
  if (kind === "open" && !rest.length && validTenantId(first) && (!second || member(workApps, second)))
    return { kind: "work", tenant: first, app: member(workApps, second) ? second : "outlook" };
  if (kind === "agent" && !rest.length && member(agents, first))
    return { kind, agent: first, directory: resolve(second ?? process.cwd()) };
  if (kind === "drive" && !rest.length && member(["list", "mount", "connect", "folder"], first) && second && (second === "personal" || validTenantId(second)))
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
const editorWorkspace = join(assetDir, "editor.auto.workspace", "snshah.auto.code-workspace");
// Keep these in sync with the checked-in .vscode defaults.
const editorSettings = {
  "editor.semanticHighlighting.enabled": true,
  "editor.renderValidationDecorations": "on",
  "js/ts.validate.enabled": true,
  "js/ts.implicitProjectConfig.strict": true,
  "js/ts.implicitProjectConfig.strictNullChecks": true,
  "js/ts.implicitProjectConfig.strictFunctionTypes": true,
  "[typescript]": {
    "editor.defaultFormatter": "vscode.typescript-language-features",
    "editor.formatOnSave": true,
    "editor.formatOnSaveMode": "file",
    "editor.tabSize": 2,
    "editor.insertSpaces": true,
    "editor.detectIndentation": false,
    "js/ts.format.enabled": true,
    "js/ts.preferences.quoteStyle": "double"
  }
};
const editorExtensions = { recommendations: ["oven.bun-vscode"] };

function privateEditorWorkspace(): string {
  return JSON.stringify({
    // This folder contains generated editor metadata only. The config opens as a separate file.
    folders: [{ path: ".", name: "Workstation configuration" }],
    settings: {
      ...editorSettings,
      "files.autoSave": "off",
      "files.hotExit": "off",
      "workbench.localHistory.enabled": false,
    },
    extensions: editorExtensions,
    tasks: {
      version: "2.0.0",
      tasks: [{
        label: "Check workstation config",
        type: "process",
        command: bin,
        args: ["config", "check"],
        group: { kind: "test", isDefault: true },
        problemMatcher: [],
      }],
    },
  }, null, 2) + "\n";
}

const menuPath = join(home, ".config/omarchy/extensions/omarchy-menu.jsonc");
const menuId = "shahid-workstation";
const commandScopes = ["claude", "codex", "local", "drive"] as const;
type Scope = typeof commandScopes[number];
const configTypes = `export type Secret =
  | { variable: string; value: string; scope: "shell" }
  | { variable: string; value: string; scope: "command"; commands: readonly ("claude" | "codex" | "local" | "drive")[] };
export type OneDriveProfile = { username: string; remote: string };
export type TenantFiles = { kind: "web" } | ({ kind: "rclone" } & OneDriveProfile);
export type Tenant = {
  /** Stable ID used in the CLI and local paths. Use lowercase letters, digits and hyphens. */
  id: string;
  /** Private name displayed by the account chooser. */
  label: string;
  /** Optional Microsoft sign-in hint. */
  username?: string;
  /** Use OneDrive on the web, or add a named rclone remote for a read-only mount. */
  files: TenantFiles;
};
export type AccountHint =
  | { kind: "gmail" | "voice" | "spotify" | "discord"; username: string }
  | { kind: "whatsapp"; phone: string }
  | { kind: "cloudflare"; username: string; account?: string }
  | { kind: "unifi"; username: string; site?: string };
export type WorkstationConfig = {
  personal: string;
  personalOneDrive: OneDriveProfile;
  accounts: readonly AccountHint[];
  /** Work tenants in menu order. Leave empty for a personal-only setup. */
  work: readonly Tenant[];
  /** Absolute path that contains your managed repository checkouts. */
  workspacesRoot: string;
  prompt: { kind: "starship" } | { kind: "posh" };
  browser: { kind: "omarchy" } | { kind: "edge-default" };
  localAI: { kind: "off" } | { kind: "ollama"; model: string };
  /** Prefer command scope. Shell-scoped secrets are inherited by child processes. */
  secrets: readonly Secret[];
};
`;

type Secret =
  | { variable: string; value: string; scope: "shell" }
  | { variable: string; value: string; scope: "command"; commands: readonly Scope[] };
type AccountHint =
  | { kind: "gmail" | "voice" | "spotify" | "discord"; username: string }
  | { kind: "whatsapp"; phone: string }
  | { kind: "cloudflare"; username: string; account?: string }
  | { kind: "unifi"; username: string; site?: string };
type WorkstationConfig = {
  personal: string;
  personalOneDrive: OneDriveProfile;
  accounts: readonly AccountHint[];
  work: readonly Tenant[];
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
function validTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value) &&
    value !== "personal" && !member(personalApps, value);
}

function tenantById(current: WorkstationConfig, id: string): Tenant {
  const tenant = current.work.find(profile => profile.id === id);
  if (!tenant) throw new UsageError(`Unknown tenant ID: ${id}. Check the work list in snshah.conf.ts.`);
  return tenant;
}

function validOneDrive(value: unknown): value is OneDriveProfile {
  return object(value) && typeof value.username === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,127}$/.test(value.username) && value.username.toLowerCase() !== "vault-staging" &&
    typeof value.remote === "string" && /^[\w][\w .-]{0,63}$/.test(value.remote);
}

function validateConfig(v: unknown): asserts v is WorkstationConfig {
  if (!object(v)) throw new Error("Export a WorkstationConfig object.");
  if (!validLabel(v.personal)) throw new Error("Invalid personal profile label.");
  if (!validOneDrive(v.personalOneDrive)) throw new Error("Invalid personal OneDrive username or remote.");
  if (!Array.isArray(v.accounts)) throw new Error("Expected an account hints array.");
  const services = new Set<string>();
  for (const hint of v.accounts) {
    if (!object(hint) || typeof hint.kind !== "string" || !member([...everydayIds, "spotify"], hint.kind) || services.has(hint.kind))
      throw new Error("Invalid or duplicate account hint.");
    const keys = hint.kind === "whatsapp" ? ["kind", "phone"] : hint.kind === "cloudflare" ? ["kind", "username", "account"] :
      hint.kind === "unifi" ? ["kind", "username", "site"] : ["kind", "username"];
    const required = hint.kind === "whatsapp" ? hint.phone : hint.username;
    if (!validLabel(required) || Object.entries(hint).some(([key, value]) => !keys.includes(key) || key !== "kind" && !validLabel(value)))
      throw new Error("Invalid account hint fields. Store sign-in hints only.");
    services.add(hint.kind);
  }
  const mountNames = new Set([v.personalOneDrive.username.toLowerCase()]);
  if (!Array.isArray(v.work)) throw new Error("Expected an ordered work tenant array.");
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const [i, p] of v.work.entries()) {
    if (!object(p) || !validTenantId(p.id) || !validLabel(p.label) || p.username !== undefined && !validLabel(p.username) || !object(p.files) || !(p.files.kind === "web" ||
      p.files.kind === "rclone" && validOneDrive(p.files)))
      throw new Error(`Invalid work profile at index ${i}.`);
    if (ids.has(p.id)) throw new Error(`Duplicate tenant ID: ${p.id}.`);
    if (labels.has(p.label)) throw new Error(`Duplicate tenant label at index ${i}.`);
    ids.add(p.id);
    labels.add(p.label);
    if ("kind" in p.files && p.files.kind === "rclone" && validOneDrive(p.files)) {
      const name = p.files.username.toLowerCase();
      if (mountNames.has(name)) throw new Error("Two OneDrive profiles use the same mount username.");
      mountNames.add(name);
    }
  }
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

function initialConfig(features?: Features): WorkstationConfig {
  return {
    personal: "Personal", personalOneDrive: { username: userInfo().username, remote: "snshah-personal" }, accounts: [],
    work: [], workspacesRoot: features?.workspaceRoot ?? defaultWorkspaceRoot,
    prompt: { kind: "posh" },
    browser: { kind: "edge-default" },
    localAI: features?.local ? { kind: "ollama", model: defaultModel } : { kind: "off" },
    secrets: [],
  };
}

function configSource(settings: WorkstationConfig): string {
  const { secrets, ...preferences } = settings;
  return [
    'import type { WorkstationConfig } from "./snshah.auto";',
    "// This private TypeScript file is the workstation configuration. Keep mode 0600.",
    beginSecrets, `const secrets = ${JSON.stringify(secrets, null, 2)} satisfies WorkstationConfig["secrets"];`, endSecrets,
    `const preferences = ${JSON.stringify(preferences, null, 2)} satisfies Omit<WorkstationConfig, "secrets">;`,
    "export default { ...preferences, secrets } satisfies WorkstationConfig;",
    "",
  ].join("\n");
}

async function settings(): Promise<WorkstationConfig> {
  return await exists(conf) ? interpretConfig(await privateConfigBytes()) : initialConfig();
}

function shellQuote(input: string): string { return "'" + input.replaceAll("'", "'\\''") + "'"; }

async function secretEnvironment(scope: Scope, config?: WorkstationConfig): Promise<NodeJS.ProcessEnv> {
  const current = config ?? await settings();
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
  // Refresh the types even if this edit session starts before the next apply.
  if (await read(declarations) !== configTypes) await atomicFile(declarations, configTypes);
  const workspace = privateEditorWorkspace();
  if (await read(editorWorkspace) !== workspace) await atomicFile(editorWorkspace, workspace, 0o600);
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
  try { await run(["code", "--new-window", "--wait", editorWorkspace, conf]); }
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
  const literal = /^\s*const\s+secrets\s*=\s*([\s\S]+?)\s+satisfies\s+WorkstationConfig\s*\[\s*["']secrets["']\s*\]\s*;?\s*$/.exec(section)?.[1];
  let managed = false;
  try { managed = literal !== undefined && JSON.stringify(Bun.JSONC.parse(literal)) === JSON.stringify(current.secrets); }
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
  return /^((https|ssh):\/\/(git@)?github\.com\/|git@github\.com:)shah\/workstation(\.git)?$/.test(url ?? "");
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

function appEntries(work: readonly Tenant[]) {
  return [
    { name: `${product} ChatGPT Dot`, url: "https://chatgpt.com/dots", icon: "system-help", args: "open dot" },
    ...work.flatMap(({ id }) => [
      { name: `${product} Outlook (${id})`, url: urls.outlook, icon: "mail-message-new", args: `open ${id} outlook` },
      { name: `${product} OneDrive (${id})`, url: urls.onedrive, icon: "folder-remote", args: `open ${id} onedrive` },
    ]),
  ];
}

async function enabledLauncher(names: readonly string[]): Promise<string | undefined> {
  const locations = [data, ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":")];
  for (const name of names) {
    for (const base of locations) {
      const entry = await read(join(base, "applications", name + ".desktop"));
      if (!entry) continue;
      if (!/^\s*(Hidden|NoDisplay)\s*=\s*true\s*$/mi.test(entry) && /^Exec=/m.test(entry))
        return name;
      break; // A user-level hidden entry masks the same system ID.
    }
  }
}

type DriveTarget = { id: string; label: string; profile: OneDriveProfile };
type DriveState = "mounted" | "configured" | "needs-sign-in" | "occupied";
type DriveStatus = { id: string; state: DriveState; path: string; remote: string; label: string };
function driveTargets(current: WorkstationConfig): DriveTarget[] {
  return [
    { id: "personal", label: current.personal, profile: current.personalOneDrive },
    ...current.work.flatMap(tenant => tenant.files.kind === "rclone" ?
      [{ id: tenant.id, label: tenant.label, profile: tenant.files }] : []),
  ];
}
function mountPath(profile: OneDriveProfile): string { return join(home, "OneDrive", profile.username); }
function driveStatus(current: WorkstationConfig, env = process.env): DriveStatus[] {
  const remotes = new Set(capture(["rclone", "listremotes"], env)?.split(/\r?\n/) ?? []);
  return driveTargets(current).map(({ id, label, profile }) => {
    const path = mountPath(profile);
    const remote = profile.remote + ":";
    const mounted = capture(["findmnt", "-n", "-o", "SOURCE,FSTYPE", "--mountpoint", path]);
    const state = mounted ? (/\s+fuse\.rclone$/.test(mounted) && mounted.replace(/\s+fuse\.rclone$/, "") === remote ? "mounted" : "occupied")
      : remotes.has(remote) ? "configured" : "needs-sign-in";
    return { id, state, path, remote, label };
  });
}
async function mountDrive(entry: DriveStatus, env: NodeJS.ProcessEnv): Promise<void> {
  if (entry.state === "mounted") return;
  if (entry.state === "occupied") throw new Error("OneDrive mount directory is occupied by another filesystem.");
  if (entry.state === "needs-sign-in") throw new Error("Connect this OneDrive account before mounting.");
  await mkdir(entry.path, { recursive: true, mode: 0o700 });
  if (!(await lstat(entry.path)).isDirectory()) throw new Error("OneDrive mount path must be a directory.");
  if ((await readdir(entry.path)).length) throw new Error("OneDrive mount directory must be empty.");
  await run(["rclone", "mount", entry.remote, entry.path, "--read-only", "--devname", entry.remote, "--daemon", "--daemon-wait", "15s"], { env });
}
async function workstationStatus(details: boolean): Promise<void> {
  const current = await settings();
  const drives = driveStatus(current, await secretEnvironment("drive", current));
  const config = await exists(conf) ? await privateConfigBytes() : undefined;
  const saved = await read(backupStamp);
  const result = {
    mounted: drives.filter(drive => drive.state === "mounted").length,
    total: drives.length,
    ai: current.localAI.kind === "off" ? "off" : await ollamaOnline() ? "online" : "offline",
    backup: config === undefined ? "unavailable" : digest(config) === saved ? "current" : "due",
    ...(details ? {
      model: current.localAI.kind === "ollama" ? current.localAI.model : null,
      drives: drives.map(({ id, label, state }) => ({ id, label, state })),
    } : {}),
  };
  print(result, true);
}
async function signInHints(): Promise<void> {
  const current = await settings();
  const hints = current.accounts.map(account => {
    const name = account.kind === "spotify" ? "Spotify" : everyday[account.kind].name;
    if (account.kind === "whatsapp") return `${name}: ${account.phone}`;
    const detail = account.kind === "cloudflare" ? account.account : account.kind === "unifi" ? account.site : undefined;
    return `${name}: ${account.username}${detail ? ` · ${detail}` : ""}`;
  });
  hints.push(`Personal OneDrive: ${current.personalOneDrive.username}`);
  for (const tenant of current.work)
    if (tenant.username) hints.push(`${tenant.label}: ${tenant.username}`);
  print(hints, false);
}

async function plan(features: Features): Promise<Step[]> {
  if (!available("omarchy")) throw new Error("Run setup on Omarchy with omarchy on PATH.");
  const current = await exists(conf) ? await settings() : initialConfig(features);
  validateConfig(current);
  const steps: Step[] = [];
  if (!available("code")) steps.push({ kind: "editor" });
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
  await file(editorWorkspace, privateEditorWorkspace(), { private: true });
  if (!await exists(conf)) await file(conf, configSource(current), { private: true });
  if (!await exists(checkout)) steps.push({ kind: "checkout", path: checkout });
  else if (!await exists(join(checkout, ".git")) || !knownWorkstationRemote(capture(["git", "-C", checkout, "remote", "get-url", "origin"])))
    throw new Error(`Expected the workstation checkout at ${checkout}. Choose another --workspaces-root if this path is in use.`);


  if (current.prompt.kind === "posh") {
    const source = await read(join(import.meta.dir, "snshah.omp.json")) ??
      await read(join(checkout, "snshah.omp.json")) ?? await read(theme);
    if (source === undefined) throw new Error("Run setup from the workstation checkout to install the Oh My Posh theme.");
    if (!available("oh-my-posh")) steps.push({ kind: "command", id: "install-oh-my-posh", argv: ["omarchy", "pkg", "aur", "add", "oh-my-posh-bin"] });
    await file(theme, source);
  } else {
    const previous = await read(theme);
    if (previous !== undefined) steps.push({ kind: "remove", path: theme, previous });
  }
  const bashrc = join(home, ".bashrc");
  await file(bashrc, upsertBlock(await read(bashrc) ?? "", beginShell, endShell, shellBlock("bash")));
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
  if ((current.work.length || current.browser.kind === "edge-default") && !available("microsoft-edge-stable"))
    steps.push({ kind: "command", id: "install-edge", argv: ["omarchy", "install", "browser", "edge"] });
  if (current.browser.kind === "edge-default" && capture(["xdg-settings", "get", "default-web-browser"], { ...process.env, XDG_CURRENT_DESKTOP: "" }) !== "microsoft-edge.desktop")
    steps.push({ kind: "command", id: "default-browser", argv: ["omarchy", "default", "browser", "edge"] });
  for (const [executable, pkg] of [["age", "age"], ["gum", "gum"], ["herdr", "herdr"]] as const) {
    if (!available(executable)) steps.push({ kind: "command", id: `install-${pkg}`, argv: ["omarchy", "pkg", "add", pkg] });
  }
  const apps = join(data, "applications");
  if (data !== join(home, ".local/share")) throw new Error("Omarchy web app installation requires the default XDG_DATA_HOME.");
  for (const id of everydayIds) {
    const app = everyday[id];
    if (!await enabledLauncher(app.entries))
      steps.push({ kind: "command", id: `webapp-${id}`, argv: ["omarchy", "webapp", "install", app.name, app.url, app.icon, "", ""] });
  }
  if (!available("spotify") && !await enabledLauncher(["Spotify", "spotify", "com.spotify.Client"]))
    steps.push({ kind: "command", id: "install-spotify", argv: ["omarchy", "install", "service", "spotify"] });
  for (const app of appEntries(current.work)) {
    const command = `snshah ${app.args}`;
    const desktop = await read(join(apps, `${app.name}.desktop`));
    if (!desktop?.split("\n").includes(`Exec=${command}`))
      steps.push({ kind: "command", id: app.args, argv: ["omarchy", "webapp", "install", app.name, app.url, app.icon, command, ""] });
  }
  if (await exists(apps)) {
    const active = new Set(current.work.map(tenant => tenant.id));
    const prefix = product + " ";
    for (const entry of (await readdir(apps, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const match = /^(Outlook|OneDrive) \(([a-z][a-z0-9-]{0,47})\)\.desktop$/.exec(entry.name.slice(prefix.length));
      if (!match || active.has(match[2])) continue;
      const path = join(apps, entry.name);
      const previous = await read(path);
      if (previous?.includes(`\nName=${entry.name.slice(0, -8)}\n`) &&
        previous.includes(`\nExec=snshah open ${match[2]} ${match[1].toLowerCase()}\n`))
        steps.push({ kind: "remove", path, previous });
    }
  }

  const storagePackages = [!available("rclone") && "rclone", !available("fusermount3") && "fuse3"]
    .filter((pkg): pkg is string => typeof pkg === "string");
  if (storagePackages.length)
    steps.push({ kind: "command", id: "install-onedrive-tools", argv: ["omarchy", "pkg", "add", ...storagePackages] });
  for (const drive of driveStatus(current, await secretEnvironment("drive", current))) {
    if (drive.state === "mounted" || drive.state === "occupied") continue;
    if (!await exists(drive.path)) steps.push({ kind: "directory", path: drive.path });
    if (drive.state === "configured") steps.push({ kind: "mount", id: drive.id, path: drive.path, remote: drive.remote });
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
  await file(menuPath, await menuContent(current.work));
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
    const deferred = new Set<Step>();
    for (const step of steps) {
      if (!json) console.log(stepLabel(step));
      switch (step.kind) {
        case "editor":
          await run(["omarchy", "install", "editor", "vscode"], { quiet: json });
          if (!available("code")) throw new Error("The Omarchy VS Code installer finished but code is unavailable.");
          break;
        case "directory": await mkdir(step.path, { recursive: true, mode: 0o700 }); break;
        case "mount": {
          const current = await settings();
          const env = await secretEnvironment("drive", current);
          const drive = driveStatus(current, env).find(candidate => candidate.id === step.id);
          if (!drive || drive.path !== step.path || drive.remote !== step.remote)
            throw new Error("OneDrive configuration changed while applying.");
          try { await mountDrive(drive, env); }
          catch {
            deferred.add(step);
            console.error(`OneDrive profile ${drive.id} could not mount. Check its sign-in and mount directory.`);
          }
          break;
        }
        case "file": await atomicFile(step.path, step.content, step.private ? 0o600 : step.executable ? 0o755 : undefined); break;
        case "command": await run(step.argv, { quiet: json }); break;
        case "wait": await waitForOllama(); break;
        case "checkout": await createCheckout(step.path); break;
        case "remove":
          if (await read(step.path) === step.previous) await rm(step.path);
          break;
      }
    }
    if (json) print({
      completed: describe(steps.filter(step => !deferred.has(step))),
      ...(deferred.size ? { deferred: describe([...deferred]) } : {}),
    }, true);
    else console.log(deferred.size ? `${product} setup complete with OneDrive mounts pending.` :
      steps.length ? `${product} setup complete.` : "No changes needed.");
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
    case "editor": return "omarchy install editor vscode";
    case "mount": return `Mount OneDrive for ${step.id}`;
    case "directory": return "Prepare OneDrive mount directory";
    case "file":
    case "checkout":
    case "remove": return `${step.kind}: ${step.path}`;
  }
}

function describe(steps: Step[]): Array<{ kind: string; target: string }> {
  return steps.map(step => ({
    kind: step.kind, target: step.kind === "command" || step.kind === "mount" ? step.id
      : step.kind === "wait" ? step.service : step.kind === "editor" ? "install-vscode"
      : step.kind === "directory" ? "onedrive-mount-directory" : step.path,
  }));
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

async function browser(url: string, id: string, app: boolean): Promise<void> {
  const tenant = tenantById(await settings(), id);
  const directory = join(data, "snshah/edge", tenant.id);
  launch(["microsoft-edge-stable", `--user-data-dir=${directory}`, app ? `--app=${url}` : url]);
}

async function openApp(app: PersonalApp): Promise<void> {
  switch (app) {
    case "gmail": case "voice": case "cloudflare": case "unifi": case "whatsapp": case "discord": {
      const entry = await enabledLauncher(everyday[app].entries);
      if (entry && available("gtk-launch")) launch(["gtk-launch", entry]);
      else launch(["omarchy-launch-webapp", everyday[app].url]);
      return;
    }
    case "spotify": {
      const entry = await enabledLauncher(["Spotify", "spotify", "com.spotify.Client"]);
      if (entry && available("gtk-launch")) launch(["gtk-launch", entry]);
      else launch(["omarchy-launch-spotify"]);
      return;
    }
    case "hints": await signInHints(); return;
    case "dot": launch(["omarchy-launch-webapp", "https://chatgpt.com/dots"]); return;
    case "herdr":
      if (available("herdr-app")) launch(["herdr-app"]);
      else launch(["omarchy-launch-terminal", "herdr"]);
      return;
    case "menu": {
      const current = await settings();
      const actions = new Map<string, Command>([
        [`Gmail · ${current.personal}`, { kind: "open", app: "gmail" }],
        ...everydayIds.filter(id => id !== "gmail").map((id): [string, Command] => [everyday[id].name, { kind: "open", app: id }]),
        ["Spotify", { kind: "open", app: "spotify" }],
        ["ChatGPT Dot", { kind: "open", app: "dot" }],
        ["Herdr", { kind: "open", app: "herdr" }],
      ]);
      for (const { id, label: tenantLabel } of current.work) {
        for (const [label, app] of [["Outlook", "outlook"], ["Calendar", "calendar"], ["Teams", "teams"], ["OneDrive", "onedrive"]] as const)
          actions.set(`${tenantLabel} · ${label}`, { kind: "work", tenant: id, app });
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
  const localConfig = join(profileDir, "opencode.auto.json");
  if (!await exists(localConfig)) throw new Error("Set up the local agent with snshah apply --local-ai.");
  const child = Bun.spawn(["opencode"], {
    cwd: directory, env: { ...await secretEnvironment(agent), OPENCODE_CONFIG: localConfig },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

async function drive(action: "list" | "mount" | "connect" | "folder", id: string): Promise<void> {
  const current = await settings();
  if (id !== "personal") tenantById(current, id);
  const env = await secretEnvironment("drive", current);
  const entry = driveStatus(current, env).find(candidate => candidate.id === id);
  if (!entry) throw new Error("Set the tenant’s files.kind to rclone before using its mount.");
  switch (action) {
    case "connect":
      console.log(`Create or reconnect the OneDrive remote named ${entry.remote.slice(0, -1)}, then run snshah drive mount ${id}.`);
      await run(["rclone", "config"], { env });
      return;
    case "folder":
      if (entry.state !== "mounted") throw new Error("Mount this OneDrive account before opening its folder.");
      launch(["xdg-open", entry.path]);
      return;
    case "mount": await mountDrive(entry, env); return;
    case "list":
      if (entry.state === "needs-sign-in") throw new Error("Connect this OneDrive account before listing files.");
      await run(["rclone", "lsf", entry.remote], { env });
  }
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
  | ["plan" | "apply" | "doctor", "--json"] | ["status", "--details"] | ["test", ...[] | ["--published"]]
  | ["open", PersonalApp] | ["open", string, WorkApp]
  | ["agent", Agent] | ["drive", "list" | "mount" | "connect" | "folder", string]
  | ["config", "edit" | "check" | "setup" | "set-secret"]
  | ["vault", "status" | "backup" | "verify" | "restore"]
  | ["plugin", "install" | "remove" | "toggle"];
type MenuAction = { id: string; label: string; args: MenuArgs; terminal?: true };
type MenuSection = { id: string; label: string; actions: MenuAction[] };

function driveActions(id: string): MenuAction[] {
  return [
    { id: "folder", label: "Open mounted folder", args: ["drive", "folder", id] },
    { id: "list", label: "List OneDrive files", args: ["drive", "list", id], terminal: true },
    { id: "mount", label: "Mount OneDrive read-only", args: ["drive", "mount", id], terminal: true },
    { id: "connect", label: "Connect OneDrive", args: ["drive", "connect", id], terminal: true },
  ];
}
function menuSections(work: readonly Tenant[]): MenuSection[] {
  return [
    { id: "open", label: "Open", actions: [
      ...everydayIds.map((app): MenuAction => ({ id: app, label: everyday[app].name, args: ["open", app] })),
      { id: "spotify", label: "Spotify", args: ["open", "spotify"] },
      { id: "hints", label: "Show private sign-in hints", args: ["open", "hints"], terminal: true },
      { id: "dot", label: "ChatGPT Dot", args: ["open", "dot"] },
      { id: "herdr", label: "Herdr", args: ["open", "herdr"] },
      { id: "chooser", label: "Accounts by name", args: ["open", "menu"] },
    ] },
    { id: "drive", label: "Personal OneDrive", actions: driveActions("personal") },
    ...work.map(({ id, files }, index): MenuSection => ({ id: `tenant-${id}`, label: `Tenant ${index + 1}`, actions: [
      ...workApps.map((app): MenuAction => ({
        id: app, label: { browser: "Edge browser", outlook: "Outlook", calendar: "Calendar", teams: "Teams", onedrive: "OneDrive on the web" }[app],
        args: ["open", id, app],
      })),
      ...(files.kind === "rclone" ? driveActions(id) : []),
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
      { id: "status", label: "Workstation status", args: ["status", "--details"], terminal: true },
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
async function menuContent(work: readonly Tenant[]): Promise<string> {
  const source = await read(menuPath) ?? "{\n}\n";
  const open = source.indexOf("{");
  if (open < 0 || !source.trimEnd().endsWith("}")) throw new Error("Expected an Omarchy menu JSONC object.");
  const rows: Record<string, { label: string; icon?: string; action?: string }> = {
    [menuId]: { label: product, icon: "󰆍" },
  };
  for (const section of menuSections(work)) {
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
  const action = menuSections((await settings()).work).flatMap(section => section.actions.map(item => ({ ...item, id: `${section.id}.${item.id}` })))
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
  for (const tenant of current.work) {
    const label = await promptInput(`Display name for ${tenant.id} (blank keeps its name)`);
    if (label) tenant.label = label;
  }
  validateConfig(current);
  if (!await confirm("Replace the config with these settings? Comments and custom expressions will be regenerated.")) return;
  if (await privateConfigBytes() !== previous) throw new Error("Config changed during setup.");
  await atomicFile(conf, configSource(current), 0o600);
  await atomicFile(menuPath, await menuContent((await settings()).work));
  await notify("Profile names updated. Back up the workstation config.", true).catch(() => {});
}

async function plugin(action: "install" | "remove" | "toggle"): Promise<void> {
  if (config !== join(home, ".config")) throw new Error("Omarchy plugin management requires the default XDG_CONFIG_HOME.");
  switch (action) {
    case "install":
      for (const [name, content] of Object.entries(pluginFiles)) await atomicFile(join(pluginDir, name), content);
      await run(["omarchy", "plugin", "validate", pluginDir]);
      await atomicFile(menuPath, await menuContent((await settings()).work));
      await run(["omarchy-shell", "shell", "rescanPlugins"]);
      await run(["omarchy", "plugin", "enable", pluginId, "--section", "right"]);
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
    case "status": await workstationStatus(command.details); return;
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
    const desktop = join(fixture, ".local/share/applications");
    const root = join(fixture, "Team Work");
    const source = await exists(join(import.meta.dir, "bootstrap.sh")) ? import.meta.dir : checkoutPath(await workspaceRoot());
    await mkdir(tools);
    await mkdir(hypr, { recursive: true });
    await mkdir(join(fixture, ".config/opencode"));
    await mkdir(desktop, { recursive: true });
    await symlink(process.execPath, join(tools, "bun"));
    for (const command of ["bash", "curl", "tar", "dirname", "mktemp", "rm", "cat", "sleep", "jq", "find", "id", "gzip", "omarchy-plugin-validate"]) {
      const path = Bun.which(command);
      if (path) await symlink(path, join(tools, command));
    }
    const bashrc = 'alias gs="git status"\nexport USER_SETTING=kept\n';
    const agentConfig = '{"userSetting":true}\n';
    const bindings = "-- User bindings\n";
    await writeFile(join(fixture, ".bashrc"), bashrc);
    await writeFile(join(fixture, "AGENTS.md"), "# Existing instructions\n");
    await writeFile(join(fixture, ".config/opencode/opencode.json"), agentConfig);
    await writeFile(join(hypr, "hyprland.lua"), "");
    await writeFile(join(hypr, "bindings.lua"), bindings);
    await writeFile(join(tools, "omarchy"), `#!/usr/bin/env bun
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const [, , group, action, name, url, , exec] = Bun.argv;
const home = process.env.HOME;
const dir = home + "/.local/share/applications";
const desktop = (title, command) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/" + title + ".desktop", "[Desktop Entry]\\nName=" + title + "\\nExec=" + command + "\\n");
};
appendFileSync(home + "/install.auto.log", Bun.argv.slice(2).join(" ") + "\\n");
if (group === "install" && action === "editor") {
  const code = process.env.PATH.split(":")[0] + "/code";
  writeFileSync(code, "#!/bin/sh\\nexit 0\\n");
  chmodSync(code, 0o755);
} else if (group === "pkg" && action === "aur" && name === "add" && url === "oh-my-posh-bin") {
  const executable = process.env.PATH.split(":")[0] + "/oh-my-posh";
  writeFileSync(executable, "#!/bin/sh\\nexit 0\\n");
  chmodSync(executable, 0o755);
} else if (group === "default" && action === "browser" && name === "edge") {
  writeFileSync(home + "/browser-default.auto.state", "microsoft-edge.desktop");
} else if (group === "install" && action === "service" && name === "spotify") {
  desktop("Spotify", "omarchy-launch-webapp https://open.spotify.com/");
} else if (group === "version") console.log("4.5.0");
else if (group === "webapp" && action === "install") {
  desktop(name, exec || "omarchy-launch-webapp " + url);
} else if (group === "plugin" && action === "validate") {
  const manifest = await Bun.file(name + "/manifest.json").json();
  if (manifest.id !== "shah.workstation" || !await Bun.file(name + "/" + manifest.entryPoints.barWidget).exists())
    process.exitCode = 9;
  if (Bun.which("omarchy-plugin-validate"))
    process.exitCode = Bun.spawnSync(["omarchy-plugin-validate", name], { stderr: "inherit" }).exitCode ?? 1;
} else if (group === "plugin" && action === "enable" && name === "shah.workstation") {
  // No live shell in the fixture.
} else if (group === "plugin" && action === "remove" && name === "shah.workstation") {
  rmSync(home + "/.config/omarchy/plugins/" + name, { recursive: true });
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
    for (const tool of ["gum", "herdr", "omarchy-shell", "fusermount3"])
      await writeFile(join(tools, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(tools, "age"), '#!/bin/sh\nif [ "$1" = "-d" ]; then cat "$3"; else cat > "$3"; fi\n', { mode: 0o755 });
    await writeFile(join(tools, "microsoft-edge-stable"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/browser.auto.log"\n', { mode: 0o755 });
    await writeFile(join(tools, "xdg-settings"), '#!/bin/sh\ncat "$HOME/browser-default.auto.state" 2>/dev/null\n', { mode: 0o755 });
    await writeFile(join(tools, "rclone"),
      '#!/bin/sh\ncase "$1" in listremotes) if test -f "$HOME/remote.auto.state"; then cat "$HOME/remote.auto.state"; fi;; mount) printf "%s fuse.rclone\\n" "$2" > "$3/mount.auto.state";; esac\n',
      { mode: 0o755 });
    await writeFile(join(tools, "findmnt"), '#!/bin/sh\ncat "$5/mount.auto.state" 2>/dev/null\n', { mode: 0o755 });
    await writeFile(join(desktop, "Discord.desktop"), "[Desktop Entry]\nName=Discord\nExec=discord\n");
    await writeFile(join(desktop, "WhatsApp.desktop"), "[Desktop Entry]\nHidden=true\nExec=omarchy-launch-webapp https://web.whatsapp.com/\n");
    const env = { HOME: fixture, PATH: `${tools}:${join(fixture, ".local/bin")}`, TERM: "dumb", XDG_DATA_DIRS: fixture };
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
    assert.equal(JSON.parse(draft)[0].target, "install-vscode");
    assert(JSON.parse(draft).some((step: { target: string }) => step.target === "default-browser"));
    assert(!JSON.parse(draft).some((step: { target: string }) => step.target === "webapp-discord"));
    const bootstrap = published
      ? ["bash", "-o", "pipefail", "-c", 'curl -fsSL https://raw.githubusercontent.com/shah/workstation/main/bootstrap.sh | bash -s -- "$@"', "--", ...flags]
      : ["bash", "bootstrap.sh", ...flags];
    assert.match(invoke(...bootstrap), /Shahid's Workstation setup complete/);
    assert.equal(invoke("snshah", "workspace"), checkoutPath(root) + "\n");
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    assert.equal(invoke(...bootstrap), "No changes needed.\n");
    const rc = await readFile(join(fixture, ".bashrc"), "utf8");
    assert(rc.startsWith(bashrc));
    assert.equal(rc.match(/>>> snshah shell >>>/g)?.length, 1);
    assert.equal(await readFile(join(fixture, "AGENTS.md"), "utf8"), "# Existing instructions\n");
    assert.equal(await readFile(join(fixture, ".config/opencode/opencode.json"), "utf8"), agentConfig);
    assert((await readFile(join(hypr, "bindings.lua"), "utf8")).startsWith(bindings));
    assert(await exists(join(hypr, "snshah.auto.lua")));
    for (const name of ["Gmail", "Google Voice", "Cloudflare Admin", "UniFi Admin", "WhatsApp", "Spotify"])
      assert(await exists(join(desktop, name + ".desktop")));
    const installation = await readFile(join(fixture, "install.auto.log"), "utf8");
    assert.equal(installation.match(/install editor vscode/g)?.length, 1);
    assert.equal(installation.match(/install service spotify/g)?.length, 1);
    assert.equal(installation.match(/pkg aur add oh-my-posh-bin/g)?.length, 1);
    assert(!installation.includes("webapp install Discord"));
    assert.match(invoke("bash", "--noprofile", "-ic", "alias ll; alias gs; type mkcd"), /alias ll='ls -al'\nalias gs='git status'/);
    assert.equal(invoke("bash", "--noprofile", "-c", 'source "$HOME/.bashrc"; alias ll 2>/dev/null || true'), "");
    const fixtureConf = join(fixture, ".config/snshah.conf.ts");
    const freshConfig = await readFile(fixtureConf, "utf8");
    const settings = await interpretConfig(freshConfig);
    const menuFile = join(fixture, ".config/omarchy/extensions/omarchy-menu.jsonc");
    assert.deepEqual(settings.work, []);
    assert.equal(settings.prompt.kind, "posh");
    assert.equal(settings.browser.kind, "edge-default");
    const hints: WorkstationConfig = { ...settings, accounts: [{ kind: "gmail", username: "fixture@example.invalid" }] };
    await writeFile(fixtureConf, configSource(hints));
    assert.match(invoke("snshah", "open", "hints"), /fixture@example.invalid/);
    assert(!invoke("snshah", "status", "--details").includes("fixture@example.invalid"));
    await writeFile(fixtureConf, freshConfig);
    const personalMount = join(fixture, "OneDrive", settings.personalOneDrive.username);
    assert(await exists(personalMount));
    const offline = JSON.parse(invoke("snshah", "status", "--details"));
    assert.equal(offline.drives[0].state, "needs-sign-in");
    assert(!invoke("snshah", "status").includes(settings.personalOneDrive.username));
    await writeFile(join(fixture, "remote.auto.state"), "snshah-personal:\n");
    // Simulate a successful mount and verify that the next apply reuses it.
    invoke("snshah", "apply");
    assert.equal(JSON.parse(invoke("snshah", "status")).mounted, 1);
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    assert(!(await readFile(menuFile, "utf8")).includes("Tenant 1"));
    const work: Tenant[] = ["studio", "research", "consulting", "operations"].map(id => ({
      id, label: `Fixture ${id}`, files: { kind: "web" },
    }));
    async function configureTenants(tenants: readonly Tenant[]) {
      await writeFile(fixtureConf, configSource({ ...settings, work: tenants }));
    }
    await configureTenants(work.slice(0, 1));
    invoke("snshah", "apply");
    assert((await readFile(menuFile, "utf8")).includes("Tenant 1"));
    assert(!(await readFile(menuFile, "utf8")).includes("Tenant 2"));
    for (const id of ["missing", "../studio"]) {
      assert.equal(Bun.spawnSync(["snshah", "open", id, "outlook"], { env }).exitCode, 2);
      assert.equal(Bun.spawnSync(["snshah", "drive", "list", id], { env }).exitCode, 2);
    }
    await configureTenants([work[0], { ...work[1], id: work[0].id }]);
    assert.match(Bun.spawnSync(["snshah", "plan"], { env }).stderr.toString(), /Duplicate tenant ID/);
    await configureTenants([{ ...work[0], files: { kind: "rclone", username: settings.personalOneDrive.username, remote: "fixture" } }]);
    assert.match(Bun.spawnSync(["snshah", "config", "check"], { env }).stderr.toString(), /same mount username/);
    await configureTenants(work);
    invoke("snshah", "apply");
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    const fourMenus = await readFile(menuFile, "utf8");
    assert(fourMenus.includes("Tenant 4") && !fourMenus.includes(work[0].label));
    for (const tenant of work) invoke("snshah", "open", tenant.id, "outlook");
    const log = join(fixture, "browser.auto.log");
    const deadline = Date.now() + 1500;
    let launches = "";
    while (Date.now() < deadline) {
      launches = await read(log) ?? "";
      if ((launches.match(/--app=https:\/\/outlook\.office\.com\/mail\//g)?.length ?? 0) === work.length) break;
      await Bun.sleep(30);
    }
    for (const { id } of work)
      assert(launches.includes(`--user-data-dir=${join(fixture, ".local/share/snshah/edge", id)}`));
    const studioProfile = join(fixture, ".local/share/snshah/edge", work[0].id);
    await mkdir(studioProfile, { recursive: true });
    const studioLauncher = join(desktop, `${product} Outlook (${work[0].id}).desktop`);
    await configureTenants([work[1], { ...work[0], label: "Renamed studio" }, ...work.slice(2)]);
    assert(!invoke("snshah", "plan", "--json").includes(studioLauncher));
    invoke("snshah", "apply");
    const reordered = await readFile(menuFile, "utf8");
    assert(reordered.indexOf(".tenant-research") < reordered.indexOf(".tenant-studio"));
    assert(!reordered.includes("Renamed studio"));
    await configureTenants(work.slice(1));
    invoke("snshah", "apply");
    assert(!await exists(studioLauncher));
    assert(await exists(studioProfile));
    assert(!(await readFile(menuFile, "utf8")).includes(".tenant-studio"));
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    invoke("snshah", "plugin", "install");
    const generatedPlugin = join(fixture, ".config/omarchy/plugins/shah.workstation");
    assert(await exists(join(generatedPlugin, "manifest.json")));
    assert(await exists(join(generatedPlugin, "Panel.auto.qml")));
    invoke("snshah", "plugin", "remove");
    assert(!await exists(generatedPlugin));
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
    for (const section of menuSections(work)) {
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
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/editor-args.auto.log"\nprintf "\\n// saved from fixture editor\\n" >> "$4"\nsleep 0.4\n', { mode: 0o755 });
    await writeFile(join(tools, "omarchy-notification-send"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/notification.auto.log"\n', { mode: 0o755 });
    invoke("snshah", "config", "edit");
    const workspacePath = join(fixture, ".local/share/snshah/editor.auto.workspace/snshah.auto.code-workspace");
    const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
    const editorArgs = (await readFile(join(fixture, "editor-args.auto.log"), "utf8")).trimEnd().split("\n");
    assert.deepEqual(editorArgs, ["--new-window", "--wait", workspacePath, fixtureConf]);
    assert.equal(workspace.settings["[typescript]"]["editor.formatOnSave"], true);
    assert.equal(workspace.settings["workbench.localHistory.enabled"], false);
    assert.deepEqual(workspace.folders, [{ path: ".", name: "Workstation configuration" }]);
    assert.deepEqual(workspace.tasks.tasks[0].args, ["config", "check"]);
    assert.deepEqual(workspace.extensions, editorExtensions);
    assert.deepEqual(JSON.parse(await readFile(join(source, ".vscode/settings.json"), "utf8")), editorSettings);
    assert.deepEqual(JSON.parse(await readFile(join(source, ".vscode/extensions.json"), "utf8")), editorExtensions);
    for (let i = 0; i < 10 && !await exists(join(fixture, "notification.auto.log")); i++) await Bun.sleep(40);
    const notification = await readFile(join(fixture, "notification.auto.log"), "utf8");
    assert(notification.includes("Back Up Now") && !notification.includes(fake));
    const formatted = configSource({
      ...settings,
      secrets: [{ variable: "EXAMPLE_ROTATE_TOKEN", value: "", scope: "command", commands: ["codex"] }],
    }).replace('\n  }\n] satisfies WorkstationConfig["secrets"];',
      "\n  },\n] satisfies WorkstationConfig['secrets']");
    await writeFile(fixtureConf, formatted);
    await writeFile(join(tools, "gum"), '#!/bin/sh\ntest "$1" = input && test "$4" = --password || exit 2\nprintf "%s\\n" "new-fixture-token"\n', { mode: 0o755 });
    invoke("snshah", "config", "set-secret", "EXAMPLE_ROTATE_TOKEN");
    const rotated = await interpretConfig(await readFile(fixtureConf, "utf8"));
    assert.equal(rotated.secrets[0]?.value, "new-fixture-token");
    const fresh = join(fixture, "home.auto.fresh");
    await mkdir(join(fresh, ".config/hypr"), { recursive: true });
    await writeFile(join(fresh, ".config/hypr/hyprland.lua"), "");
    env.HOME = fresh;
    assert.match(invoke("bun", import.meta.path, "apply"), /Shahid's Workstation setup complete/);
    assert(await exists(checkoutPath(join(fresh, "Work"))));
    assert(await exists(join(fresh, ".config/oh-my-posh/snshah.auto.omp.json")));
    const freshBin = join(fresh, ".local/bin/snshah");
    assert.equal(invoke(freshBin, "plan", "--json"), "[]\n");
    console.log("Workstation self-test passed.");
  } finally { await rm(fixture, { recursive: true, force: true }); }
}
