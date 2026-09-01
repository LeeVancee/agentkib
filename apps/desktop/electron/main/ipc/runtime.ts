import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { RUNTIME_METHODS } from "../../generated/runtime-protocol";
import type { DesktopRuntimeHost } from "../runtime-host";
import {
  optionalPositiveInteger,
  optionalString,
  requireBoolean,
  requireObject,
  requirePositiveInteger,
  requireString,
  requireText,
} from "./validation";

const KNOWN_AGENTS = new Set([
  "codex",
  "claude-code",
  "cursor",
  "open-claw",
  "hermes",
  "deepseek-harness",
]);

interface RuntimeIpcOptions {
  runtime(): DesktopRuntimeHost;
  assertTrustedRenderer(event: IpcMainInvokeEvent): void;
  withRuntimeCapabilities(runtime: unknown): unknown;
}

export function registerRuntimeIpc({
  runtime,
  assertTrustedRenderer,
  withRuntimeCapabilities: withElectronRuntimeCapabilities,
}: RuntimeIpcOptions): void {
  function registerWorkspaceIpc(): void {
    ipcMain.handle("agentkib:workspace:scan", (event, project: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.scanWorkspace, {
        project: requireString(project, "project"),
      });
    });
    ipcMain.handle("agentkib:workspace:prepare-manifest", (event, project: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.prepareManifest, {
        project: requireString(project, "project"),
      });
    });
    ipcMain.handle(
      "agentkib:workspace:resolve-context",
      (event, project: unknown, cwd: unknown, agent: unknown) => {
        assertTrustedRenderer(event);
        const parsedAgent = requireString(agent, "agent");
        if (!KNOWN_AGENTS.has(parsedAgent)) throw new Error(`Unsupported agent: ${parsedAgent}`);
        return runtime().request(RUNTIME_METHODS.resolveContext, {
          project: requireString(project, "project"),
          cwd: requireString(cwd, "cwd"),
          agent: parsedAgent,
        });
      },
    );
    ipcMain.handle("agentkib:workspace:add", (event, workspacePath: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.addWorkspace, {
        path: requireString(workspacePath, "path"),
      });
    });
    ipcMain.handle("agentkib:workspace:refresh", (event, id: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.refreshWorkspace, {
        id: requireString(id, "id"),
      });
    });
    ipcMain.handle("agentkib:workspace:exclude", (event, id: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.excludeWorkspace, {
        id: requireString(id, "id"),
      });
    });
    ipcMain.handle("agentkib:workspace:restore-excluded", (event, workspacePath: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.restoreExcludedWorkspace, {
        path: requireString(workspacePath, "path"),
      });
    });
    ipcMain.handle("agentkib:workspace:doctor-report", (event, id: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.workspaceDoctorReport, {
        id: requireString(id, "id"),
      });
    });
    ipcMain.handle("agentkib:workspace:git-summary", (event, id: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.workspaceGitSummary, {
        id: requireString(id, "workspaceId"),
      });
    });
    ipcMain.handle("agentkib:workspace:git-history", (event, id: unknown, query: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.workspaceGitHistory, {
        workspaceId: requireString(id, "workspaceId"),
        query: requireObject(query, "git history query"),
      });
    });
    ipcMain.handle("agentkib:workspace:git-commit-files", (event, id: unknown, oid: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.gitCommitFiles, {
        workspaceId: requireString(id, "workspaceId"),
        oid: requireString(oid, "oid"),
      });
    });
    ipcMain.handle("agentkib:workspace:git-diff", (event, id: unknown, request: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.gitDiff, {
        workspaceId: requireString(id, "workspaceId"),
        request: requireObject(request, "git diff request"),
      });
    });
    ipcMain.handle("agentkib:workspace:sessions", (event, id: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.workspaceSessions, {
        workspaceId: requireString(id, "workspaceId"),
      });
    });
    ipcMain.handle("agentkib:workspace:session-status", (event, id: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.workspaceSessionStatus, {
        workspaceId: requireString(id, "workspaceId"),
      });
    });
    ipcMain.handle("agentkib:workspace:refresh-sessions", (event, id: unknown, force: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.refreshWorkspaceSessions, {
        workspaceId: requireString(id, "workspaceId"),
        force: force === undefined ? false : requireBoolean(force, "force"),
      });
    });
    ipcMain.handle(
      "agentkib:session:events",
      (event, id: unknown, cursor: unknown, limit: unknown) => {
        assertTrustedRenderer(event);
        return runtime().request(RUNTIME_METHODS.sessionEvents, {
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
        sessionId: unknown,
        workspaceId: unknown,
        filename: unknown,
        format: unknown,
        editedContent: unknown,
        targetAgent: unknown,
        mode: unknown,
        sourceFingerprint: unknown,
        acceptLosses: unknown,
        historyBudgetTokens: unknown,
        archiveId: unknown,
      ) => {
        assertTrustedRenderer(event);
        return runtimeRequest(event, RUNTIME_METHODS.planSessionHandoff, {
          sessionId: requireString(sessionId, "sessionId"),
          workspaceId: requireString(workspaceId, "workspaceId"),
          filename: requireString(filename, "filename"),
          format: requireString(format, "format"),
          editedContent:
            editedContent === undefined ? undefined : requireText(editedContent, "editedContent"),
          targetAgent: requireString(targetAgent, "targetAgent"),
          mode: requireString(mode, "mode"),
          sourceFingerprint: requireString(sourceFingerprint, "sourceFingerprint"),
          acceptLosses: requireBoolean(acceptLosses, "acceptLosses"),
          historyBudgetTokens: requirePositiveInteger(historyBudgetTokens, "historyBudgetTokens"),
          archiveId: optionalString(archiveId, "archiveId"),
        });
      },
    );
    ipcMain.handle(
      "agentkib:session:continue-handoff",
      (event, changeSet: unknown, launchRequest: unknown, approveHome: unknown) => {
        assertTrustedRenderer(event);
        return runtimeRequest(event, RUNTIME_METHODS.continueSessionHandoff, {
          changeSet: requireObject(changeSet, "changeSet"),
          launchRequest: requireObject(launchRequest, "launchRequest"),
          approveHome: requireBoolean(approveHome, "approveHome"),
        });
      },
    );
    ipcMain.handle("agentkib:session:launch-handoff", (event, launchRequest: unknown) => {
      assertTrustedRenderer(event);
      return runtimeRequest(event, RUNTIME_METHODS.launchSessionHandoff, {
        ...requireObject(launchRequest, "launchRequest"),
      });
    });
    ipcMain.handle("agentkib:workspace:openers", (event, id: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.listWorkspaceOpeners, {
        workspaceId: requireString(id, "workspaceId"),
      });
    });
    ipcMain.handle("agentkib:workspace:open", async (event, id: unknown, openerId: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.openWorkspaceWithApp, {
        workspaceId: requireString(id, "workspaceId"),
        openerId: optionalString(openerId, "openerId"),
      });
    });
  }

  function registerFeatureIpc(): void {
    ipcMain.handle(
      "agentkib:changes:plan",
      (event, project: unknown, manifest: unknown, includeHome: unknown) => {
        assertTrustedRenderer(event);
        return runtime().request(RUNTIME_METHODS.planChanges, {
          project: requireString(project, "project"),
          manifest: requireObject(manifest, "manifest"),
          includeHome: requireBoolean(includeHome, "includeHome"),
        });
      },
    );
    ipcMain.handle("agentkib:changes:apply", (event, changeSet: unknown, approveHome: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.applyChanges, {
        changeSet: requireObject(changeSet, "changeSet"),
        approveHome: requireBoolean(approveHome, "approveHome"),
      });
    });
    ipcMain.handle("agentkib:memories:list", (event, project: unknown, status: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.listMemories, {
        project: requireString(project, "project"),
        status: status === undefined ? null : optionalString(status, "status"),
      });
    });
    ipcMain.handle(
      "agentkib:memories:search",
      (event, project: unknown, query: unknown, limit: unknown) => {
        assertTrustedRenderer(event);
        return runtime().request(RUNTIME_METHODS.searchMemories, {
          project: requireString(project, "project"),
          query: requireText(query, "query"),
          limit: optionalPositiveInteger(limit, "limit") ?? 50,
        });
      },
    );
    ipcMain.handle("agentkib:memories:propose", (event, project: unknown, proposal: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.proposeMemory, {
        project: requireString(project, "project"),
        proposal: requireObject(proposal, "proposal"),
      });
    });
    ipcMain.handle(
      "agentkib:memories:review",
      (event, id: unknown, status: unknown, editedContent: unknown) => {
        assertTrustedRenderer(event);
        return runtime().request(RUNTIME_METHODS.reviewMemory, {
          id: requireString(id, "id"),
          status: requireString(status, "status"),
          editedContent: optionalString(editedContent, "editedContent"),
        });
      },
    );
    ipcMain.handle("agentkib:sessions:clear-index", (event, workspaceId: unknown) => {
      assertTrustedRenderer(event);
      return runtime().request(RUNTIME_METHODS.clearSessionIndex, {
        workspaceId: optionalString(workspaceId, "workspaceId"),
      });
    });
    ipcMain.handle("agentkib:sessions:set-index-enabled", (event, enabled: unknown) => {
      assertTrustedRenderer(event);
      return runtime()
        .request(RUNTIME_METHODS.setSessionIndexEnabled, {
          value: requireBoolean(enabled, "enabled"),
        })
        .then(withElectronRuntimeCapabilities);
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
        return runtime().request(RUNTIME_METHODS.planMcpMigration, {
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
    return runtime().request(method, params);
  }

  registerWorkspaceIpc();
  registerFeatureIpc();
}
