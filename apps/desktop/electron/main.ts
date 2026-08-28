import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { RUNTIME_METHODS, type RuntimeHandshakeResult } from "./generated/runtime-protocol";
import { DesktopRuntimeHost } from "./runtime-host";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const appFlavor = process.env.AGENTKIB_DEV === "1" ? "ai.agentkib.dev" : "ai.agentkib";
const electronDataPath = path.join(app.getPath("appData"), appFlavor, "electron");
app.setPath("userData", electronDataPath);
app.setPath("sessionData", electronDataPath);

let mainWindow: BrowserWindow | undefined;
let runtimeHost: DesktopRuntimeHost | undefined;
let runtimeHandshake: RuntimeHandshakeResult | undefined;
let shutdownStarted = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startApplication).catch(showStartupFailure);
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && runtimeHandshake) void createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted || !runtimeHost) return;
  event.preventDefault();
  shutdownStarted = true;
  void runtimeHost.stop().finally(() => app.quit());
});

async function startApplication(): Promise<void> {
  if (process.env.AGENTKIB_DEV === "1") app.setName("AgentKib Dev");
  await registerRendererProtocol();

  runtimeHost = new DesktopRuntimeHost({
    executablePath: resolveRuntimeExecutable(),
    clientVersion: app.getVersion(),
    environment: {
      AGENTKIB_APP_FLAVOR: appFlavor,
      AGENTKIB_APP_NAME: process.env.AGENTKIB_DEV === "1" ? "AgentKib Dev" : "AgentKib",
      AGENTKIB_APP_VERSION: app.getVersion(),
      AGENTKIB_SYSTEM_THEME: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    },
  });
  runtimeHost.on("ready", (handshake: RuntimeHandshakeResult) => {
    runtimeHandshake = handshake;
  });
  runtimeHost.on("crash-loop", (error: Error) => void showStartupFailure(error));
  runtimeHandshake = await runtimeHost.start();

  ipcMain.handle("agentkib:runtime:handshake", (event) => {
    assertTrustedRenderer(event);
    if (!runtimeHandshake) throw new Error("AgentKib runtime is not ready");
    return runtimeHandshake;
  });
  registerWorkspaceIpc();
  registerHomeIpc();
  registerShellIpc();

  await createMainWindow();
}

function registerWorkspaceIpc(): void {
  ipcMain.handle("agentkib:workspace:scan", (event, project: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.scanWorkspace, {
      project: requireString(project, "project"),
    });
  });
  ipcMain.handle("agentkib:workspace:prepare-manifest", (event, project: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.prepareManifest, {
      project: requireString(project, "project"),
    });
  });
  ipcMain.handle(
    "agentkib:workspace:resolve-context",
    (event, project: unknown, cwd: unknown, agent: unknown) => {
      assertTrustedRenderer(event);
      const parsedAgent = requireString(agent, "agent");
      if (!KNOWN_AGENTS.has(parsedAgent)) throw new Error(`Unsupported agent: ${parsedAgent}`);
      return requireRuntime().request(RUNTIME_METHODS.resolveContext, {
        project: requireString(project, "project"),
        cwd: requireString(cwd, "cwd"),
        agent: parsedAgent,
      });
    },
  );
  ipcMain.handle("agentkib:workspace:add", (event, workspacePath: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.addWorkspace, {
      path: requireString(workspacePath, "path"),
    });
  });
  ipcMain.handle("agentkib:workspace:refresh", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.refreshWorkspace, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:workspace:exclude", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.excludeWorkspace, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:workspace:restore-excluded", (event, workspacePath: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.restoreExcludedWorkspace, {
      path: requireString(workspacePath, "path"),
    });
  });
  ipcMain.handle("agentkib:workspace:doctor-report", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.workspaceDoctorReport, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:workspace:git-summary", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.workspaceGitSummary, {
      id: requireString(id, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:workspace:git-history", (event, id: unknown, query: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.workspaceGitHistory, {
      workspaceId: requireString(id, "workspaceId"),
      query: requireObject(query, "git history query"),
    });
  });
  ipcMain.handle("agentkib:workspace:git-commit-files", (event, id: unknown, oid: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.gitCommitFiles, {
      workspaceId: requireString(id, "workspaceId"),
      oid: requireString(oid, "oid"),
    });
  });
  ipcMain.handle("agentkib:workspace:git-diff", (event, id: unknown, request: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.gitDiff, {
      workspaceId: requireString(id, "workspaceId"),
      request: requireObject(request, "git diff request"),
    });
  });
  ipcMain.handle("agentkib:workspace:openers", async (event, id: unknown) => {
    assertTrustedRenderer(event);
    const workspace = await findWorkspace(requireString(id, "workspaceId"));
    if (!workspace) return [];
    return [
      {
        id: "system-file-manager",
        name: process.platform === "darwin" ? "Finder" : "File manager",
        category: "file-manager",
        preferred: true,
      },
    ];
  });
  ipcMain.handle("agentkib:workspace:open", async (event, id: unknown, openerId: unknown) => {
    assertTrustedRenderer(event);
    if (openerId !== undefined && openerId !== "system-file-manager") {
      throw new Error(`Unsupported workspace opener: ${String(openerId)}`);
    }
    const workspace = await findWorkspace(requireString(id, "workspaceId"));
    if (!workspace) throw new Error("Workspace not found");
    const error = await shell.openPath(workspace.path);
    if (error) throw new Error(error);
  });
}

async function findWorkspace(id: string): Promise<{ path: string } | undefined> {
  const workspaces = await requireRuntime().request(RUNTIME_METHODS.listWorkspaces, {});
  if (!Array.isArray(workspaces)) return undefined;
  const workspace = workspaces.find(
    (value): value is { id: string; path: string } =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "path" in value &&
      (value as { id?: unknown }).id === id &&
      typeof (value as { path?: unknown }).path === "string",
  );
  return workspace ? { path: workspace.path } : undefined;
}

function registerShellIpc(): void {
  ipcMain.handle("agentkib:shell:open-directory", async (event, title: unknown) => {
    assertTrustedRenderer(event);
    const window = mainWindow;
    if (!window) throw new Error("AgentKib window is not ready");
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
      title: title === undefined ? undefined : requireText(title, "title"),
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
}

function registerHomeIpc(): void {
  ipcMain.handle("agentkib:home:runtime", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.runtimeInfo, {});
  });
  ipcMain.handle("agentkib:home:workspaces", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listWorkspaces, {});
  });
  ipcMain.handle("agentkib:home:agent-installations", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listAgentInstallations, {});
  });
  ipcMain.handle("agentkib:home:catalog-assets", (event, input: unknown) => {
    assertTrustedRenderer(event);
    const value = requireObject(input, "catalog query");
    return requireRuntime().request(RUNTIME_METHODS.searchCatalogAssets, {
      query: value.query === undefined ? "" : requireText(value.query, "query"),
      agent: optionalString(value.agent, "agent"),
      workspaceId: optionalString(value.workspaceId, "workspaceId"),
      limit: optionalPositiveInteger(value.limit, "limit") ?? 500,
    });
  });
  ipcMain.handle("agentkib:home:global-memories", (event, status: unknown) => {
    assertTrustedRenderer(event);
    if (status !== undefined && !MEMORY_STATUSES.has(requireString(status, "status"))) {
      throw new Error(`Unsupported memory status: ${String(status)}`);
    }
    return requireRuntime().request(RUNTIME_METHODS.listGlobalMemories, { status });
  });
  ipcMain.handle("agentkib:home:activity", (event, limit: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listActivity, {
      limit: optionalPositiveInteger(limit, "limit") ?? 200,
    });
  });
  ipcMain.handle("agentkib:home:scan-roots", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listScanRoots, {});
  });
  ipcMain.handle("agentkib:home:excluded-workspaces", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listExcludedWorkspaces, {});
  });
  ipcMain.handle("agentkib:home:remote-gateways", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listRemoteGateways, {});
  });
  ipcMain.handle("agentkib:home:insights-summary", (event, query: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.insightsSummary, {
      query: requireObject(query, "insights query"),
    });
  });
  ipcMain.handle("agentkib:home:insights-status", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.insightsStatus, {});
  });
  ipcMain.handle("agentkib:home:quota-collector-status", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.quotaCollectorStatus, {});
  });
  ipcMain.handle("agentkib:home:refresh-status", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.refreshStatus, {});
  });
  ipcMain.handle("agentkib:home:update-onboarding", (event, onboardingEvent: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.updateOnboarding, {
      event: requireObject(onboardingEvent, "onboarding event"),
    });
  });
  ipcMain.handle("agentkib:home:obsidian-integration", (event) => {
    assertTrustedRenderer(event);
    return {
      installation: {
        installed: false,
        app_path: undefined,
        version: undefined,
        cli_available: false,
      },
      vaults: [],
      workspace_links: [],
    };
  });
  ipcMain.handle("agentkib:workspace:doctor-summaries", (event, ids: unknown) => {
    assertTrustedRenderer(event);
    if (!Array.isArray(ids)) throw new TypeError("workspaceIds must be an array");
    const workspaceIds = ids.map((id) => requireString(id, "workspaceId"));
    if (workspaceIds.length > 100) throw new RangeError("workspaceIds cannot exceed 100 items");
    return requireRuntime().request(RUNTIME_METHODS.workspaceDoctorSummaries, { workspaceIds });
  });
}

const KNOWN_AGENTS = new Set([
  "codex",
  "claude-code",
  "cursor",
  "open-claw",
  "hermes",
  "deepseek-harness",
]);
const MEMORY_STATUSES = new Set(["pending", "approved", "rejected", "invalidated"]);

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Rejected IPC from an unknown renderer");
  }
}

function requireRuntime(): DesktopRuntimeHost {
  if (!runtimeHost || !runtimeHandshake) throw new Error("AgentKib runtime is not ready");
  return runtimeHost;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : requireString(value, name);
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: "AgentKib",
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 680,
    show: false,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const allowedOrigin = process.env.VITE_DEV_SERVER_URL
      ? new URL(process.env.VITE_DEV_SERVER_URL).origin
      : "app://bundle";
    if (new URL(targetUrl).origin !== allowedOrigin) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await window.loadURL("app://bundle/index.html");
}

async function registerRendererProtocol(): Promise<void> {
  const rendererRoot = path.resolve(app.getAppPath(), "dist");
  await protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "bundle") return new Response("Not found", { status: 404 });

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    let assetPath = path.resolve(rendererRoot, relativePath);
    if (!isWithin(rendererRoot, assetPath)) return new Response("Forbidden", { status: 403 });

    let contents: Buffer;
    try {
      contents = await readFile(assetPath);
    } catch {
      assetPath = path.join(rendererRoot, "index.html");
      contents = await readFile(assetPath);
    }

    return new Response(contents, {
      headers: {
        "content-type": contentType(assetPath),
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
      },
    });
  });
}

function resolveRuntimeExecutable(): string {
  if (process.env.AGENTKIB_RUNTIME_PATH) return process.env.AGENTKIB_RUNTIME_PATH;
  const executable = process.platform === "win32" ? "agentkib-runtime.exe" : "agentkib-runtime";
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", executable);
  return path.resolve(process.cwd(), "../../target/debug", executable);
}

async function showStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AgentKib failed to start: ${message}\n`);
  if (!app.isReady()) return;

  const window = new BrowserWindow({
    title: "AgentKib startup error",
    width: 720,
    height: 420,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const html = `<!doctype html><meta charset="utf-8"><title>AgentKib startup error</title><style>body{font:14px system-ui;background:#111;color:#eee;padding:32px}code{white-space:pre-wrap;color:#fca5a5}</style><h1>AgentKib could not start</h1><p>The Rust runtime did not become ready.</p><code>${escapeHtml(message)}</code>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character];
  });
}
