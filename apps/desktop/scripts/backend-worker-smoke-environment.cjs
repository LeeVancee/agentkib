const path = require("node:path");

// Preserve command/native-library lookup on Windows, plus locale settings. Agent
// overrides, credentials and Node/Electron injection flags must not cross this boundary.
const runtimeVariables = new Map(
  [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "SystemDrive",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
    "OS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ].map((name) => [name.toUpperCase(), name]),
);

function createIsolatedWorkerEnvironment(root, source = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    const runtimeName = runtimeVariables.get(name.toUpperCase());
    if (runtimeName && value !== undefined) environment[runtimeName] = value;
  }
  Object.assign(environment, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, "AppData/Roaming"),
    LOCALAPPDATA: path.join(root, "AppData/Local"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    TMPDIR: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_DATA_HOME: path.join(root, ".local/share"),
    XDG_STATE_HOME: path.join(root, ".local/state"),
    XDG_CACHE_HOME: path.join(root, ".cache"),
    XDG_DATA_DIRS: path.join(root, "system-data"),
    AGENTKIB_HOME: path.join(root, "library"),
    AGENTKIB_DATA_DIR: path.join(root, "data"),
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
    CODEX_HOME: path.join(root, ".codex"),
    CURSOR_CONFIG_DIR: path.join(root, ".cursor"),
    CURSOR_DATA_DIR: path.join(root, ".cursor"),
    HERMES_HOME: path.join(root, ".hermes"),
    OPENCLAW_HOME: root,
    OPENCLAW_PROFILE: "default",
    OPENCLAW_STATE_DIR: path.join(root, ".openclaw"),
    OPENCLAW_CONFIG_PATH: path.join(root, ".openclaw/openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: path.join(root, ".openclaw/workspace"),
    GROK_HOME: path.join(root, ".grok"),
    DSH_HOME: path.join(root, ".dsh"),
    OPENCODE_CONFIG: path.join(root, ".config/opencode/opencode.json"),
    OPENCODE_CONFIG_DIR: path.join(root, ".config/opencode"),
  });
  if (process.platform === "win32") {
    environment.HOMEDRIVE = path.parse(root).root.replace(/[\\/]$/, "");
    environment.HOMEPATH = root.slice(environment.HOMEDRIVE.length);
  }
  return environment;
}

module.exports = { createIsolatedWorkerEnvironment };
