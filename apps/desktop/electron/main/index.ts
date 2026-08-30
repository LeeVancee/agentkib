import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import { RUNTIME_METHODS, type RuntimeHandshakeResult } from "../generated/runtime-protocol";
import { DesktopRuntimeHost } from "./runtime-host";
import { registerRuntimeIpc } from "./ipc/runtime";
import {
  assertTrustedRenderer as assertTrustedRendererEvent,
  optionalCloseBehavior,
  optionalPositiveInteger,
  optionalString,
  requireAppIconPreference,
  requireBoolean,
  requireObject,
  requirePositiveInteger,
  requireString,
  requireText,
  requireThemePreference,
} from "./ipc/validation";

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
let tray: Tray | undefined;
let runtimeHost: DesktopRuntimeHost | undefined;
let runtimeHandshake: RuntimeHandshakeResult | undefined;
let shutdownStarted = false;
let quitApproved = false;
let closeBehavior: "minimize-to-tray" | "quit" | undefined;
let appIconPreference: "white" | "black" = "white";
let pendingUpdateVersion: string | undefined;
let applicationInitialized = false;
let applicationInitialization: Promise<void> | undefined;
let startupFailureWindow: BrowserWindow | undefined;
let ipcHandlersRegistered = false;
let nativeShellCreated = false;
let quotaRefreshTimer: NodeJS.Timeout | undefined;
let quotaRefreshPromise: Promise<ElectronQuotaRefreshReceipt> | undefined;
let insightsRefreshTimer: NodeJS.Timeout | undefined;
let insightsRefreshPromise: Promise<ElectronInsightsRefreshReceipt> | undefined;

const QUOTA_REFRESH_INTERVAL_MS = 60_000;
const QUOTA_REFRESH_VISIBLE_MAX_AGE_MS = 5 * 60_000;
const QUOTA_REFRESH_BACKGROUND_MAX_AGE_MS = 15 * 60_000;
const QUOTA_RESET_GRACE_MS = 60_000;
const INSIGHTS_INITIAL_DELAY_MS = 30_000;
const INSIGHTS_REFRESH_INTERVAL_MS = 60_000;
const INSIGHTS_MAX_AGE_MS = 30 * 60_000;

interface ElectronRuntimeInfo {
  close_behavior?: "minimize-to-tray" | "quit";
  app_icon_preference?: "white" | "black";
  theme_preference?: "system" | "light" | "dark";
  effective_theme?: "light" | "dark";
  quota_auto_refresh_enabled?: boolean;
}

interface ElectronQuotaWindow {
  remaining_percent?: number;
  reset_at?: string;
}

interface ElectronQuotaProvider {
  windows?: ElectronQuotaWindow[];
  accounts?: Array<{ windows?: ElectronQuotaWindow[] }>;
}

interface ElectronQuotaSnapshot {
  freshness?: "fresh" | "stale" | "unavailable";
  providers?: ElectronQuotaProvider[];
}

interface ElectronQuotaCollectorStatus {
  last_success_at?: string;
}

interface ElectronQuotaRefreshReceipt {
  kind: "quota";
  disposition: "queued" | "already-running" | "backoff";
  request_id: string;
  status: {
    kind: "quota";
    state: "succeeded";
    request_id: string;
    queued_at: string;
    started_at: string;
    finished_at: string;
    progress_current: number;
    progress_total: number;
    error?: string;
    next_allowed_at?: string;
  };
}

interface ElectronInsightsStatus {
  refreshed_at?: string;
}

interface ElectronInsightsRefreshReceipt {
  kind: "insights";
  disposition: "queued" | "already-running" | "backoff";
  request_id: string;
  status: {
    kind: "insights";
    state: "succeeded";
    request_id: string;
    queued_at: string;
    started_at: string;
    finished_at: string;
    progress_current: number;
    progress_total: number;
    error?: string;
    next_allowed_at?: string;
  };
}

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
  if (BrowserWindow.getAllWindows().length === 0 && applicationInitialized) void createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted || !runtimeHost) return;
  if (!quitApproved) {
    event.preventDefault();
    requestRendererQuitGuard();
    return;
  }
  event.preventDefault();
  shutdownStarted = true;
  stopQuotaScheduler();
  stopInsightsScheduler();
  void runtimeHost.stop().finally(() => app.quit());
});

nativeTheme.on("updated", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    "agentkib:theme-changed",
    nativeTheme.shouldUseDarkColors ? "dark" : "light",
  );
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
      AGENTKIB_LOCALE: normalizeSystemLocale(app.getLocale()),
      AGENTKIB_SYSTEM_THEME: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      AGENTKIB_QUOTA_SIDECAR: resolveQuotaSidecar(),
    },
  });
  runtimeHost.on("ready", (handshake: RuntimeHandshakeResult) => {
    runtimeHandshake = handshake;
    if (!applicationInitialized) {
      void initializeApplication().catch(showStartupFailure);
    }
  });
  runtimeHost.on("crash-loop", (error: Error) => void showStartupFailure(error));
  runtimeHandshake = await runtimeHost.start();
  await initializeApplication();
}

async function initializeApplication(): Promise<void> {
  if (applicationInitialized) return;
  if (applicationInitialization) return applicationInitialization;

  applicationInitialization = (async () => {
    const runtime = await requireRuntime().request<ElectronRuntimeInfo>(
      RUNTIME_METHODS.runtimeInfo,
      {},
    );
    closeBehavior = runtime.close_behavior;
    appIconPreference = runtime.app_icon_preference ?? "white";
    applyApplicationIcon(appIconPreference);
    if (runtime.theme_preference) nativeTheme.themeSource = runtime.theme_preference;
    else if (runtime.effective_theme) nativeTheme.themeSource = runtime.effective_theme;

    if (!ipcHandlersRegistered) {
      ipcMain.handle("agentkib:runtime:handshake", (event) => {
        assertTrustedRenderer(event);
        if (!runtimeHandshake) throw new Error("AgentKib runtime is not ready");
        return runtimeHandshake;
      });
      registerRuntimeIpc({
        runtime: requireRuntime,
        mainWindow: () => mainWindow,
        withRuntimeCapabilities: withElectronRuntimeCapabilities,
      });
      registerHomeIpc();
      registerShellIpc();
      registerUpdateIpc();
      ipcHandlersRegistered = true;
    }

    if (!nativeShellCreated) {
      createNativeShell();
      nativeShellCreated = true;
    }
    await createMainWindow();
    applicationInitialized = true;
    startQuotaScheduler();
    startInsightsScheduler();
    if (startupFailureWindow && !startupFailureWindow.isDestroyed()) {
      startupFailureWindow.close();
      startupFailureWindow = undefined;
    }
  })();

  try {
    await applicationInitialization;
  } catch (error) {
    applicationInitialization = undefined;
    throw error;
  }
}

function createNativeShell(): void {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.getName(),
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "View",
          submenu: [{ role: "toggleDevTools" }, { role: "togglefullscreen" }],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  const image = createTrayImage();
  if (image.isEmpty()) return;
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(`${app.getName()} · Local Agent assets`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${app.getName()}`, click: showMainWindow },
      { type: "separator" },
      { label: `Quit ${app.getName()}`, click: () => app.quit() },
    ]),
  );
  tray.on("click", showMainWindow);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function requestRendererQuitGuard(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    quitApproved = true;
    app.quit();
    return;
  }
  if (!window.isVisible()) window.show();
  window.focus();
  window.webContents.send("agentkib:quit-requested");
}

function withElectronRuntimeCapabilities(runtime: unknown): unknown {
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) return runtime;
  const enriched = { ...(runtime as Record<string, unknown>) };
  enriched.tray_available = Boolean(tray && !tray.isDestroyed());
  if (enriched.theme_preference === "system") {
    enriched.effective_theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }
  return enriched;
}

function startQuotaScheduler(): void {
  stopQuotaScheduler();
  void requestQuotaIfDue().catch(() => undefined);
  quotaRefreshTimer = setInterval(() => {
    void requestQuotaIfDue().catch(() => undefined);
  }, QUOTA_REFRESH_INTERVAL_MS);
}

function stopQuotaScheduler(): void {
  if (!quotaRefreshTimer) return;
  clearInterval(quotaRefreshTimer);
  quotaRefreshTimer = undefined;
}

function startInsightsScheduler(): void {
  stopInsightsScheduler();
  insightsRefreshTimer = setTimeout(() => {
    void requestInsightsIfDue().catch(() => undefined);
    insightsRefreshTimer = setInterval(() => {
      void requestInsightsIfDue().catch(() => undefined);
    }, INSIGHTS_REFRESH_INTERVAL_MS);
  }, INSIGHTS_INITIAL_DELAY_MS);
}

function stopInsightsScheduler(): void {
  if (!insightsRefreshTimer) return;
  clearTimeout(insightsRefreshTimer);
  insightsRefreshTimer = undefined;
}

async function requestInsightsIfDue(): Promise<void> {
  if (!applicationInitialized || !runtimeHandshake || shutdownStarted || insightsRefreshPromise)
    return;

  const host = requireRuntime();
  const status = await host.request<ElectronInsightsStatus>(RUNTIME_METHODS.insightsStatus, {});
  const refreshedAt = status.refreshed_at ? Date.parse(status.refreshed_at) : Number.NaN;
  if (Number.isFinite(refreshedAt) && Date.now() - refreshedAt < INSIGHTS_MAX_AGE_MS) return;
  await requestInsightsRefresh(host);
}

function requestInsightsRefresh(host = requireRuntime()): Promise<ElectronInsightsRefreshReceipt> {
  if (insightsRefreshPromise) return insightsRefreshPromise;

  const requestId = `electron-insights-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const promise = host
    .request<ElectronInsightsRefreshReceipt>(RUNTIME_METHODS.refreshInsights, {})
    .then((receipt) => {
      emitElectronRefreshState(receipt.status);
      return receipt;
    })
    .catch((error: unknown) => {
      emitElectronRefreshState({
        kind: "insights",
        state: "failed",
        request_id: requestId,
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  insightsRefreshPromise = promise;
  void promise
    .finally(() => {
      if (insightsRefreshPromise === promise) insightsRefreshPromise = undefined;
    })
    .catch(() => undefined);
  emitElectronRefreshState({
    kind: "insights",
    state: "running",
    request_id: requestId,
    queued_at: startedAt,
    started_at: startedAt,
  });
  return promise;
}

function requestRefreshWithEvents(
  kind: "discovery" | "storage",
  method: string,
): Promise<{ status: unknown }> {
  const requestId = `electron-${kind}-${Date.now()}`;
  const startedAt = new Date().toISOString();
  emitElectronRefreshState({
    kind,
    state: "running",
    request_id: requestId,
    queued_at: startedAt,
    started_at: startedAt,
  });
  return requireRuntime()
    .request<{ status: unknown }>(method, {})
    .then((receipt) => {
      emitElectronRefreshState(receipt.status);
      return receipt;
    })
    .catch((error: unknown) => {
      emitElectronRefreshState({
        kind,
        state: "failed",
        request_id: requestId,
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
}

async function requestQuotaIfDue(): Promise<void> {
  if (!applicationInitialized || !runtimeHandshake || shutdownStarted || quotaRefreshPromise)
    return;

  const host = requireRuntime();
  const runtime = await host.request<ElectronRuntimeInfo>(RUNTIME_METHODS.runtimeInfo, {});
  if (!runtime.quota_auto_refresh_enabled) return;

  const [snapshot, collectorStatus] = await Promise.all([
    host.request<ElectronQuotaSnapshot | undefined>(RUNTIME_METHODS.quotaSnapshot, {}),
    host.request<ElectronQuotaCollectorStatus>(RUNTIME_METHODS.quotaCollectorStatus, {}),
  ]);
  const lastSuccessAt = collectorStatus.last_success_at
    ? Date.parse(collectorStatus.last_success_at)
    : Number.NaN;
  const lowRemaining = snapshot?.providers?.some((provider) => {
    const windows = [
      ...(provider.windows ?? []),
      ...(provider.accounts ?? []).flatMap((account) => account.windows ?? []),
    ];
    return windows.some(
      (window) =>
        typeof window.remaining_percent === "number" &&
        Number.isFinite(window.remaining_percent) &&
        window.remaining_percent <= 20,
    );
  });
  const windowVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const maxAge =
    windowVisible || lowRemaining
      ? QUOTA_REFRESH_VISIBLE_MAX_AGE_MS
      : QUOTA_REFRESH_BACKGROUND_MAX_AGE_MS;
  const staleByAge = !Number.isFinite(lastSuccessAt) || Date.now() - lastSuccessAt >= maxAge;
  const resetDue = snapshot?.providers?.some((provider) => {
    const windows = [
      ...(provider.windows ?? []),
      ...(provider.accounts ?? []).flatMap((account) => account.windows ?? []),
    ];
    return windows.some((window) => {
      const resetAt = window.reset_at ? Date.parse(window.reset_at) : Number.NaN;
      return (
        Number.isFinite(resetAt) &&
        resetAt <= Date.now() - QUOTA_RESET_GRACE_MS &&
        (!Number.isFinite(lastSuccessAt) || lastSuccessAt < resetAt)
      );
    });
  });

  if (snapshot?.freshness !== "stale" && !staleByAge && !resetDue) return;
  await requestQuotaRefresh(host);
}

function requestQuotaRefresh(host = requireRuntime()): Promise<ElectronQuotaRefreshReceipt> {
  if (quotaRefreshPromise) return quotaRefreshPromise;

  const startedAt = new Date().toISOString();
  const promise = host
    .request<ElectronQuotaRefreshReceipt>(RUNTIME_METHODS.refreshQuota, {})
    .then((receipt) => {
      emitElectronRefreshState(receipt.status);
      void host
        .request<ElectronQuotaSnapshot | undefined>(RUNTIME_METHODS.quotaSnapshot, {})
        .then((snapshot) => {
          if (snapshot) sendRendererEvent("agentkib:quota-updated", snapshot);
        })
        .catch(() => undefined);
      return receipt;
    })
    .catch((error: unknown) => {
      emitElectronRefreshState({
        kind: "quota",
        state: "failed",
        request_id: `electron-quota-${Date.now()}`,
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  quotaRefreshPromise = promise;
  void promise
    .finally(() => {
      if (quotaRefreshPromise === promise) quotaRefreshPromise = undefined;
    })
    .catch(() => undefined);
  emitElectronRefreshState({
    kind: "quota",
    state: "running",
    request_id: `electron-quota-${Date.now()}`,
    queued_at: startedAt,
    started_at: startedAt,
  });
  return promise;
}

function emitElectronRefreshState(status: unknown): void {
  sendRendererEvent("agentkib:electron-refresh-state", status);
}

function sendRendererEvent(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function registerUpdateIpc(): void {
  const updaterChannel =
    process.platform === "darwin" || process.platform === "win32" ? process.arch : undefined;
  if (updaterChannel) autoUpdater.channel = updaterChannel;
  (autoUpdater as import("node:events").EventEmitter).on("before-quit-for-update", () => {
    quitApproved = true;
  });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  ipcMain.handle("agentkib:updates:check", async (event) => {
    assertTrustedRenderer(event);
    if (!app.isPackaged || process.env.AGENTKIB_DEV === "1") return undefined;
    const result = await autoUpdater.checkForUpdates();
    const update = result?.updateInfo;
    if (!update || update.version === app.getVersion()) {
      pendingUpdateVersion = undefined;
      return undefined;
    }
    pendingUpdateVersion = update.version;
    const releaseNotes = update.releaseNotes;
    const notes =
      typeof releaseNotes === "string"
        ? releaseNotes
        : Array.isArray(releaseNotes)
          ? releaseNotes
              .map((entry) => entry.note ?? "")
              .filter(Boolean)
              .join("\n\n") || undefined
          : undefined;
    return {
      current_version: app.getVersion(),
      version: update.version,
      published_at: update.releaseDate || undefined,
      notes,
      release_url: `https://github.com/starroyhq/agentkib/releases/tag/v${update.version}`,
      install_mode: process.platform === "linux" && !process.env.APPIMAGE ? "manual" : "in-app",
    };
  });
  ipcMain.handle("agentkib:updates:install", async (event, version: unknown) => {
    assertTrustedRenderer(event);
    if (!app.isPackaged || process.env.AGENTKIB_DEV === "1") {
      throw new Error("errors.updateUnavailableInDevelopment");
    }
    const expectedVersion = requireString(version, "version");
    if (process.platform === "linux" && !process.env.APPIMAGE) {
      throw new Error("errors.updateManualInstallRequired");
    }
    if (pendingUpdateVersion !== expectedVersion) {
      throw new Error("errors.updateChanged");
    }
    const progressChannel = "agentkib:updates:progress";
    const onProgress = (progress: { transferred: number; total: number }) => {
      event.sender.send(progressChannel, {
        event: "progress",
        data: {
          downloaded: progress.transferred,
          content_length: progress.total || undefined,
        },
      });
    };
    autoUpdater.on("download-progress", onProgress);
    try {
      event.sender.send(progressChannel, { event: "started", data: {} });
      await autoUpdater.downloadUpdate();
      event.sender.send(progressChannel, { event: "finished" });
      pendingUpdateVersion = undefined;
      autoUpdater.quitAndInstall();
    } finally {
      autoUpdater.removeListener("download-progress", onProgress);
    }
  });
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
  ipcMain.handle("agentkib:shell:open-external", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const target = new URL(requireText(value, "url"));
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("Only HTTP(S) external URLs are supported");
    }
    await shell.openExternal(target.toString());
  });
  ipcMain.handle("agentkib:shell:open-files-and-folders-settings", (event) => {
    assertTrustedRenderer(event);
    const settingsUrl =
      process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        : process.platform === "win32"
          ? "ms-settings:privacy-broadfilesystemaccess"
          : undefined;
    if (!settingsUrl) throw new Error("Opening file and folder settings is not supported");
    return shell.openExternal(settingsUrl);
  });
  ipcMain.handle("agentkib:shell:open-quota-dashboard", (event, request: unknown) => {
    assertTrustedRenderer(event);
    const navigation = requireObject(request, "navigation request");
    if (navigation.page !== "quota") throw new Error("Only quota navigation is supported");
    showMainWindow();
    mainWindow?.webContents.send("agentkib:navigate", navigation);
  });
  ipcMain.handle("agentkib:shell:hide-window", (event) => {
    assertTrustedRenderer(event);
    BrowserWindow.fromWebContents(event.sender)?.hide();
  });
  ipcMain.handle("agentkib:shell:quit", (event) => {
    assertTrustedRenderer(event);
    quitApproved = true;
    app.quit();
  });
  ipcMain.handle("agentkib:settings:set-close-behavior", (event, value: unknown) => {
    assertTrustedRenderer(event);
    const next = optionalCloseBehavior(value);
    closeBehavior = next;
    return requireRuntime().request(RUNTIME_METHODS.setCloseBehavior, { value: next ?? null });
  });
  ipcMain.handle("agentkib:settings:set-locale", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request(RUNTIME_METHODS.setLocale, {
        preference: requireString(preference, "preference"),
      })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:settings:set-theme", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    const next = requireThemePreference(preference);
    nativeTheme.themeSource = next;
    return requireRuntime()
      .request(RUNTIME_METHODS.setThemePreference, { preference: next })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:settings:set-app-icon", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    const next = requireAppIconPreference(preference);
    return requireRuntime()
      .request(RUNTIME_METHODS.setAppIconPreference, { preference: next })
      .then((runtime) => {
        appIconPreference = next;
        applyApplicationIcon(appIconPreference);
        return withElectronRuntimeCapabilities(runtime);
      });
  });
}

function registerHomeIpc(): void {
  ipcMain.handle("agentkib:home:runtime", async (event) => {
    assertTrustedRenderer(event);
    const runtime = await requireRuntime().request(RUNTIME_METHODS.runtimeInfo, {});
    return withElectronRuntimeCapabilities(runtime);
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
  ipcMain.handle("agentkib:home:add-scan-root", (event, rootPath: unknown, maxDepth: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.addScanRoot, {
      path: requireString(rootPath, "path"),
      maxDepth: requirePositiveInteger(maxDepth, "maxDepth"),
    });
  });
  ipcMain.handle("agentkib:home:remove-scan-root", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.removeScanRoot, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-discovery", (event) => {
    assertTrustedRenderer(event);
    return requestRefreshWithEvents("discovery", RUNTIME_METHODS.refreshDiscovery);
  });
  ipcMain.handle("agentkib:home:discovery-report", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.discoveryReport, {});
  });
  ipcMain.handle("agentkib:home:excluded-workspaces", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listExcludedWorkspaces, {});
  });
  ipcMain.handle("agentkib:home:remote-gateways", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listRemoteGateways, {});
  });
  ipcMain.handle("agentkib:home:save-remote-gateway", (event, input: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.saveRemoteGateway, {
      input: requireObject(input, "remote gateway"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-remote-gateway", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.refreshRemoteGateway, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:home:remove-remote-gateway", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.removeRemoteGateway, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:home:insights-view", (event, query: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.insightsView, {
      query: requireObject(query, "insights query"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-insights", (event) => {
    assertTrustedRenderer(event);
    return requestInsightsRefresh();
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
  ipcMain.handle("agentkib:home:quota-snapshot", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.quotaSnapshot, {});
  });
  ipcMain.handle("agentkib:home:quota-preferences", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.quotaPreferences, {});
  });
  ipcMain.handle("agentkib:home:set-quota-preferences", (event, preferences: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.setQuotaPreferences, {
      preferences: requireObject(preferences, "quota preferences"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-quota", (event) => {
    assertTrustedRenderer(event);
    return requestQuotaRefresh();
  });
  ipcMain.handle("agentkib:home:set-quota-auto-refresh", (event, enabled: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request<ElectronRuntimeInfo>(RUNTIME_METHODS.setQuotaAutoRefresh, {
        value: requireBoolean(enabled, "enabled"),
      })
      .then((runtime) => {
        if (runtime.quota_auto_refresh_enabled) {
          void requestQuotaIfDue().catch(() => undefined);
        }
        return withElectronRuntimeCapabilities(runtime);
      });
  });
  ipcMain.handle("agentkib:home:set-quota-prompt-seen", (event, seen: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request(RUNTIME_METHODS.setQuotaPromptSeen, {
        value: requireBoolean(seen, "seen"),
      })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:home:refresh-status", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.refreshStatus, {});
  });
  ipcMain.handle("agentkib:home:storage-overview", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.storageOverview, {});
  });
  ipcMain.handle(
    "agentkib:home:storage-children",
    (event, workspaceId: unknown, relativePath: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.storageChildren, {
        workspaceId: requireString(workspaceId, "workspaceId"),
        relativePath: requireText(relativePath, "relativePath"),
      });
    },
  );
  ipcMain.handle("agentkib:home:refresh-storage", (event) => {
    assertTrustedRenderer(event);
    return requestRefreshWithEvents("storage", RUNTIME_METHODS.refreshStorage);
  });
  ipcMain.handle(
    "agentkib:home:open-storage-path",
    async (event, workspaceId: unknown, relativePath: unknown) => {
      assertTrustedRenderer(event);
      const target = await requireRuntime().request<string>(RUNTIME_METHODS.resolveStoragePath, {
        workspaceId: requireString(workspaceId, "workspaceId"),
        relativePath: requireText(relativePath, "relativePath"),
      });
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
    },
  );
  ipcMain.handle("agentkib:home:cancel-storage", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.cancelStorage, {});
  });
  ipcMain.handle("agentkib:home:update-onboarding", (event, onboardingEvent: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request(RUNTIME_METHODS.updateOnboarding, {
        event: requireObject(onboardingEvent, "onboarding event"),
      })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:home:obsidian-integration", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.obsidianIntegration, {});
  });
  ipcMain.handle("agentkib:home:add-obsidian-vault", (event, vaultPath: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.addObsidianVault, {
      path: requireString(vaultPath, "path"),
    });
  });
  ipcMain.handle(
    "agentkib:home:link-obsidian-workspace",
    (event, workspaceId: unknown, vaultPath: unknown, relativeTarget: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.linkObsidianWorkspace, {
        workspaceId: requireString(workspaceId, "workspaceId"),
        vaultPath: requireString(vaultPath, "vaultPath"),
        relativeTarget: optionalString(relativeTarget, "relativeTarget"),
      });
    },
  );
  ipcMain.handle("agentkib:home:unlink-obsidian-workspace", (event, workspaceId: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.unlinkObsidianWorkspace, {
      id: requireString(workspaceId, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:home:open-obsidian", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.openObsidian, {});
  });
  ipcMain.handle("agentkib:home:open-obsidian-workspace", (event, workspaceId: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.openObsidianWorkspace, {
      id: requireString(workspaceId, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:workspace:doctor-summaries", (event, ids: unknown) => {
    assertTrustedRenderer(event);
    if (!Array.isArray(ids)) throw new TypeError("workspaceIds must be an array");
    const workspaceIds = ids.map((id) => requireString(id, "workspaceId"));
    if (workspaceIds.length > 100) throw new RangeError("workspaceIds cannot exceed 100 items");
    return requireRuntime().request(RUNTIME_METHODS.workspaceDoctorSummaries, { workspaceIds });
  });
}

const MEMORY_STATUSES = new Set(["pending", "approved", "rejected", "invalidated"]);

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  assertTrustedRendererEvent(event, mainWindow);
}

function requireRuntime(): DesktopRuntimeHost {
  if (!runtimeHost || !runtimeHandshake) throw new Error("AgentKib runtime is not ready");
  return runtimeHost;
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
    ...(process.platform !== "darwin" ? { icon: resolveApplicationIcon() } : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 15, y: 25 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  window.on("close", (event) => {
    if (shutdownStarted || quitApproved) return;
    if (closeBehavior === "minimize-to-tray") {
      event.preventDefault();
      if (tray) window.hide();
      else window.minimize();
      return;
    }
    event.preventDefault();
    requestRendererQuitGuard();
  });
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

function resolveQuotaSidecar(): string {
  if (process.env.AGENTKIB_QUOTA_SIDECAR) return process.env.AGENTKIB_QUOTA_SIDECAR;
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "bin",
      process.platform === "win32" ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar",
    );
  }
  return path.resolve(
    process.cwd(),
    "build/quota",
    process.platform === "win32" ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar",
  );
}

function resolveTrayIcon(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "icons", "tray-icon.png");
  return path.resolve(app.getAppPath(), "resources/icons/tray-icon.png");
}

function createTrayImage(): Electron.NativeImage {
  const source = nativeImage.createFromPath(resolveTrayIcon());
  if (source.isEmpty() || process.platform !== "darwin") return source;

  const image = nativeImage.createEmpty();
  image.addRepresentation({
    scaleFactor: 1,
    width: 16,
    height: 16,
    buffer: source.resize({ width: 16, height: 16 }).toPNG(),
  });
  image.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: source.resize({ width: 32, height: 32 }).toPNG(),
  });
  return image;
}

function resolveApplicationIcon(preference = appIconPreference): string {
  const suffix = process.platform === "darwin" ? "-macos" : "";
  const filename = `app-icon-${preference}${suffix}.png`;
  if (app.isPackaged) return path.join(process.resourcesPath, "icons", filename);
  return path.resolve(app.getAppPath(), "resources/icons", filename);
}

function applyApplicationIcon(preference: "white" | "black"): void {
  const image = nativeImage.createFromPath(resolveApplicationIcon(preference));
  if (image.isEmpty()) return;
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(image);
}

function normalizeSystemLocale(locale: string | undefined): "zh-CN" | "zh-TW" | "ja-JP" | "en-US" {
  const normalized = locale?.replaceAll("_", "-").toLowerCase() ?? "";
  if (/^(zh|yue)-(hant|tw|hk|mo)(-|$)/.test(normalized)) return "zh-TW";
  if (/^zh-(hans|cn|sg)(-|$)/.test(normalized) || normalized === "zh") return "zh-CN";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja-JP";
  return "en-US";
}

async function showStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AgentKib failed to start: ${message}\n`);
  if (!app.isReady()) return;

  if (startupFailureWindow && !startupFailureWindow.isDestroyed()) {
    startupFailureWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    title: "AgentKib startup error",
    width: 720,
    height: 420,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  startupFailureWindow = window;
  window.once("closed", () => {
    if (startupFailureWindow === window) startupFailureWindow = undefined;
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
