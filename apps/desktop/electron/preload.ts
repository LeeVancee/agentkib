import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./desktop-api";

const desktopApi = Object.freeze({
  platform: process.platform,
  runtime: Object.freeze({
    handshake: () => ipcRenderer.invoke("agentkib:runtime:handshake"),
  }),
  workspace: Object.freeze({
    scan: (project: string) => ipcRenderer.invoke("agentkib:workspace:scan", project),
    prepareManifest: (project: string) =>
      ipcRenderer.invoke("agentkib:workspace:prepare-manifest", project),
    resolveContext: (project: string, cwd: string, agent: string) =>
      ipcRenderer.invoke("agentkib:workspace:resolve-context", project, cwd, agent),
    add: (path: string) => ipcRenderer.invoke("agentkib:workspace:add", path),
    refresh: (id: string) => ipcRenderer.invoke("agentkib:workspace:refresh", id),
    exclude: (id: string) => ipcRenderer.invoke("agentkib:workspace:exclude", id),
    restoreExcluded: (path: string) =>
      ipcRenderer.invoke("agentkib:workspace:restore-excluded", path),
    doctorReport: (id: string) => ipcRenderer.invoke("agentkib:workspace:doctor-report", id),
    gitSummary: (id: string) => ipcRenderer.invoke("agentkib:workspace:git-summary", id),
    gitHistory: (id: string, query: unknown) =>
      ipcRenderer.invoke("agentkib:workspace:git-history", id, query),
    gitCommitFiles: (id: string, oid: string) =>
      ipcRenderer.invoke("agentkib:workspace:git-commit-files", id, oid),
    gitDiff: (id: string, request: unknown) =>
      ipcRenderer.invoke("agentkib:workspace:git-diff", id, request),
    sessions: (id: string) => ipcRenderer.invoke("agentkib:workspace:sessions", id),
    sessionStatus: (id: string) => ipcRenderer.invoke("agentkib:workspace:session-status", id),
    refreshSessions: (id: string, force?: boolean) =>
      ipcRenderer.invoke("agentkib:workspace:refresh-sessions", id, force),
    sessionEvents: (id: string, cursor?: string, limit?: number) =>
      ipcRenderer.invoke("agentkib:session:events", id, cursor, limit),
    openers: (id: string) => ipcRenderer.invoke("agentkib:workspace:openers", id),
    open: (id: string, openerId?: string) =>
      ipcRenderer.invoke("agentkib:workspace:open", id, openerId),
    doctorSummaries: (workspaceIds: string[]) =>
      ipcRenderer.invoke("agentkib:workspace:doctor-summaries", workspaceIds),
  }),
  shell: Object.freeze({
    openDirectory: (title?: string) => ipcRenderer.invoke("agentkib:shell:open-directory", title),
  }),
  home: Object.freeze({
    runtime: () => ipcRenderer.invoke("agentkib:home:runtime"),
    workspaces: () => ipcRenderer.invoke("agentkib:home:workspaces"),
    agentInstallations: () => ipcRenderer.invoke("agentkib:home:agent-installations"),
    catalogAssets: (input: unknown) => ipcRenderer.invoke("agentkib:home:catalog-assets", input),
    globalMemories: (status?: string) =>
      ipcRenderer.invoke("agentkib:home:global-memories", status),
    activity: (limit?: number) => ipcRenderer.invoke("agentkib:home:activity", limit),
    scanRoots: () => ipcRenderer.invoke("agentkib:home:scan-roots"),
    excludedWorkspaces: () => ipcRenderer.invoke("agentkib:home:excluded-workspaces"),
    remoteGateways: () => ipcRenderer.invoke("agentkib:home:remote-gateways"),
    insightsSummary: (query: unknown) =>
      ipcRenderer.invoke("agentkib:home:insights-summary", query),
    insightsStatus: () => ipcRenderer.invoke("agentkib:home:insights-status"),
    quotaCollectorStatus: () => ipcRenderer.invoke("agentkib:home:quota-collector-status"),
    refreshStatus: () => ipcRenderer.invoke("agentkib:home:refresh-status"),
    updateOnboarding: (event: unknown) =>
      ipcRenderer.invoke("agentkib:home:update-onboarding", event),
    obsidianIntegration: () => ipcRenderer.invoke("agentkib:home:obsidian-integration"),
  }),
}) satisfies DesktopApi;

contextBridge.exposeInMainWorld("agentkibDesktop", desktopApi);
