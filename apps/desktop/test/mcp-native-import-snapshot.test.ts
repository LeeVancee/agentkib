import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import {
  readNativeMcpImport,
  readNativeMcpImports,
  scanNativeMcp,
} from "../../../packages/backend/src/mcp-native-scan";
import { McpStdioTransport } from "../../../packages/backend/src/mcp-stdio-transport";
import { planNativeMcpMigration } from "../../../packages/backend/src/mcp-migration-plan";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
function fixture() {
  const root = canonicalize(
    mkdtempSync(path.join(os.tmpdir(), "agentkib-native-import-snapshot-")),
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    data = path.join(root, "data");
  mkdirSync(home);
  mkdirSync(project);
  const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  const store = new BackendStore(path.join(data, "db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "registered",
    project,
    "fixture",
    "healthy",
    new Date().toISOString(),
  );
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const management = new McpManagement(store, environment, data, manager);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Unexpected network request");
  });
  const command = vi.spyOn(commands, "run").mockImplementation(() => {
    throw new Error("Unexpected command");
  });
  const process = vi.spyOn(McpStdioTransport.prototype, "start").mockImplementation(() => {
    throw new Error("Unexpected process");
  });
  const scan = () => scanNativeMcp({ project }, store, environment);
  const preview = (candidateIds = scan().map((candidate) => candidate.id)) =>
    management.previewImport({ project, candidateIds });
  const apply = (plan: ReturnType<typeof preview>) =>
    management.applyImport({
      project,
      token: plan.token,
      revision: plan.revision,
      selections: plan.items.map((item) => ({ key: item.key, action: "add" as const })),
    });
  return {
    root,
    home,
    project,
    environment,
    store,
    manager,
    management,
    scan,
    preview,
    apply,
    assertOffline: () => {
      expect(network).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(process).not.toHaveBeenCalled();
    },
  };
}
const reads = (file: string) =>
  vi.mocked(readFileSync).mock.calls.filter(([source]) => source === file).length;
const hub = { running: true, port: 47653 };
const bulkContent = () =>
  JSON.stringify({
    description: "ordinary text ".repeat(50_000),
    mcp: {
      servers: Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => [
          `server${String(index).padStart(3, "0")}`,
          { transport: "streamable-http", url: "https://example.invalid/mcp" },
        ]),
      ),
    },
  });
function enableCollected(f: ReturnType<typeof fixture>) {
  const file = path.join(f.project, ".agentkib/mcp.json");
  const document = JSON.parse(readFileSync(file, "utf8"));
  for (const server of document.servers) server.enabled = true;
  write(file, JSON.stringify(document));
  vi.spyOn(f.manager, "hasCurrentProbe").mockReturnValue(true);
}
function migrate(f: ReturnType<typeof fixture>, ids = f.scan().map((candidate) => candidate.id)) {
  return f.management.previewMigration(
    {
      project: f.project,
      revision: f.management.state({ project: f.project }).revision,
      candidateIds: ids,
    },
    hub,
  );
}

describe("native MCP import operation snapshots", () => {
  it("previews and collects 128 valid services with bounded reads and event-loop delay", async () => {
    const f = fixture(),
      source = path.join(f.home, ".openclaw/openclaw.json");
    const content = bulkContent();
    expect(Buffer.byteLength(content)).toBeGreaterThan(700_000);
    write(source, content);
    const ids = f.scan().map((candidate) => candidate.id);
    vi.mocked(readFileSync).mockClear();
    const started = performance.now();
    const timer = new Promise<number>((resolve) =>
      setTimeout(() => resolve(performance.now() - started), 1),
    );
    const preview = f.preview(ids);
    const previewMs = performance.now() - started,
      timerMs = await timer;
    expect(preview.items).toHaveLength(128);
    expect(preview.items.every((item) => item.status === "new")).toBe(true);
    expect(reads(source)).toBeLessThanOrEqual(2);
    expect(previewMs).toBeLessThan(1000);
    expect(timerMs).toBeLessThan(1000);
    vi.mocked(readFileSync).mockClear();
    const applyStarted = performance.now();
    const result = f.apply(preview);
    expect(performance.now() - applyStarted).toBeLessThan(1000);
    expect(reads(source)).toBeLessThanOrEqual(2);
    expect(result.results).toHaveLength(128);
    expect(result.results.every((item) => item.status === "saved")).toBe(true);
    expect(
      f.management.state({ project: f.project }).servers.every((item) => !item.config.enabled),
    ).toBe(true);
    expect(readFileSync(source, "utf8")).toBe(content);
    f.assertOffline();
  }, 30_000);

  it("keeps item order, individual failures, private keys and project working directories", () => {
    const f = fixture(),
      source = path.join(f.project, ".mcp.json");
    const content = JSON.stringify({
      mcpServers: {
        ready: { command: "must-not-run", env: { TOKEN: "source-private" } },
        invalid: { url: "https://example.invalid/mcp", extra: "unsupported-private" },
        ambiguous: { command: "must-not-run", cwd: "relative" },
        remote: {
          url: "https://example.invalid/mcp",
          headers: { Authorization: "header-private" },
        },
      },
    });
    write(source, content);
    const candidates = f.scan().reverse();
    const preview = f.preview(candidates.map((candidate) => candidate.id));
    expect(preview.items.map((item) => item.key)).toEqual(
      candidates.map((candidate) => candidate.id),
    );
    for (const item of preview.items) {
      const name = candidates.find((candidate) => candidate.id === item.key)!.name;
      expect(item.status).toBe(["invalid", "ambiguous"].includes(name) ? "blocked" : "new");
      if (name === "ready")
        expect(item).toMatchObject({
          config: { cwd: f.project, env: {} },
          required_env: ["TOKEN"],
        });
      if (name === "remote")
        expect(item).toMatchObject({
          config: { headers: {} },
          required_headers: ["Authorization"],
        });
    }
    expect(JSON.stringify(preview)).not.toMatch(
      /source-private|header-private|unsupported-private/,
    );
    expect(readFileSync(source, "utf8")).toBe(content);
    f.assertOffline();
  });

  it.each(["same size and mtime", "deleted", "profile switched", "unsafe ancestor"])(
    "rereads a native import before apply when its source is %s",
    (change) => {
      const f = fixture(),
        source = path.join(f.home, ".openclaw/openclaw.json");
      const content = JSON.stringify({
        mcp: { servers: { alpha: { url: "https://example.invalid/v1" } } },
      });
      write(source, content);
      const candidate = f.scan()[0]!,
        preview = f.preview([candidate.id]);
      if (change === "same size and mtime") {
        const timestamp = new Date("2026-01-01T00:00:00.000Z");
        utimesSync(source, timestamp, timestamp);
        const before = statSync(source);
        write(source, content.replace("/v1", "/v2"));
        utimesSync(source, before.atime, before.mtime);
        expect(statSync(source).size).toBe(before.size);
        expect(statSync(source).mtimeMs).toBe(before.mtimeMs);
        expect(readNativeMcpImport(candidate)).toMatchObject({ url: "https://example.invalid/v2" });
      } else if (change === "deleted") rmSync(source);
      else if (change === "profile switched") {
        write(path.join(f.home, ".openclaw-other/openclaw.json"), content);
        f.environment.OPENCLAW_PROFILE = "other";
      } else {
        rmSync(path.dirname(source), { recursive: true });
        const redirected = path.join(f.root, "redirected");
        write(path.join(redirected, "openclaw.json"), content);
        symlinkSync(redirected, path.dirname(source), "junction");
      }
      expect(() => f.apply(preview)).toThrow(/changed/);
      expect(f.management.state({ project: f.project }).servers).toEqual([]);
      f.assertOffline();
    },
  );

  it("isolates a failed document read for every selected entry and starts a new batch fresh", () => {
    const f = fixture(),
      broken = path.join(f.project, ".mcp.json"),
      healthy = path.join(f.home, ".cursor/mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        alpha: { url: "https://example.invalid/alpha" },
        beta: { url: "https://example.invalid/beta" },
      },
    });
    write(broken, original);
    write(healthy, '{"mcpServers":{"healthy":{"url":"https://example.invalid/healthy"}}}');
    const candidates = f.scan();
    write(broken, "{ malformed-private");
    vi.mocked(readFileSync).mockClear();
    const results = readNativeMcpImports(candidates, f.project);
    expect(results.map((result) => result.candidate.id)).toEqual(
      candidates.map((candidate) => candidate.id),
    );
    expect(results.filter((result) => "error" in result)).toHaveLength(2);
    expect(results.filter((result) => "server" in result)).toHaveLength(1);
    expect(reads(broken)).toBe(1);
    write(broken, original);
    expect(readNativeMcpImports(candidates, f.project).every((result) => "server" in result)).toBe(
      true,
    );
    expect(reads(broken)).toBe(2);
    f.assertOffline();
  });

  it("keeps the document parser bound to the agent even when candidates share a path", () => {
    const f = fixture(),
      source = path.join(f.project, ".mcp.json");
    write(source, '{"mcpServers":{"alpha":{"url":"https://example.invalid/alpha"}}}');
    const candidate = f.scan()[0]!;
    const results = readNativeMcpImports([candidate, { ...candidate, agent: "codex" }], f.project);
    expect(results[0]).toHaveProperty("server");
    expect(results[1]).toHaveProperty("error");
    f.assertOffline();
  });

  it("uses bounded source reads for a collected 128-service migration preview and apply", async () => {
    const f = fixture(),
      source = path.join(f.home, ".openclaw/openclaw.json"),
      content = bulkContent();
    write(source, content);
    const ids = f.scan().map((candidate) => candidate.id);
    f.apply(f.preview(ids));
    enableCollected(f);
    vi.mocked(readFileSync).mockClear();
    const started = performance.now(),
      preview = await migrate(f, ids);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(reads(source)).toBeLessThanOrEqual(10);
    expect(preview.changes).toHaveLength(1);
    expect(readFileSync(source, "utf8")).toBe(content);
    vi.mocked(readFileSync).mockClear();
    const applyStarted = performance.now();
    f.management.applyMigration({ token: preview.token, approveHome: true }, hub);
    expect(performance.now() - applyStarted).toBeLessThan(1500);
    expect(reads(source)).toBeLessThanOrEqual(5);
    expect(Object.keys(JSON.parse(readFileSync(source, "utf8")).mcp.servers)).toEqual(["agentkib"]);
    expect(f.management.state({ project: f.project }).servers).toHaveLength(128);
    f.assertOffline();
  }, 30_000);

  it("uses bounded source reads for the legacy 128-service migration planner", async () => {
    const f = fixture(),
      source = path.join(f.home, ".openclaw/openclaw.json"),
      content = bulkContent();
    write(source, content);
    write(
      path.join(f.project, ".agentkib/manifest.yaml"),
      "schema_version: 2\nworkspace:\n  id: registered\n  name: fixture\n",
    );
    const ids = f.scan().map((candidate) => candidate.id);
    const probe = vi.spyOn(f.manager, "probeConfig").mockResolvedValue([]);
    vi.mocked(readFileSync).mockClear();
    const started = performance.now();
    const plan = await planNativeMcpMigration(
      { project: f.project, candidateIds: ids, mcpHubStatus: hub },
      f.store,
      f.manager,
      f.environment,
    );
    expect(performance.now() - started).toBeLessThan(1500);
    expect(reads(source)).toBeLessThanOrEqual(5);
    expect(probe).toHaveBeenCalledTimes(128);
    expect(plan.changes).toHaveLength(2);
    expect(readFileSync(source, "utf8")).toBe(content);
    f.assertOffline();
  }, 30_000);

  it.each(["source bytes", "active profile"])(
    "rechecks %s after asynchronous legacy probes",
    async (change) => {
      const f = fixture(),
        source = path.join(f.home, ".openclaw/openclaw.json");
      const content = JSON.stringify({
        mcp: {
          servers: {
            alpha: { url: "https://example.invalid/v1" },
            beta: { url: "https://example.invalid/v1" },
          },
        },
      });
      write(source, content);
      write(
        path.join(f.project, ".agentkib/manifest.yaml"),
        "schema_version: 2\nworkspace:\n  id: registered\n  name: fixture\n",
      );
      const ids = f.scan().map((candidate) => candidate.id);
      vi.spyOn(f.manager, "probeConfig").mockImplementation(async () => {
        await Promise.resolve();
        if (change === "source bytes") write(source, content.replaceAll("/v1", "/v2"));
        else {
          write(path.join(f.home, ".openclaw-other/openclaw.json"), content);
          f.environment.OPENCLAW_PROFILE = "other";
        }
        return [];
      });
      await expect(
        planNativeMcpMigration(
          { project: f.project, candidateIds: ids, mcpHubStatus: hub },
          f.store,
          f.manager,
          f.environment,
        ),
      ).rejects.toThrow(/changed during probe/);
      expect(f.management.state({ project: f.project }).servers).toEqual([]);
      f.assertOffline();
    },
  );

  it("rechecks after awaited planning and again before applying a migration token", async () => {
    const f = fixture(),
      source = path.join(f.project, ".mcp.json");
    const content = '{"mcpServers":{"alpha":{"url":"https://example.invalid/v1"}}}';
    write(source, content);
    const ids = f.scan().map((candidate) => candidate.id);
    f.apply(f.preview(ids));
    enableCollected(f);
    const pending = migrate(f, ids);
    write(source, content.replace("/v1", "/v2"));
    await expect(pending).rejects.toThrow(/changed while planning/);
    write(source, content);
    const preview = await migrate(f, ids);
    write(source, content.replace("/v1", "/v2"));
    expect(() =>
      f.management.applyMigration({ token: preview.token, approveHome: false }, hub),
    ).toThrow(/changed/);
    expect(readFileSync(source, "utf8")).toBe(content.replace("/v1", "/v2"));
    f.assertOffline();
  });
});
