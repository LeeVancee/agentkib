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
    doctorSummaries: (workspaceIds: string[]) =>
      ipcRenderer.invoke("agentkib:workspace:doctor-summaries", workspaceIds),
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
  }),
}) satisfies DesktopApi;

contextBridge.exposeInMainWorld("agentkibDesktop", desktopApi);
