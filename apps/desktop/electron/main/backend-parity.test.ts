import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TypeScriptBackend } from "@agentkib/backend";
import { BACKEND_INITIALIZE, BACKEND_PREFERENCES } from "@agentkib/backend/migration";
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
    directory = await mkdtemp(path.join(tmpdir(), "agentkib-backend-parity-"));
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
      ('recent', '', 'manual', -2, NULL, '[]');
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
