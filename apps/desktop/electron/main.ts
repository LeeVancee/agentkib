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
  type MenuItemConstructorOptions,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
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
let tray: Tray | undefined;
let runtimeHost: DesktopRuntimeHost | undefined;
let runtimeHandshake: RuntimeHandshakeResult | undefined;
let shutdownStarted = false;
let closeBehavior: "minimize-to-tray" | "quit" | undefined;
let pendingUpdateVersion: string | undefined;

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
      AGENTKIB_LOCALE: normalizeSystemLocale(app.getLocale()),
      AGENTKIB_SYSTEM_THEME: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      AGENTKIB_QUOTA_SIDECAR: resolveQuotaSidecar(),
    },
  });
  runtimeHost.on("ready", (handshake: RuntimeHandshakeResult) => {
    runtimeHandshake = handshake;
  });
  runtimeHost.on("crash-loop", (error: Error) => void showStartupFailure(error));
  runtimeHandshake = await runtimeHost.start();
  const runtime = await runtimeHost.request<{
    close_behavior?: "minimize-to-tray" | "quit";
    effective_theme?: "light" | "dark";
  }>(RUNTIME_METHODS.runtimeInfo, {});
  closeBehavior = runtime.close_behavior;
  if (runtime.effective_theme) nativeTheme.themeSource = runtime.effective_theme;

  ipcMain.handle("agentkib:runtime:handshake", (event) => {
    assertTrustedRenderer(event);
    if (!runtimeHandshake) throw new Error("AgentKib runtime is not ready");
    return runtimeHandshake;
  });
  registerWorkspaceIpc();
  registerHomeIpc();
  registerShellIpc();
  registerFeatureIpc();
  registerUpdateIpc();

  createNativeShell();
  await createMainWindow();
}

function createNativeShell(): void {
  const applicationMenu: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
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
        ]
      : [
          {
            label: "File",
            submenu: [{ role: "quit" }],
          },
          {
            label: "View",
            submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
          },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu));

  const image = nativeImage.createFromPath(resolveTrayIcon());
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

function registerUpdateIpc(): void {
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
  ipcMain.handle("agentkib:workspace:sessions", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.workspaceSessions, {
      workspaceId: requireString(id, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:workspace:session-status", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.workspaceSessionStatus, {
      workspaceId: requireString(id, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:workspace:refresh-sessions", (event, id: unknown, force: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.refreshWorkspaceSessions, {
      workspaceId: requireString(id, "workspaceId"),
      force: force === undefined ? false : requireBoolean(force, "force"),
    });
  });
  ipcMain.handle(
    "agentkib:session:events",
    (event, id: unknown, cursor: unknown, limit: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.sessionEvents, {
        sessionId: requireString(id, "sessionId"),
        cursor: optionalString(cursor, "cursor"),
        limit: optionalPositiveInteger(limit, "limit"),
      });
    },
  );
  ipcMain.handle("agentkib:session:prepare-handoff", (event, request: unknown) => {
    assertTrustedRenderer(event);
    return runtimeRequest(event, RUNTIME_METHODS.prepareSessionHandoff, {
      request: requireObject(request, "handoff request"),
    });
  });
  ipcMain.handle("agentkib:session:summarize-handoff", (event, request: unknown) => {
    assertTrustedRenderer(event);
    return runtimeRequest(event, RUNTIME_METHODS.summarizeSessionHandoff, {
      request: requireObject(request, "handoff request"),
    });
  });
  ipcMain.handle(
    "agentkib:session:sanitize-handoff",
    (event, format: unknown, editedContent: unknown) => {
      assertTrustedRenderer(event);
      return runtimeRequest(event, RUNTIME_METHODS.sanitizeSessionHandoff, {
        format: requireString(format, "format"),
        editedContent: requireText(editedContent, "editedContent"),
      });
    },
  );
  ipcMain.handle(
    "agentkib:session:plan-handoff",
    (
      event,
      workspaceId: unknown,
      filename: unknown,
      format: unknown,
      editedContent: unknown,
      targetAgent: unknown,
    ) => {
      assertTrustedRenderer(event);
      return runtimeRequest(event, RUNTIME_METHODS.planSessionHandoff, {
        workspaceId: requireString(workspaceId, "workspaceId"),
        filename: requireString(filename, "filename"),
        format: requireString(format, "format"),
        editedContent: requireText(editedContent, "editedContent"),
        targetAgent: requireString(targetAgent, "targetAgent"),
      });
    },
  );
  ipcMain.handle(
    "agentkib:session:continue-handoff",
    (event, changeSet: unknown, launchRequest: unknown) => {
      assertTrustedRenderer(event);
      return runtimeRequest(event, RUNTIME_METHODS.continueSessionHandoff, {
        changeSet: requireObject(changeSet, "changeSet"),
        launchRequest: requireObject(launchRequest, "launchRequest"),
      });
    },
  );
  ipcMain.handle("agentkib:session:launch-handoff", (event, launchRequest: unknown) => {
    assertTrustedRenderer(event);
    return runtimeRequest(event, RUNTIME_METHODS.launchSessionHandoff, {
      ...requireObject(launchRequest, "launchRequest"),
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
  ipcMain.handle("agentkib:shell:quit", (event) => {
    assertTrustedRenderer(event);
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
    return requireRuntime().request(RUNTIME_METHODS.setLocale, {
      preference: requireString(preference, "preference"),
    });
  });
  ipcMain.handle("agentkib:settings:set-theme", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    const next = requireThemePreference(preference);
    nativeTheme.themeSource = next;
    return requireRuntime().request(RUNTIME_METHODS.setThemePreference, { preference: next });
  });
  ipcMain.handle("agentkib:settings:set-app-icon", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.setAppIconPreference, {
      preference: requireAppIconPreference(preference),
    });
  });
}

function registerFeatureIpc(): void {
  ipcMain.handle(
    "agentkib:changes:plan",
    (event, project: unknown, manifest: unknown, includeHome: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.planChanges, {
        project: requireString(project, "project"),
        manifest: requireObject(manifest, "manifest"),
        includeHome: requireBoolean(includeHome, "includeHome"),
      });
    },
  );
  ipcMain.handle("agentkib:changes:apply", (event, changeSet: unknown, approveHome: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.applyChanges, {
      changeSet: requireObject(changeSet, "changeSet"),
      approveHome: requireBoolean(approveHome, "approveHome"),
    });
  });
  ipcMain.handle("agentkib:memories:list", (event, project: unknown, status: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listMemories, {
      project: requireString(project, "project"),
      status: status === undefined ? null : optionalString(status, "status"),
    });
  });
  ipcMain.handle(
    "agentkib:memories:search",
    (event, project: unknown, query: unknown, limit: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.searchMemories, {
        project: requireString(project, "project"),
        query: requireText(query, "query"),
        limit: optionalPositiveInteger(limit, "limit") ?? 50,
      });
    },
  );
  ipcMain.handle("agentkib:memories:propose", (event, project: unknown, proposal: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.proposeMemory, {
      project: requireString(project, "project"),
      proposal: requireObject(proposal, "proposal"),
    });
  });
  ipcMain.handle(
    "agentkib:memories:review",
    (event, id: unknown, status: unknown, editedContent: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.reviewMemory, {
        id: requireString(id, "id"),
        status: requireString(status, "status"),
        editedContent: optionalString(editedContent, "editedContent"),
      });
    },
  );
  ipcMain.handle("agentkib:sessions:clear-index", (event, workspaceId: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.clearSessionIndex, {
      workspaceId: optionalString(workspaceId, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:sessions:set-index-enabled", (event, enabled: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.setSessionIndexEnabled, {
      value: requireBoolean(enabled, "enabled"),
    });
  });

  ipcMain.handle("agentkib:mcp:hub-status", (event) =>
    runtimeRequest(event, RUNTIME_METHODS.mcpHubStatus, {}),
  );
  ipcMain.handle("agentkib:mcp:update-network", (event, settings: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.updateMcpNetwork, {
      settings: requireObject(settings, "settings"),
    }),
  );
  ipcMain.handle("agentkib:mcp:list-servers", (event, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.listMcpServers, {
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle("agentkib:mcp:get-server", (event, serverId: unknown, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.getMcpServer, {
      serverId: requireString(serverId, "serverId"),
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle("agentkib:mcp:save-server", (event, server: unknown, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.saveMcpServer, {
      server: requireObject(server, "server"),
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle(
    "agentkib:mcp:save-local-values",
    (event, serverId: unknown, env: unknown, headers: unknown, project: unknown) =>
      runtimeRequest(event, RUNTIME_METHODS.saveMcpLocalValues, {
        serverId: requireString(serverId, "serverId"),
        env: requireObject(env, "env"),
        headers: requireObject(headers, "headers"),
        project: optionalString(project, "project") ?? null,
      }),
  );
  ipcMain.handle("agentkib:mcp:remove-server", (event, serverId: unknown, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.removeMcpServer, {
      serverId: requireString(serverId, "serverId"),
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle("agentkib:mcp:probe-runtime", (event, serverId: unknown, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.probeMcpRuntime, {
      serverId: requireString(serverId, "serverId"),
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle("agentkib:mcp:start-oauth", (event, serverId: unknown, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.startMcpOAuth, {
      serverId: requireString(serverId, "serverId"),
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle("agentkib:mcp:list-runtimes", (event) =>
    runtimeRequest(event, RUNTIME_METHODS.listMcpRuntimes, {}),
  );
  ipcMain.handle("agentkib:mcp:restart-runtime", (event, serverId: unknown, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.restartMcpRuntime, {
      serverId: requireString(serverId, "serverId"),
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle("agentkib:mcp:stop-runtime", (event, serverId: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.stopMcpRuntime, {
      serverId: optionalString(serverId, "serverId") ?? null,
    }),
  );
  ipcMain.handle("agentkib:mcp:search-registry", (event, query: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.searchMcpRegistry, {
      query: requireText(query, "query"),
    }),
  );
  ipcMain.handle("agentkib:mcp:refresh-registry", (event, query: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.refreshMcpRegistry, {
      query: requireText(query, "query"),
    }),
  );
  ipcMain.handle("agentkib:mcp:install", (event, entry: unknown, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.installMcp, {
      entry: requireObject(entry, "entry"),
      project: optionalString(project, "project") ?? null,
      confirmed: true,
    }),
  );
  ipcMain.handle(
    "agentkib:mcp:update",
    (event, installationId: unknown, entry: unknown, project: unknown) =>
      runtimeRequest(event, RUNTIME_METHODS.updateMcp, {
        installationId: requireString(installationId, "installationId"),
        entry: requireObject(entry, "entry"),
        project: optionalString(project, "project") ?? null,
        confirmed: true,
      }),
  );
  ipcMain.handle("agentkib:mcp:list-installations", (event) =>
    runtimeRequest(event, RUNTIME_METHODS.listMcpInstallations, {}),
  );
  ipcMain.handle("agentkib:mcp:uninstall", (event, installationId: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.uninstallMcp, {
      installationId: requireString(installationId, "installationId"),
      confirmed: true,
    }),
  );
  ipcMain.handle("agentkib:mcp:scan-native", (event, project: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.scanNativeMcp, {
      project: optionalString(project, "project") ?? null,
    }),
  );
  ipcMain.handle(
    "agentkib:mcp:plan-migration",
    (event, project: unknown, candidateIds: unknown) => {
      assertTrustedRenderer(event);
      if (!Array.isArray(candidateIds)) throw new TypeError("candidateIds must be an array");
      return requireRuntime().request(RUNTIME_METHODS.planMcpMigration, {
        project: requireString(project, "project"),
        candidateIds: candidateIds.map((id) => requireString(id, "candidateId")),
      });
    },
  );

  ipcMain.handle("agentkib:insights:heatmap", (event, query: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.insightsHeatmap, {
      query: requireObject(query, "query"),
    }),
  );
  ipcMain.handle("agentkib:insights:agent-usage", (event, query: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.agentUsageBreakdown, {
      query: requireObject(query, "query"),
    }),
  );
  ipcMain.handle("agentkib:insights:model-usage", (event, query: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.modelUsageBreakdown, {
      query: requireObject(query, "query"),
    }),
  );
  ipcMain.handle("agentkib:insights:workspace-usage", (event, query: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.workspaceUsageBreakdown, {
      query: requireObject(query, "query"),
    }),
  );
  ipcMain.handle("agentkib:insights:repository-commits", (event, query: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.repositoryCommitBreakdown, {
      query: requireObject(query, "query"),
    }),
  );
  ipcMain.handle("agentkib:insights:achievements", (event) =>
    runtimeRequest(event, RUNTIME_METHODS.achievements, {}),
  );
  ipcMain.handle("agentkib:insights:git-identities", (event) =>
    runtimeRequest(event, RUNTIME_METHODS.gitIdentities, {}),
  );
  ipcMain.handle("agentkib:insights:add-git-identity-alias", (event, email: unknown) =>
    runtimeRequest(event, RUNTIME_METHODS.addGitIdentityAlias, {
      email: requireString(email, "email"),
    }),
  );
  ipcMain.handle(
    "agentkib:insights:set-git-identity-enabled",
    (event, id: unknown, enabled: unknown) =>
      runtimeRequest(event, RUNTIME_METHODS.setGitIdentityEnabled, {
        id: requireString(id, "id"),
        enabled: requireBoolean(enabled, "enabled"),
      }),
  );
}

function runtimeRequest(
  event: IpcMainInvokeEvent,
  method: string,
  params: unknown,
): Promise<unknown> {
  assertTrustedRenderer(event);
  return requireRuntime().request(method, params);
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
    return requireRuntime().request(RUNTIME_METHODS.refreshDiscovery, {});
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
    return requireRuntime().request(RUNTIME_METHODS.refreshInsights, {});
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
    return requireRuntime().request(RUNTIME_METHODS.refreshQuota, {});
  });
  ipcMain.handle("agentkib:home:set-quota-auto-refresh", (event, enabled: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.setQuotaAutoRefresh, {
      value: requireBoolean(enabled, "enabled"),
    });
  });
  ipcMain.handle("agentkib:home:set-quota-prompt-seen", (event, seen: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.setQuotaPromptSeen, {
      value: requireBoolean(seen, "seen"),
    });
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
    return requireRuntime().request(RUNTIME_METHODS.refreshStorage, {});
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
    return requireRuntime().request(RUNTIME_METHODS.updateOnboarding, {
      event: requireObject(onboardingEvent, "onboarding event"),
    });
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

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
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

function optionalCloseBehavior(value: unknown): "minimize-to-tray" | "quit" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "minimize-to-tray" && value !== "quit") {
    throw new TypeError("close behavior must be minimize-to-tray or quit");
  }
  return value;
}

function requireThemePreference(value: unknown): "system" | "light" | "dark" {
  if (value !== "system" && value !== "light" && value !== "dark") {
    throw new TypeError("theme preference must be system, light, or dark");
  }
  return value;
}

function requireAppIconPreference(value: unknown): "white" | "black" {
  if (value !== "white" && value !== "black") {
    throw new TypeError("app icon preference must be white or black");
  }
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const parsed = optionalPositiveInteger(value, name);
  if (parsed === undefined) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
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
    if (!shutdownStarted && closeBehavior === "minimize-to-tray") {
      event.preventDefault();
      if (tray) window.hide();
      else window.minimize();
    }
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
  const triple =
    process.platform === "darwin"
      ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
  return path.resolve(process.cwd(), "src-tauri/binaries", `agentkib-quota-sidecar-${triple}`);
}

function resolveTrayIcon(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "icons", "tray-icon.png");
  return path.resolve(app.getAppPath(), "src-tauri/icons/tray-icon.png");
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
