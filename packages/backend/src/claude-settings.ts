import { claudeConfigFiles, claudeManagedDir, resolveClaudeConfig } from "./claude-config";
import type { ClaudeConfig } from "./claude-config";
import { resolveRepoRoot } from "./claude-memory";
import {
  defaultIo,
  flavor,
  isInside,
  pathKey,
  probe,
  type ClaudeIo,
  type OutsideMode,
  type ProbeContext,
} from "./context-claude-sources";
import { userHome } from "./mcp-config-read";
import { sanitizeSessionText } from "./session-handoff";

// Claude Code settings, read-only. Basis, https://code.claude.com/docs/en/settings and
// https://code.claude.com/docs/en/managed-settings:
// - Files: managed (`managed-settings.json` and `managed-settings.d/*.json` in the policy folder),
//   local (`.claude/settings.local.json`, kept at the repository root), project
//   (`.claude/settings.json` of the working directory) and user (`<config>/settings.json`).
// - Precedence, highest first: managed, command line (`--settings`), local, project, user.
// - Lists such as `permissions.allow` merge across files instead of overriding. Documented for
//   the managed drop-in files: single values are replaced by the later file, lists are combined,
//   nested blocks merge key by key. Between the other layers the same rules are assumed (not
//   verified for nested blocks other than `permissions`).
// - Strict JSON: a comment or a trailing comma is a syntax error.
//
// What AgentKib cannot see: `--settings` and `--setting-sources` (command line), policy delivered
// as a macOS configuration profile or a Windows registry value, and server-managed settings from
// the claude.ai console. The result can therefore differ from what a running Claude Code uses.
//
// Secrets. A settings file can hold credentials in several places, so nothing leaves this module
// as raw text. Outgoing text is built only from (a) key names, (b) an allow list of plain values
// that never carry credentials (`SHOWN_VALUES`), and (c) commands, rules and URLs after
// `redactText`. The `env` block shows names only. Credential helpers (`apiKeyHelper` and the
// like) show "configured". Values of keys that are not listed here are never shown.

export type SettingsLayerId = "managed" | "local" | "project" | "user";
/** Highest precedence first. The command line (`--settings`) sits between managed and local. */
export const LAYER_ORDER: readonly SettingsLayerId[] = ["managed", "local", "project", "user"];
export type SettingsFileStatus =
  | "ok"
  | "missing"
  | "unparseable"
  | "not-object"
  | "too-large"
  | "unreadable"
  | "network"
  | "sensitive";
export interface SettingsFile {
  layer: SettingsLayerId;
  /** The path as written. Callers decide whether to show it. */
  file: string;
  status: SettingsFileStatus;
  /** Where a syntax error is (1-based). Never the text around it. */
  position?: { line: number; column: number };
  /** The file is not below the workspace root. */
  outside: boolean;
  /** Top-level key names of a parsed file, sorted and bounded. */
  keys: string[];
}
export type InstructionFiles =
  | "claude-md-or-agents-md"
  | "claude-md-and-agents-md"
  | "claude-md"
  | "managed-only";
export interface McpPolicyEntry {
  serverName?: string;
  serverUrl?: string;
  serverCommand?: string[];
}

const MAX_BYTES = 256 * 1024;
const MAX_KEYS = 200;
const MAX_NAME_CHARS = 80;
const MAX_TEXT_CHARS = 200;
const MAX_LIST = 50;
const MAX_ENTRIES = 256;
const MAX_DROP_INS = 64;
const MAX_DEPTH = 8;
const AGENTS_PLUGIN_IDS = ["cc-plugin-agents-md@builtin", "agents-md@builtin"] as const;
const INSTRUCTION_VALUES: readonly string[] = [
  "claude-md-or-agents-md",
  "claude-md-and-agents-md",
  "claude-md",
  "managed-only",
];
/** Keys whose plain value is safe to show: none of them holds a credential, a command or a URL. */
const SHOWN_VALUES = new Set([
  "model",
  "outputStyle",
  "language",
  "theme",
  "effortLevel",
  "defaultShell",
  "agent",
  "alwaysThinkingEnabled",
  "autoMemoryEnabled",
  "autoMemoryDirectory",
  "autoCompactEnabled",
  "cleanupPeriodDays",
  "includeCoAuthoredBy",
  "includeGitInstructions",
  "enableAllProjectMcpServers",
  "allowManagedMcpServersOnly",
  "disableAllHooks",
  "editorMode",
  "verbose",
  "fastMode",
  "autoUpdatesChannel",
  "respectGitignore",
  "plansDirectory",
  "spinnerTipsEnabled",
  "timeZone",
  "viewMode",
  "teammateMode",
]);
/** Keys that name a command which produces a credential: only "configured" is ever shown. */
const CREDENTIAL_HELPERS = new Set([
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "proxyAuthHelper",
  "policyHelper",
]);
/** Keys with a command that is shown after redaction. */
const COMMAND_KEYS = new Set(["statusLine", "subagentStatusLine", "fileSuggestion"]);
/** Handled by dedicated lines; they are not repeated among the other keys. */
const DEDICATED = new Set([
  ...SHOWN_VALUES,
  ...CREDENTIAL_HELPERS,
  ...COMMAND_KEYS,
  "permissions",
  "env",
  "hooks",
  "enabledPlugins",
  "claudeMd",
  "claudeMdExcludes",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "allowedMcpServers",
  "deniedMcpServers",
  "managedMcpServers",
  "pluginConfigs",
  "extraKnownMarketplaces",
]);
/** A later value replaces the earlier one whole instead of merging. */
const WHOLE_VALUE_KEYS = new Set(["fallbackModel", "modelPicker"]);

type Obj = { [key: string]: unknown };
const isObject = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: Obj, key: string) => Object.hasOwn(value, key);
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, MAX_ENTRIES)
    : [];

// ---- redaction -------------------------------------------------------------------------------

const SECRET_WORD = "(?:token|key|secret|passw(?:or)?d|passwd|auth|credential|bearer|cookie|sig)";

/**
 * Text that may be a command, a rule or a URL, made safe to show: the shared session redaction
 * first (known prefixes, `Bearer`, secret-looking `key=value`), then rules for what that one
 * does not know (flags such as `--token x`, `NAME_KEY=x`, header lines, URL credentials, long
 * opaque blobs). Shortened last, so that a cut can never leave half a secret.
 */
export function redactText(text: string): string {
  let output = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
      ? " "
      : character;
  }).join("");
  output = sanitizeSessionText(output, { value: 0 });
  output = output.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]*(?::[^\s/@'"]*)?@/gi,
    "$1[REDACTED]@",
  );
  output = output.replace(
    new RegExp(`([?&#;][^=&\\s'"#;]*${SECRET_WORD}[^=&\\s'"#;]*=)[^&\\s'"#;]+`, "gi"),
    "$1[REDACTED]",
  );
  output = output.replace(
    new RegExp(
      `(--?[a-z0-9_-]*${SECRET_WORD}[a-z0-9_-]*(?:=|\\s+))("[^"]*"|'[^']*'|[^\\s'"]+)`,
      "gi",
    ),
    "$1[REDACTED]",
  );
  output = output.replace(
    new RegExp(
      `(\\b[a-z_][a-z0-9_]*${SECRET_WORD}[a-z0-9_]*\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s'"]+)`,
      "gi",
    ),
    "$1[REDACTED]",
  );
  output = output.replace(
    /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\n"']+)/gi,
    "$1$2[REDACTED]",
  );
  // Opaque runs: a long word with digits and letters, or base64 that contains slashes. Plain words
  // and ordinary paths do not look like that.
  output = output.replace(
    /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+=]{32,}(?![A-Za-z0-9_\-+/=])/g,
    (blob) => (/\d/.test(blob) && /[A-Za-z]/.test(blob) ? "[REDACTED]" : blob),
  );
  output = output.replace(
    /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9+]{16,}\/[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9_\-+/=])/g,
    (blob) => (/[a-z]/.test(blob) && /[A-Z]/.test(blob) && /\d/.test(blob) ? "[REDACTED]" : blob),
  );
  return output.length > MAX_TEXT_CHARS ? `${output.slice(0, MAX_TEXT_CHARS)}…` : output;
}

/** A key or identifier taken from a file, bounded and redacted. */
function safeName(name: string): string {
  const cleaned = redactText(name);
  return cleaned.length > MAX_NAME_CHARS ? `${cleaned.slice(0, MAX_NAME_CHARS)}…` : cleaned;
}

// ---- merging ---------------------------------------------------------------------------------

function fresh(): Obj {
  return Object.create(null) as Obj;
}
function unionList(base: unknown[], over: unknown[]): unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];
  for (const item of [...base, ...over]) {
    const key = typeof item === "string" ? `s:${item}` : `j:${JSON.stringify(item) ?? "undefined"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output.slice(0, MAX_ENTRIES);
}
/** `over` wins for single values, lists are combined, nested blocks merge key by key. */
function merge(base: Obj, over: Obj, top = true, depth = 0): Obj {
  const output = fresh();
  for (const key of Object.keys(base)) output[key] = base[key];
  for (const key of Object.keys(over)) {
    const next = over[key];
    const previous = own(output, key) ? output[key] : undefined;
    if (top && WHOLE_VALUE_KEYS.has(key)) output[key] = next;
    else if (Array.isArray(previous) && Array.isArray(next))
      output[key] = unionList(previous, next);
    else if (isObject(previous) && isObject(next) && depth < MAX_DEPTH)
      output[key] = merge(previous, next, false, depth + 1);
    else output[key] = next;
  }
  return output;
}

function syntaxPosition(
  text: string,
  error: unknown,
): { line: number; column: number } | undefined {
  const message = error instanceof Error ? error.message : "";
  const found = /position (\d+)/.exec(message);
  if (!found) return undefined;
  const index = Math.min(Number(found[1]), text.length);
  let line = 1;
  let column = 1;
  for (let at = 0; at < index; at++) {
    if (text[at] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

// ---- reading ---------------------------------------------------------------------------------

export interface ClaudeSettingsOptions {
  /** Canonical workspace root. */
  root: string;
  /** Canonical working directory inside the root; the project layer is read from here. */
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** `none` reads nothing at all. */
  mode: OutsideMode;
  config?: ClaudeConfig;
  /** Where organization policy files live; `null` for none. Defaults to the platform's folder. */
  managedDir?: string | null;
  platform?: NodeJS.Platform;
  io?: ClaudeIo;
  /** Whether a file must not be read (credential stores), given the written and the real path. */
  sensitive?: (written: string, real: string) => boolean;
  /** Read the managed and user layers only: there is no project to take the other two from. */
  withoutProject?: boolean;
}

interface Loaded {
  file: SettingsFile;
  data?: Obj;
}

function readFileLayer(
  layer: SettingsLayerId,
  written: string,
  base: string | null,
  options: ClaudeSettingsOptions,
  context: ProbeContext,
): Loaded {
  const outsideRoot = (real: string) => !isInside(real, options.root, context.platform);
  const result = (
    status: SettingsFileStatus,
    extra: Partial<SettingsFile> = {},
    data?: Obj,
  ): Loaded => ({
    file: {
      layer,
      file: written,
      status,
      outside: extra.outside ?? outsideRoot(written),
      keys: [],
      ...extra,
    },
    ...(data ? { data } : {}),
  });
  const found = probe(written, base, context);
  if (found.kind === "missing") return result("missing");
  if (found.kind === "network") return result("network");
  if (found.kind !== "file") return result("unreadable");
  const outside = outsideRoot(found.real);
  if (options.sensitive?.(written, found.real)) return result("sensitive", { outside });
  if (found.size > MAX_BYTES) return result("too-large", { outside });
  let bytes: Buffer;
  try {
    bytes = context.io.readFile(found.real, MAX_BYTES + 1);
  } catch {
    return result("unreadable", { outside });
  }
  if (bytes.length > MAX_BYTES) return result("too-large", { outside });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return result("unparseable", { outside });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const position = syntaxPosition(text, error);
    return result("unparseable", { outside, ...(position ? { position } : {}) });
  }
  if (!isObject(parsed)) return result("not-object", { outside });
  const keys = Object.keys(parsed)
    .sort()
    .slice(0, MAX_KEYS)
    .map((key) => safeName(key));
  return result("ok", { outside, keys }, parsed);
}

export function readClaudeSettings(options: ClaudeSettingsOptions): ClaudeSettings {
  if (options.mode === "none")
    return new ClaudeSettings(options.platform ?? process.platform, [], new Map(), new Map());
  const platform = options.platform ?? process.platform;
  const context: ProbeContext = { io: options.io ?? defaultIo, platform };
  const p = flavor(platform);
  const home = userHome(options.environment);
  const config = options.config ?? resolveClaudeConfig(options.environment, home, platform);
  const loaded: Loaded[] = [];
  const layers = new Map<SettingsLayerId, Obj>();
  const origins = new Map<string, string>();
  const fold = (layer: SettingsLayerId, items: Loaded[]) => {
    let merged = fresh();
    for (const item of items) {
      loaded.push(item);
      if (!item.data) continue;
      for (const key of Object.keys(item.data)) origins.set(`${layer}:${key}`, item.file.file);
      merged = merge(merged, item.data);
    }
    if (items.some((item) => item.data)) layers.set(layer, merged);
  };

  // managed: the file first, then the drop-ins in alphabetical order; a later one wins.
  const managed =
    options.managedDir === undefined ? claudeManagedDir(platform) : options.managedDir;
  if (managed) {
    const items = [
      readFileLayer("managed", p.join(managed, "managed-settings.json"), null, options, context),
    ];
    const directory = probe(p.join(managed, "managed-settings.d"), null, context);
    if (directory.kind === "dir") {
      let names: string[] = [];
      try {
        names = context.io.readdir(directory.real);
      } catch {
        // An unreadable drop-in folder shows up as the missing files it holds.
      }
      names = names
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, MAX_DROP_INS);
      for (const name of names)
        items.push(readFileLayer("managed", p.join(directory.real, name), null, options, context));
    }
    fold("managed", items);
  }

  if (options.withoutProject) {
    fold("user", [
      readFileLayer("user", claudeConfigFiles(config, platform).settings, null, options, context),
    ]);
    return new ClaudeSettings(
      platform,
      loaded.map((item) => item.file),
      layers,
      origins,
    );
  }
  // local: the repository root's file wins over the working directory's older copy.
  const repository = resolveRepoRoot(options.cwd, context).base;
  const localDirs =
    platform === "win32" || pathKey(repository, platform) === pathKey(home, platform)
      ? [options.cwd]
      : pathKey(repository, platform) === pathKey(options.cwd, platform)
        ? [options.cwd]
        : [options.cwd, repository];
  fold(
    "local",
    localDirs.map((dir) =>
      readFileLayer("local", p.join(dir, ".claude", "settings.local.json"), null, options, context),
    ),
  );
  fold("project", [
    readFileLayer(
      "project",
      p.join(options.cwd, ".claude", "settings.json"),
      options.cwd,
      options,
      context,
    ),
  ]);
  fold("user", [
    readFileLayer("user", claudeConfigFiles(config, platform).settings, null, options, context),
  ]);
  return new ClaudeSettings(
    platform,
    loaded.map((item) => item.file),
    layers,
    origins,
  );
}

// ---- model -----------------------------------------------------------------------------------

/** Text that is safe to show, with the layer it came from. */
export interface Shown {
  text: string;
  layer: SettingsLayerId;
}
export interface HookSummary {
  /** A settings layer, or `plugin:<id>` for the hooks of a plugin. */
  layer: string;
  event: string;
  matcher?: string;
  type: string;
  /** Redacted. Only the command, URL or a size, never headers or prompt text. */
  detail: string;
}
export type View = "full" | "project-metadata";

export class ClaudeSettings {
  readonly files: readonly SettingsFile[];
  #layers: Map<SettingsLayerId, Obj>;
  #origins: Map<string, string>;
  #platform: NodeJS.Platform;

  constructor(
    platform: NodeJS.Platform,
    files: SettingsFile[],
    layers: Map<SettingsLayerId, Obj>,
    origins: Map<string, string>,
  ) {
    this.#platform = platform;
    this.files = files;
    this.#layers = layers;
    this.#origins = origins;
  }

  /** At least one settings file was found and parsed. */
  get any(): boolean {
    return this.#layers.size > 0;
  }
  /**
   * At least one settings file exists, parsed or not. A path that was not followed (a link to a
   * network share) or could not be looked at does not count: Claude Code would not read it either.
   */
  get anyFile(): boolean {
    return this.files.some((file) => !["missing", "network", "unreadable"].includes(file.status));
  }
  /** Layers that hold data, highest precedence first. */
  #present(): SettingsLayerId[] {
    return LAYER_ORDER.filter((layer) => this.#layers.has(layer));
  }
  /** The layers that set `key`, highest precedence first. */
  #setting(key: string): { layer: SettingsLayerId; value: unknown }[] {
    return this.#present()
      .filter((layer) => own(this.#layers.get(layer)!, key))
      .map((layer) => ({ layer, value: this.#layers.get(layer)![key] }));
  }
  #merged(): Obj {
    let output = fresh();
    for (const layer of [...LAYER_ORDER].reverse()) {
      const data = this.#layers.get(layer);
      if (data) output = merge(output, data);
    }
    return output;
  }

  // ---- values used by the other features ----

  /** `claudeMdExcludes` patterns: arrays merge across every layer. */
  claudeMdExcludes(): string[] {
    const value = this.#merged().claudeMdExcludes;
    return strings(value).filter((pattern) => pattern !== "" && pattern.length <= 1024);
  }
  /** The `claudeMd` text. Honored in managed settings only. */
  managedClaudeMd(): { text: string; file: string } | null {
    const data = this.#layers.get("managed");
    const text = data && own(data, "claudeMd") ? data.claudeMd : undefined;
    if (typeof text !== "string" || text.trim() === "") return null;
    return { text, file: this.#origins.get("managed:claudeMd") ?? "managed settings" };
  }
  /**
   * The "Project instructions" choice, kept under `pluginConfigs["cc-plugin-agents-md@builtin"]`
   * (`agents-md@builtin` before 2.1.285). Read from managed, user (and `--settings`, not visible)
   * settings; project and local settings are ignored, which is reported in `ignoredIn`.
   */
  instructionFiles(): {
    value: InstructionFiles;
    layer?: SettingsLayerId;
    ignoredIn: SettingsLayerId[];
    invalid: boolean;
  } {
    const read = (layer: SettingsLayerId) => {
      const configs = this.#layers.get(layer)?.pluginConfigs;
      if (!isObject(configs)) return undefined;
      for (const id of AGENTS_PLUGIN_IDS) {
        const entry = own(configs, id) ? configs[id] : undefined;
        const options = isObject(entry) && isObject(entry.options) ? entry.options : undefined;
        if (options && own(options, "instructionFiles")) return options.instructionFiles;
      }
      return undefined;
    };
    const ignoredIn = (["local", "project"] as const).filter((layer) => read(layer) !== undefined);
    let invalid = false;
    for (const layer of ["managed", "user"] as const) {
      const value = read(layer);
      if (value === undefined) continue;
      if (typeof value === "string" && INSTRUCTION_VALUES.includes(value))
        return { value: value as InstructionFiles, layer, ignoredIn, invalid };
      invalid = true;
    }
    return { value: "claude-md-or-agents-md", ignoredIn, invalid };
  }
  /**
   * Auto memory settings. `enabled` is false when the highest layer that sets
   * `autoMemoryEnabled` says false. `autoMemoryDirectory` is applied from managed and user
   * settings only: project and local files can set it too, but Claude Code honors that only in a
   * trusted folder, which AgentKib cannot see, and a cloned repository must not be able to point
   * the preview at a folder of its choice.
   */
  autoMemory(): {
    enabled: boolean;
    enabledLayer?: SettingsLayerId;
    directory?: { value: string; layer: SettingsLayerId };
    directoryIgnoredIn: SettingsLayerId[];
    directoryInvalid: boolean;
  } {
    const enabledSet = this.#setting("autoMemoryEnabled").find(
      (entry) => typeof entry.value === "boolean",
    );
    const directories = this.#setting("autoMemoryDirectory").filter(
      (entry) => typeof entry.value === "string",
    );
    const trusted = directories.find(
      (entry) => entry.layer === "managed" || entry.layer === "user",
    );
    const value = trusted?.value as string | undefined;
    const valid =
      value !== undefined &&
      value.length <= 1024 &&
      (value.startsWith("~/") || flavor(this.#platform).isAbsolute(value)) &&
      !value.split(/[\\/]+/).includes("..");
    return {
      enabled: enabledSet?.value !== false,
      ...(enabledSet ? { enabledLayer: enabledSet.layer } : {}),
      ...(trusted && valid ? { directory: { value: value!, layer: trusted.layer } } : {}),
      directoryIgnoredIn: directories
        .map((entry) => entry.layer)
        .filter((layer) => layer === "project" || layer === "local"),
      directoryInvalid: trusted !== undefined && !valid,
    };
  }
  /** Approval state of `.mcp.json` servers (project scope). */
  mcpApprovals(): {
    enableAll?: { value: boolean; layer: SettingsLayerId };
    enabled: Map<string, SettingsLayerId[]>;
    disabled: Map<string, SettingsLayerId[]>;
  } {
    const enableAll = this.#setting("enableAllProjectMcpServers").find(
      (entry) => typeof entry.value === "boolean",
    );
    const collect = (key: string) => {
      const map = new Map<string, SettingsLayerId[]>();
      for (const entry of this.#setting(key))
        for (const name of strings(entry.value))
          map.set(name, [...(map.get(name) ?? []), entry.layer]);
      return map;
    };
    return {
      ...(enableAll
        ? { enableAll: { value: enableAll.value as boolean, layer: enableAll.layer } }
        : {}),
      enabled: collect("enabledMcpjsonServers"),
      disabled: collect("disabledMcpjsonServers"),
    };
  }
  /**
   * MCP allow and deny lists. `allowedMcpServers` merges across layers unless
   * `allowManagedMcpServersOnly` is set in managed settings, which makes the managed list the
   * only one. `deniedMcpServers` always merges.
   */
  mcpPolicy(): {
    allowed?: McpPolicyEntry[];
    denied: McpPolicyEntry[];
    managedOnly: boolean;
    managedServers: Obj;
  } {
    const entries = (value: unknown): McpPolicyEntry[] =>
      (Array.isArray(value) ? value : []).flatMap((item): McpPolicyEntry[] => {
        if (!isObject(item)) return [];
        const entry: McpPolicyEntry = {};
        if (typeof item.serverName === "string") entry.serverName = item.serverName;
        if (typeof item.serverUrl === "string") entry.serverUrl = item.serverUrl;
        if (
          Array.isArray(item.serverCommand) &&
          item.serverCommand.every((part) => typeof part === "string")
        )
          entry.serverCommand = item.serverCommand as string[];
        return Object.keys(entry).length ? [entry] : [];
      });
    const managed = this.#layers.get("managed");
    const managedOnly = managed?.allowManagedMcpServersOnly === true;
    const merged = this.#merged();
    const source = managedOnly ? managed!.allowedMcpServers : merged.allowedMcpServers;
    const servers =
      managed && isObject(managed.managedMcpServers) ? managed.managedMcpServers : fresh();
    return {
      ...(Array.isArray(source) ? { allowed: entries(source) } : {}),
      denied: entries(merged.deniedMcpServers),
      managedOnly,
      managedServers: servers,
    };
  }
  /** The managed settings file that holds `managedMcpServers`, as written. */
  managedServersFile(): string | undefined {
    return this.#origins.get("managed:managedMcpServers");
  }
  /** `enabledPlugins`: nested blocks merge key by key, the highest layer wins for each plugin. */
  enabledPlugins(): Map<string, { enabled: boolean; layer: SettingsLayerId }> {
    const output = new Map<string, { enabled: boolean; layer: SettingsLayerId }>();
    for (const layer of [...LAYER_ORDER].reverse()) {
      const plugins = this.#layers.get(layer)?.enabledPlugins;
      if (!isObject(plugins)) continue;
      for (const id of Object.keys(plugins).slice(0, MAX_ENTRIES))
        if (typeof plugins[id] === "boolean") output.set(id, { enabled: plugins[id], layer });
    }
    return output;
  }
  /** Hooks of every layer. They run side by side, so nothing overrides anything. */
  hooks(): HookSummary[] {
    const output: HookSummary[] = [];
    for (const layer of this.#present()) {
      const hooks = this.#layers.get(layer)!.hooks;
      output.push(...summarizeHooks(hooks, layer));
    }
    return output;
  }
  /** Names of the `env` block, never the values. */
  envNames(): { name: string; layer: SettingsLayerId }[] {
    const output: { name: string; layer: SettingsLayerId }[] = [];
    for (const layer of this.#present()) {
      const env = this.#layers.get(layer)!.env;
      if (isObject(env))
        for (const name of Object.keys(env).slice(0, MAX_ENTRIES))
          output.push({ name: safeName(name), layer });
    }
    return output;
  }
  /** Whether the `env` block of a layer sets `name` (for notes only; the value stays unread). */
  envSets(name: string): SettingsLayerId | undefined {
    return this.#present().find((layer) => {
      const env = this.#layers.get(layer)!.env;
      return isObject(env) && own(env, name);
    });
  }

  // ---- text ----

  /**
   * The settings as text. `full` is for the app and the CLI. `project-metadata` is for the MCP
   * tool: the project layer only, without anything that could hold a secret (no env names or
   * values, no rules, commands or URLs, only counts).
   */
  describe(view: View): string {
    const files =
      view === "full" ? this.files : this.files.filter((file) => file.layer === "project");
    const lines = [
      view === "full"
        ? "Settings files (highest precedence first; the command line, --settings, is not visible):"
        : "Settings file of this project:",
    ];
    for (const file of files) {
      if (file.layer === "managed" && file.status === "missing") continue;
      const shown = view === "full" ? file.file : `${file.layer} layer`;
      const keys =
        file.status === "ok" && file.keys.length
          ? `; keys: ${file.keys.slice(0, 40).join(", ")}`
          : "";
      lines.push(`- ${file.layer}: ${shown} - ${describeStatus(file)}${keys}`);
    }
    const layers =
      view === "full" ? this.#present() : this.#present().filter((layer) => layer === "project");
    if (!layers.length) return lines.join("\n");
    lines.push(
      "",
      view === "full" ? "Effective values (highest precedence first):" : "Values in this layer:",
    );
    lines.push(...this.#valueLines(view, layers));
    return lines.join("\n");
  }

  /**
   * One line per settings file that exists, with the layer, whether it parses and its top-level
   * key names. No path, no value: this is what the MCP tool says about files it must not show.
   */
  metadataLines(except: readonly SettingsLayerId[] = []): string[] {
    return this.files
      .filter((file) => file.status !== "missing" && !except.includes(file.layer))
      .map((file) => {
        const keys =
          file.status === "ok" && file.keys.length ? ` (${file.keys.slice(0, 40).join(", ")})` : "";
        return `Claude Code settings, ${file.layer} layer: ${describeStatus(file)}${keys}. The values are not included in this result.`;
      });
  }

  #valueLines(view: View, layers: readonly SettingsLayerId[]): string[] {
    const full = view === "full";
    const lines: string[] = [];
    const has = (layer: SettingsLayerId, key: string) => own(this.#layers.get(layer)!, key);
    const where = (key: string) => layers.filter((layer) => has(layer, key));
    const value = (key: string) => this.#layers.get(where(key)[0]!)![key];
    const tag = (key: string) => `(${where(key)[0]})`;

    for (const key of [...SHOWN_VALUES].sort()) {
      if (!where(key).length) continue;
      const raw = value(key);
      if (typeof raw === "boolean" || typeof raw === "number")
        lines.push(`${key} = ${String(raw)} ${tag(key)}`);
      else if (typeof raw === "string")
        lines.push(`${key} = ${JSON.stringify(redactText(raw))} ${tag(key)}`);
      else lines.push(`${key} = (not a plain value) ${tag(key)}`);
    }

    // permissions
    const permissionLayers = layers.filter((layer) =>
      isObject(this.#layers.get(layer)!.permissions),
    );
    if (permissionLayers.length) {
      const mode = permissionLayers.find((layer) => {
        const raw = (this.#layers.get(layer)!.permissions as Obj).defaultMode;
        // `auto` and `bypassPermissions` do not take effect from project or local settings.
        return (
          typeof raw === "string" &&
          !(
            (layer === "project" || layer === "local") &&
            (raw === "auto" || raw === "bypassPermissions")
          )
        );
      });
      if (mode)
        lines.push(
          `permissions.defaultMode = ${JSON.stringify(redactText((this.#layers.get(mode)!.permissions as Obj).defaultMode as string))} (${mode})`,
        );
      for (const list of ["allow", "ask", "deny", "additionalDirectories"] as const) {
        const rules: string[] = [];
        const from: SettingsLayerId[] = [];
        for (const layer of permissionLayers) {
          const items = strings((this.#layers.get(layer)!.permissions as Obj)[list]);
          if (items.length) from.push(layer);
          for (const item of items) if (!rules.includes(item)) rules.push(item);
        }
        if (!rules.length) continue;
        lines.push(
          `permissions.${list}: ${rules.length} ${rules.length === 1 ? "entry" : "entries"} (${from.join(", ")})`,
        );
        // Rules can contain commands and URLs, so only the app gets to see them, redacted.
        if (full)
          for (const rule of rules.slice(0, MAX_LIST)) lines.push(`  - ${redactText(rule)}`);
        if (full && rules.length > MAX_LIST) lines.push(`  … (+${rules.length - MAX_LIST} more)`);
      }
    }

    // env: names only
    const env = this.envNames().filter((entry) => layers.includes(entry.layer));
    if (env.length) {
      const names = [...new Set(env.map((entry) => entry.name))];
      lines.push(
        full
          ? `env: ${names.length} ${names.length === 1 ? "name" : "names"}, values hidden: ${names.slice(0, MAX_LIST).join(", ")}`
          : `env: ${names.length} ${names.length === 1 ? "name" : "names"}, values hidden`,
      );
    }

    // credential helpers: configured, never the command
    for (const key of [...CREDENTIAL_HELPERS].sort())
      if (where(key).length) lines.push(`${key}: configured, value hidden ${tag(key)}`);
    // commands that are shown redacted in the app
    for (const key of [...COMMAND_KEYS].sort()) {
      if (!where(key).length) continue;
      const raw = value(key);
      const command =
        typeof raw === "string"
          ? raw
          : isObject(raw) && typeof raw.command === "string"
            ? raw.command
            : undefined;
      if (!full) lines.push(`${key}: configured ${tag(key)}`);
      else if (command !== undefined)
        lines.push(`${key}: command ${redactText(command)} ${tag(key)}`);
      else lines.push(`${key}: configured ${tag(key)}`);
    }

    // hooks
    const hooks = this.hooks().filter((hook) => (layers as readonly string[]).includes(hook.layer));
    if (hooks.length) {
      if (full) {
        lines.push("hooks:");
        for (const hook of hooks.slice(0, MAX_LIST))
          lines.push(
            `  - ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.type}${hook.detail ? ` ${hook.detail}` : ""} (${hook.layer})`,
          );
        if (hooks.length > MAX_LIST) lines.push(`  … (+${hooks.length - MAX_LIST} more)`);
      } else {
        const events = new Set(hooks.map((hook) => hook.event));
        lines.push(
          `hooks: ${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"} for ${events.size} ${events.size === 1 ? "event" : "events"}, commands hidden`,
        );
      }
    }

    // plugins
    const plugins = [...this.enabledPlugins()].filter(([, entry]) => layers.includes(entry.layer));
    if (plugins.length)
      lines.push(
        `enabledPlugins: ${plugins
          .slice(0, MAX_LIST)
          .map(([id, entry]) => `${safeName(id)} ${entry.enabled ? "on" : "off"} (${entry.layer})`)
          .join(", ")}`,
      );

    // lists shown by name
    for (const key of [
      "claudeMdExcludes",
      "enabledMcpjsonServers",
      "disabledMcpjsonServers",
    ] as const) {
      const items = [
        ...new Set(where(key).flatMap((layer) => strings(this.#layers.get(layer)![key]))),
      ];
      if (!items.length) continue;
      lines.push(
        full
          ? `${key}: ${items.length} (${where(key).join(", ")}): ${items
              .slice(0, MAX_LIST)
              .map((item) => redactText(item))
              .join(", ")}`
          : `${key}: ${items.length}`,
      );
    }
    for (const key of ["allowedMcpServers", "deniedMcpServers"] as const) {
      const count = [
        ...new Set(
          where(key).flatMap((layer) =>
            Array.isArray(this.#layers.get(layer)![key])
              ? (this.#layers.get(layer)![key] as unknown[]).map((item) => JSON.stringify(item))
              : [],
          ),
        ),
      ].length;
      if (where(key).length)
        lines.push(
          `${key}: ${count} ${count === 1 ? "entry" : "entries"} (${where(key).join(", ")})`,
        );
    }
    const servers = layers.flatMap((layer) => {
      const raw = this.#layers.get(layer)!.managedMcpServers;
      return isObject(raw) ? Object.keys(raw) : [];
    });
    if (servers.length)
      lines.push(
        `managedMcpServers: ${servers.length} (names and definitions are shown in the MCP view)`,
      );
    if (where("claudeMd").length) {
      const text = this.managedClaudeMd();
      lines.push(
        `claudeMd: ${text ? `${Buffer.byteLength(text.text)} bytes` : "empty"} (managed; shown with the instructions)`,
      );
    }
    // plugin configuration: ids and the instruction choice only, option values can be secrets
    const configs = layers.flatMap((layer) => {
      const raw = this.#layers.get(layer)!.pluginConfigs;
      return isObject(raw) ? Object.keys(raw).map(safeName) : [];
    });
    if (configs.length)
      lines.push(
        `pluginConfigs: ${configs.length} plugin(s), option values hidden: ${[...new Set(configs)].slice(0, MAX_LIST).join(", ")}`,
      );
    const choice = this.instructionFiles();
    if (choice.layer && layers.includes(choice.layer))
      lines.push(`Project instructions = ${choice.value} (${choice.layer})`);
    const marketplaces = layers.flatMap((layer) => {
      const raw = this.#layers.get(layer)!.extraKnownMarketplaces;
      return isObject(raw) ? Object.keys(raw).map(safeName) : [];
    });
    if (marketplaces.length)
      lines.push(
        `extraKnownMarketplaces: ${[...new Set(marketplaces)].slice(0, MAX_LIST).join(", ")} (sources hidden)`,
      );

    // everything else: names only
    const other = new Map<string, SettingsLayerId>();
    for (const layer of layers)
      for (const key of Object.keys(this.#layers.get(layer)!))
        if (!DEDICATED.has(key) && !other.has(key)) other.set(key, layer);
    if (other.size)
      lines.push(
        `Other keys set (values not shown): ${[...other]
          .slice(0, MAX_KEYS)
          .map(([key, layer]) => `${safeName(key)} (${layer})`)
          .join(", ")}`,
      );
    return lines;
  }
}

function describeStatus(file: SettingsFile): string {
  switch (file.status) {
    case "ok":
      return `parsed, ${file.keys.length} ${file.keys.length === 1 ? "key" : "keys"}`;
    case "missing":
      return "not found";
    case "unparseable":
      return file.position
        ? `cannot be parsed (line ${file.position.line}, column ${file.position.column})`
        : "cannot be parsed";
    case "not-object":
      return "cannot be used (the top level is not an object)";
    case "too-large":
      return `skipped (larger than ${MAX_BYTES / 1024} KiB)`;
    case "network":
      return "skipped (network path)";
    case "sensitive":
      return "skipped (sensitive path)";
    default:
      return "could not be read";
  }
}

export function summarizeHooks(hooks: unknown, layer: string): HookSummary[] {
  if (!isObject(hooks)) return [];
  const output: HookSummary[] = [];
  for (const event of Object.keys(hooks).slice(0, 40)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups.slice(0, 20)) {
      if (!isObject(group)) continue;
      const matcher = typeof group.matcher === "string" ? safeName(group.matcher) : undefined;
      const list = Array.isArray(group.hooks) ? group.hooks.slice(0, 20) : [];
      for (const hook of list) {
        if (!isObject(hook)) continue;
        const type = typeof hook.type === "string" ? safeName(hook.type) : "command";
        let detail = "";
        if (typeof hook.command === "string") detail = redactText(hook.command);
        else if (typeof hook.url === "string") detail = redactText(hook.url);
        else if (typeof hook.prompt === "string") detail = `(${hook.prompt.length} characters)`;
        output.push({
          layer,
          event: safeName(event),
          ...(matcher ? { matcher } : {}),
          type,
          detail,
        });
      }
    }
  }
  return output;
}
