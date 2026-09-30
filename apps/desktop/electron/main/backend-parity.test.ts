import { mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TypeScriptBackend } from "@agentkib/backend";
import {
  BACKEND_INITIALIZE,
  BACKEND_PREFERENCES,
  BACKEND_PLAN_WORKSPACE,
  BACKEND_PLAN_DISCOVERY,
  NATIVE_CONTEXT,
  NATIVE_INSPECT,
  NATIVE_DISCOVERY,
  NATIVE_SESSION_INDEX_CHANGED,
  type WorkspacePlan,
  type NativeContext,
  type InspectedWorkspace,
  type DiscoverySnapshot,
  type DiscoveryPlan,
} from "@agentkib/backend/migration";
import { RUNTIME_METHODS } from "../generated/runtime-protocol";
import { DesktopRuntimeHost, RuntimeRequestError } from "./runtime-host";

describe("TypeScript migration parity against the current Rust runtime", () => {
  let directory: string;
  let rust: DesktopRuntimeHost;
  let backend: TypeScriptBackend;
  let database: DatabaseSync;
  let id = 0;
  const environment = { AGENTKIB_LOCALE: "zh-TW", AGENTKIB_SYSTEM_THEME: "dark" };

  function request(method: string, params: unknown = {}) {
    return backend.handle({ jsonrpc: "2.0", id: ++id, method, params });
  }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "agentkib-backend-parity-")));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await writeFile(
      path.join(directory, "preferences.json"),
      JSON.stringify({
        mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
        quota_popover: { visible_providers: ["codex"], future_field: true },
        future_setting: { nested: [1, 2, 3] },
      }),
    );
    rust = new DesktopRuntimeHost({
      executablePath: path.resolve(
        "../../target/debug",
        process.platform === "win32" ? "agentkib-runtime.exe" : "agentkib-runtime",
      ),
      clientVersion: "parity-test",
      maxRestarts: 0,
      environment: {
        ...environment,
        AGENTKIB_BENCHMARK_DATA_DIR: directory,
        AGENTKIB_HOME: path.join(directory, "home"),
        CODEX_HOME: path.join(directory, "codex"),
        CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
      },
    });
    await rust.start();
    await rust.request(RUNTIME_METHODS.listWorkspaces, {});
    database = new DatabaseSync(path.join(directory, "agentkib.db"));
    database.exec(`
      DELETE FROM workspace_sources; DELETE FROM workspaces;
      DELETE FROM audit_events; DELETE FROM scan_roots; DELETE FROM excluded_workspaces;
      INSERT INTO workspaces(id, canonical_path, name, status, asset_count, warning_count, last_discovered_at, last_active_at, last_scanned_at, repository_group_id, manifest_workspace_id)
      VALUES ('recent', '/fixture/工作區', '工作區', 'attention', 4, 2, '2026-09-30T08:00:00Z', '2026-09-30T08:00:00.123456789+08:00', NULL, 'group-a', 'manifest-a'),
      ('legacy', '/fixture/legacy', 'Legacy', 'healthy', -3, -1, '2026-09-30T08:00:00Z', '1700000000123', 'invalid', NULL, NULL),
      ('empty', '/fixture/empty', 'Empty', 'healthy', 0, 0, '2026-09-30T08:00:00Z', NULL, '2026-02-30T00:00:00Z', NULL, NULL);
      INSERT INTO workspace_sources(workspace_id, agent, evidence, session_count, last_active_at, session_cwds)
      VALUES ('recent', 'codex', 'session-cwd', 7, '2026-09-30T08:00:00.123456+08:00', '["/fixture/工作區","/fixture/工作區/sub"]'),
      ('recent', '', 'manual', -2, NULL, '[]'),
      ('recent', 'open-claw', 'configured-workspace', 1, '2026-09-30T00:00:00Z', '[]');
      INSERT INTO audit_events VALUES ('audit-new', 'recent', 'workspace.add', '中文 detail', '2026-09-30T08:00:00.123456789+08:00'),
      ('audit-old', NULL, 'workspace.remove', 'legacy', '2026-09-29T23:59:59Z');
      INSERT INTO scan_roots VALUES ('root', '/fixture/root', 1, 5, '2026-09-30t08:00:00.120z');
      INSERT INTO excluded_workspaces VALUES ('/fixture/excluded', '2026-09-30T08:00:00.120+08:00');
    `);
    backend = new TypeScriptBackend(environment);
    expect(request(BACKEND_INITIALIZE, { dataDir: directory }).error).toBeUndefined();
  }, 20_000);

  afterAll(async () => {
    backend?.close();
    database?.close();
    await rust?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("preserves workspace sources, legacy timestamps, ordering and null fields", async () => {
    const expected = await rust.request(RUNTIME_METHODS.listWorkspaces, {});
    expect(request(RUNTIME_METHODS.listWorkspaces).result).toEqual(expected);
    expect(request(RUNTIME_METHODS.listWorkspaces).result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "recent", last_active_at: "2026-09-30T00:00:00.123456789Z" }),
        expect.objectContaining({ id: "legacy", asset_count: 0, last_scanned_at: null }),
      ]),
    );
    database.exec("UPDATE workspaces SET name = 'Changed by Rust owner' WHERE id = 'recent'");
    expect(request(RUNTIME_METHODS.listWorkspaces).result).toEqual(
      await rust.request(RUNTIME_METHODS.listWorkspaces, {}),
    );
    expect(
      database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value,
    ).toBe("15");
  });

  it("matches cached lists and activity limit clamping", async () => {
    for (const method of [RUNTIME_METHODS.listScanRoots, RUNTIME_METHODS.listExcludedWorkspaces])
      expect(request(method).result).toEqual(await rust.request(method, {}));
    for (const params of [{}, { limit: 0 }, { limit: 1 }, { limit: 999 }])
      expect(request(RUNTIME_METHODS.listActivity, params).result).toEqual(
        await rust.request(RUNTIME_METHODS.listActivity, params),
      );
  });

  it("writes preferences that Rust can read while preserving unrelated settings", async () => {
    const cases: [string, unknown][] = [
      [RUNTIME_METHODS.setLocale, { preference: "zh-TW" }],
      [RUNTIME_METHODS.setThemePreference, { preference: "light" }],
      [RUNTIME_METHODS.setAccentThemePreference, { preference: "sakura" }],
      [RUNTIME_METHODS.setSidebarWidthPreference, { preference: 377 }],
      [RUNTIME_METHODS.setAppIconPreference, { preference: "black" }],
      [RUNTIME_METHODS.setCloseBehavior, { value: "quit" }],
      [RUNTIME_METHODS.setCloseBehavior, {}],
    ];
    for (const [method, params] of cases) {
      const result = request(method, params);
      expect(result.error).toBeUndefined();
      expect(await rust.request(RUNTIME_METHODS.runtimeInfo, {})).toMatchObject(
        result.result as object,
      );
    }
    await rust.request(RUNTIME_METHODS.setLocale, { preference: "system" });
    await rust.request(RUNTIME_METHODS.setThemePreference, { preference: "system" });
    expect(await rust.request(RUNTIME_METHODS.runtimeInfo, {})).toMatchObject(
      request(BACKEND_PREFERENCES).result as object,
    );
    const saved = JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8"));
    expect(saved.future_setting).toEqual({ nested: [1, 2, 3] });
    expect(saved.quota_popover.future_field).toBe(true);
  });

  it("matches Rust error categories and leaves settings unchanged on rejected writes", async () => {
    const cases: [string, unknown][] = [
      [RUNTIME_METHODS.setLocale, { preference: "unsupported" }],
      [RUNTIME_METHODS.setLocale, { preference: null }],
      [RUNTIME_METHODS.setThemePreference, { preference: "invalid" }],
      [RUNTIME_METHODS.setAccentThemePreference, {}],
      [RUNTIME_METHODS.setSidebarWidthPreference, { preference: 249 }],
      [RUNTIME_METHODS.setSidebarWidthPreference, { preference: -1 }],
      [RUNTIME_METHODS.setSidebarWidthPreference, { preference: 250.5 }],
      [RUNTIME_METHODS.setCloseBehavior, { value: "invalid" }],
      [RUNTIME_METHODS.listActivity, { limit: -1 }],
      [RUNTIME_METHODS.listActivity, { limit: null }],
    ];
    const saved = await readFile(path.join(directory, "preferences.json"), "utf8");
    for (const [method, params] of cases) {
      const failure = await rust.request(method, params).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RuntimeRequestError);
      expect(request(method, params).error?.code).toBe((failure as RuntimeRequestError).code);
    }
    expect(await readFile(path.join(directory, "preferences.json"), "utf8")).toBe(saved);
  });

  async function workspace(method: string, params: { path?: string; id?: string }) {
    const context = await rust.request<NativeContext>(NATIVE_CONTEXT, {});
    const planning = request(BACKEND_PLAN_WORKSPACE, {
      ...params,
      operation: method === RUNTIME_METHODS.addWorkspace ? "add" : "refresh",
      context,
    });
    if (planning.error) return planning;
    const plan = planning.result as WorkspacePlan;
    const scans = await rust.request<InspectedWorkspace[]>(NATIVE_INSPECT, { workspaces: [plan] });
    return request(method, { ...params, _plan: plan, _inspection: scans[0]!.inspection });
  }

  it("lets Rust read TS workspace/catalog writes, deduplicates aliases, and cascades exclusions", async () => {
    const project = path.join(directory, "工作區");
    await mkdir(project);
    await writeFile(path.join(project, "AGENTS.md"), "# Shared instructions\nUse pnpm.\n");
    const added = await workspace(RUNTIME_METHODS.addWorkspace, { path: project });
    expect(added.error).toBeUndefined();
    const summary = added.result as { id: string; path: string; asset_count: number };
    expect(summary).toMatchObject({ path: project, status: "healthy" });
    expect(summary.asset_count).toBeGreaterThan(0);
    expect(request(RUNTIME_METHODS.listWorkspaces).result).toEqual(
      await rust.request(RUNTIME_METHODS.listWorkspaces, {}),
    );
    const catalogBefore = database
      .prepare("SELECT * FROM catalog_assets WHERE workspace_id = ? ORDER BY id")
      .all(summary.id);
    expect(catalogBefore.length).toBeGreaterThan(0);
    // The Rust refresh must produce the same catalog content as the pure inspector + TS persistence.
    await rust.request(RUNTIME_METHODS.refreshWorkspace, { id: summary.id });
    expect(
      database
        .prepare("SELECT * FROM catalog_assets WHERE workspace_id = ? ORDER BY id")
        .all(summary.id),
    ).toEqual(catalogBefore);
    const alias = path.join(directory, "workspace-alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await workspace(RUNTIME_METHODS.addWorkspace, { path: alias })).result).toMatchObject({
      id: summary.id,
      path: project,
    });
    expect(request(RUNTIME_METHODS.excludeWorkspace, { id: summary.id }).error).toBeUndefined();
    expect(
      database.prepare("SELECT * FROM workspace_sources WHERE workspace_id = ?").all(summary.id),
    ).toEqual([]);
    expect(
      database.prepare("SELECT * FROM catalog_assets WHERE workspace_id = ?").all(summary.id),
    ).toEqual([]);
    expect(request(RUNTIME_METHODS.listExcludedWorkspaces).result).toEqual(
      await rust.request(RUNTIME_METHODS.listExcludedWorkspaces, {}),
    );
    expect(
      request(RUNTIME_METHODS.restoreExcludedWorkspace, { path: alias }).error,
    ).toBeUndefined();
    expect(
      database.prepare("SELECT * FROM excluded_workspaces WHERE canonical_path = ?").all(project),
    ).toEqual([]);
    await workspace(RUNTIME_METHODS.addWorkspace, { path: project });
    const current = database
      .prepare("SELECT id FROM workspaces WHERE canonical_path = ?")
      .get(project)!.id as string;
    // A failed refresh commits attention but keeps the previous catalog, as the Rust owner does.
    await rm(project, { recursive: true });
    const failed = await workspace(RUNTIME_METHODS.refreshWorkspace, { id: current });
    expect(failed.error?.code).toBe(-32000);
    expect(
      database.prepare("SELECT status, warning_count FROM workspaces WHERE id = ?").get(current),
    ).toMatchObject({ status: "attention", warning_count: 1 });
    expect(
      database.prepare("SELECT * FROM catalog_assets WHERE workspace_id = ?").all(current).length,
    ).toBeGreaterThan(0);
    expect(request(RUNTIME_METHODS.listWorkspaces).result).toEqual(
      await rust.request(RUNTIME_METHODS.listWorkspaces, {}),
    );
    const context = await rust.request<NativeContext>(NATIVE_CONTEXT, {});
    await mkdir(path.join(directory, "codex"), { recursive: true });
    expect(
      request(BACKEND_PLAN_WORKSPACE, {
        operation: "add",
        path: path.join(directory, "codex"),
        context,
      }).error?.code,
    ).toBe(-32000);
  });

  it("preserves scan-root identity, creation timestamps, depth clamping, and deletion", async () => {
    const root = path.join(directory, "scan-root");
    await mkdir(root);
    const first = request(RUNTIME_METHODS.addScanRoot, { path: root, maxDepth: 0 }).result as {
      id: string;
      created_at: string;
    };
    expect(first).toMatchObject({ path: root, max_depth: 1, enabled: true });
    database
      .prepare(
        "UPDATE scan_roots SET enabled = 0, created_at = '2026-09-30T08:00:00.123456789+08:00' WHERE id = ?",
      )
      .run(first.id);
    const second = request(RUNTIME_METHODS.addScanRoot, { path: root, maxDepth: 99 });
    expect(second.error).toBeUndefined();
    expect(second.result).toMatchObject({
      id: first.id,
      max_depth: 8,
      enabled: true,
      created_at: "2026-09-30T00:00:00.123456789Z",
    });
    expect(request(RUNTIME_METHODS.listScanRoots).result).toEqual(
      await rust.request(RUNTIME_METHODS.listScanRoots, {}),
    );
    expect(request(RUNTIME_METHODS.removeScanRoot, { id: first.id }).error).toBeUndefined();
    expect(request(RUNTIME_METHODS.removeScanRoot, { id: "missing" }).result).toBeNull();
  });

  it("persists discovery atomically without deleting existing projects when providers fail", async () => {
    const project = path.join(directory, "discovered");
    const excluded = path.join(directory, "excluded");
    const probe = path.join(directory, "probe");
    const retained = path.join(directory, "retained");
    for (const value of [project, excluded, probe, retained]) await mkdir(value);
    await writeFile(path.join(probe, ".codexbar-session-id"), "probe");
    const retainedId = (await workspace(RUNTIME_METHODS.addWorkspace, { path: retained }))
      .result as { id: string };
    const excludedId = (await workspace(RUNTIME_METHODS.addWorkspace, { path: excluded }))
      .result as { id: string };
    request(RUNTIME_METHODS.excludeWorkspace, { id: excludedId.id });
    await writeFile(path.join(project, "AGENTS.md"), "Discovery instructions");
    const context = await rust.request<NativeContext>(NATIVE_CONTEXT, {});
    const candidate = {
      source_agent: "codex",
      evidence: "session-cwd",
      last_active_at: "2026-09-30T00:00:00.123456789Z",
      session_count: 3,
      repository_group_id: "group",
      session_cwds: [project, path.join(project, "sub")],
    };
    const snapshot: DiscoverySnapshot = {
      candidates: [
        ...[project, excluded, probe, path.join(directory, "codex")].map((value) => ({
          ...candidate,
          path: value,
        })),
        ...[
          "claude-code",
          "cursor",
          "opencode",
          "open-claw",
          "hermes",
          "grok-build",
          "antigravity",
          "deepseek-harness",
        ].map((agent) => ({ ...candidate, source_agent: agent, path: project })),
      ],
      installations: [
        {
          agent: "codex",
          installed: true,
          configured: true,
          version: "fixture",
          home: path.join(directory, "codex"),
          warnings: [],
        },
      ],
      home_assets: [
        {
          id: "",
          scope: "agent-home",
          workspace_id: null,
          agent: "codex",
          kind: "instruction",
          name: "AGENTS.md",
          path: path.join(directory, "codex", "AGENTS.md"),
          summary: "Global instructions",
          size: 20,
          modified_at: null,
        },
      ],
      errors: ["fixture provider failed"],
      source_diagnostics: [
        "codex",
        "claude-code",
        "cursor",
        "opencode",
        "open-claw",
        "hermes",
        "grok-build",
        "antigravity",
        "deepseek-harness",
      ].map((agent) => ({
        agent,
        source: "fixture",
        status: "failed",
        started_at: "2026-09-30T00:00:00Z",
        finished_at: "2026-09-30T00:00:01Z",
        reasons: ["fixture provider failed"],
      })),
    };
    const plan = request(BACKEND_PLAN_DISCOVERY, { snapshot, context }).result as DiscoveryPlan;
    expect(plan.workspaces).toHaveLength(1);
    const inspections = await rust.request<InspectedWorkspace[]>(NATIVE_INSPECT, {
      workspaces: plan.workspaces,
    });
    const before = database.prepare("SELECT count(*) AS count FROM workspaces").get()!.count;
    expect(
      request(RUNTIME_METHODS.refreshDiscovery, {
        _plan: plan,
        _snapshot: snapshot,
        _inspections: [],
        _queuedAt: "2026-09-30T00:00:00Z",
        _startedAt: "2026-09-30T00:00:00.123456789Z",
      }).error?.code,
    ).toBe(-32000);
    expect(database.prepare("SELECT count(*) AS count FROM workspaces").get()!.count).toBe(before);
    // A failed installation insert rolls back every preceding workspace/catalog mutation.
    const invalid = {
      ...snapshot,
      installations: [{ ...snapshot.installations[0]!, version: { invalid: true } }],
    };
    expect(
      request(RUNTIME_METHODS.refreshDiscovery, {
        _plan: plan,
        _snapshot: invalid,
        _inspections: inspections,
        _queuedAt: "2026-09-30T00:00:00Z",
        _startedAt: "2026-09-30T00:00:00Z",
      }).error?.code,
    ).toBe(-32000);
    expect(database.prepare("SELECT count(*) AS count FROM workspaces").get()!.count).toBe(before);
    const receipt = request(RUNTIME_METHODS.refreshDiscovery, {
      _plan: plan,
      _snapshot: snapshot,
      _inspections: inspections,
      _queuedAt: "2026-09-30T00:00:00Z",
      _startedAt: "2026-09-30T00:00:00.123456789Z",
    });
    expect(receipt.error).toBeUndefined();
    expect(receipt.result).toMatchObject({
      kind: "discovery",
      status: { state: "succeeded", progress_current: 1, progress_total: 1 },
    });
    expect(
      database.prepare("SELECT id FROM workspaces WHERE id = ?").get(retainedId.id),
    ).toBeDefined();
    expect(request(RUNTIME_METHODS.listWorkspaces).result).toEqual(
      await rust.request(RUNTIME_METHODS.listWorkspaces, {}),
    );
    const report = request(RUNTIME_METHODS.discoveryReport);
    expect(report.error).toBeUndefined();
    expect(report.result).toEqual(await rust.request(RUNTIME_METHODS.discoveryReport, {}));
    expect(report.result).toMatchObject({
      discovered_count: 1,
      errors: ["fixture provider failed"],
      started_at: "2026-09-30T00:00:00.123456789Z",
    });
    const latest = database
      .prepare(
        "SELECT id, source_diagnostics FROM discovery_runs ORDER BY finished_at DESC LIMIT 1",
      )
      .get()!;
    const diagnostics = JSON.parse(latest.source_diagnostics as string);
    diagnostics[0].started_at = "2026-09-30T08:00:00.123456789+08:00";
    diagnostics[0].path = null;
    diagnostics[0].candidate_count = null;
    diagnostics[0].future_field = true;
    database
      .prepare("UPDATE discovery_runs SET source_diagnostics = ? WHERE id = ?")
      .run(JSON.stringify(diagnostics), latest.id as string);
    expect(request(RUNTIME_METHODS.discoveryReport).result).toEqual(
      await rust.request(RUNTIME_METHODS.discoveryReport, {}),
    );
    database
      .prepare("UPDATE discovery_runs SET discovered_count = -1 WHERE id = ?")
      .run(latest.id as string);
    const invalidCount = await rust.request(RUNTIME_METHODS.discoveryReport, {}).then(
      () => null,
      (error: unknown) => error,
    );
    expect(invalidCount).toBeInstanceOf(RuntimeRequestError);
    expect(request(RUNTIME_METHODS.discoveryReport).error?.code).toBe(
      (invalidCount as RuntimeRequestError).code,
    );
    database
      .prepare(
        "UPDATE discovery_runs SET source_diagnostics = ?, discovered_count = 1 WHERE id = ?",
      )
      .run(latest.source_diagnostics as string, latest.id as string);
    const homeAsset = database
      .prepare("SELECT id FROM catalog_assets WHERE scope = 'agent-home'")
      .get();
    expect(homeAsset!.id).toMatch(/^[a-f0-9]{64}$/);
    // The native adapter exposes scan data without persisting discovery reports/workspaces.
    const reports = database.prepare("SELECT count(*) AS count FROM discovery_runs").get()!.count;
    const raw = await rust.request<DiscoverySnapshot>(NATIVE_DISCOVERY, {
      roots: [{ path: project, max_depth: 1 }],
    });
    expect(raw.candidates.some((value) => value.path === project)).toBe(true);
    expect(database.prepare("SELECT count(*) AS count FROM discovery_runs").get()!.count).toBe(
      reports,
    );
  }, 30_000);

  it("matches all remaining application preferences, onboarding transitions, and quota selectors", async () => {
    const cases: [string, unknown][] = [
      [RUNTIME_METHODS.setSessionIndexEnabled, { enabled: false }],
      [RUNTIME_METHODS.setLocalAutoRefresh, { value: false }],
      [RUNTIME_METHODS.setQuotaAutoRefresh, { enabled: true }],
      [RUNTIME_METHODS.setQuotaPromptSeen, { seen: false }],
      [
        RUNTIME_METHODS.updateOnboarding,
        { event: { event: "doctor-completed", workspace_id: "first", repairable_count: 2 } },
      ],
      [
        RUNTIME_METHODS.updateOnboarding,
        { event: { event: "repair-applied", workspace_id: "first" } },
      ],
      [
        RUNTIME_METHODS.updateOnboarding,
        { event: { event: "doctor-completed", workspace_id: "second", repairable_count: 0 } },
      ],
      [RUNTIME_METHODS.updateOnboarding, { event: { event: "dismissed" } }],
      [RUNTIME_METHODS.updateOnboarding, { event: { event: "restarted" } }],
    ];
    for (const [method, params] of cases) {
      const prior = await readFile(path.join(directory, "preferences.json"), "utf8");
      const expected = await rust.request<Record<string, unknown>>(method, params);
      await writeFile(path.join(directory, "preferences.json"), prior);
      const result = request(method, params);
      expect(result.error).toBeUndefined();
      expect(expected).toMatchObject(result.result as object);
      expect(await rust.request(RUNTIME_METHODS.runtimeInfo, {})).toMatchObject(
        result.result as object,
      );
    }
    // Disabling indexing leaves the worker fence/clearing in the native adapter until batch 3.
    database
      .prepare(
        "INSERT INTO conversation_index_status(workspace_id, agent, last_attempt_at, session_count) VALUES (?, 'codex', ?, 0)",
      )
      .run(retainedWorkspaceId(), "2026-09-30T00:00:00Z");
    await rust.request(NATIVE_SESSION_INDEX_CHANGED, { value: false });
    expect(
      database.prepare("SELECT count(*) AS count FROM conversation_index_status").get()!.count,
    ).toBe(0);
    const preferences = {
      hidden_providers: [" codex", "codex", "", "codex", "😀", "中"],
      hidden_windows: [
        { provider_id: "codex", account_id: "b", kind: "session", label: "Session" },
        { provider_id: "codex", kind: "session", label: "Session" },
        { provider_id: "codex", account_id: "a", kind: "session", label: "Session" },
        { provider_id: "codex", kind: "session", label: "Session" },
        { provider_id: "", kind: "session", label: "Session" },
      ],
    };
    const expected = await rust.request(RUNTIME_METHODS.setQuotaPreferences, { preferences });
    expect(request(RUNTIME_METHODS.setQuotaPreferences, { preferences }).result).toEqual(expected);
    expect(request(RUNTIME_METHODS.quotaPreferences).result).toEqual(
      await rust.request(RUNTIME_METHODS.quotaPreferences, {}),
    );
    const saved = JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8"));
    expect(saved.future_setting).toEqual({ nested: [1, 2, 3] });
  });

  function retainedWorkspaceId(): string {
    return database.prepare("SELECT id FROM workspaces LIMIT 1").get()!.id as string;
  }

  it("rejects invalid batch-one requests without writing preferences or roots", async () => {
    const cases: [string, unknown][] = [
      [RUNTIME_METHODS.setLocalAutoRefresh, { value: true, enabled: false }],
      [RUNTIME_METHODS.setSessionIndexEnabled, {}],
      [RUNTIME_METHODS.setQuotaPromptSeen, { seen: "true" }],
      [
        RUNTIME_METHODS.setQuotaPreferences,
        { preferences: { hidden_windows: [{ provider_id: "codex" }] } },
      ],
      [RUNTIME_METHODS.setQuotaPreferences, { preferences: { hidden_providers: null } }],
      [
        RUNTIME_METHODS.updateOnboarding,
        { event: { event: "doctor-completed", workspace_id: "fixture", repairable_count: -1 } },
      ],
      [RUNTIME_METHODS.updateOnboarding, { event: { event: "unsupported" } }],
      [RUNTIME_METHODS.addScanRoot, { path: directory, maxDepth: -1 }],
      [RUNTIME_METHODS.addScanRoot, { path: directory }],
      [RUNTIME_METHODS.removeScanRoot, { id: null }],
      [RUNTIME_METHODS.excludeWorkspace, { id: null }],
      [RUNTIME_METHODS.restoreExcludedWorkspace, { path: 1 }],
    ];
    const preferences = await readFile(path.join(directory, "preferences.json"), "utf8");
    const roots = request(RUNTIME_METHODS.listScanRoots).result;
    for (const [method, params] of cases) {
      const failure = await rust.request(method, params).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RuntimeRequestError);
      expect(request(method, params).error?.code).toBe((failure as RuntimeRequestError).code);
    }
    expect(await readFile(path.join(directory, "preferences.json"), "utf8")).toBe(preferences);
    expect(request(RUNTIME_METHODS.listScanRoots).result).toEqual(roots);
  });

  it("rejects incompatible schemas without changing the database", () => {
    database.prepare("UPDATE schema_meta SET value = '16' WHERE key = 'schema_version'").run();
    const other = new TypeScriptBackend(environment);
    try {
      expect(
        other.handle({
          jsonrpc: "2.0",
          id: 1,
          method: BACKEND_INITIALIZE,
          params: { dataDir: directory },
        }).error?.code,
      ).toBe(-32000);
      expect(
        database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value,
      ).toBe("16");
    } finally {
      other.close();
      database.prepare("UPDATE schema_meta SET value = '15' WHERE key = 'schema_version'").run();
    }
  });
});
