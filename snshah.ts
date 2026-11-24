#!/usr/bin/env -S bun --no-env-file
import assert from "node:assert/strict";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, isIPv4, type AddressInfo, type Socket } from "node:net";
import { createInterface } from "node:readline/promises";
import type { Duplex } from "node:stream";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  homedir,
  userInfo,
  hostname,
  networkInterfaces,
  tmpdir,
} from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type OneDriveProfile = { username: string; remote: string };
type TenantFiles = { kind: "web" } | ({ kind: "rclone" } & OneDriveProfile);
type Tenant = {
  id: string;
  label: string;
  username?: string;
  files: TenantFiles;
};
const workApps = [
  "browser",
  "outlook",
  "calendar",
  "teams",
  "onedrive",
] as const;
type WorkApp = (typeof workApps)[number];
const everyday = {
  gmail: {
    name: "Gmail",
    url: "https://mail.google.com/",
    icon: "mail-message-new",
    entries: ["Gmail", "Google Mail"],
  },
  voice: {
    name: "Google Voice",
    url: "https://voice.google.com/",
    icon: "call-start",
    entries: ["Google Voice"],
  },
  cloudflare: {
    name: "Cloudflare Admin",
    url: "https://dash.cloudflare.com/",
    icon: "network-server",
    entries: ["Cloudflare Admin", "Cloudflare"],
  },
  unifi: {
    name: "UniFi Admin",
    url: "https://unifi.ui.com/",
    icon: "network-workgroup",
    entries: ["UniFi Admin", "UniFi"],
  },
  whatsapp: {
    name: "WhatsApp",
    url: "https://web.whatsapp.com/",
    icon: "whatsapp",
    entries: ["WhatsApp", "whatsapp"],
  },
  discord: {
    name: "Discord",
    url: "https://discord.com/channels/@me",
    icon: "omarchy-discord",
    entries: ["Discord", "discord", "com.discordapp.Discord"],
  },
} as const;
const everydayIds = [
  "gmail",
  "voice",
  "cloudflare",
  "unifi",
  "whatsapp",
  "discord",
] as const;
const personalApps = [
  ...everydayIds,
  "spotify",
  "dot",
  "herdr",
  "menu",
  "hints",
] as const;
type PersonalApp = (typeof personalApps)[number];
const agents = ["claude", "codex", "local"] as const;
type Agent = (typeof agents)[number];
type Features = { local: boolean; workspaceRoot?: string };
type Command =
  | { kind: "context" }
  | { kind: "update"; check: boolean; yes: boolean }
  | { kind: "workspace"; root?: string }
  | { kind: "test"; published: boolean }
  | { kind: "plan" | "apply"; json: boolean; features: Features }
  | { kind: "doctor"; json: boolean }
  | {
      kind: "ssh";
      action: "enroll" | "devices" | "revoke" | "enable";
      device?: string;
    }
  | { kind: "status"; details: boolean }
  | { kind: "shell"; shell: "bash" | "zsh" }
  | { kind: "open"; app: PersonalApp }
  | { kind: "work"; tenant: string; app: WorkApp }
  | { kind: "agent"; agent: Agent; directory: string }
  | {
      kind: "drive";
      tenant: string;
      action: "list" | "mount" | "connect" | "folder";
    }
  | { kind: "vault"; action: "status" | "backup" }
  | { kind: "restore" | "verify"; archive?: string; overwrite: boolean }
  | { kind: "config"; action: "edit" | "check" | "setup" }
  | { kind: "set-secret"; variable: string }
  | { kind: "menu"; id?: string; terminal: boolean }
  | { kind: "shell-env" }
  | { kind: "plugin"; action: "install" | "remove" | "toggle" };

type Step =
  | {
      kind: "file";
      path: string;
      content: string;
      executable?: boolean;
      private?: boolean;
    }
  | { kind: "agent-config"; path: string; content: string; previous?: string }
  | { kind: "command"; id: string; argv: string[] }
  | { kind: "wait"; service: "ollama" }
  | { kind: "checkout"; path: string; repository: string }
  | { kind: "directory"; path: string }
  | { kind: "mount"; id: string; path: string; remote: string }
  | { kind: "editor" }
  | { kind: "ssh-server" }
  | { kind: "remove"; path: string; previous: string };

const home = homedir();
const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
const bin = join(home, ".local/bin/snshah");
const profileDir = join(config, "snshah");
const assetDir = join(data, "snshah");
const product = "Workshop";
const cliVersion = "0.3.0";
const defaultRepository = "shah/workshop";
const defaultWorkspaceRoot = join(home, "Work");
const theme = join(config, "oh-my-posh/snshah.auto.omp.json");
const pluginId = "shah.workstation";
const pluginDir = join(config, "omarchy/plugins", pluginId);
const pluginFiles = {
  "manifest.json": `{
  "schemaVersion": 1,
  "id": "shah.workstation",
  "name": "Workshop",
  "version": "0.2.0",
  "author": "shah",
  "description": "Workshop shortcuts and local Ollama status",
  "kinds": ["bar-widget"],
  "entryPoints": { "barWidget": "Panel.auto.qml" },
  "barWidget": {
    "displayName": "Workshop",
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
  readonly property string summaryText: summary.total === undefined ? "Workshop" :
    "Workshop · " + summary.mounted + "/" + summary.total + " drives · " +
    (summary.ai === "online" ? "AI ready" : summary.ai === "offline" ? "AI offline" : "AI off") +
    (summary.backup === "due" ? " · Backup due" : "")
  readonly property string narrowText: summary.total === undefined ? "Workshop" :
    "Workshop · " + summary.mounted + "/" + summary.total +
    (summary.ai === "online" ? " · AI" : summary.ai === "offline" ? " · AI ↓" : "") +
    (summary.backup === "due" ? " · !" : "")
  readonly property var actions: {
    const rows = [
      { label: "Workshop menu", args: ["menu"] },
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
            text: "Workshop"
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
  ll: "ls -al",
  gs: "git status --short --branch",
  gd: "git diff",
  gds: "git diff --staged",
  gl: "git log --oneline --graph --decorate",
} as const;

class UsageError extends Error {}

const commanderDependency = "commander@12.1.0";
const chalkDependency = "chalk@5.6.2";
const clackDependency = "@clack/prompts@0.11.0";
const interactiveOutput = !!process.stdout.isTTY && process.env.TERM !== "dumb";
let chalk: typeof import("chalk").default | undefined;

function member<const T extends readonly string[]>(
  choices: T,
  value: string | undefined,
): value is T[number] {
  return value !== undefined && choices.some((choice) => choice === value);
}

function styled(
  message: string,
  style: "action" | "success" | "pending" | "error" = "action",
): string {
  if (!interactiveOutput) return message;
  const icons = { action: "🛠️", success: "✅", pending: "🟡", error: "❌" };
  const colors = {
    action: chalk?.cyan,
    success: chalk?.green,
    pending: chalk?.yellow,
    error: chalk?.red,
  };
  return `${icons[style]}  ${colors[style]?.(message) ?? message}`;
}

function say(message: string, style?: Parameters<typeof styled>[1]): void {
  console.log(styled(message, style));
}

async function cliPrompts() {
  return import(clackDependency).catch(() => {
    throw new Error(
      `Could not load ${clackDependency}. Check access to the npm registry and retry.`,
    );
  });
}

function workspaceOption(path?: string): string | undefined {
  return path
    ? resolve(
        path === "~"
          ? home
          : path.startsWith("~/")
            ? join(home, path.slice(2))
            : path,
      )
    : undefined;
}

async function dispatchCli(
  argv: string[],
  dispatch: (command: Command) => Promise<void> = execute,
): Promise<void> {
  const {
    Command: Cli,
    Argument,
    CommanderError,
  } = await import(commanderDependency).catch(() => {
    throw new Error(
      `Could not load ${commanderDependency}. Check access to the npm registry and retry.`,
    );
  });
  if (interactiveOutput && !process.env.NO_COLOR && !chalk)
    chalk = (await import(chalkDependency).catch(() => undefined))?.default;
  const program = new Cli()
    .name("snshah")
    .version(`v${cliVersion}`)
    .description(
      interactiveOutput
        ? (chalk?.bold.cyan("🛠️  Shahid’s AI Agents Workshop") ??
            "🛠️  Shahid’s AI Agents Workshop")
        : "Shahid’s AI Agents Workshop",
    );
  program.exitOverride();
  program.configureOutput({
    outputError: (message: string, write: (text: string) => void) =>
      write(styled(message.trimEnd(), "error") + "\n"),
  });
  program.action(() => program.outputHelp());
  program.addHelpText("after", () =>
    interactiveOutput
      ? `\n${chalk?.bold("🚀  Start here") ?? "🚀  Start here"}\n  snshah plan       Preview setup\n  snshah update     Get the latest Workshop\n  snshah ssh --help See remote access commands\n`
      : "",
  );

  const description = (icon: string, message: string) =>
    interactiveOutput ? `${icon}  ${chalk?.cyan(message) ?? message}` : message;
  const command = (
    parent: typeof program,
    name: string,
    icon: string,
    message: string,
  ) => parent.command(name).description(description(icon, message));
  const group = (name: string, icon: string, message: string) => {
    const parent = command(program, name, icon, message);
    parent.action(() => parent.outputHelp());
    return parent;
  };
  const oneOf = (
    name: string,
    choices: readonly string[],
    fallback?: string,
  ) => {
    const argument = new Argument(name).choices([...choices]);
    if (fallback !== undefined) argument.default(fallback);
    return argument;
  };

  for (const kind of ["plan", "apply"] as const) {
    command(
      program,
      kind,
      kind === "plan" ? "🔎" : "🛠️",
      kind === "plan" ? "Preview setup changes" : "Apply Workshop setup",
    )
      .option("--workspaces-root <path>", "Root for repository checkouts")
      .option("--local-ai", "Enable local Ollama setup")
      .option("--json", "Print structured output")
      .action(
        (options: {
          workspacesRoot?: string;
          localAi?: boolean;
          json?: boolean;
        }) =>
          dispatch({
            kind,
            json: !!options.json,
            features: {
              local: !!options.localAi,
              workspaceRoot: workspaceOption(options.workspacesRoot),
            },
          }),
      );
  }
  command(
    program,
    "update",
    "📦",
    "Install the latest published Workshop revision",
  )
    .option("--check", "Preview the update")
    .option("--yes", "Apply without prompting")
    .action((options: { check?: boolean; yes?: boolean }) =>
      dispatch({ kind: "update", check: !!options.check, yes: !!options.yes }),
    );
  command(program, "workspace", "📁", "Print the configured checkout path")
    .option("--workspaces-root <path>", "Root for repository checkouts")
    .action((options: { workspacesRoot?: string }) =>
      dispatch({
        kind: "workspace",
        root: workspaceOption(options.workspacesRoot),
      }),
    );
  command(program, "doctor", "🩺", "Inspect Workshop dependencies")
    .option("--json", "Print structured output")
    .action((options: { json?: boolean }) =>
      dispatch({ kind: "doctor", json: !!options.json }),
    );
  command(program, "status", "📊", "Print status for the Omarchy widget")
    .option("--details", "Include drive details")
    .action((options: { details?: boolean }) =>
      dispatch({ kind: "status", details: !!options.details }),
    );
  command(program, "test", "🧪", "Run the Workshop self-test")
    .option("--published", "Test the published bootstrap")
    .action((options: { published?: boolean }) =>
      dispatch({ kind: "test", published: !!options.published }),
    );
  command(program, "context", "🧭", "Print the current shell context").action(
    () => dispatch({ kind: "context" }),
  );
  command(program, "shell", "🐚", "Emit shell initialization code")
    .addArgument(oneOf("[shell]", ["bash", "zsh"], "bash"))
    .action((shell: "bash" | "zsh") => dispatch({ kind: "shell", shell }));
  command(program, "agent", "🤖", "Start an agent in a directory")
    .addArgument(oneOf("<agent>", agents))
    .argument("[directory]")
    .action((agent: Agent, directory?: string) =>
      dispatch({
        kind: "agent",
        agent,
        directory: resolve(directory ?? process.cwd()),
      }),
    );
  command(program, "open", "🚀", "Open an app or tenant")
    .argument("<app-or-tenant>")
    .addArgument(oneOf("[tenant-app]", workApps))
    .action((target: string, app?: WorkApp) => {
      if (!app && member(personalApps, target))
        return dispatch({ kind: "open", app: target });
      if (!validTenantId(target))
        throw new UsageError("Choose a known app or a valid tenant ID.");
      return dispatch({ kind: "work", tenant: target, app: app ?? "outlook" });
    });

  const ssh = group("ssh", "🔑", "Enroll and manage remote devices");
  command(ssh, "enroll", "➕", "Start a one-time enrollment").action(() =>
    dispatch({ kind: "ssh", action: "enroll" }),
  );
  command(ssh, "devices", "💻", "List enrolled devices")
    .alias("list")
    .action(() => dispatch({ kind: "ssh", action: "devices" }));
  command(ssh, "revoke", "🗑️", "Revoke a device key")
    .argument("[device]")
    .action((device?: string) =>
      dispatch({ kind: "ssh", action: "revoke", device }),
    );
  command(ssh, "enable", "🟢", "Enable regular key-only SSH").action(() =>
    dispatch({ kind: "ssh", action: "enable" }),
  );

  const drives = group("drive", "☁️", "Manage OneDrive connections");
  for (const [action, message] of [
    ["list", "List files"],
    ["mount", "Mount a remote"],
    ["connect", "Sign in to OneDrive"],
    ["folder", "Open the mount folder"],
  ] as const)
    command(drives, action, "☁️", message)
      .argument("<tenant>")
      .action((tenant: string) => {
        if (tenant !== "personal" && !validTenantId(tenant))
          throw new UsageError("Choose personal or a valid tenant ID.");
        return dispatch({ kind: "drive", action, tenant });
      });

  const vaultCommand = group(
    "vault",
    "🔐",
    "Back up and restore configuration",
  );
  for (const [action, message] of [
    ["status", "Check backup status"],
    ["backup", "Create an encrypted backup"],
  ] as const)
    command(vaultCommand, action, "🔐", message).action(() =>
      dispatch({ kind: "vault", action }),
    );
  command(vaultCommand, "verify", "🔎", "Verify a backup")
    .argument("[archive]")
    .action((archive?: string) =>
      dispatch({ kind: "verify", archive, overwrite: false }),
    );
  command(vaultCommand, "restore", "📦", "Restore a backup")
    .argument("[archive]")
    .option("--overwrite", "Replace the existing config")
    .action((archive: string | undefined, options: { overwrite?: boolean }) =>
      dispatch({ kind: "restore", archive, overwrite: !!options.overwrite }),
    );

  const configCommand = group(
    "config",
    "⚙️",
    "Edit and validate Workshop settings",
  );
  for (const [action, message] of [
    ["setup", "Set profile names"],
    ["check", "Validate configuration"],
    ["edit", "Open configuration in the editor"],
  ] as const)
    command(configCommand, action, "⚙️", message).action(() =>
      dispatch({ kind: "config", action }),
    );
  command(configCommand, "set-secret", "🔒", "Enter a secret with masked input")
    .argument("<variable>")
    .action((variable: string) => dispatch({ kind: "set-secret", variable }));

  const plugins = group("plugin", "🧩", "Manage the Omarchy bar widget");
  for (const [action, message] of [
    ["install", "Install or refresh the widget"],
    ["remove", "Remove the widget"],
    ["toggle", "Open the Workshop menu"],
  ] as const)
    command(plugins, action, "🧩", message).action(() =>
      dispatch({ kind: "plugin", action }),
    );

  const menu = command(program, "menu", "📋", "Open the Workshop menu");
  menu.action(() => dispatch({ kind: "menu", terminal: false }));
  menu
    .command("run", { hidden: true })
    .argument("<action>")
    .option("--terminal")
    .action((id: string, options: { terminal?: boolean }) =>
      dispatch({ kind: "menu", id, terminal: !!options.terminal }),
    );
  program
    .command("shell-env", { hidden: true })
    .action(() => dispatch({ kind: "shell-env" }));
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.exitCode !== 0) process.exitCode = 2;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicFile(
  path: string,
  content: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const previous = (await exists(path)) ? await lstat(path) : undefined;
  if (previous && !previous.isFile())
    throw new Error(`Expected a regular file at ${path}`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), ".snshah.auto.write-"));
  const draft = join(temporary, `draft.auto.${basename(path)}`);
  try {
    await writeFile(draft, content, {
      mode: mode ?? (previous && previous.mode & 0o777) ?? 0o644,
    });
    await rename(draft, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function available(command: string): boolean {
  return Bun.which(command) !== null;
}

async function run(
  argv: string[],
  options: { cwd?: string; quiet?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: options.quiet ? 2 : "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${argv[0]} exited with status ${code}`);
}

function capture(argv: string[], env = process.env): string | undefined {
  if (!available(argv[0])) return undefined;
  const result = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 3000,
    env,
  });
  return result.success ? result.stdout.toString().trim() : undefined;
}

function launch(argv: string[], cwd?: string): void {
  Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  }).unref();
}

function print(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) for (const item of value) say(String(item));
  else say(String(value));
}

async function shellCode(shell: "bash" | "zsh"): Promise<string> {
  const aliases = Object.entries(addedAliases).map(
    ([name, value]) =>
      `alias ${name} >/dev/null 2>&1 || alias ${name}='${value}'`,
  );
  const fnCheck = shell === "bash" ? "declare -F mkcd" : "whence -w mkcd";
  const lines = [
    ...aliases,
    `${fnCheck} >/dev/null 2>&1 || mkcd() { mkdir -p -- "$1" && cd -- "$1"; }`,
  ];
  if (await exists(theme)) {
    const quoted = "'" + theme.replaceAll("'", "'\\''") + "'";
    lines.push(
      `if command -v oh-my-posh >/dev/null 2>&1; then eval "$(oh-my-posh init ${shell} --config ${quoted})"; fi`,
    );
  }
  if (await exists(conf))
    lines.push(
      'if [[ -x "$HOME/.local/bin/snshah" ]]; then',
      "  { case $- in *x*) _snshah_trace=1; set +x;; esac; } 2>/dev/null",
      '  if _snshah_exports=$("$HOME/.local/bin/snshah" shell-env); then eval "$_snshah_exports"; fi',
      "  unset _snshah_exports",
      "  if [[ ${_snshah_trace:-} == 1 ]]; then unset _snshah_trace; set -x; fi",
      "fi",
    );
  return lines.join("\n");
}

const beginShell = "# >>> snshah shell >>>";
const endShell = "# <<< snshah shell <<<";
const shellBlock = (shell: "bash" | "zsh") =>
  [
    beginShell,
    'if [[ $- == *i* && -x "$HOME/.local/bin/snshah" ]]; then',
    `  if _snshah_init=$("$HOME/.local/bin/snshah" shell ${shell}); then`,
    '    eval "$_snshah_init"',
    "  fi",
    "  unset _snshah_init",
    "fi",
    endShell,
  ].join("\n");

function upsertBlock(
  content: string,
  start: string,
  end: string,
  block: string,
): string {
  const lines = content.split("\n");
  const first = lines.indexOf(start);
  const last = lines.indexOf(end);
  if (first === -1 && last === -1)
    return `${content}${content && !content.endsWith("\n") ? "\n" : ""}${block}\n`;
  if (
    last <= first ||
    first < 0 ||
    lines.lastIndexOf(start) !== first ||
    lines.lastIndexOf(end) !== last
  )
    throw new Error(`Invalid managed block: ${start}`);
  return [...lines.slice(0, first), block, ...lines.slice(last + 1)].join("\n");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const conf = join(home, ".config/snshah.conf.ts");
const declarations = join(dirname(conf), "snshah.auto.d.ts");
const editorWorkspace = join(
  assetDir,
  "editor.auto.workspace",
  "snshah.auto.code-workspace",
);
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
    "js/ts.preferences.quoteStyle": "double",
  },
};
const editorExtensions = { recommendations: ["oven.bun-vscode"] };

function formatGeneratedConfig(path: string, source: string): string {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "fmt",
      "--no-script",
      "--no-config",
      "--no-editorconfig",
      "--quote-props=preserve",
      ...(path.endsWith(".code-workspace") ? ["--parser", "json"] : []),
      "--stdin-filepath",
      basename(path),
    ],
    { stdin: Buffer.from(source), stdout: "pipe", stderr: "pipe" },
  );
  if (!result.success || !result.stdout.length)
    throw new Error(
      `Could not format ${basename(path)} with bun fmt. Check its syntax and use Bun 1.4.4 or newer.`,
    );
  return result.stdout.toString();
}

function formattedConfigTypes(): string {
  return formatGeneratedConfig(declarations, configTypes);
}

function privateEditorWorkspace(): string {
  return formatGeneratedConfig(
    editorWorkspace,
    JSON.stringify(
      {
        // This folder contains generated editor metadata only. The config opens as a separate file.
        folders: [{ path: ".", name: "Workshop configuration" }],
        settings: {
          ...editorSettings,
          "files.autoSave": "off",
          "files.hotExit": "off",
          "workbench.localHistory.enabled": false,
        },
        extensions: editorExtensions,
        tasks: {
          version: "2.0.0",
          tasks: [
            {
              label: "Check Workshop config",
              type: "process",
              command: bin,
              args: ["config", "check"],
              group: { kind: "test", isDefault: true },
              problemMatcher: [],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
}

const menuPath = join(home, ".config/omarchy/extensions/omarchy-menu.jsonc");
const menuId = "shahid-workstation";
const commandScopes = ["claude", "codex", "local", "drive"] as const;
type Scope = (typeof commandScopes)[number];
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
  /** Default GitHub repository in owner/name form. */
  repository: string;
  prompt: { kind: "starship" } | { kind: "posh" };
  browser: { kind: "omarchy" } | { kind: "edge-default" };
  localAI: { kind: "off" } | { kind: "ollama"; model: string };
  /** Prefer command scope. Shell-scoped secrets are inherited by child processes. */
  secrets: readonly Secret[];
};
`;

type Secret =
  | { variable: string; value: string; scope: "shell" }
  | {
      variable: string;
      value: string;
      scope: "command";
      commands: readonly Scope[];
    };
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
  repository: string;
  prompt: { kind: "starship" } | { kind: "posh" };
  browser: { kind: "omarchy" } | { kind: "edge-default" };
  localAI: { kind: "off" } | { kind: "ollama"; model: string };
  secrets: readonly Secret[];
};
const beginSecrets = "// >>> snshah secrets >>>";
const endSecrets = "// <<< snshah secrets <<<";
function validLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 64 &&
    !/[\x00-\x1f\x7f/]/.test(value)
  );
}
function validTenantId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9-]{0,47}$/.test(value) &&
    value !== "personal" &&
    !member(personalApps, value)
  );
}

function tenantById(current: WorkstationConfig, id: string): Tenant {
  const tenant = current.work.find((profile) => profile.id === id);
  if (!tenant)
    throw new UsageError(
      `Unknown tenant ID: ${id}. Check the work list in snshah.conf.ts.`,
    );
  return tenant;
}

function validOneDrive(value: unknown): value is OneDriveProfile {
  return (
    object(value) &&
    typeof value.username === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,127}$/.test(value.username) &&
    value.username.toLowerCase() !== "vault-staging" &&
    typeof value.remote === "string" &&
    /^[\w][\w .-]{0,63}$/.test(value.remote)
  );
}

function validateConfig(v: unknown): asserts v is WorkstationConfig {
  if (!object(v)) throw new Error("Export a WorkstationConfig object.");
  if (!validLabel(v.personal))
    throw new Error("Invalid personal profile label.");
  if (!validOneDrive(v.personalOneDrive))
    throw new Error("Invalid personal OneDrive username or remote.");
  if (!Array.isArray(v.accounts))
    throw new Error("Expected an account hints array.");
  const services = new Set<string>();
  for (const hint of v.accounts) {
    if (
      !object(hint) ||
      typeof hint.kind !== "string" ||
      !member([...everydayIds, "spotify"], hint.kind) ||
      services.has(hint.kind)
    )
      throw new Error("Invalid or duplicate account hint.");
    const keys =
      hint.kind === "whatsapp"
        ? ["kind", "phone"]
        : hint.kind === "cloudflare"
          ? ["kind", "username", "account"]
          : hint.kind === "unifi"
            ? ["kind", "username", "site"]
            : ["kind", "username"];
    const required = hint.kind === "whatsapp" ? hint.phone : hint.username;
    if (
      !validLabel(required) ||
      Object.entries(hint).some(
        ([key, value]) =>
          !keys.includes(key) || (key !== "kind" && !validLabel(value)),
      )
    )
      throw new Error("Invalid account hint fields. Store sign-in hints only.");
    services.add(hint.kind);
  }
  const mountNames = new Set([v.personalOneDrive.username.toLowerCase()]);
  if (!Array.isArray(v.work))
    throw new Error("Expected an ordered work tenant array.");
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const [i, p] of v.work.entries()) {
    if (
      !object(p) ||
      !validTenantId(p.id) ||
      !validLabel(p.label) ||
      (p.username !== undefined && !validLabel(p.username)) ||
      !object(p.files) ||
      !(
        p.files.kind === "web" ||
        (p.files.kind === "rclone" && validOneDrive(p.files))
      )
    )
      throw new Error(`Invalid work profile at index ${i}.`);
    if (ids.has(p.id)) throw new Error(`Duplicate tenant ID: ${p.id}.`);
    if (labels.has(p.label))
      throw new Error(`Duplicate tenant label at index ${i}.`);
    ids.add(p.id);
    labels.add(p.label);
    if (
      "kind" in p.files &&
      p.files.kind === "rclone" &&
      validOneDrive(p.files)
    ) {
      const name = p.files.username.toLowerCase();
      if (mountNames.has(name))
        throw new Error("Two OneDrive profiles use the same mount username.");
      mountNames.add(name);
    }
  }
  if (
    typeof v.workspacesRoot !== "string" ||
    !isAbsolute(v.workspacesRoot) ||
    /[\x00-\x1f]/.test(v.workspacesRoot)
  )
    throw new Error("workspacesRoot must be an absolute path.");
  if (
    typeof v.repository !== "string" ||
    !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9_.-]*$/i.test(v.repository) ||
    /\.git$/i.test(v.repository)
  )
    throw new Error(
      "repository must be a GitHub owner/name without a .git suffix.",
    );
  if (
    !object(v.prompt) ||
    !member(
      ["starship", "posh"],
      typeof v.prompt.kind === "string" ? v.prompt.kind : undefined,
    )
  )
    throw new Error("Invalid prompt choice.");
  if (
    !object(v.browser) ||
    (v.browser.kind !== "omarchy" && v.browser.kind !== "edge-default")
  )
    throw new Error("Invalid default browser choice.");
  if (
    !object(v.localAI) ||
    !(
      v.localAI.kind === "off" ||
      (v.localAI.kind === "ollama" &&
        typeof v.localAI.model === "string" &&
        /^[\w][\w./:-]{0,99}$/.test(v.localAI.model))
    )
  )
    throw new Error("Invalid local AI choice or model.");
  if (!Array.isArray(v.secrets)) throw new Error("Expected a list of secrets.");
  const seen = new Set<string>();
  for (const [i, item] of v.secrets.entries()) {
    if (
      !object(item) ||
      typeof item.variable !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(item.variable) ||
      /^(PATH|HOME|SHELL|IFS|PWD|OLDPWD|ENV|BASH.*|ZDOTDIR|LD_.*|DYLD_.*|NODE_OPTIONS|BUN_OPTIONS|XDG_.*|SNSHAH_.*)$/.test(
        item.variable,
      ) ||
      seen.has(item.variable) ||
      typeof item.value !== "string" ||
      item.value.includes("\0") ||
      !(
        item.scope === "shell" ||
        (item.scope === "command" &&
          Array.isArray(item.commands) &&
          item.commands.length &&
          item.commands.every((action) =>
            member(commandScopes, action as string),
          ) &&
          new Set(item.commands).size === item.commands.length)
      )
    )
      throw new Error(`Invalid or duplicate secret declaration at index ${i}.`);
    seen.add(item.variable);
  }
}

async function privateConfigBytes(): Promise<string> {
  const { open } = await import("node:fs/promises");
  const file = await open(
    conf,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error(
      "Cannot open the private Workshop config. Run snshah apply to create it.",
    );
  });
  try {
    const st = await file.stat();
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== 0o600 ||
      st.size > 256 * 1024
    )
      throw new Error(
        "Workshop config must be a regular file you own with mode 0600 and at most 256 KiB.",
      );
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function interpretConfig(text: string): Promise<WorkstationConfig> {
  let result: unknown;
  try {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
    result = (
      await import(
        "data:text/javascript;base64," + Buffer.from(js).toString("base64")
      )
    ).default;
  } catch {
    throw new Error(
      "The Workshop config could not be loaded. Check its TypeScript syntax and use only type imports.",
    );
  }
  validateConfig(result);
  return result;
}

function initialConfig(features?: Features): WorkstationConfig {
  return {
    personal: "Personal",
    personalOneDrive: {
      username: userInfo().username,
      remote: "snshah-personal",
    },
    accounts: [],
    work: [],
    workspacesRoot: features?.workspaceRoot ?? defaultWorkspaceRoot,
    repository: defaultRepository,
    prompt: { kind: "posh" },
    browser: { kind: "edge-default" },
    localAI: features?.local
      ? { kind: "ollama", model: defaultModel }
      : { kind: "off" },
    secrets: [],
  };
}

function configSource(settings: WorkstationConfig): string {
  const { secrets, ...preferences } = settings;
  return formatGeneratedConfig(
    conf,
    [
      'import type { WorkstationConfig } from "./snshah.auto";',
      "// This private TypeScript file is the Workshop configuration. Keep mode 0600.",
      beginSecrets,
      `const secrets = ${JSON.stringify(secrets, null, 2)} satisfies WorkstationConfig["secrets"];`,
      endSecrets,
      `const preferences = ${JSON.stringify(preferences, null, 2)} satisfies Omit<WorkstationConfig, "secrets">;`,
      "export default { ...preferences, secrets } satisfies WorkstationConfig;",
      "",
    ].join("\n"),
  );
}

async function settings(): Promise<WorkstationConfig> {
  return (await exists(conf))
    ? interpretConfig(await privateConfigBytes())
    : initialConfig();
}

function shellQuote(input: string): string {
  return "'" + input.replaceAll("'", "'\\''") + "'";
}

async function secretEnvironment(
  scope: Scope,
  config?: WorkstationConfig,
): Promise<NodeJS.ProcessEnv> {
  const current = config ?? (await settings());
  const env = { ...process.env };
  for (const secret of current.secrets)
    if (
      secret.value &&
      secret.scope === "command" &&
      secret.commands.includes(scope)
    )
      env[secret.variable] = secret.value;
  return env;
}

async function promptInput(title: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Open this prompt in a terminal.");
  const { text, password, isCancel } = await cliPrompts();
  const value = await (hidden
    ? password({ message: `🔒  ${title}` })
    : text({ message: `🛠️  ${title}` }));
  if (isCancel(value)) throw new Error("Input canceled.");
  return value;
}

async function notify(message: string, backup = false): Promise<void> {
  if (available("omarchy-notification-send"))
    launch([
      "omarchy-notification-send",
      product,
      message,
      ...(backup
        ? [
            "--action",
            "Back Up Now",
            "omarchy-launch-terminal",
            bin,
            "menu",
            "run",
            "vault.backup",
            "--terminal",
          ]
        : []),
    ]);
  else if (available("notify-send"))
    await run(["notify-send", product, message]);
}

async function editConfig(): Promise<void> {
  let previous = await privateConfigBytes();
  // Refresh the types even if this edit session starts before the next apply.
  const types = formattedConfigTypes();
  if ((await read(declarations)) !== types)
    await atomicFile(declarations, types);
  const workspace = privateEditorWorkspace();
  if ((await read(editorWorkspace)) !== workspace)
    await atomicFile(editorWorkspace, workspace, 0o600);
  const { watch } = await import("node:fs");
  const watcher = watch(dirname(conf), (_event, name) => {
    if (name === basename(conf)) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void saved();
      }, 220);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function saved() {
    try {
      const next = await privateConfigBytes();
      if (next === previous) return;
      const formatted = formatGeneratedConfig(conf, next);
      await interpretConfig(formatted);
      if ((await privateConfigBytes()) !== next) return;
      if (formatted !== next) await atomicFile(conf, formatted, 0o600);
      previous = formatted;
      if (digest(formatted) !== (await read(backupStamp)))
        await notify(
          "Workshop config changed since its last encrypted backup.",
          true,
        );
    } catch {
      await notify(
        "The Workshop config could not be validated. Run Configuration → Check.",
      ).catch(() => {});
    }
  }
  try {
    await run(["code", "--new-window", "--wait", editorWorkspace, conf]);
  } finally {
    watcher.close();
    clearTimeout(timer);
    await saved();
  }
}

async function rotateSecret(
  text: string,
  variable: string,
  readValue: () => Promise<string>,
): Promise<string> {
  const current = await interpretConfig(text);
  const existing = current.secrets.find(
    (secret) => secret.variable === variable,
  );
  if (!existing)
    throw new Error(
      "Declare this variable and its scope in the config before setting its value.",
    );
  const lines = text.split("\n");
  const first = lines.indexOf(beginSecrets);
  const last = lines.indexOf(endSecrets);
  const section = lines.slice(first + 1, last).join("\n");
  const literal =
    /^\s*const\s+secrets\s*=\s*([\s\S]+?)\s+satisfies\s+WorkstationConfig\s*\[\s*["']secrets["']\s*\]\s*;?\s*$/.exec(
      section,
    )?.[1];
  let managed = false;
  try {
    managed =
      literal !== undefined &&
      JSON.stringify(Bun.JSONC.parse(literal)) ===
        JSON.stringify(current.secrets);
  } catch {
    /* A custom expression should be edited directly. */
  }
  if (first < 0 || last <= first || !managed)
    throw new Error(
      "The secret declarations were edited as code. Set the value directly in VS Code, or format the marked declarations as generated JSON literals.",
    );
  const value = await readValue();
  const updated = current.secrets.map((entry) =>
    entry.variable === variable ? { ...entry, value } : entry,
  );
  const block = [
    beginSecrets,
    `const secrets = ${JSON.stringify(updated, null, 2)} satisfies WorkstationConfig["secrets"];`,
    endSecrets,
  ].join("\n");
  const next = formatGeneratedConfig(
    conf,
    upsertBlock(text, beginSecrets, endSecrets, block),
  );
  await interpretConfig(next);
  return next;
}

async function setSecret(variable: string): Promise<void> {
  const text = await privateConfigBytes();
  const next = await rotateSecret(text, variable, () =>
    promptInput("New token value", true),
  );
  if ((await privateConfigBytes()) !== text)
    throw new Error("The config changed while the prompt was open.");
  await atomicFile(conf, next, 0o600);
  await notify("Secret updated. Back up the Workshop config.", true).catch(
    () => {},
  );
}

async function workspaceRoot(override?: string): Promise<string> {
  return override ?? (await settings()).workspacesRoot;
}

function checkoutPath(root: string, repository = defaultRepository): string {
  return join(root, "github.com", repository);
}

function matchesRepository(
  url: string | undefined,
  repository: string,
): boolean {
  const slug =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)(.+)$/i.exec(
      url ?? "",
    )?.[1];
  return (
    slug?.replace(/\.git$/i, "").toLowerCase() === repository.toLowerCase()
  );
}

async function createCheckout(path: string, repository: string): Promise<void> {
  const remote = `https://github.com/${repository}.git`;
  await mkdir(dirname(path), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(path), ".workstation.auto.clone-"),
  );
  try {
    const checkout = join(staging, "checkout.auto.git");
    await run(["git", "clone", "--", remote, checkout], { quiet: true });
    await rename(checkout, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function appEntries(work: readonly Tenant[]) {
  return [
    {
      name: `${product} ChatGPT Dot`,
      url: "https://chatgpt.com/dots",
      icon: "system-help",
      args: "open dot",
    },
    ...work.flatMap(({ id }) => [
      {
        name: `${product} Outlook (${id})`,
        url: urls.outlook,
        icon: "mail-message-new",
        args: `open ${id} outlook`,
      },
      {
        name: `${product} OneDrive (${id})`,
        url: urls.onedrive,
        icon: "folder-remote",
        args: `open ${id} onedrive`,
      },
    ]),
  ];
}

async function enabledLauncher(
  names: readonly string[],
): Promise<string | undefined> {
  const locations = [
    data,
    ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
  ];
  for (const name of names) {
    for (const base of locations) {
      const entry = await read(join(base, "applications", name + ".desktop"));
      if (!entry) continue;
      if (
        !/^\s*(Hidden|NoDisplay)\s*=\s*true\s*$/im.test(entry) &&
        /^Exec=/m.test(entry)
      )
        return name;
      break; // A user-level hidden entry masks the same system ID.
    }
  }
}

type DriveTarget = { id: string; label: string; profile: OneDriveProfile };
type DriveState = "mounted" | "configured" | "needs-sign-in" | "occupied";
type DriveStatus = {
  id: string;
  state: DriveState;
  path: string;
  remote: string;
  label: string;
};
function driveTargets(current: WorkstationConfig): DriveTarget[] {
  return [
    {
      id: "personal",
      label: current.personal,
      profile: current.personalOneDrive,
    },
    ...current.work.flatMap((tenant) =>
      tenant.files.kind === "rclone"
        ? [{ id: tenant.id, label: tenant.label, profile: tenant.files }]
        : [],
    ),
  ];
}
function mountPath(profile: OneDriveProfile): string {
  return join(home, "OneDrive", profile.username);
}
function driveStatus(
  current: WorkstationConfig,
  env = process.env,
): DriveStatus[] {
  const remotes = new Set(
    capture(["rclone", "listremotes"], env)?.split(/\r?\n/) ?? [],
  );
  return driveTargets(current).map(({ id, label, profile }) => {
    const path = mountPath(profile);
    const remote = profile.remote + ":";
    const mounted = capture([
      "findmnt",
      "-n",
      "-o",
      "SOURCE,FSTYPE",
      "--mountpoint",
      path,
    ]);
    const state = mounted
      ? /\s+fuse\.rclone$/.test(mounted) &&
        mounted.replace(/\s+fuse\.rclone$/, "") === remote
        ? "mounted"
        : "occupied"
      : remotes.has(remote)
        ? "configured"
        : "needs-sign-in";
    return { id, state, path, remote, label };
  });
}
async function mountDrive(
  entry: DriveStatus,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (entry.state === "mounted") return;
  if (entry.state === "occupied")
    throw new Error(
      "OneDrive mount directory is occupied by another filesystem.",
    );
  if (entry.state === "needs-sign-in")
    throw new Error("Connect this OneDrive account before mounting.");
  await mkdir(entry.path, { recursive: true, mode: 0o700 });
  if (!(await lstat(entry.path)).isDirectory())
    throw new Error("OneDrive mount path must be a directory.");
  if ((await readdir(entry.path)).length)
    throw new Error("OneDrive mount directory must be empty.");
  await run(
    [
      "rclone",
      "mount",
      entry.remote,
      entry.path,
      "--read-only",
      "--devname",
      entry.remote,
      "--daemon",
      "--daemon-wait",
      "15s",
    ],
    { env },
  );
}
async function workstationStatus(details: boolean): Promise<void> {
  const current = await settings();
  const drives = driveStatus(
    current,
    await secretEnvironment("drive", current),
  );
  const config = (await exists(conf)) ? await privateConfigBytes() : undefined;
  const saved = await read(backupStamp);
  const result = {
    mounted: drives.filter((drive) => drive.state === "mounted").length,
    total: drives.length,
    ai:
      current.localAI.kind === "off"
        ? "off"
        : (await ollamaOnline())
          ? "online"
          : "offline",
    backup:
      config === undefined
        ? "unavailable"
        : digest(config) === saved
          ? "current"
          : "due",
    ...(details
      ? {
          model:
            current.localAI.kind === "ollama" ? current.localAI.model : null,
          drives: drives.map(({ id, label, state }) => ({ id, label, state })),
        }
      : {}),
  };
  if (!interactiveOutput) print(result, true);
  else {
    say(
      `OneDrive · ${result.mounted}/${result.total} mounted`,
      result.mounted === result.total ? "success" : "pending",
    );
    if (details)
      for (const drive of drives) say(`${drive.label} · ${drive.state}`);
    say(`Local AI · ${result.ai}`);
    say(
      `Vault backup · ${result.backup}`,
      result.backup === "current" ? "success" : "pending",
    );
  }
}
async function signInHints(): Promise<void> {
  const current = await settings();
  const hints = current.accounts.map((account) => {
    const name =
      account.kind === "spotify" ? "Spotify" : everyday[account.kind].name;
    if (account.kind === "whatsapp") return `${name}: ${account.phone}`;
    const detail =
      account.kind === "cloudflare"
        ? account.account
        : account.kind === "unifi"
          ? account.site
          : undefined;
    return `${name}: ${account.username}${detail ? ` · ${detail}` : ""}`;
  });
  hints.push(`Personal OneDrive: ${current.personalOneDrive.username}`);
  for (const tenant of current.work)
    if (tenant.username) hints.push(`${tenant.label}: ${tenant.username}`);
  print(hints, false);
}

function codexDefaults(previous: string): string {
  const current = Bun.TOML.parse(previous);
  if (!object(current)) throw new Error("Expected a Codex TOML config.");
  if (current.default_permissions !== undefined) return previous;

  const assignments: string[] = [];
  const expected = { ...current };
  if (current.approval_policy === undefined) {
    assignments.push('approval_policy = "never"');
    expected.approval_policy = "never";
  }
  if (current.sandbox_mode === undefined) {
    assignments.push('sandbox_mode = "workspace-write"');
    expected.sandbox_mode = "workspace-write";
  }

  const sandbox = current.sandbox_workspace_write;
  if (sandbox !== undefined && !object(sandbox))
    throw new Error("Expected sandbox_workspace_write to be a TOML table.");
  const networkDefault =
    expected.sandbox_mode === "workspace-write" &&
    sandbox?.network_access === undefined;
  if (!assignments.length && !networkDefault) return previous;
  const candidates = [previous];
  if (networkDefault) {
    expected.sandbox_workspace_write = { ...sandbox, network_access: true };
    const header =
      /^[ \t]*\[[ \t]*(?:sandbox_workspace_write|"sandbox_workspace_write"|'sandbox_workspace_write')[ \t]*\][ \t]*(?:#[^\r\n]*)?\r?$/gm;
    const inline =
      /^[ \t]*(?:sandbox_workspace_write|"sandbox_workspace_write"|'sandbox_workspace_write')[ \t]*=[ \t]*\{[ \t]*/gm;
    // Compare parsed settings before saving. This also rejects matches inside multiline strings.
    for (const match of previous.matchAll(header)) {
      const end = match.index + match[0].length;
      candidates.push(
        previous.slice(0, end) +
          "\nnetwork_access = true" +
          previous.slice(end),
      );
    }
    for (const match of previous.matchAll(inline)) {
      const end = match.index + match[0].length;
      const separator = previous[end] === "}" ? " " : ", ";
      candidates.push(
        previous.slice(0, end) +
          "network_access = true" +
          separator +
          previous.slice(end),
      );
    }
    candidates.push(
      "sandbox_workspace_write.network_access = true\n" + previous,
    );
  }
  const prefix = assignments.length
    ? "# Workshop defaults for new Codex sessions\n" +
      assignments.join("\n") +
      "\n\n"
    : "";
  for (const candidate of candidates) {
    const updated = prefix + candidate;
    try {
      assert.deepEqual(Bun.TOML.parse(updated), expected);
      return updated;
    } catch {
      /* Try the next TOML representation. */
    }
  }
  throw new Error(
    "Could not add Codex defaults without changing existing settings.",
  );
}

const claudeNetworkDomains = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "release-assets.githubusercontent.com",
  "registry.npmjs.org",
  "registry.npmjs.com",
];

function settingsSection(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!object(value))
    throw new Error(`Expected Claude Code ${name} settings to be an object.`);
  return value;
}

function claudeDefaults(previous: string): {
  content: string;
  sandboxEnabled: boolean;
} {
  const current = settingsSection(
    previous ? JSON.parse(previous) : undefined,
    "user",
  );
  const permissions = settingsSection(current.permissions, "permissions");
  const sandbox = settingsSection(current.sandbox, "sandbox");
  const network = settingsSection(sandbox.network, "sandbox.network");
  const defaults = {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    ...sandbox,
  };
  const next = {
    ...current,
    permissions: { defaultMode: "acceptEdits", ...permissions },
    sandbox:
      sandbox.enabled === false
        ? sandbox
        : {
            ...defaults,
            network: { allowedDomains: claudeNetworkDomains, ...network },
          },
  };
  const content = JSON.stringify(next, null, 2) + "\n";
  // Keep the original formatting when the settings are already equivalent.
  try {
    assert.deepEqual(next, current);
    return { content: previous, sandboxEnabled: defaults.enabled === true };
  } catch {
    return { content, sandboxEnabled: defaults.enabled === true };
  }
}

async function agentConfigSource(path: string): Promise<string | undefined> {
  if ((await exists(path)) && !(await lstat(path)).isFile())
    throw new Error(`Expected a regular file at ${path}`);
  return read(path);
}

async function planAgentDefaults(): Promise<Step[]> {
  const steps: Step[] = [];
  const claudePath = join(
    process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    "settings.json",
  );
  const codexPath = join(
    process.env.CODEX_HOME || join(home, ".codex"),
    "config.toml",
  );
  const claude = await agentConfigSource(claudePath);
  const claudeSettings = claudeDefaults(claude ?? "");
  if (claudeSettings.sandboxEnabled) {
    const missing = [
      ["bwrap", "bubblewrap"],
      ["socat", "socat"],
    ]
      .filter(([executable]) => !available(executable))
      .map(([, pkg]) => pkg);
    if (missing.length)
      steps.push({
        kind: "command",
        id: "install-claude-sandbox-tools",
        argv: ["omarchy", "pkg", "add", ...missing],
      });
  }
  if (claudeSettings.content !== claude)
    steps.push({
      kind: "agent-config",
      path: claudePath,
      content: claudeSettings.content,
      previous: claude,
    });
  const codex = await agentConfigSource(codexPath);
  const codexSettings = codexDefaults(codex ?? "");
  if (codexSettings !== codex)
    steps.push({
      kind: "agent-config",
      path: codexPath,
      content: codexSettings,
      previous: codex,
    });

  const start = "<!-- >>> Workshop sandbox guidance >>> -->";
  const end = "<!-- <<< Workshop sandbox guidance <<< -->";
  const guidance = [
    start,
    "## Working in the Workshop sandbox",
    "",
    "Proceed without asking for permission for routine work an experienced engineer would do in their own sandbox, including inspecting and editing project files, running builds and tests, and using Git for local work.",
    "Use the permissions and sandbox boundaries provided by the session.",
    end,
  ].join("\n");
  const codexInstructions = join(dirname(codexPath), "AGENTS.md");
  const override = join(dirname(codexPath), "AGENTS.override.md");
  for (const path of [
    join(dirname(claudePath), "CLAUDE.md"),
    (await agentConfigSource(override))?.trim() ? override : codexInstructions,
  ]) {
    const previous = await agentConfigSource(path);
    const content = upsertBlock(previous ?? "", start, end, guidance);
    if (content !== previous)
      steps.push({ kind: "agent-config", path, content, previous });
  }
  return steps;
}

async function plan(features: Features): Promise<Step[]> {
  if (!available("omarchy"))
    throw new Error("Run setup on Omarchy with omarchy on PATH.");
  const current = (await exists(conf))
    ? await settings()
    : initialConfig(features);
  validateConfig(current);
  const steps: Step[] = [];
  if (!available("code")) steps.push({ kind: "editor" });
  if (!regularSshReady()) steps.push({ kind: "ssh-server" });
  async function file(
    path: string,
    content: string,
    options: { executable?: boolean; private?: boolean } = {},
  ) {
    const mode = (await exists(path)) ? await lstat(path) : undefined;
    if (mode && !mode.isFile())
      throw new Error(`Expected a regular file at ${path}`);
    if (
      (await read(path)) !== content ||
      (options.executable && !(mode && mode.mode & constants.S_IXUSR)) ||
      (options.private && !!(mode && mode.mode & 0o077))
    )
      steps.push({ kind: "file", path, content, ...options });
  }

  const source = await read(import.meta.path);
  if (source === undefined)
    throw new Error("Cannot locate the snshah TypeScript script.");
  await file(bin, source, { executable: true });
  const root = features.workspaceRoot ?? current.workspacesRoot;
  const checkout = checkoutPath(root, current.repository);
  await file(declarations, formattedConfigTypes());
  await file(editorWorkspace, privateEditorWorkspace(), { private: true });
  if (!(await exists(conf)))
    await file(conf, configSource(current), { private: true });
  steps.push(...(await planAgentDefaults()));
  if (!(await exists(checkout)))
    steps.push({
      kind: "checkout",
      path: checkout,
      repository: current.repository,
    });
  else if (
    !(await exists(join(checkout, ".git"))) ||
    !matchesRepository(
      capture(["git", "-C", checkout, "remote", "get-url", "origin"]),
      current.repository,
    )
  )
    throw new Error(
      `Expected the Workshop checkout at ${checkout}. Choose another --workspaces-root if this path is in use.`,
    );

  const legacyEnrollment = join(assetDir, "ssh-enrollment.auto.py");
  if (
    (await exists(legacyEnrollment)) &&
    (await lstat(legacyEnrollment)).isFile()
  ) {
    const previous = await read(legacyEnrollment);
    if (
      previous !== undefined &&
      createHash("sha256").update(previous).digest("hex") ===
        "522cd6cbdf8ea2126b0d4e6291bc6167d1f39720922313e59c4fcf300406ffee"
    )
      steps.push({ kind: "remove", path: legacyEnrollment, previous });
  }

  if (current.prompt.kind === "posh") {
    const source =
      (await read(join(import.meta.dir, "snshah.omp.json"))) ??
      (await read(join(checkout, "snshah.omp.json"))) ??
      (await read(theme));
    if (source === undefined)
      throw new Error(
        "Run setup from the Workshop checkout to install the Oh My Posh theme.",
      );
    if (!available("oh-my-posh"))
      steps.push({
        kind: "command",
        id: "install-oh-my-posh",
        argv: ["omarchy", "pkg", "aur", "add", "oh-my-posh-bin"],
      });
    await file(theme, source);
  } else {
    const previous = await read(theme);
    if (previous !== undefined)
      steps.push({ kind: "remove", path: theme, previous });
  }
  const bashrc = join(home, ".bashrc");
  await file(
    bashrc,
    upsertBlock(
      (await read(bashrc)) ?? "",
      beginShell,
      endShell,
      shellBlock("bash"),
    ),
  );
  const hypr = join(config, "hypr");
  if (!(await exists(join(hypr, "hyprland.lua"))))
    throw new Error(
      "This Workshop profile requires Omarchy Quattro with Hyprland Lua.",
    );
  const bindings = join(hypr, "bindings.lua");
  const bindingFile = join(hypr, "snshah.auto.lua");
  await file(
    bindingFile,
    `o.bind("SUPER + ALT + M", "${product}", "snshah menu")\n`,
  );
  const bindingBlock = [
    "-- >>> snshah workstation >>>",
    'dofile((os.getenv("XDG_CONFIG_HOME") or os.getenv("HOME") .. "/.config") .. "/hypr/snshah.auto.lua")',
    "-- <<< snshah workstation <<<",
  ];
  await file(
    bindings,
    upsertBlock(
      (await read(bindings)) ?? "",
      bindingBlock[0],
      bindingBlock[2],
      bindingBlock.join("\n"),
    ),
  );
  if (
    (current.work.length || current.browser.kind === "edge-default") &&
    !available("microsoft-edge-stable")
  )
    steps.push({
      kind: "command",
      id: "install-edge",
      argv: ["omarchy", "install", "browser", "edge"],
    });
  if (
    current.browser.kind === "edge-default" &&
    capture(["xdg-settings", "get", "default-web-browser"], {
      ...process.env,
      XDG_CURRENT_DESKTOP: "",
    }) !== "microsoft-edge.desktop"
  )
    steps.push({
      kind: "command",
      id: "default-browser",
      argv: ["omarchy", "default", "browser", "edge"],
    });
  for (const [executable, pkg] of [
    ["age", "age"],
    ["herdr", "herdr"],
  ] as const) {
    if (!available(executable))
      steps.push({
        kind: "command",
        id: `install-${pkg}`,
        argv: ["omarchy", "pkg", "add", pkg],
      });
  }
  const apps = join(data, "applications");
  if (data !== join(home, ".local/share"))
    throw new Error(
      "Omarchy web app installation requires the default XDG_DATA_HOME.",
    );
  for (const id of everydayIds) {
    const app = everyday[id];
    if (!(await enabledLauncher(app.entries)))
      steps.push({
        kind: "command",
        id: `webapp-${id}`,
        argv: [
          "omarchy",
          "webapp",
          "install",
          app.name,
          app.url,
          app.icon,
          "",
          "",
        ],
      });
  }
  if (
    !available("spotify") &&
    !(await enabledLauncher(["Spotify", "spotify", "com.spotify.Client"]))
  )
    steps.push({
      kind: "command",
      id: "install-spotify",
      argv: ["omarchy", "install", "service", "spotify"],
    });
  for (const app of appEntries(current.work)) {
    const command = `snshah ${app.args}`;
    const desktop = await read(join(apps, `${app.name}.desktop`));
    if (!desktop?.split("\n").includes(`Exec=${command}`))
      steps.push({
        kind: "command",
        id: app.args,
        argv: [
          "omarchy",
          "webapp",
          "install",
          app.name,
          app.url,
          app.icon,
          command,
          "",
        ],
      });
  }
  if (await exists(apps)) {
    const active = new Set(current.work.map((tenant) => tenant.id));
    const prefix = product + " ";
    const legacyPrefix = "Shahid's Workstation ";
    for (const entry of (await readdir(apps, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      if (!entry.isFile()) continue;
      const legacy = entry.name.startsWith(legacyPrefix);
      if (!legacy && !entry.name.startsWith(prefix)) continue;
      const suffix = entry.name.slice(
        legacy ? legacyPrefix.length : prefix.length,
      );
      const match =
        /^(Outlook|OneDrive) \(([a-z][a-z0-9-]{0,47})\)\.desktop$/.exec(suffix);
      let command: string;
      if (legacy && suffix === "ChatGPT Dot.desktop")
        command = "snshah open dot";
      else if (match && (legacy || !active.has(match[2])))
        command = `snshah open ${match[2]} ${match[1].toLowerCase()}`;
      else continue;
      const path = join(apps, entry.name);
      const previous = await read(path);
      const lines = previous?.split("\n");
      if (
        previous !== undefined &&
        lines?.includes(`Name=${entry.name.slice(0, -8)}`) &&
        lines.includes(`Exec=${command}`)
      )
        steps.push({ kind: "remove", path, previous });
    }
  }

  const storagePackages = [
    !available("rclone") && "rclone",
    !available("fusermount3") && "fuse3",
  ].filter((pkg): pkg is string => typeof pkg === "string");
  if (storagePackages.length)
    steps.push({
      kind: "command",
      id: "install-onedrive-tools",
      argv: ["omarchy", "pkg", "add", ...storagePackages],
    });
  for (const drive of driveStatus(
    current,
    await secretEnvironment("drive", current),
  )) {
    if (drive.state === "mounted" || drive.state === "occupied") continue;
    if (!(await exists(drive.path)))
      steps.push({ kind: "directory", path: drive.path });
    if (drive.state === "configured")
      steps.push({
        kind: "mount",
        id: drive.id,
        path: drive.path,
        remote: drive.remote,
      });
  }
  if (features.local || current.localAI.kind === "ollama") {
    const model =
      current.localAI.kind === "ollama" ? current.localAI.model : defaultModel;
    if (!available("ollama"))
      steps.push({
        kind: "command",
        id: "install-ollama",
        argv: ["omarchy", "pkg", "add", "ollama"],
      });
    if (!(await ollamaOnline())) {
      steps.push({
        kind: "command",
        id: "start-ollama",
        argv: ["sudo", "systemctl", "enable", "--now", "ollama.service"],
      });
      steps.push({ kind: "wait", service: "ollama" });
    }
    if (!capture(["ollama", "show", model]))
      steps.push({
        kind: "command",
        id: "pull-model",
        argv: ["ollama", "pull", model],
      });
    await file(
      join(profileDir, "opencode.auto.json"),
      JSON.stringify(
        {
          default_agent: "plan",
          model: `ollama/${model}`,
          provider: {
            ollama: {
              npm: "@ai-sdk/openai-compatible",
              name: "Ollama",
              options: { baseURL: `${ollamaUrl}/v1` },
              models: { [model]: { name: model } },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
  await file(menuPath, await menuContent(current.work));
  return steps;
}

async function ollamaOnline(): Promise<boolean> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const workshopRemote = "https://github.com/shah/workshop.git";
const installReceipt = join(assetDir, "installed-revision.auto.json");
const commitSha = /^[0-9a-f]{40}$/;
const stagedExecutableName = "snshah.auto.next";

async function installedRevision(): Promise<string | undefined> {
  const receipt = await read(installReceipt);
  const installed = await read(bin);
  if (!receipt || !installed) return undefined;
  try {
    const value = JSON.parse(receipt);
    if (
      typeof value?.revision === "string" &&
      commitSha.test(value.revision) &&
      value.digest === digest(installed)
    )
      return value.revision;
  } catch {}
  return undefined;
}

async function commandOutput(argv: string[], quiet = false): Promise<string> {
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: quiet ? "ignore" : "inherit",
  });
  const [output, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`${argv[0]} exited with status ${status}`);
  return output;
}

async function updateWorkshop({
  check,
  yes,
}: Extract<Command, { kind: "update" }>): Promise<void> {
  if (process.getuid?.() === 0)
    throw new Error("Run snshah update as your desktop user.");
  if (check && yes) throw new UsageError("Choose either --check or --yes.");
  if (!check && !yes && !process.stdin.isTTY)
    throw new UsageError("Run update in a terminal or pass --yes.");
  say("Checking GitHub for the latest Workshop revision.");
  const ref = (
    await commandOutput([
      "git",
      "ls-remote",
      "--exit-code",
      workshopRemote,
      "refs/heads/main",
    ])
  ).trim();
  const [revision, branch] = ref.split(/\s+/);
  if (!commitSha.test(revision) || branch !== "refs/heads/main")
    throw new Error("GitHub returned an unexpected revision.");
  if ((await installedRevision()) === revision) {
    say(
      `Already up to date · v${cliVersion} · ${revision.slice(0, 12)}`,
      "success",
    );
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), "workshop.auto.update-"));
  try {
    const archive = join(scratch, "source.auto.tar.gz");
    const candidate = join(scratch, "snshah.ts");
    const downloadLabel = `📦  Downloading Workshop · ${revision.slice(0, 12)}`;
    const progress = interactiveOutput
      ? (await cliPrompts()).spinner()
      : undefined;
    if (progress) progress.start(downloadLabel);
    else say(`Downloading Workshop · ${revision.slice(0, 12)}`);
    try {
      await run([
        "curl",
        "-fsSL",
        "--retry",
        "2",
        "--max-time",
        "60",
        `https://codeload.github.com/shah/workshop/tar.gz/${revision}`,
        "-o",
        archive,
      ]);
      await run([
        "tar",
        "-xzf",
        archive,
        "-C",
        scratch,
        "--strip-components=1",
      ]);
      if (!(await lstat(candidate)).isFile())
        throw new Error(
          "The downloaded revision does not contain a regular snshah.ts file.",
        );
      progress?.stop("✅  Workshop revision downloaded");
    } catch (error) {
      progress?.stop("❌  Workshop download failed", 1);
      throw error;
    }
    const localModules = join(dirname(bin), "node_modules");
    const candidateModules = join(scratch, "node_modules");
    if ((await exists(localModules)) && !(await exists(candidateModules)))
      await symlink(localModules, candidateModules, "dir");
    const installer = [process.execPath, "--no-env-file", candidate];
    const protocol = await commandOutput(
      [...installer, "update-protocol"],
      true,
    ).catch(() => "");
    if (protocol.trim() !== "1")
      throw new Error(
        "This revision predates staged updates. The installed CLI was left in place.",
      );
    const env = {
      ...process.env,
      SNSHAH_INSTALL_REVISION: revision,
      SNSHAH_STAGE_UPDATE: "1",
    };
    const candidateVersion = (
      await commandOutput([...installer, "--version"])
    ).trim();
    say(
      `Previewing ${revision.slice(0, 12)} · v${cliVersion} → ${candidateVersion}`,
    );
    await run([...installer, "plan"], { env });
    if (check || (!yes && !(await confirm("Install this Workshop revision?"))))
      return;
    const original = await read(bin);
    await run([...installer, "apply"], { env });
    const staged = await read(join(scratch, stagedExecutableName));
    if (!staged || staged !== (await read(candidate)))
      throw new Error("The candidate did not stage the expected executable.");
    await withApplyLock(async () => {
      if ((await read(bin)) !== original) {
        if ((await installedRevision()) === revision) return;
        throw new Error(
          "The installed CLI changed during this update. Run snshah update again.",
        );
      }
      await recordRevision(revision, staged);
      await atomicFile(bin, staged, 0o755);
    });
    say(
      `Workshop updated · ${candidateVersion} · ${revision.slice(0, 12)}`,
      "success",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function recordRevision(revision: string, source: string): Promise<void> {
  await atomicFile(
    installReceipt,
    JSON.stringify({ revision, digest: digest(source) }) + "\n",
    0o600,
  );
}

async function withApplyLock(operation: () => Promise<void>): Promise<void> {
  await mkdir(assetDir, { recursive: true });
  const lock = join(assetDir, "apply.auto.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Setup is locked: ${lock}. If the previous run was interrupted and has stopped, remove this empty directory.`,
      );
    throw error;
  }
  try {
    await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function apply(features: Features, json: boolean): Promise<void> {
  await withApplyLock(async () => {
    const stagedUpdate = process.env.SNSHAH_STAGE_UPDATE === "1";
    const revision = process.env.SNSHAH_INSTALL_REVISION;
    if ((revision || stagedUpdate) && !commitSha.test(revision ?? ""))
      throw new Error("Invalid install revision.");
    const steps = await plan(features);
    const executable = steps.find(
      (step) => step.kind === "file" && step.path === bin,
    );
    const deferred = new Set<Step>();
    for (const step of steps) {
      if (step === executable) continue;
      if (!json) say(stepLabel(step));
      switch (step.kind) {
        case "editor":
          await run(["omarchy", "install", "editor", "vscode"], {
            quiet: json,
          });
          if (!available("code"))
            throw new Error(
              "The Omarchy VS Code installer finished but code is unavailable.",
            );
          break;
        case "directory":
          await mkdir(step.path, { recursive: true, mode: 0o700 });
          break;
        case "mount": {
          const current = await settings();
          const env = await secretEnvironment("drive", current);
          const drive = driveStatus(current, env).find(
            (candidate) => candidate.id === step.id,
          );
          if (
            !drive ||
            drive.path !== step.path ||
            drive.remote !== step.remote
          )
            throw new Error("OneDrive configuration changed while applying.");
          try {
            await mountDrive(drive, env);
          } catch {
            deferred.add(step);
            console.error(
              styled(
                `OneDrive profile ${drive.id} could not mount. Check its sign-in and mount directory.`,
                "pending",
              ),
            );
          }
          break;
        }
        case "file":
          await atomicFile(
            step.path,
            step.content,
            step.private ? 0o600 : step.executable ? 0o755 : undefined,
          );
          break;
        case "agent-config":
          try {
            if ((await agentConfigSource(step.path)) !== step.previous)
              throw new Error(
                `Agent settings changed during setup at ${step.path}. Run apply again.`,
              );
            const directory = dirname(step.path);
            let existingParent = directory;
            while (!(await exists(existingParent)))
              existingParent = dirname(existingParent);
            await access(existingParent, constants.W_OK);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await atomicFile(step.path, step.content, 0o600);
          } catch (error) {
            if (
              !member(
                ["EACCES", "EPERM", "EROFS"],
                (error as NodeJS.ErrnoException).code,
              )
            )
              throw error;
            deferred.add(step);
            console.error(
              styled(
                `Could not write ${step.path}. Re-run snshah apply from a regular Omarchy terminal.`,
                "pending",
              ),
            );
          }
          break;
        case "ssh-server":
          await enableRegularSsh(json);
          break;
        case "command":
          await run(step.argv, { quiet: json });
          break;
        case "wait":
          await waitForOllama();
          break;
        case "checkout":
          await createCheckout(step.path, step.repository);
          break;
        case "remove":
          if ((await read(step.path)) === step.previous) await rm(step.path);
          break;
      }
    }
    if (revision) {
      const source = await read(import.meta.path);
      if (source === undefined)
        throw new Error("The installer source disappeared during apply.");
      if (stagedUpdate)
        await atomicFile(
          join(import.meta.dir, stagedExecutableName),
          source,
          0o755,
        );
      else await recordRevision(revision, source);
    }
    if (!stagedUpdate && executable?.kind === "file") {
      if (!json) say("Installing the Workshop executable.");
      await atomicFile(executable.path, executable.content, 0o755);
    }
    if (json)
      print(
        {
          completed: describe(steps.filter((step) => !deferred.has(step))),
          ...(deferred.size ? { deferred: describe([...deferred]) } : {}),
        },
        true,
      );
    else
      say(
        deferred.size
          ? `${product} setup complete with pending steps.`
          : steps.length
            ? `${product} setup complete.`
            : "No changes needed.",
        deferred.size ? "pending" : "success",
      );
  });
}

async function waitForOllama(): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    if (await ollamaOnline()) return;
    await Bun.sleep(300);
  } while (Date.now() < deadline);
  throw new Error(
    "Ollama did not become reachable on port 11434. Check journalctl -u ollama.service.",
  );
}

function stepLabel(step: Step): string {
  switch (step.kind) {
    case "command":
      return step.argv.join(" ");
    case "wait":
      return `Wait for ${step.service}`;
    case "editor":
      return "omarchy install editor vscode";
    case "ssh-server":
      return "Enable key-only OpenSSH on port 22";
    case "mount":
      return `Mount OneDrive for ${step.id}`;
    case "directory":
      return "Prepare OneDrive mount directory";
    case "file":
    case "agent-config":
    case "checkout":
    case "remove":
      return `${step.kind}: ${step.path}`;
  }
}

function describe(steps: Step[]): Array<{ kind: string; target: string }> {
  return steps.map((step) => ({
    kind: step.kind,
    target:
      step.kind === "command" || step.kind === "mount"
        ? step.id
        : step.kind === "wait"
          ? step.service
          : step.kind === "editor"
            ? "install-vscode"
            : step.kind === "directory"
              ? "onedrive-mount-directory"
              : step.kind === "ssh-server"
                ? "enable-ssh-server"
                : step.path,
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
  if (json) print(result, true);
  else
    for (const [key, value] of Object.entries(result))
      say(
        `${key} · ${typeof value === "boolean" ? (value ? "Ready" : "Unavailable") : (value ?? "Unavailable")}`,
        value === true
          ? "success"
          : value === false || value === null
            ? "pending"
            : "action",
      );
}

async function browser(url: string, id: string, app: boolean): Promise<void> {
  const tenant = tenantById(await settings(), id);
  const directory = join(data, "snshah/edge", tenant.id);
  launch([
    "microsoft-edge-stable",
    `--user-data-dir=${directory}`,
    app ? `--app=${url}` : url,
  ]);
}

async function openApp(app: PersonalApp): Promise<void> {
  switch (app) {
    case "gmail":
    case "voice":
    case "cloudflare":
    case "unifi":
    case "whatsapp":
    case "discord": {
      const entry = await enabledLauncher(everyday[app].entries);
      if (entry && available("gtk-launch")) launch(["gtk-launch", entry]);
      else launch(["omarchy-launch-webapp", everyday[app].url]);
      return;
    }
    case "spotify": {
      const entry = await enabledLauncher([
        "Spotify",
        "spotify",
        "com.spotify.Client",
      ]);
      if (entry && available("gtk-launch")) launch(["gtk-launch", entry]);
      else launch(["omarchy-launch-spotify"]);
      return;
    }
    case "hints":
      await signInHints();
      return;
    case "dot":
      launch(["omarchy-launch-webapp", "https://chatgpt.com/dots"]);
      return;
    case "herdr":
      if (available("herdr-app")) launch(["herdr-app"]);
      else launch(["omarchy-launch-terminal", "herdr"]);
      return;
    case "menu": {
      const current = await settings();
      const actions = new Map<string, Command>([
        [`Gmail · ${current.personal}`, { kind: "open", app: "gmail" }],
        ...everydayIds
          .filter((id) => id !== "gmail")
          .map((id): [string, Command] => [
            everyday[id].name,
            { kind: "open", app: id },
          ]),
        ["Spotify", { kind: "open", app: "spotify" }],
        ["ChatGPT Dot", { kind: "open", app: "dot" }],
        ["Herdr", { kind: "open", app: "herdr" }],
      ]);
      for (const { id, label: tenantLabel } of current.work) {
        for (const [label, app] of [
          ["Outlook", "outlook"],
          ["Calendar", "calendar"],
          ["Teams", "teams"],
          ["OneDrive", "onedrive"],
        ] as const)
          actions.set(`${tenantLabel} · ${label}`, {
            kind: "work",
            tenant: id,
            app,
          });
      }
      let selected: string;
      if (available("omarchy-menu-select") && !process.stdin.isTTY) {
        const child = Bun.spawn(
          ["omarchy-menu-select", "Workshop accounts", ...actions.keys()],
          { stdin: "inherit", stdout: "pipe", stderr: "inherit" },
        );
        const [selection, code] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        if (code === 130 || code === 1) return;
        if (code !== 0)
          throw new Error(`Omarchy menu exited with status ${code}`);
        selected = selection.trimEnd();
      } else {
        if (!process.stdin.isTTY)
          throw new Error("Open the account picker in a terminal.");
        const { select, isCancel } = await cliPrompts();
        const selection = await select({
          message: "🚀  Open an app or account",
          options: [...actions.keys()].map((value) => ({
            value,
            label: value,
          })),
        });
        if (isCancel(selection)) return;
        selected = selection;
      }
      const action = actions.get(selected);
      if (!action) throw new Error("The launcher returned an unknown action.");
      await execute(action);
    }
  }
}

async function runAgent(agent: Agent, directory: string): Promise<void> {
  if (!(await stat(directory)).isDirectory())
    throw new Error(`Expected a workspace directory: ${directory}`);
  if (agent !== "local") {
    await run([agent], { cwd: directory, env: await secretEnvironment(agent) });
    return;
  }
  const localConfig = join(profileDir, "opencode.auto.json");
  if (!(await exists(localConfig)))
    throw new Error("Set up the local agent with snshah apply --local-ai.");
  const child = Bun.spawn(["opencode"], {
    cwd: directory,
    env: { ...(await secretEnvironment(agent)), OPENCODE_CONFIG: localConfig },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

async function drive(
  action: "list" | "mount" | "connect" | "folder",
  id: string,
): Promise<void> {
  const current = await settings();
  if (id !== "personal") tenantById(current, id);
  const env = await secretEnvironment("drive", current);
  const entry = driveStatus(current, env).find(
    (candidate) => candidate.id === id,
  );
  if (!entry)
    throw new Error(
      "Set the tenant’s files.kind to rclone before using its mount.",
    );
  switch (action) {
    case "connect":
      say(
        `Create or reconnect the OneDrive remote named ${entry.remote.slice(0, -1)}, then run snshah drive mount ${id}.`,
      );
      await run(["rclone", "config"], { env });
      return;
    case "folder":
      if (entry.state !== "mounted")
        throw new Error(
          "Mount this OneDrive account before opening its folder.",
        );
      launch(["xdg-open", entry.path]);
      return;
    case "mount":
      await mountDrive(entry, env);
      if (interactiveOutput)
        say(`OneDrive mounted at ${entry.path}`, "success");
      return;
    case "list":
      if (entry.state === "needs-sign-in")
        throw new Error("Connect this OneDrive account before listing files.");
      await run(["rclone", "lsf", entry.remote], { env });
  }
}

const vaultStaging = join(home, "OneDrive/Vault-Staging");
const vaultMagic = "SNSHAH-CONFIG-1\n";
const backupStamp = join(assetDir, "vault.auto.sha256");

async function archives(): Promise<string[]> {
  if (!(await exists(vaultStaging))) return [];
  return (await readdir(vaultStaging, { withFileTypes: true }))
    .filter(
      (file) => file.isFile() && /^snshah-config-.*\.ts\.age$/.test(file.name),
    )
    .map((file) => join(vaultStaging, file.name))
    .sort()
    .reverse();
}
function digest(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

async function vault(action: "status" | "backup"): Promise<void> {
  if (action === "status") {
    const text = (await exists(conf)) ? await privateConfigBytes() : undefined;
    const backedUp =
      text !== undefined && digest(text) === (await read(backupStamp));
    const snapshots = await archives();
    if (!interactiveOutput)
      print(
        { config: conf, staging: vaultStaging, backedUp, archives: snapshots },
        true,
      );
    else {
      say(
        backedUp ? "Vault backup is up to date." : "Vault backup is due.",
        backedUp ? "success" : "pending",
      );
      for (const snapshot of snapshots) say(snapshot);
    }
    return;
  }
  const text = await privateConfigBytes();
  await interpretConfig(text);
  await mkdir(vaultStaging, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(vaultStaging, ".snshah.auto.vault-"));
  try {
    const encrypted = join(temporary, "backup.auto.age");
    const child = Bun.spawn(["age", "-p", "-o", encrypted], {
      stdin: new Blob([vaultMagic, text]),
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) throw new Error("Vault encryption failed.");
    await chmod(encrypted, 0o600);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(vaultStaging, `snshah-config-${stamp}.ts.age`);
    await rename(encrypted, destination);
    await atomicFile(backupStamp, digest(text), 0o600);
    say(destination, "success");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function restore(
  command: Extract<Command, { kind: "restore" | "verify" }>,
): Promise<void> {
  const source = command.archive
    ? resolve(command.archive)
    : (await archives())[0];
  if (!source) throw new Error("Supply a single-config vault snapshot.");
  const existing = (await exists(conf))
    ? await privateConfigBytes()
    : undefined;
  if (
    command.kind === "restore" &&
    existing !== undefined &&
    !command.overwrite
  )
    throw new Error(
      "Config already exists. Verify the snapshot and use --overwrite to replace it.",
    );
  const child = Bun.spawn(["age", "-d", "--", source], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
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
  if ((await child.exited) !== 0) throw new Error("Vault decryption failed.");
  const bytes = Buffer.concat(fragments).toString("utf8");
  if (!bytes.startsWith(vaultMagic))
    throw new Error("Snapshot must contain exactly one Workshop config.");
  const text = bytes.slice(vaultMagic.length);
  // Treat restored TypeScript as code. Verify syntax without evaluating it.
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(text);
  } catch {
    throw new Error("Snapshot contains invalid TypeScript.");
  }
  if (command.kind === "verify") {
    say(
      "Snapshot format and TypeScript syntax verified. Review its code before loading.",
      "success",
    );
    return;
  }
  if (
    (await exists(conf))
      ? existing === undefined || (await privateConfigBytes()) !== existing
      : existing !== undefined
  )
    throw new Error("Config changed during restore.");
  await atomicFile(conf, formatGeneratedConfig(conf, text), 0o600);
  say(
    "Config restored. Review its code before running snshah config check.",
    "success",
  );
}

type MenuArgs =
  | [
      kind:
        | "help"
        | "update"
        | "plan"
        | "apply"
        | "doctor"
        | "workspace"
        | "context"
        | "shell"
        | "menu",
    ]
  | ["plan" | "apply" | "doctor", "--json"]
  | ["status", "--details"]
  | ["test", ...([] | ["--published"])]
  | ["open", PersonalApp]
  | ["open", string, WorkApp]
  | ["agent", Agent]
  | ["drive", "list" | "mount" | "connect" | "folder", string]
  | ["config", "edit" | "check" | "setup" | "set-secret"]
  | ["vault", "status" | "backup" | "verify" | "restore"]
  | ["ssh", "enroll" | "devices" | "revoke"]
  | ["plugin", "install" | "remove" | "toggle"];
type MenuAction = {
  id: string;
  label: string;
  args: MenuArgs;
  terminal?: true;
};
type MenuSection = { id: string; label: string; actions: MenuAction[] };

function driveActions(id: string): MenuAction[] {
  return [
    {
      id: "folder",
      label: "Open mounted folder",
      args: ["drive", "folder", id],
    },
    {
      id: "list",
      label: "List OneDrive files",
      args: ["drive", "list", id],
      terminal: true,
    },
    {
      id: "mount",
      label: "Mount OneDrive read-only",
      args: ["drive", "mount", id],
      terminal: true,
    },
    {
      id: "connect",
      label: "Connect OneDrive",
      args: ["drive", "connect", id],
      terminal: true,
    },
  ];
}
function menuSections(work: readonly Tenant[]): MenuSection[] {
  return [
    {
      id: "open",
      label: "Open",
      actions: [
        ...everydayIds.map((app): MenuAction => ({
          id: app,
          label: everyday[app].name,
          args: ["open", app],
        })),
        { id: "spotify", label: "Spotify", args: ["open", "spotify"] },
        {
          id: "hints",
          label: "Show private sign-in hints",
          args: ["open", "hints"],
          terminal: true,
        },
        { id: "dot", label: "ChatGPT Dot", args: ["open", "dot"] },
        { id: "herdr", label: "Herdr", args: ["open", "herdr"] },
        { id: "chooser", label: "Accounts by name", args: ["open", "menu"] },
      ],
    },
    {
      id: "drive",
      label: "Personal OneDrive",
      actions: driveActions("personal"),
    },
    ...work.map(({ id, files }, index): MenuSection => ({
      id: `tenant-${id}`,
      label: `Tenant ${index + 1}`,
      actions: [
        ...workApps.map((app): MenuAction => ({
          id: app,
          label: {
            browser: "Edge browser",
            outlook: "Outlook",
            calendar: "Calendar",
            teams: "Teams",
            onedrive: "OneDrive on the web",
          }[app],
          args: ["open", id, app],
        })),
        ...(files.kind === "rclone" ? driveActions(id) : []),
      ],
    })),
    {
      id: "agents",
      label: "Agents",
      actions: [
        ...agents.map((agent): MenuAction => ({
          id: agent,
          label: {
            claude: "Claude Code",
            codex: "Codex",
            local: "Local OpenCode",
          }[agent],
          args: ["agent", agent],
          terminal: true,
        })),
      ],
    },
    {
      id: "config",
      label: "Configuration",
      actions: [
        { id: "edit", label: "Edit in VS Code", args: ["config", "edit"] },
        {
          id: "check",
          label: "Check configuration",
          args: ["config", "check"],
          terminal: true,
        },
        {
          id: "setup",
          label: "Name my profiles",
          args: ["config", "setup"],
          terminal: true,
        },
        {
          id: "secret",
          label: "Set a declared secret",
          args: ["config", "set-secret"],
          terminal: true,
        },
        {
          id: "shell",
          label: "Shell integration",
          args: ["shell"],
          terminal: true,
        },
      ],
    },
    {
      id: "remote",
      label: "Remote Access",
      actions: [
        {
          id: "enroll",
          label: "Enroll a device",
          args: ["ssh", "enroll"],
          terminal: true,
        },
        {
          id: "devices",
          label: "List enrolled devices",
          args: ["ssh", "devices"],
          terminal: true,
        },
        {
          id: "revoke",
          label: "Revoke a device",
          args: ["ssh", "revoke"],
          terminal: true,
        },
      ],
    },
    {
      id: "setup",
      label: "Setup & Diagnostics",
      actions: [
        {
          id: "update",
          label: "📦 Update Workshop",
          args: ["update"],
          terminal: true,
        },
        {
          id: "plan",
          label: "Preview changes",
          args: ["plan"],
          terminal: true,
        },
        {
          id: "planjson",
          label: "Preview changes (JSON)",
          args: ["plan", "--json"],
          terminal: true,
        },
        {
          id: "apply",
          label: "Apply changes",
          args: ["apply"],
          terminal: true,
        },
        {
          id: "applyjson",
          label: "Apply changes (JSON)",
          args: ["apply", "--json"],
          terminal: true,
        },
        {
          id: "doctor",
          label: "Diagnostics",
          args: ["doctor"],
          terminal: true,
        },
        {
          id: "status",
          label: "Workshop status",
          args: ["status", "--details"],
          terminal: true,
        },
        {
          id: "json",
          label: "Diagnostics (JSON)",
          args: ["doctor", "--json"],
          terminal: true,
        },
        {
          id: "workspace",
          label: "Workspace path",
          args: ["workspace"],
          terminal: true,
        },
        {
          id: "context",
          label: "Shell context",
          args: ["context"],
          terminal: true,
        },
        { id: "test", label: "Self-test", args: ["test"], terminal: true },
        {
          id: "published",
          label: "Test published installer",
          args: ["test", "--published"],
          terminal: true,
        },
        {
          id: "help",
          label: "CLI help & flags",
          args: ["help"],
          terminal: true,
        },
      ],
    },
    {
      id: "vault",
      label: "Vault",
      actions: [
        {
          id: "status",
          label: "Backup status",
          args: ["vault", "status"],
          terminal: true,
        },
        {
          id: "backup",
          label: "Back up now",
          args: ["vault", "backup"],
          terminal: true,
        },
        {
          id: "verify",
          label: "Verify snapshot",
          args: ["vault", "verify"],
          terminal: true,
        },
        {
          id: "restore",
          label: "Restore snapshot",
          args: ["vault", "restore"],
          terminal: true,
        },
      ],
    },
    {
      id: "plugin",
      label: "Plugin",
      actions: [
        {
          id: "install",
          label: "Install or refresh bar shortcut",
          args: ["plugin", "install"],
          terminal: true,
        },
        {
          id: "toggle",
          label: "Open Workshop menu",
          args: ["plugin", "toggle"],
        },
        {
          id: "remove",
          label: "Remove bar shortcut",
          args: ["plugin", "remove"],
          terminal: true,
        },
      ],
    },
  ];
}
const menuStart = "  // >>> snshah menu >>>";
const menuEnd = "  // <<< snshah menu <<<";
async function menuContent(work: readonly Tenant[]): Promise<string> {
  const source = (await read(menuPath)) ?? "{\n}\n";
  const open = source.indexOf("{");
  if (open < 0 || !source.trimEnd().endsWith("}"))
    throw new Error("Expected an Omarchy menu JSONC object.");
  const rows: Record<
    string,
    { label: string; icon?: string; action?: string }
  > = {
    [menuId]: { label: product, icon: "󰆍" },
  };
  for (const section of menuSections(work)) {
    rows[`${menuId}.${section.id}`] = { label: section.label };
    for (const action of section.actions) {
      const id = `${section.id}.${action.id}`;
      rows[`${menuId}.${id}`] = {
        label: action.label,
        action: `${shellQuote(bin)} menu run ${id}`,
      };
    }
  }
  const entries = Object.entries(rows).map(
    ([key, row]) => `  ${JSON.stringify(key)}: ${JSON.stringify(row)},`,
  );
  const block = [menuStart, ...entries, menuEnd].join("\n");
  if (source.includes(menuStart) || source.includes(menuEnd))
    return upsertBlock(source, menuStart, menuEnd, block);
  return (
    source.slice(0, open + 1) +
    "\n" +
    block +
    "\n" +
    source.slice(open + 1).replace(/^\r?\n/, "")
  );
}

async function menu(
  command: Extract<Command, { kind: "menu" }>,
): Promise<void> {
  if (!command.id) {
    await run(["omarchy", "menu", "summon", menuId]);
    return;
  }
  const action = menuSections((await settings()).work)
    .flatMap((section) =>
      section.actions.map((item) => ({
        ...item,
        id: `${section.id}.${item.id}`,
      })),
    )
    .find((item) => item.id === command.id);
  if (!action) throw new Error("Unknown Workshop menu action.");
  if (action.terminal && !command.terminal) {
    launch([
      "omarchy-launch-terminal",
      bin,
      "menu",
      "run",
      action.id,
      "--terminal",
    ]);
    return;
  }
  const argv: string[] = [...action.args];
  if (command.id === "config.shell") {
    console.log(
      'Load the aliases and exports in your current shell with eval "$(snshah shell)".',
    );
  } else {
    if (argv[0] === "agent") {
      const directory = await promptInput(
        "Workspace directory (blank for the current directory)",
      );
      if (directory) argv.push(directory);
    }
    if (command.id === "config.secret")
      argv.push(await promptInput("Declared environment variable name"));
    if (command.id === "setup.apply" || command.id === "setup.applyjson") {
      await dispatchCli(["plan"]);
      if (!(await confirm("Apply these changes?"))) return;
    }
    if (command.id === "vault.verify" || command.id === "vault.restore") {
      const archive = await promptInput("Snapshot path (blank for the latest)");
      if (archive) argv.push(archive);
      if (command.id === "vault.restore" && (await exists(conf))) {
        if (!(await confirm("Back up the current config before replacing it?")))
          return;
        await vault("backup");
        argv.push("--overwrite");
      }
    }
    if (
      command.id === "plugin.remove" &&
      !(await confirm("Remove the Workshop bar shortcut?"))
    )
      return;
    await dispatchCli(argv);
  }
  if (action.terminal && process.stdin.isTTY)
    await promptInput("Press Enter to close").catch(() => {});
}
async function confirm(title: string): Promise<boolean> {
  if (!process.stdin.isTTY)
    throw new Error("Open this confirmation in a terminal.");
  const { confirm, isCancel } = await cliPrompts();
  const answer = await confirm({
    message: `🛠️  ${title}`,
    initialValue: false,
  });
  return !isCancel(answer) && answer === true;
}

async function configure(action: "edit" | "check" | "setup"): Promise<void> {
  if (action === "edit") return editConfig();
  const previous = await privateConfigBytes();
  const current = await interpretConfig(previous);
  if (action === "check") {
    say("Workshop config is valid.", "success");
    return;
  }
  const personal = await promptInput("Personal profile display name");
  if (personal) current.personal = personal;
  for (const tenant of current.work) {
    const label = await promptInput(
      `Display name for ${tenant.id} (blank keeps its name)`,
    );
    if (label) tenant.label = label;
  }
  validateConfig(current);
  if (
    !(await confirm(
      "Replace the config with these settings? Comments and custom expressions will be regenerated.",
    ))
  )
    return;
  if ((await privateConfigBytes()) !== previous)
    throw new Error("Config changed during setup.");
  await atomicFile(conf, configSource(current), 0o600);
  await atomicFile(menuPath, await menuContent((await settings()).work));
  await notify(
    "Profile names updated. Back up the Workshop config.",
    true,
  ).catch(() => {});
}

async function plugin(action: "install" | "remove" | "toggle"): Promise<void> {
  if (config !== join(home, ".config"))
    throw new Error(
      "Omarchy plugin management requires the default XDG_CONFIG_HOME.",
    );
  switch (action) {
    case "install":
      for (const [name, content] of Object.entries(pluginFiles))
        await atomicFile(join(pluginDir, name), content);
      await run(["omarchy", "plugin", "validate", pluginDir]);
      await atomicFile(menuPath, await menuContent((await settings()).work));
      await run(["omarchy-shell", "shell", "rescanPlugins"]);
      await run([
        "omarchy",
        "plugin",
        "enable",
        pluginId,
        "--section",
        "right",
      ]);
      return;
    case "remove":
      if (await exists(pluginDir))
        await run(["omarchy", "plugin", "remove", pluginId, "--yes"]);
      return;
    case "toggle":
      await run(["omarchy", "menu", "summon", menuId]);
  }
}

const enrolledKeyMarker = "snshah-enrolled:";
const enrollmentAlphabet = "ACDEFHJKMNPRTUVWXY23479";

function newEnrollmentCode(): string {
  return Array.from(
    { length: 4 },
    () => enrollmentAlphabet[randomInt(enrollmentAlphabet.length)],
  ).join("");
}
const sshDeviceName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/;
const workshopKeyPath = "$HOME/.ssh/id_ed25519_workshop";

function sshFingerprint(blob: Uint8Array): string {
  return (
    "SHA256:" +
    createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")
  );
}

function parseEnrollmentKey(line: string): {
  key: string;
  fingerprint: string;
} {
  const [, key] =
    /^ssh-ed25519[ \t]+([A-Za-z0-9+/]{68})(?:[ \t]+[^\r\n]*)?$/.exec(
      line.trim(),
    ) ?? [];
  const blob = Buffer.from(key ?? "", "base64");
  const header = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
  if (blob.length !== 51 || !blob.subarray(0, header.length).equals(header))
    throw new Error("Paste one valid ssh-ed25519 public key.");
  return { key, fingerprint: sshFingerprint(blob) };
}

function enrolledDevice(line: string) {
  const [type, key, marker, extra] = line.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !marker?.startsWith(enrolledKeyMarker) || extra)
    return undefined;
  const name = marker.slice(enrolledKeyMarker.length);
  if (!sshDeviceName.test(name)) return undefined;
  try {
    return { name, ...parseEnrollmentKey(`${type} ${key}`) };
  } catch {
    return undefined;
  }
}

async function readAuthorizedKeys(directory: string): Promise<string> {
  const path = join(directory, "authorized_keys");
  try {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid!() ||
      info.mode & 0o022
    )
      throw new Error(
        "Expected a user-owned ~/.ssh directory without group or other write access.",
      );
    const file = await openFile(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid!())
        throw new Error("Expected a user-owned regular authorized_keys file.");
      return await file.readFile("latin1");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function editAuthorizedKeys(
  directory: string,
  edit: (original: string) => string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await readAuthorizedKeys(directory);
  const lock = join(directory, ".snshah-enrollment.auto.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `SSH key changes are locked at ${lock}. If the previous command stopped, remove that empty directory.`,
      );
    throw error;
  }
  try {
    const original = await readAuthorizedKeys(directory);
    const updated = edit(original);
    if ((await readAuthorizedKeys(directory)) !== original)
      throw new Error("authorized_keys changed during enrollment. Try again.");
    await atomicFile(
      join(directory, "authorized_keys"),
      Buffer.from(updated, "latin1"),
      0o600,
    );
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function authorizeDevice(
  directory: string,
  name: string,
  key: string,
): Promise<void> {
  return editAuthorizedKeys(directory, (original) => {
    const lines = original.split("\n");
    if (
      lines.some(
        (line) =>
          !line.trimStart().startsWith("#") &&
          line.trim().split(/\s+/).includes(key),
      )
    )
      throw new Error("This key is already in authorized_keys.");
    if (lines.some((line) => enrolledDevice(line)?.name === name))
      throw new Error("This device name is already enrolled.");
    const separator = original && !original.endsWith("\n") ? "\n" : "";
    return `${original}${separator}ssh-ed25519 ${key} ${enrolledKeyMarker}${name}\n`;
  });
}

function revokeDevice(directory: string, name: string): Promise<void> {
  return editAuthorizedKeys(directory, (original) => {
    const updated = original
      .split(/(?<=\n)/)
      .filter((line) => enrolledDevice(line)?.name !== name)
      .join("");
    if (updated === original)
      throw new Error("No enrolled device has that name.");
    return updated;
  });
}

async function enrollmentInput(
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await terminal.question(question, { signal })).trim();
  } finally {
    terminal.close();
  }
}

async function chooseEnrollmentAddress() {
  const choices = Object.entries(networkInterfaces()).flatMap(
    ([name, addresses]) =>
      (addresses ?? [])
        .filter(
          (address) =>
            address.family === "IPv4" && !address.internal && address.cidr,
        )
        .map((address) => ({ name, ...address })),
  );
  if (!choices.length) throw new Error("No LAN IPv4 address found.");
  const { select, isCancel } = await cliPrompts();
  const choice = await select({
    message: "🔑  Select the LAN address for SSH enrollment",
    options: choices.map((address, value) => ({
      value,
      label: `${address.name}  ${address.cidr}`,
    })),
  });
  return isCancel(choice) ? undefined : choices[choice];
}

function enrollmentSubnet(cidr: string): {
  cidr: string;
  contains: (address: string) => boolean;
} {
  const [address, prefix] = cidr.split("/");
  const ipv4 = (ip: string) =>
    ip
      .split(".")
      .reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
  const mask =
    Number(prefix) === 0 ? 0 : (0xffffffff << (32 - Number(prefix))) >>> 0;
  const network = (ipv4(address) & mask) >>> 0;
  const networkAddress = [24, 16, 8, 0]
    .map((shift) => (network >>> shift) & 255)
    .join(".");
  return {
    cidr: `${networkAddress}/${prefix}`,
    contains: (ip) => isIPv4(ip) && (ipv4(ip) & mask) >>> 0 === network,
  };
}

async function enrollmentFirewall(
  address: string,
  subnet: string,
  port: number,
): Promise<() => Promise<void>> {
  const ufw = Bun.which("ufw");
  if (!ufw) return async () => {};
  const command = ["sudo", "env", "LC_ALL=C", ufw];
  const status = Bun.spawn([...command, "status"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(status.stdout).text();
  if ((await status.exited) !== 0)
    throw new Error("Could not check the UFW firewall.");
  if (!output.startsWith("Status: active")) return async () => {};
  const rule = [
    "allow",
    "proto",
    "tcp",
    "from",
    subnet,
    "to",
    address,
    "port",
    String(port),
  ];
  const cleanup = async () => {
    try {
      await run([...command, "--force", "delete", ...rule]);
    } catch {
      throw new Error(
        `Remove the temporary rule with sudo ufw delete ${rule.join(" ")}`,
      );
    }
  };
  try {
    await run([...command, ...rule, "comment", "snshah enrollment"]);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}

const enrollmentClipboard = {
  "1": `Get-Content "${workshopKeyPath}.pub" | Set-Clipboard`,
  "2": `pbcopy < "${workshopKeyPath}.pub"`,
  "3": `cat "${workshopKeyPath}.pub"`,
} as const;

function enrollmentLines(onLine: (line: string) => void, onCancel: () => void) {
  let line = "";
  return (data: Buffer) => {
    for (const byte of data) {
      if (byte === 3 || byte === 4) return onCancel();
      if (byte === 13 || byte === 10) {
        if (line) onLine(line);
        line = "";
      } else if (byte === 127 || byte === 8) {
        line = line.slice(0, -1);
      } else if (line.length >= 2048) {
        return onCancel();
      } else {
        line += String.fromCharCode(byte);
      }
    }
  };
}

// The pinned SSH module is loaded at runtime. Describe only the server methods used here.
type EnrollmentChannel = Duplex & { exit: (status: number) => void };
interface EnrollmentSession {
  on(event: "pty", handler: (accept?: () => void) => void): void;
  once(
    event: "shell",
    handler: (accept: () => EnrollmentChannel) => void,
  ): void;
}
interface EnrollmentClient {
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close" | "ready", handler: () => void): void;
  on(
    event: "authentication",
    handler: (context: {
      method: string;
      username: string;
      password?: string;
      accept: () => void;
      reject: (methods: string[]) => void;
    }) => void,
  ): void;
  once(
    event: "session",
    handler: (accept: () => EnrollmentSession) => void,
  ): void;
}

function enrollmentHost(address: string, name = hostname()): string {
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(name)
    ? name
    : address;
}

function enrollmentSshCommands(
  executable: string,
  account: string,
  host: string,
  address: string,
): string {
  const primary = `${executable} ${account}@${host}`;
  return host === address
    ? primary
    : `${primary}\nIf the hostname does not resolve: ${executable} ${account}@${address}`;
}

async function enrollSshDevice(directory: string): Promise<void> {
  if (process.getuid!() === 0 || !process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Open enrollment from a regular user's local terminal.");
  const dependency = "ssh2@1.17.0";
  const { Server, utils } = (
    await import(dependency).catch((error) => {
      throw new Error(
        `Could not load ${dependency}: ${errorMessage(error)}. Check Bun's package resolution and access to the npm registry.`,
      );
    })
  ).default;
  const choice = await chooseEnrollmentAddress();
  if (!choice) return;
  const hostKey = utils.generateKeyPairSync("rsa", { bits: 3072 });
  const publicHostKey = utils.parseKey(hostKey.public);
  if (publicHostKey instanceof Error) throw publicHostKey;
  const subnet = enrollmentSubnet(choice.cidr!);
  const host = enrollmentHost(choice.address);
  const code = Buffer.from(newEnrollmentCode());
  const account = userInfo().username;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Enrollment canceled."));
  const sockets = new Set<Socket>();
  const result = Promise.withResolvers<void>();
  // A failure can arrive while the firewall command is still running.
  void result.promise.catch(() => {});
  let codeUsed = false;
  let accepting = false;
  let failures = 0;
  let connections = 0;
  let approval: Promise<void> | undefined;
  let cleanupFirewall: (() => Promise<void>) | undefined;
  const abort = () => result.reject(controller.signal.reason);
  const server = new Server(
    { hostKeys: [hostKey.private] },
    (client: EnrollmentClient, info: { ip: string; port: number }) => {
      let authenticated = false;
      client.on("error", (error: Error) => {
        if (authenticated) result.reject(error);
      });
      client.on("close", () => {
        if (authenticated)
          result.reject(new Error("Enrollment client disconnected."));
      });
      client.on("authentication", (context) => {
        const password = Buffer.from(
          context.method === "password"
            ? (context.password ?? "").toUpperCase()
            : "",
        );
        if (
          !codeUsed &&
          context.username === "enroll" &&
          password.length === code.length &&
          timingSafeEqual(password, code)
        ) {
          codeUsed = true;
          authenticated = true;
          for (const socket of sockets) {
            if (
              socket.remoteAddress === info.ip &&
              socket.remotePort === info.port
            )
              socket.setTimeout(0);
            else socket.destroy();
          }
          context.accept();
          listener.close();
          return;
        }
        context.reject(["password"]);
        if (context.method === "password" && ++failures >= 5)
          result.reject(
            new Error("Too many enrollment authentication attempts."),
          );
      });
      client.on("ready", () => {
        client.once("session", (accept) => {
          const session = accept();
          session.on("pty", (allow) => allow?.());
          session.once("shell", (openShell) => {
            const stream = openShell();
            stream.on("error", (error: Error) => result.reject(error));
            stream.on("end", () =>
              result.reject(new Error("Enrollment client disconnected.")),
            );
            let osSelected = false;
            const send = (message: string) =>
              stream.write(message.replaceAll("\n", "\r\n"));
            stream.on(
              "data",
              enrollmentLines(
                (line) => {
                  if (approval) return;
                  if (!osSelected) {
                    if (!member(["1", "2", "3"], line)) {
                      send("\nChoose 1, 2, or 3: ");
                      return;
                    }
                    osSelected = true;
                    send(
                      `\nIn another local terminal, reuse an Ed25519 key or create one:\n  ssh-keygen -t ed25519 -f "${workshopKeyPath}"\n` +
                        `Copy or display the public key with:\n  ${enrollmentClipboard[line]}\nPaste the single ssh-ed25519 line here and press Enter:\n`,
                    );
                    return;
                  }
                  let submitted: ReturnType<typeof parseEnrollmentKey>;
                  try {
                    submitted = parseEnrollmentKey(line);
                  } catch {
                    send("\nPaste one valid ssh-ed25519 public key: ");
                    return;
                  }
                  // Echo the validated key fields so a pasted comment cannot control the terminal.
                  send(
                    `\nPublic key received:\n  ssh-ed25519 ${submitted.key}\nFingerprint: ${submitted.fingerprint}\n\n` +
                      `Go back to the Workshop PC (${host}). Match the fingerprint, then enter a device name such as travel-laptop to approve.\n` +
                      "This terminal will show the result.\n",
                  );
                  approval = (async () => {
                    say(
                      `Request from ${info.ip} for ${account}. Public key: ${submitted.fingerprint}`,
                      "pending",
                    );
                    const name = await enrollmentInput(
                      "Enter a device name (for example, travel-laptop) to approve, or press Enter to deny: ",
                      controller.signal,
                    );
                    controller.signal.throwIfAborted();
                    if (stream.destroyed || stream.readableEnded)
                      throw new Error("Enrollment client disconnected.");
                    if (!name) {
                      send("\nEnrollment denied.\n");
                      stream.exit(1);
                    } else {
                      if (!sshDeviceName.test(name))
                        throw new Error(
                          "Use 1–40 letters, digits, underscores, dots, or hyphens.",
                        );
                      await authorizeDevice(directory, name, submitted.key);
                      clearTimeout(timeout);
                      if (!regularSshRunning()) {
                        send(
                          "\nKey saved. Starting regular key-only SSH on the Workshop PC.\n",
                        );
                        say("Starting regular key-only SSH.");
                        try {
                          await enableRegularSsh();
                        } catch (error) {
                          const retry = `Run snshah ssh enable on the Workshop PC, then reconnect.`;
                          send(
                            `\nThe key is enrolled. Regular SSH setup could not finish. ${retry}\n`,
                          );
                          stream.exit(1);
                          stream.end();
                          await Bun.sleep(150);
                          throw new Error(
                            `The key is enrolled. ${retry} ${errorMessage(error)}`,
                          );
                        }
                      }
                      say(
                        `Enrolled ${name}. Normal SSH account: ${account}@${host}`,
                        "success",
                      );
                      send(
                        "\nApproved. Verify the normal SSH host fingerprint on first connection.\n" +
                          enrollmentSshCommands(
                            `ssh -o IdentitiesOnly=yes -i "${workshopKeyPath}"`,
                            account,
                            host,
                            choice.address,
                          ) +
                          "\nIf you reused a key, substitute its private key path.\n",
                      );
                      stream.exit(0);
                    }
                    stream.end();
                  })();
                  void approval.then(
                    () => result.resolve(),
                    (error) => result.reject(error),
                  );
                },
                () =>
                  result.reject(
                    new Error("Enrollment canceled by the client."),
                  ),
              ),
            );
            send(
              "\nSSH key enrollment\n1. Windows PowerShell\n2. macOS\n3. Linux / WSL\nChoose 1, 2, or 3: ",
            );
          });
        });
      });
    },
  );
  const listener = createServer((socket) => {
    if (
      !accepting ||
      codeUsed ||
      sockets.size >= 4 ||
      !subnet.contains(socket.remoteAddress ?? "")
    ) {
      socket.destroy();
      return;
    }
    if (++connections > 12) {
      socket.destroy();
      result.reject(new Error("Too many enrollment connections."));
      return;
    }
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(60_000, () => socket.destroy());
    server.injectSocket(socket);
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  controller.signal.addEventListener("abort", abort, { once: true });
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, choice.address, resolve);
    });
    const port = (listener.address() as AddressInfo).port;
    cleanupFirewall = await enrollmentFirewall(
      choice.address,
      subnet.cidr,
      port,
    );
    controller.signal.throwIfAborted();
    timeout = setTimeout(
      () => controller.abort(new Error("Enrollment expired.")),
      300_000,
    );
    accepting = true;
    say(
      `On the new PC, run: ${enrollmentSshCommands(`ssh -p ${port}`, "enroll", host, choice.address)}`,
    );
    say(
      `Verify this enrollment host fingerprint: ${sshFingerprint(publicHostKey.getPublicSSH())}`,
    );
    say(
      `One-time code: ${code.toString()}\nWaiting up to five minutes. Press Ctrl+C to cancel.`,
      "pending",
    );
    await result.promise;
    // Give the client a chance to receive the exit message before closing its socket.
    await Bun.sleep(150);
  } finally {
    controller.abort();
    await approval?.catch(() => {});
    clearTimeout(timeout);
    listener.close();
    for (const socket of sockets) socket.destroy();
    try {
      await cleanupFirewall?.();
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
}

const workshopSshPolicyPath =
  "/etc/ssh/sshd_config.d/05-workshop-key-only.conf";
const workshopSshPolicy = [
  "# Workshop defaults. Enroll a device to authorize its SSH key.",
  "PubkeyAuthentication yes",
  "AuthenticationMethods publickey",
  "PasswordAuthentication no",
  "KbdInteractiveAuthentication no",
  "PermitRootLogin no",
].join("\n");

function regularSshRunning(): boolean {
  return ["sshd.service", "sshd.socket"].some(
    (unit) => capture(["systemctl", "is-active", unit]) === "active",
  );
}

function regularSshReady(): boolean {
  return (
    regularSshRunning() &&
    capture(["systemctl", "is-enabled", "sshd.service"]) === "enabled" &&
    capture(["cat", workshopSshPolicyPath]) === workshopSshPolicy
  );
}

async function enableRegularSsh(quiet = false): Promise<void> {
  if (!available("sshd"))
    await run(["omarchy", "pkg", "add", "openssh"], { quiet });
  await run(["sudo", "ssh-keygen", "-A"], { quiet });

  const previous = capture(["cat", workshopSshPolicyPath]);
  if (previous !== undefined && previous !== workshopSshPolicy)
    throw new Error(
      `Review the existing SSH policy at ${workshopSshPolicyPath} before enabling Workshop SSH.`,
    );

  const scratch = await mkdtemp(join(tmpdir(), "workshop.auto.sshd-"));
  const source = join(scratch, "sshd_config");
  let created = false;
  let validated = false;
  try {
    if (previous === undefined) {
      await writeFile(source, workshopSshPolicy + "\n", { mode: 0o600 });
      await run(["sudo", "install", "-Dm644", source, workshopSshPolicyPath], {
        quiet,
      });
      created = true;
    }

    await run(["sudo", "sshd", "-t"], { quiet });
    const effective = (await commandOutput(["sudo", "sshd", "-T"]))
      .split("\n")
      .map((line) => line.replace(/^\S+/, (option) => option.toLowerCase()));
    const required = [
      "port 22",
      "pubkeyauthentication yes",
      "authenticationmethods publickey",
      "passwordauthentication no",
      "kbdinteractiveauthentication no",
      "permitrootlogin no",
    ];
    if (
      !required.every((setting) => effective.includes(setting)) ||
      !effective.some(
        (line) =>
          line.startsWith("authorizedkeysfile ") &&
          line.split(/\s+/).includes(".ssh/authorized_keys"),
      )
    )
      throw new Error(
        "OpenSSH did not load the Workshop port, key file, and key-only settings. Check sshd_config and its drop-ins.",
      );

    validated = true;
    if (available("ufw")) {
      await run(["sudo", "ufw", "limit", "22/tcp", "comment", "omarchy-sshd"], {
        quiet,
      });
      await run(["sudo", "ufw", "reload"], { quiet });
    }
    await run(["sudo", "systemctl", "enable", "sshd.service"], { quiet });
    await run(["sudo", "systemctl", "reload-or-restart", "sshd.service"], {
      quiet,
    });
  } catch (error) {
    if (created && !validated)
      await run(["sudo", "rm", "-f", workshopSshPolicyPath], { quiet });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function workshopSsh(
  command: Extract<Command, { kind: "ssh" }>,
): Promise<void> {
  const directory = join(home, ".ssh");
  if (command.action === "enroll") return enrollSshDevice(directory);
  if (command.action === "revoke") {
    const name = command.device ?? (await promptInput("Device name to revoke"));
    await revokeDevice(directory, name);
    say(`Revoked ${name}. Existing SSH sessions remain open.`, "success");
    return;
  }
  if (command.action === "enable") {
    if (!regularSshReady()) await enableRegularSsh();
    say("Key-only OpenSSH is enabled on port 22.", "success");
    for (const path of (await readdir("/etc/ssh")).sort()) {
      if (/^ssh_host_.*_key\.pub$/.test(path))
        await run(["ssh-keygen", "-lf", join("/etc/ssh", path)]);
    }
    return;
  }
  const devices = (await readAuthorizedKeys(directory))
    .split("\n")
    .map(enrolledDevice)
    .filter((device) => device !== undefined);
  if (!devices.length) say("No devices enrolled through Workshop.", "pending");
  for (const device of devices) say(`${device.name}  ${device.fingerprint}`);
}

async function execute(command: Command): Promise<void> {
  switch (command.kind) {
    case "update":
      await updateWorkshop(command);
      return;
    case "shell":
      console.log(await shellCode(command.shell));
      return;
    case "workspace": {
      const current = await settings();
      say(
        checkoutPath(
          command.root ?? current.workspacesRoot,
          current.repository,
        ),
      );
      return;
    }
    case "test":
      await selfTest(command.published);
      return;
    case "context":
      say(
        process.env.CODEX_THREAD_ID ||
          process.env.CODEX_SANDBOX ||
          process.env.CLAUDECODE ||
          process.env.OPENCODE
          ? "AGENT"
          : process.env.HERDR_PANE_ID ||
              process.env.HERDR_SESSION_ID ||
              process.env.HERDR
            ? "HERDR"
            : "HUMAN",
      );
      return;
    case "status":
      await workstationStatus(command.details);
      return;
    case "doctor":
      await doctor(command.json);
      return;
    case "ssh":
      await workshopSsh(command);
      return;
    case "open":
      if (interactiveOutput && !member(["menu", "hints"], command.app))
        say(`Opening ${command.app}.`);
      await openApp(command.app);
      return;
    case "work":
      if (interactiveOutput)
        say(`Opening ${command.app} for ${command.tenant}.`);
      await browser(
        urls[command.app],
        command.tenant,
        command.app !== "browser",
      );
      return;
    case "agent":
      if (interactiveOutput)
        say(`Starting ${command.agent} in ${command.directory}`);
      await runAgent(command.agent, command.directory);
      return;
    case "drive":
      await drive(command.action, command.tenant);
      return;
    case "vault":
      await vault(command.action);
      return;
    case "restore":
    case "verify":
      await restore(command);
      return;
    case "config":
      await configure(command.action);
      return;
    case "set-secret":
      await setSecret(command.variable);
      say("Secret saved.", "success");
      return;
    case "menu":
      await menu(command);
      return;
    case "shell-env":
      if (process.stdout.isTTY)
        throw new Error("Load these exports via snshah shell.");
      for (const secret of (await settings()).secrets)
        if (secret.value && secret.scope === "shell")
          console.log(`export ${secret.variable}=${shellQuote(secret.value)}`);
      return;
    case "plugin":
      await plugin(command.action);
      if (interactiveOutput && command.action !== "toggle")
        say(
          command.action === "install"
            ? "Workshop widget ready."
            : "Workshop widget removed.",
          "success",
        );
      return;
    case "plan": {
      const steps = await plan(command.features);
      if (command.json) print(describe(steps), true);
      else if (steps.length) print(steps.map(stepLabel), false);
      else say("No changes needed.", "success");
      return;
    }
    case "apply": {
      if (process.getuid?.() === 0)
        throw new Error("Run snshah apply as your desktop user.");
      try {
        await apply(command.features, command.json);
      } catch (error) {
        throw new Error(
          `Setup stopped: ${errorMessage(error)}. Run snshah plan to see what remains.`,
        );
      }
      return;
    }
  }
  const exhaustive: never = command;
  throw new Error(`Unhandled command: ${exhaustive}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  const argv = Bun.argv.slice(2);
  if (argv.length === 1 && member(["--version", "-V"], argv[0]))
    console.log(`v${cliVersion}`);
  else if (argv.length === 1 && argv[0] === "update-protocol") console.log("1");
  else await dispatchCli(argv);
} catch (error) {
  console.error(styled(`snshah: ${errorMessage(error)}`, "error"));
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

async function selfTest(published: boolean): Promise<void> {
  const fixture = await mkdtemp(join(tmpdir(), "workstation.auto.test-"));
  try {
    const tools = join(fixture, "tools.auto.bin");
    const hypr = join(fixture, ".config/hypr");
    const desktop = join(fixture, ".local/share/applications");
    const root = join(fixture, "Team Work");
    const source = (await exists(join(import.meta.dir, "bootstrap.sh")))
      ? import.meta.dir
      : checkoutPath(await workspaceRoot());
    await mkdir(tools);
    await mkdir(hypr, { recursive: true });
    await mkdir(join(fixture, ".config/opencode"));
    await mkdir(desktop, { recursive: true });
    await symlink(process.execPath, join(tools, "bun"));
    for (const command of [
      "sh",
      "bash",
      "curl",
      "tar",
      "dirname",
      "mktemp",
      "rm",
      "sleep",
      "jq",
      "find",
      "id",
      "gzip",
      "omarchy-plugin-validate",
    ]) {
      const path = Bun.which(command);
      if (path) await symlink(path, join(tools, command));
    }
    await writeFile(
      join(tools, "cat"),
      `#!/bin/sh
if [ "$1" = ${shellQuote(workshopSshPolicyPath)} ]; then exec /usr/bin/cat "$HOME/sshd.auto.policy"; fi
exec /usr/bin/cat "$@"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(tools, "systemctl"),
      '#!/bin/sh\ntest -f "$HOME/sshd.auto.active" || exit 3\ncase "$1" in is-active) printf "active\\n";; is-enabled) printf "enabled\\n";; *) exit 2;; esac\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(tools, "sudo"),
      `#!/usr/bin/env bun
import { appendFileSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
const args = Bun.argv.slice(2);
const [tool, action] = args;
const home = process.env.HOME;
appendFileSync(home + "/sshd.auto.log", args.join(" ") + "\\n");
if (tool === "install" && action === "-Dm644") copyFileSync(args[2], home + "/sshd.auto.policy");
else if (tool === "sshd" && action === "-T") console.log("Port 22\\nPubkeyAuthentication yes\\nAuthenticationMethods publickey\\nPasswordAuthentication no\\nKbdInteractiveAuthentication no\\nPermitRootLogin no\\nAuthorizedKeysFile .ssh/authorized_keys");
else if (tool === "systemctl" && action === "reload-or-restart") {
  if (!existsSync(home + "/sshd.auto.policy") || existsSync(home + "/.ssh/authorized_keys")) process.exit(4);
  writeFileSync(home + "/sshd.auto.active", "");
} else if (!["ssh-keygen", "sshd", "ufw", "systemctl"].includes(tool)) process.exit(2);
`,
      { mode: 0o755 },
    );
    const bashrc = 'alias gs="git status"\nexport USER_SETTING=kept\n';
    const agentConfig = '{"userSetting":true}\n';
    const bindings = "-- User bindings\n";
    await writeFile(join(fixture, ".bashrc"), bashrc);
    await writeFile(join(fixture, "AGENTS.md"), "# Existing instructions\n");
    await writeFile(
      join(fixture, ".config/opencode/opencode.json"),
      agentConfig,
    );
    await writeFile(join(hypr, "hyprland.lua"), "");
    await writeFile(join(hypr, "bindings.lua"), bindings);
    await writeFile(
      join(tools, "omarchy"),
      `#!/usr/bin/env bun
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
`,
      { mode: 0o755 },
    );
    const git = Bun.which("git");
    assert(git, "git is required for the self-test");
    await writeFile(
      join(tools, "git"),
      `#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
const argv = Bun.argv.slice(2);
if (argv[0] === "clone") mkdirSync(argv.at(-1) + "/.git", { recursive: true });
else if (argv[0] === "-C" && argv[2] === "remote") console.log("https://github.com/shah/workshop.git");
else if (argv[0] === "ls-remote" && argv.length === 4) console.log("0123456789abcdef0123456789abcdef01234567\trefs/heads/main");
else process.exitCode = Bun.spawnSync([${JSON.stringify(git)}, ...argv], { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
`,
      { mode: 0o755 },
    );
    for (const tool of [
      "herdr",
      "omarchy-shell",
      "fusermount3",
      "bwrap",
      "socat",
      "sshd",
      "ufw",
    ])
      await writeFile(join(tools, tool), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    await writeFile(
      join(tools, "age"),
      '#!/bin/sh\nif [ "$1" = "-d" ]; then cat "$3"; else cat > "$3"; fi\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(tools, "microsoft-edge-stable"),
      '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/browser.auto.log"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(tools, "xdg-settings"),
      '#!/bin/sh\ncat "$HOME/browser-default.auto.state" 2>/dev/null\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(tools, "rclone"),
      '#!/bin/sh\ncase "$1" in listremotes) if test -f "$HOME/remote.auto.state"; then cat "$HOME/remote.auto.state"; fi;; mount) printf "%s fuse.rclone\\n" "$2" > "$3/mount.auto.state";; esac\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(tools, "findmnt"),
      '#!/bin/sh\ncat "$5/mount.auto.state" 2>/dev/null\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(desktop, "Discord.desktop"),
      "[Desktop Entry]\nName=Discord\nExec=discord\n",
    );
    await writeFile(
      join(desktop, "WhatsApp.desktop"),
      "[Desktop Entry]\nHidden=true\nExec=omarchy-launch-webapp https://web.whatsapp.com/\n",
    );
    const env = {
      HOME: fixture,
      PATH: `${tools}:${join(fixture, ".local/bin")}`,
      TERM: "dumb",
      XDG_DATA_DIRS: fixture,
    };
    const invoke = (...argv: string[]) => {
      const result = Bun.spawnSync(argv, { env, cwd: source });
      if (!result.success)
        throw new Error(`${argv.join(" ")}: ${result.stderr.toString()}`);
      return result.stdout.toString();
    };
    assert.equal(
      invoke("bun", import.meta.path, "workspace"),
      checkoutPath(join(fixture, "Work")) + "\n",
    );
    const flags = ["--workspaces-root", root];
    const draft = invoke("bun", import.meta.path, "plan", "--json", ...flags);
    assert.equal(
      invoke("bun", import.meta.path, "plan", ...flags, "--json"),
      draft,
    );
    assert(
      JSON.parse(draft).some(
        (step: { kind: string; target: string }) =>
          step.kind === "checkout" && step.target === checkoutPath(root),
      ),
    );
    assert.equal(JSON.parse(draft)[0].target, "install-vscode");
    assert(
      JSON.parse(draft).some(
        (step: { target: string }) => step.target === "default-browser",
      ),
    );
    assert(
      !JSON.parse(draft).some(
        (step: { target: string }) => step.target === "webapp-discord",
      ),
    );
    const bootstrap = published
      ? [
          "bash",
          "-o",
          "pipefail",
          "-c",
          'curl -fsSL https://raw.githubusercontent.com/shah/workshop/main/bootstrap.sh | sh -s -- "$@"',
          "--",
          ...flags,
        ]
      : ["sh", "bootstrap.sh", ...flags];
    assert.match(invoke(...bootstrap), /Workshop setup complete/);
    assert.equal(invoke("snshah", "workspace"), checkoutPath(root) + "\n");
    assert.equal(invoke("snshah", "--version"), `v${cliVersion}\n`);
    assert.equal(invoke("snshah", "-V"), `v${cliVersion}\n`);
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    assert.equal(invoke(...bootstrap), "No changes needed.\n");
    assert.equal(
      await readFile(join(fixture, "sshd.auto.policy"), "utf8"),
      workshopSshPolicy + "\n",
    );
    assert(!(await exists(join(fixture, ".ssh/authorized_keys"))));
    const sshLog = (await readFile(join(fixture, "sshd.auto.log"), "utf8"))
      .trimEnd()
      .split("\n");
    assert.deepEqual(
      sshLog.filter((line) => !line.startsWith("install ")),
      [
        "ssh-keygen -A",
        "sshd -t",
        "sshd -T",
        "ufw limit 22/tcp comment omarchy-sshd",
        "ufw reload",
        "systemctl enable sshd.service",
        "systemctl reload-or-restart sshd.service",
      ],
    );
    if (!published) {
      const candidateDirectory = join(fixture, "update.auto.source");
      const candidateArchive = join(fixture, "update.auto.tar.gz");
      const candidatePath = join(candidateDirectory, "snshah.ts");
      const oldBin = join(fixture, ".local/bin/snshah");
      const original = await readFile(oldBin, "utf8");
      const candidate = original + "\n// Fixture update\n";
      await mkdir(candidateDirectory);
      async function stageCandidate(sourceCode: string) {
        await writeFile(candidatePath, sourceCode);
        await run([
          "tar",
          "-czf",
          candidateArchive,
          "-C",
          fixture,
          basename(candidateDirectory),
        ]);
      }
      await stageCandidate(candidate);
      await rm(join(tools, "curl"), { force: true });
      await writeFile(
        join(tools, "curl"),
        `#!/usr/bin/env bun
const argv = Bun.argv.slice(2);
const output = argv[argv.indexOf("-o") + 1];
if (!argv.includes("https://codeload.github.com/shah/workshop/tar.gz/0123456789abcdef0123456789abcdef01234567")) process.exit(2);
if (await Bun.file(process.env.HOME + "/update.auto.fail-download").exists()) process.exit(1);
await Bun.write(output, Bun.file(process.env.HOME + "/update.auto.tar.gz"));
`,
        { mode: 0o755 },
      );
      assert.match(
        invoke("snshah", "update", "--check"),
        /Previewing 0123456789ab/,
      );
      assert.equal(await readFile(oldBin, "utf8"), original);
      await writeFile(join(fixture, "update.auto.fail-download"), "");
      assert.equal(
        Bun.spawnSync(["snshah", "update", "--yes"], { env, cwd: source })
          .exitCode,
        1,
      );
      await rm(join(fixture, "update.auto.fail-download"));
      assert.equal(await readFile(oldBin, "utf8"), original);
      await stageCandidate(
        'console.error("legacy usage output"); process.exitCode = 2;',
      );
      const legacy = Bun.spawnSync(["snshah", "update", "--yes"], {
        env,
        cwd: source,
      });
      assert.equal(legacy.exitCode, 1);
      assert.match(legacy.stderr.toString(), /predates staged updates/);
      assert(!legacy.stderr.toString().includes("legacy usage output"));
      assert.equal(await readFile(oldBin, "utf8"), original);
      const failing = candidate.replace(
        "    if (revision) {\n      const source",
        '    if (revision) {\n      throw new Error("fixture apply failure");\n      const source',
      );
      assert.notEqual(failing, candidate);
      await stageCandidate(failing);
      const rejected = Bun.spawnSync(["snshah", "update", "--yes"], {
        env,
        cwd: source,
      });
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr.toString(), /fixture apply failure/);
      assert.equal(await readFile(oldBin, "utf8"), original);
      await stageCandidate(candidate);
      assert.match(invoke("snshah", "update", "--yes"), /Workshop updated/);
      assert.equal(await readFile(oldBin, "utf8"), candidate);
      assert.match(invoke("snshah", "update", "--check"), /Already up to date/);
      await atomicFile(oldBin, original, 0o755);
      await rm(join(tools, "curl"));
      const systemCurl = Bun.which("curl");
      if (systemCurl) await symlink(systemCurl, join(tools, "curl"));
    }
    const oldDot = join(desktop, "Shahid's Workstation ChatGPT Dot.desktop");
    await writeFile(
      oldDot,
      "[Desktop Entry]\nName=Shahid's Workstation ChatGPT Dot\nExec=snshah open dot\n",
    );
    assert.match(invoke("snshah", "apply"), /Workshop setup complete/);
    assert(await exists(join(desktop, "Workshop ChatGPT Dot.desktop")));
    assert(!(await exists(oldDot)));
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    const rc = await readFile(join(fixture, ".bashrc"), "utf8");
    assert(rc.startsWith(bashrc));
    assert.equal(rc.match(/>>> snshah shell >>>/g)?.length, 1);
    assert.equal(
      await readFile(join(fixture, "AGENTS.md"), "utf8"),
      "# Existing instructions\n",
    );
    assert.equal(
      await readFile(join(fixture, ".config/opencode/opencode.json"), "utf8"),
      agentConfig,
    );
    assert(
      (await readFile(join(hypr, "bindings.lua"), "utf8")).startsWith(bindings),
    );
    assert(await exists(join(hypr, "snshah.auto.lua")));
    for (const name of [
      "Gmail",
      "Google Voice",
      "Cloudflare Admin",
      "UniFi Admin",
      "WhatsApp",
      "Spotify",
    ])
      assert(await exists(join(desktop, name + ".desktop")));
    const installation = await readFile(
      join(fixture, "install.auto.log"),
      "utf8",
    );
    assert.equal(installation.match(/install editor vscode/g)?.length, 1);
    assert.equal(installation.match(/install service spotify/g)?.length, 1);
    assert.equal(installation.match(/pkg aur add oh-my-posh-bin/g)?.length, 1);
    assert(!installation.includes("webapp install Discord"));
    assert.match(
      invoke("bash", "--noprofile", "-ic", "alias ll; alias gs; type mkcd"),
      /alias ll='ls -al'\nalias gs='git status'/,
    );
    assert.equal(
      invoke(
        "bash",
        "--noprofile",
        "-c",
        'source "$HOME/.bashrc"; alias ll 2>/dev/null || true',
      ),
      "",
    );
    const fixtureConf = join(fixture, ".config/snshah.conf.ts");
    const freshConfig = await readFile(fixtureConf, "utf8");
    const settings = await interpretConfig(freshConfig);
    const menuFile = join(
      fixture,
      ".config/omarchy/extensions/omarchy-menu.jsonc",
    );
    assert.match(await readFile(menuFile, "utf8"), /Remote Access/);
    assert.equal(
      invoke("snshah", "ssh", "devices"),
      "No devices enrolled through Workshop.\n",
    );
    const keyBlob = Buffer.concat([
      Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
      Buffer.alloc(32, 1),
    ]);
    const enrolledKey = parseEnrollmentKey(
      `ssh-ed25519 ${keyBlob.toString("base64")} fixture`,
    );
    assert.throws(() => parseEnrollmentKey("ssh-ed25519 invalid"));
    const sshDirectory = join(fixture, ".ssh");
    const authorized = join(sshDirectory, "authorized_keys");
    await mkdir(sshDirectory, { mode: 0o700 });
    await writeFile(authorized, "# existing key comment\n");
    await authorizeDevice(sshDirectory, "laptop", enrolledKey.key);
    await assert.rejects(
      authorizeDevice(sshDirectory, "other", enrolledKey.key),
      /already/,
    );
    assert.equal((await stat(authorized)).mode & 0o777, 0o600);
    assert.equal(
      invoke("snshah", "ssh", "list"),
      `laptop  ${enrolledKey.fingerprint}\n`,
    );
    assert.match(invoke("snshah", "ssh", "revoke", "laptop"), /Revoked laptop/);
    assert.equal(
      await readFile(authorized, "utf8"),
      "# existing key comment\n",
    );
    for (let i = 0; i < 32; i++) {
      const code = newEnrollmentCode();
      assert.equal(code.length, 4);
      assert(
        [...code].every((character) => enrollmentAlphabet.includes(character)),
      );
    }
    assert.equal(
      enrollmentHost("192.168.11.3", "workshop.local"),
      "workshop.local",
    );
    assert.equal(
      enrollmentHost("192.168.11.3", "invalid hostname"),
      "192.168.11.3",
    );
    assert.equal(
      enrollmentSshCommands(
        "ssh -p 2222",
        "enroll",
        "workshop.local",
        "192.168.11.3",
      ),
      "ssh -p 2222 enroll@workshop.local\nIf the hostname does not resolve: ssh -p 2222 enroll@192.168.11.3",
    );
    const subnet = enrollmentSubnet("192.168.11.3/24");
    assert.equal(subnet.cidr, "192.168.11.0/24");
    assert(
      subnet.contains("192.168.11.90") &&
        !subnet.contains("192.168.12.90") &&
        !subnet.contains(""),
    );
    const received: string[] = [];
    const parser = enrollmentLines(
      (line) => received.push(line),
      () => received.push("canceled"),
    );
    parser(Buffer.from("1\r\nssh-ed"));
    parser(Buffer.from("25519\r\u0003"));
    assert.deepEqual(received, ["1", "ssh-ed25519", "canceled"]);
    assert.deepEqual(settings.work, []);
    assert.equal(settings.repository, "shah/workshop");
    await writeFile(
      fixtureConf,
      configSource({ ...settings, repository: "example/another-repo" }),
    );
    assert.equal(
      invoke("snshah", "workspace"),
      checkoutPath(root, "example/another-repo") + "\n",
    );
    await writeFile(fixtureConf, freshConfig);
    assert.equal(settings.prompt.kind, "posh");
    assert.equal(settings.browser.kind, "edge-default");
    const hints: WorkstationConfig = {
      ...settings,
      accounts: [{ kind: "gmail", username: "fixture@example.invalid" }],
    };
    await writeFile(fixtureConf, configSource(hints));
    assert.match(invoke("snshah", "open", "hints"), /fixture@example.invalid/);
    assert(
      !invoke("snshah", "status", "--details").includes(
        "fixture@example.invalid",
      ),
    );
    await writeFile(fixtureConf, freshConfig);
    const personalMount = join(
      fixture,
      "OneDrive",
      settings.personalOneDrive.username,
    );
    assert(await exists(personalMount));
    const offline = JSON.parse(invoke("snshah", "status", "--details"));
    assert.equal(offline.drives[0].state, "needs-sign-in");
    assert(
      !invoke("snshah", "status").includes(settings.personalOneDrive.username),
    );
    await writeFile(join(fixture, "remote.auto.state"), "snshah-personal:\n");
    // Simulate a successful mount and verify that the next apply reuses it.
    invoke("snshah", "apply");
    assert.equal(JSON.parse(invoke("snshah", "status")).mounted, 1);
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    assert(!(await readFile(menuFile, "utf8")).includes("Tenant 1"));
    const work: Tenant[] = [
      "studio",
      "research",
      "consulting",
      "operations",
    ].map((id) => ({
      id,
      label: `Fixture ${id}`,
      files: { kind: "web" },
    }));
    async function configureTenants(tenants: readonly Tenant[]) {
      await writeFile(
        fixtureConf,
        configSource({ ...settings, work: tenants }),
      );
    }
    await configureTenants(work.slice(0, 1));
    invoke("snshah", "apply");
    assert((await readFile(menuFile, "utf8")).includes("Tenant 1"));
    assert(!(await readFile(menuFile, "utf8")).includes("Tenant 2"));
    for (const id of ["missing", "../studio"]) {
      assert.equal(
        Bun.spawnSync(["snshah", "open", id, "outlook"], { env }).exitCode,
        2,
      );
      assert.equal(
        Bun.spawnSync(["snshah", "drive", "list", id], { env }).exitCode,
        2,
      );
    }
    await configureTenants([work[0], { ...work[1], id: work[0].id }]);
    assert.match(
      Bun.spawnSync(["snshah", "plan"], { env }).stderr.toString(),
      /Duplicate tenant ID/,
    );
    await configureTenants([
      {
        ...work[0],
        files: {
          kind: "rclone",
          username: settings.personalOneDrive.username,
          remote: "fixture",
        },
      },
    ]);
    assert.match(
      Bun.spawnSync(["snshah", "config", "check"], { env }).stderr.toString(),
      /same mount username/,
    );
    await configureTenants(work);
    invoke("snshah", "apply");
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    const fourMenus = await readFile(menuFile, "utf8");
    assert(
      fourMenus.includes("Tenant 4") && !fourMenus.includes(work[0].label),
    );
    for (const tenant of work) invoke("snshah", "open", tenant.id, "outlook");
    const log = join(fixture, "browser.auto.log");
    const deadline = Date.now() + 1500;
    let launches = "";
    while (Date.now() < deadline) {
      launches = (await read(log)) ?? "";
      if (
        (launches.match(/--app=https:\/\/outlook\.office\.com\/mail\//g)
          ?.length ?? 0) === work.length
      )
        break;
      await Bun.sleep(30);
    }
    for (const { id } of work)
      assert(
        launches.includes(
          `--user-data-dir=${join(fixture, ".local/share/snshah/edge", id)}`,
        ),
      );
    const studioProfile = join(fixture, ".local/share/snshah/edge", work[0].id);
    await mkdir(studioProfile, { recursive: true });
    const studioLauncher = join(
      desktop,
      `${product} Outlook (${work[0].id}).desktop`,
    );
    await configureTenants([
      work[1],
      { ...work[0], label: "Renamed studio" },
      ...work.slice(2),
    ]);
    assert(!invoke("snshah", "plan", "--json").includes(studioLauncher));
    invoke("snshah", "apply");
    const reordered = await readFile(menuFile, "utf8");
    assert(
      reordered.indexOf(".tenant-research") <
        reordered.indexOf(".tenant-studio"),
    );
    assert(!reordered.includes("Renamed studio"));
    await configureTenants(work.slice(1));
    invoke("snshah", "apply");
    assert(!(await exists(studioLauncher)));
    assert(await exists(studioProfile));
    assert(!(await readFile(menuFile, "utf8")).includes(".tenant-studio"));
    assert.equal(invoke("snshah", "plan", "--json"), "[]\n");
    invoke("snshah", "plugin", "install");
    const generatedPlugin = join(
      fixture,
      ".config/omarchy/plugins/shah.workstation",
    );
    assert(await exists(join(generatedPlugin, "manifest.json")));
    assert(await exists(join(generatedPlugin, "Panel.auto.qml")));
    invoke("snshah", "plugin", "remove");
    assert(!(await exists(generatedPlugin)));
    assert.equal((await stat(fixtureConf)).mode & 0o777, 0o600);
    const baseline = await readFile(fixtureConf, "utf8");
    const fake = "fixture-only-token";
    const configured = baseline.replace(
      "const secrets = []",
      `const secrets = [
      {variable:"SNSH_TEST_SHELL",value:"${fake}",scope:"shell"},
      {variable:"SNSH_TEST_COMMAND",value:"${fake}",scope:"command",commands:["codex"]}
    ]`,
    );
    await writeFile(fixtureConf, configured);
    assert.match(invoke("snshah", "config", "check"), /valid/);
    assert(!invoke("snshah", "shell").includes(fake));
    assert(invoke("snshah", "shell-env").includes(fake));
    assert(!invoke("snshah", "shell-env").includes("SNSH_TEST_COMMAND"));
    assert(!invoke("snshah", "doctor", "--json").includes(fake));
    await writeFile(
      join(tools, "codex"),
      '#!/bin/sh\ntest -n "$SNSH_TEST_COMMAND" && test -z "$SNSH_TEST_SHELL"\n',
      { mode: 0o755 },
    );
    invoke("snshah", "agent", "codex", fixture);
    await writeFile(
      join(tools, "check-shell.auto"),
      '#!/bin/sh\ntest -n "$SNSH_TEST_SHELL" && test -z "$SNSH_TEST_COMMAND"\n',
      { mode: 0o755 },
    );
    const exportCheck = Bun.spawnSync(
      ["bash", "-xc", 'eval "$(snshah shell)"; check-shell.auto'],
      { env },
    );
    assert(exportCheck.success);
    assert(!exportCheck.stderr.toString().includes(fake));
    for (const section of menuSections(work)) {
      assert.equal(
        new Set(section.actions.map((action) => action.id)).size,
        section.actions.length,
      );
      for (const action of section.actions) {
        if (action.args[0] === "help") continue;
        let dispatched = false;
        await dispatchCli(
          action.args.join(" ") === "config set-secret"
            ? [...action.args, "SNSH_TEST_COMMAND"]
            : action.args,
          async () => {
            dispatched = true;
          },
        );
        assert(dispatched, `Menu action does not resolve: ${action.id}`);
      }
    }
    const menuText = await readFile(
      join(fixture, ".config/omarchy/extensions/omarchy-menu.jsonc"),
      "utf8",
    );
    assert(
      menuText.includes("Edit in VS Code") &&
        menuText.includes("Restore snapshot") &&
        !menuText.includes(fake),
    );
    await chmod(fixtureConf, 0o644);
    const insecure = Bun.spawnSync(["snshah", "shell-env"], { env });
    assert.equal(insecure.exitCode, 1);
    assert(!insecure.stdout.toString().includes(fake));
    await chmod(fixtureConf, 0o600);
    const archive = invoke("snshah", "vault", "backup").trim();
    assert.match(basename(archive), /^snshah-config-.*\.ts\.age$/);
    assert.match(invoke("snshah", "vault", "verify", archive), /verified/);
    assert.equal(
      Bun.spawnSync(["snshah", "vault", "restore", archive], { env }).exitCode,
      1,
    );
    await rm(fixtureConf);
    invoke("snshah", "vault", "restore", archive);
    assert.equal(
      await readFile(fixtureConf, "utf8"),
      formatGeneratedConfig(conf, configured),
    );
    assert.equal((await stat(fixtureConf)).mode & 0o777, 0o600);
    assert.equal(await readFile(join(fixture, ".bashrc"), "utf8"), rc);
    await writeFile(
      join(tools, "code"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/editor-args.auto.log"\nprintf "\\n// saved from fixture editor\\n" >> "$4"\nsleep 0.4\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(tools, "omarchy-notification-send"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/notification.auto.log"\n',
      { mode: 0o755 },
    );
    invoke("snshah", "config", "edit");
    const workspacePath = join(
      fixture,
      ".local/share/snshah/editor.auto.workspace/snshah.auto.code-workspace",
    );
    const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
    const editorArgs = (
      await readFile(join(fixture, "editor-args.auto.log"), "utf8")
    )
      .trimEnd()
      .split("\n");
    assert.deepEqual(editorArgs, [
      "--new-window",
      "--wait",
      workspacePath,
      fixtureConf,
    ]);
    assert.equal(
      workspace.settings["[typescript]"]["editor.formatOnSave"],
      true,
    );
    assert.equal(workspace.settings["workbench.localHistory.enabled"], false);
    assert.deepEqual(workspace.folders, [
      { path: ".", name: "Workshop configuration" },
    ]);
    assert.deepEqual(workspace.tasks.tasks[0].args, ["config", "check"]);
    assert.deepEqual(workspace.extensions, editorExtensions);
    assert.deepEqual(
      JSON.parse(await readFile(join(source, ".vscode/settings.json"), "utf8")),
      editorSettings,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(source, ".vscode/extensions.json"), "utf8"),
      ),
      editorExtensions,
    );
    for (
      let i = 0;
      i < 10 && !(await exists(join(fixture, "notification.auto.log")));
      i++
    )
      await Bun.sleep(40);
    const notification = await readFile(
      join(fixture, "notification.auto.log"),
      "utf8",
    );
    assert(
      notification.includes("Back Up Now") && !notification.includes(fake),
    );
    const formatted = configSource({
      ...settings,
      secrets: [
        {
          variable: "EXAMPLE_ROTATE_TOKEN",
          value: "",
          scope: "command",
          commands: ["codex"],
        },
      ],
    }).replace(
      '\n  }\n] satisfies WorkstationConfig["secrets"];',
      "\n  },\n] satisfies WorkstationConfig['secrets']",
    );
    const rotatedSource = await rotateSecret(
      formatted,
      "EXAMPLE_ROTATE_TOKEN",
      async () => "new-fixture-token",
    );
    assert.equal(formatGeneratedConfig(conf, rotatedSource), rotatedSource);
    const rotated = await interpretConfig(
      await rotateSecret(
        rotatedSource,
        "EXAMPLE_ROTATE_TOKEN",
        async () => "new-fixture-token",
      ),
    );
    assert.equal(rotated.secrets[0]?.value, "new-fixture-token");
    const fresh = join(fixture, "home.auto.fresh");
    await mkdir(join(fresh, ".config/hypr"), { recursive: true });
    await writeFile(join(fresh, ".config/hypr/hyprland.lua"), "");
    env.HOME = fresh;
    assert.match(
      invoke("bun", import.meta.path, "apply"),
      /Workshop setup complete/,
    );
    assert(await exists(checkoutPath(join(fresh, "Work"))));
    assert(
      await exists(join(fresh, ".config/oh-my-posh/snshah.auto.omp.json")),
    );
    const freshCodex = join(fresh, ".codex/config.toml");
    const freshClaude = join(fresh, ".claude/settings.json");
    assert.deepEqual(Bun.TOML.parse(await readFile(freshCodex, "utf8")), {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { network_access: true },
    });
    const claude = JSON.parse(await readFile(freshClaude, "utf8"));
    assert.equal(claude.permissions.defaultMode, "acceptEdits");
    assert.equal(claude.sandbox.autoAllowBashIfSandboxed, true);
    assert.equal(claude.sandbox.allowUnsandboxedCommands, false);
    assert.equal(claude.sandbox.failIfUnavailable, true);
    assert(claude.sandbox.network.allowedDomains.includes("github.com"));
    for (const path of [freshCodex, freshClaude])
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const path of [".codex/AGENTS.md", ".claude/CLAUDE.md"])
      assert.match(
        await readFile(join(fresh, path), "utf8"),
        /Proceed without asking for permission/,
      );
    for (const chunk of [
      '[sandbox_workspace_write]\nwritable_roots = ["/tmp"]\n',
      'sandbox_workspace_write = { writable_roots = ["/tmp"] }\n',
      'sandbox_workspace_write.writable_roots = ["/tmp"]\n',
    ]) {
      const custom =
        'model = "custom"\napproval_policy = "on-request"\n' + chunk;
      const merged = codexDefaults(custom);
      assert.deepEqual(Bun.TOML.parse(merged), {
        model: "custom",
        approval_policy: "on-request",
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: {
          writable_roots: ["/tmp"],
          network_access: true,
        },
      });
      assert.equal(codexDefaults(merged), merged);
    }
    const selectedProfile = 'default_permissions = "custom"\n';
    assert.equal(codexDefaults(selectedProfile), selectedProfile);
    const customClaude =
      '{"model":"custom","permissions":{"defaultMode":"default","deny":["Bash(example)"]},"sandbox":{"network":{"allowedDomains":["example.org"]}}}';
    const mergedClaude = claudeDefaults(customClaude).content;
    const parsedClaude = JSON.parse(mergedClaude);
    assert.equal(parsedClaude.model, "custom");
    assert.deepEqual(parsedClaude.permissions, {
      defaultMode: "default",
      deny: ["Bash(example)"],
    });
    assert.deepEqual(parsedClaude.sandbox.network.allowedDomains, [
      "example.org",
    ]);
    assert.equal(claudeDefaults(mergedClaude).content, mergedClaude);
    for (const path of [
      ".config/snshah.conf.ts",
      ".config/snshah.auto.d.ts",
      ".local/share/snshah/editor.auto.workspace/snshah.auto.code-workspace",
    ]) {
      const text = await readFile(join(fresh, path), "utf8");
      assert.equal(formatGeneratedConfig(path, text), text);
    }
    const freshBin = join(fresh, ".local/bin/snshah");
    assert.equal(invoke(freshBin, "plan", "--json"), "[]\n");
    say("Workshop self-test passed.", "success");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
