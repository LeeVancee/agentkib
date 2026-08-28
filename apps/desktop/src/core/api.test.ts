import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("AgentKib API boundary", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    Reflect.deleteProperty(globalThis, "window");
  });

  afterEach(() => Reflect.deleteProperty(globalThis, "window"));

  it("normalizes omitted legacy connections in manifest drafts", async () => {
    vi.mocked(invoke).mockResolvedValue({
      schema_version: 2,
      workspace: { id: "workspace", name: "Workspace" },
      instructions: { shared: "", scoped: [], platform_overrides: {} },
      skills: [],
      mcp: { config: "mcp.json" },
      memories: { require_approval: true },
      adapters: {},
    });

    await expect(api.manifest("/tmp/workspace")).resolves.toMatchObject({ connections: [] });
    expect(invoke).toHaveBeenCalledWith("prepare_manifest", { project: "/tmp/workspace" });
  });

  it("keeps Obsidian linking explicit at the IPC boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({
      workspace_id: "workspace",
      vault_path: "/Notes",
      target_path: "/Notes/Projects",
    });

    await api.linkWorkspaceToObsidian("workspace", "/Notes", "Projects");

    expect(invoke).toHaveBeenCalledWith("link_workspace_to_obsidian", {
      workspaceId: "workspace",
      vaultPath: "/Notes",
      relativeTarget: "Projects",
    });
  });

  it("sends theme preferences through the desktop preference boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ theme_preference: "light", effective_theme: "light" });

    await api.setThemePreference("light");

    expect(invoke).toHaveBeenCalledWith("set_theme_preference", { preference: "light" });
  });

  it("sends app icon preferences through the desktop preference boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ app_icon_preference: "black" });

    await api.setAppIconPreference("black");

    expect(invoke).toHaveBeenCalledWith("set_app_icon_preference", { preference: "black" });
  });

  it("checks for application updates through the narrow updater boundary", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await api.checkAppUpdate();

    expect(invoke).toHaveBeenCalledWith("check_app_update");
  });

  it("persists onboarding events through the preference boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ onboarding: { acknowledged_version: 1 } });

    await api.updateOnboarding({ event: "dismissed" });

    expect(invoke).toHaveBeenCalledWith("update_onboarding", {
      event: { event: "dismissed" },
    });
  });

  it("queues refresh work without waiting for collector results", async () => {
    vi.mocked(invoke).mockResolvedValue({
      kind: "insights",
      disposition: "queued",
      request_id: "refresh-1",
      status: { kind: "insights", state: "queued" },
    });

    await expect(api.requestRefresh("insights", true)).resolves.toMatchObject({
      disposition: "queued",
    });

    expect(invoke).toHaveBeenCalledWith("request_refresh", { kind: "insights", force: true });
  });

  it("exposes quota refresh as a non-blocking IPC request", async () => {
    vi.mocked(invoke).mockResolvedValue({
      kind: "quota",
      disposition: "queued",
      request_id: "quota-1",
      status: { kind: "quota", state: "queued" },
    });

    await expect(api.refreshQuota()).resolves.toMatchObject({
      kind: "quota",
      disposition: "queued",
    });

    expect(invoke).toHaveBeenCalledWith("refresh_quota");
  });

  it("updates the persisted automatic quota query preference through IPC", async () => {
    vi.mocked(invoke).mockResolvedValue({ quota_auto_refresh_enabled: false });

    await api.setQuotaAutoRefreshEnabled(false);

    expect(invoke).toHaveBeenCalledWith("set_quota_auto_refresh_enabled", { enabled: false });
  });

  it("records that the automatic quota query prompt has been handled", async () => {
    vi.mocked(invoke).mockResolvedValue({ quota_auto_refresh_prompt_seen: true });

    await api.setQuotaAutoRefreshPromptSeen(true);

    expect(invoke).toHaveBeenCalledWith("set_quota_auto_refresh_prompt_seen", { seen: true });
  });

  it("keeps workspace storage scanning explicit", async () => {
    vi.mocked(invoke).mockResolvedValue({
      total_workspace_count: 2,
      scanned_workspace_count: 0,
      workspaces: [],
    });

    await api.storageOverview();
    expect(invoke).toHaveBeenCalledWith("get_storage_overview");

    vi.mocked(invoke).mockResolvedValue({
      kind: "storage",
      disposition: "queued",
      request_id: "storage-1",
      status: { kind: "storage", state: "queued" },
    });
    await api.requestRefresh("storage", true);
    expect(invoke).toHaveBeenCalledWith("request_refresh", { kind: "storage", force: true });
  });

  it("keeps recursive storage exploration within the workspace IPC boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "directory:target", name: "target", children: [] });

    await api.workspaceStorageChildren("workspace-1", "target/debug");
    expect(invoke).toHaveBeenCalledWith("get_workspace_storage_children", {
      workspaceId: "workspace-1",
      relativePath: "target/debug",
    });

    await api.openWorkspaceStoragePath("workspace-1", "target/debug");
    expect(invoke).toHaveBeenCalledWith("open_workspace_storage_path", {
      workspaceId: "workspace-1",
      relativePath: "target/debug",
    });
  });

  it("keeps conversation bodies behind an explicit on-demand IPC call", async () => {
    vi.mocked(invoke).mockResolvedValue({ events: [], warnings: [] });

    await api.sessionEvents("hashed-session", "p64", 100);

    expect(invoke).toHaveBeenCalledWith("read_session_events", {
      sessionId: "hashed-session",
      cursor: "p64",
      limit: 100,
    });
  });

  it("keeps Doctor diagnostics scoped to stored workspace ids", async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    await api.workspaceDoctorSummaries(["workspace-1"]);
    expect(invoke).toHaveBeenCalledWith("get_workspace_doctor_summaries", {
      workspaceIds: ["workspace-1"],
    });

    await api.workspaceDoctorReport("workspace-1");
    expect(invoke).toHaveBeenCalledWith("get_workspace_doctor_report", {
      workspaceId: "workspace-1",
    });
  });

  it("routes Doctor reports through the Electron preload contract", async () => {
    const doctorReport = vi.fn().mockResolvedValue({ summary: { workspace_id: "workspace-1" } });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentkibDesktop: { workspace: { doctorReport } } },
    });

    await api.workspaceDoctorReport("workspace-1");

    expect(doctorReport).toHaveBeenCalledWith("workspace-1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes Git workspace reads through the Electron preload contract", async () => {
    const gitSummary = vi.fn().mockResolvedValue(undefined);
    const gitHistory = vi.fn().mockResolvedValue(undefined);
    const gitCommitFiles = vi.fn().mockResolvedValue([]);
    const gitDiff = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agentkibDesktop: {
          workspace: { gitSummary, gitHistory, gitCommitFiles, gitDiff },
        },
      },
    });

    await api.workspaceGitSummary("workspace-1");
    await api.workspaceGitHistory("workspace-1", { merges_only: true });
    await api.gitCommitFiles("workspace-1", "abc123");
    await api.gitDiff("workspace-1", { kind: "worktree" });

    expect(gitSummary).toHaveBeenCalledWith("workspace-1");
    expect(gitHistory).toHaveBeenCalledWith("workspace-1", { merges_only: true });
    expect(gitCommitFiles).toHaveBeenCalledWith("workspace-1", "abc123");
    expect(gitDiff).toHaveBeenCalledWith("workspace-1", { kind: "worktree" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("batches Doctor summaries within the backend limit", async () => {
    const workspaceIds = Array.from({ length: 201 }, (_, index) => `workspace-${index}`);
    vi.mocked(invoke)
      .mockResolvedValueOnce(workspaceIds.slice(0, 100).map((workspace_id) => ({ workspace_id })))
      .mockResolvedValueOnce(workspaceIds.slice(100, 200).map((workspace_id) => ({ workspace_id })))
      .mockResolvedValueOnce(workspaceIds.slice(200).map((workspace_id) => ({ workspace_id })));

    await expect(api.workspaceDoctorSummaries(workspaceIds)).resolves.toHaveLength(201);

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(1, "get_workspace_doctor_summaries", {
      workspaceIds: workspaceIds.slice(0, 100),
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "get_workspace_doctor_summaries", {
      workspaceIds: workspaceIds.slice(100, 200),
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "get_workspace_doctor_summaries", {
      workspaceIds: workspaceIds.slice(200),
    });
  });

  it("previews handoffs before planning a ChangeSet save", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: "ready",
      draft: { filename: "handoff.md", content: "# handoff" },
    });
    const request = {
      session_id: "hashed-session",
      target_agent: "claude-code" as const,
      format: "markdown" as const,
    };

    await api.prepareSessionHandoff(request);
    expect(invoke).toHaveBeenCalledWith("prepare_session_handoff", { request });

    await api.summarizeSessionHandoff(request);
    expect(invoke).toHaveBeenCalledWith("summarize_session_handoff", { request });

    await api.sanitizeSessionHandoff("markdown", "# edited handoff");
    expect(invoke).toHaveBeenCalledWith("sanitize_session_handoff", {
      format: "markdown",
      editedContent: "# edited handoff",
    });

    await api.planSessionHandoff(
      "workspace-1",
      "handoff.md",
      "markdown",
      "# handoff",
      "claude-code",
    );
    expect(invoke).toHaveBeenCalledWith("plan_session_handoff", {
      workspaceId: "workspace-1",
      filename: "handoff.md",
      format: "markdown",
      editedContent: "# handoff",
      targetAgent: "claude-code",
    });

    const launchRequest = {
      workspace_id: "workspace-1",
      filename: "handoff.md",
      target_agent: "claude-code" as const,
    };
    const changeSet = {
      id: "changes",
      project_root: "/tmp/project",
      created_at: "2026-08-18T00:00:00Z",
      changes: [],
      requires_home_approval: false,
    };
    await api.continueSessionHandoff(changeSet, launchRequest);
    expect(invoke).toHaveBeenCalledWith("continue_session_handoff", { changeSet, launchRequest });
    await api.launchSessionHandoff(launchRequest);
    expect(invoke).toHaveBeenCalledWith("launch_session_handoff", { launchRequest });
  });

  it("refreshes only the selected workspace conversation index", async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    await api.refreshWorkspaceSessions("workspace-1", true);

    expect(invoke).toHaveBeenCalledWith("refresh_workspace_sessions", {
      workspaceId: "workspace-1",
      force: true,
    });
  });

  it("persists quota popover display preferences through desktop preferences", async () => {
    const preferences = {
      hidden_providers: ["claude"],
      hidden_windows: [{ provider_id: "codex", kind: "weekly", label: "Weekly" }],
    };
    vi.mocked(invoke).mockResolvedValue(preferences);

    await expect(api.setQuotaPopoverPreferences(preferences)).resolves.toEqual(preferences);

    expect(invoke).toHaveBeenCalledWith("set_quota_popover_preferences", { preferences });
  });

  it("opens the quota dashboard at an exact provider window", async () => {
    const window = { provider_id: "codex", account_id: "work", kind: "weekly", label: "Weekly" };
    vi.mocked(invoke).mockResolvedValue(undefined);

    await api.openQuotaDashboard("codex", window, false);

    expect(invoke).toHaveBeenCalledWith("open_quota_dashboard", {
      provider: "codex",
      window,
      configurePopover: false,
    });
  });

  it("keeps remote gateway credentials inside the native IPC boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "gateway", state: "connected" });

    await api.saveRemoteGateway({
      kind: "open-claw",
      name: "Server",
      url: "wss://gateway.test",
      auth_kind: "token",
      secret: "local-only",
    });

    expect(invoke).toHaveBeenCalledWith("save_remote_gateway", {
      input: {
        kind: "open-claw",
        name: "Server",
        url: "wss://gateway.test",
        auth_kind: "token",
        secret: "local-only",
      },
    });
  });
});
