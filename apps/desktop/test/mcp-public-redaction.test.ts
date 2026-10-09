import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import { serverSchema } from "../../../packages/backend/src/mcp-config-read";
import { publicMcpConfig, redactMcpText } from "../../../packages/backend/src/mcp-import";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-public-redaction-"))),
    home = path.join(root, "home"),
    data = path.join(root, "data");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(home);
  const store = new BackendStore(path.join(data, "db.sqlite"));
  cleanups.push(() => store.close());
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, { HOME: home, USERPROFILE: home }, data, commands);
  cleanups.push(() => manager.closeAsync());
  const management = new McpManagement(store, { HOME: home, USERPROFILE: home }, data, manager);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const execute = vi.spyOn(commands, "run").mockRejectedValue(new Error("Unexpected execution"));
  return { home, root, store, management, fetch, execute };
}

describe("bounded public MCP redaction", () => {
  it("does not reprocess generated markers across repeated private values in real collection", () => {
    const f = fixture();
    const text = JSON.stringify({
      mcpServers: {
        demo: {
          command: "node",
          env: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`DEMO_${index}`, "e"])),
        },
      },
    });
    const preview = f.management.previewImport({ text });
    expect(preview.items[0]?.status).toBe("new");
    expect(preview.items[0]?.config).toMatchObject({ command: "nod[redacted]", env: {} });
    f.management.applyImport({
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: preview.items[0]!.key, action: "add" }],
    });
    expect(f.management.state({}).servers[0]?.config).toMatchObject({
      command: "nod[redacted]",
      env: {},
    });
    expect(
      JSON.parse(readFileSync(path.join(f.home, ".agentkib/mcp.json"), "utf8")).servers[0],
    ).toMatchObject({ command: "node", enabled: false });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["node", ["e", "d"], "no[redacted]"],
    ["node", ["d", "e"], "no[redacted]"],
    ["abcde", ["abc", "cde"], "[redacted]"],
    ["abcde", ["cde", "abc"], "[redacted]"],
    ["ababa", ["aba"], "[redacted]"],
    ["x 秘密碼 y 秘密碼 z", ["秘密", "密碼"], "x [redacted] y [redacted] z"],
    ["a.*b|a.*b", ["a.*b"], "[redacted]|[redacted]"],
  ] as const)("masks original overlapping literal matches in %s", (text, secrets, expected) => {
    expect(redactMcpText(text, secrets)).toBe(expected);
  });

  it("preserves normal fields and source data across public projection", () => {
    const source = serverSchema.parse({
      id: "demo",
      name: "demo",
      transport: "stdio",
      command: "runner",
      args: ["--token", "secret-value-3482", "--mode", "ordinary", "secret-value-3482"],
      env: { TOKEN: "secret-value-3482" },
      headers: { Authorization: "secret-value-3482" },
    });
    const before = structuredClone(source),
      publicValue = publicMcpConfig(source);
    expect(publicValue).toMatchObject({
      command: "runner",
      args: ["--token", "[redacted]", "--mode", "ordinary", "[redacted]"],
      env: {},
      headers: {},
    });
    expect(source).toEqual(before);
    expect(publicMcpConfig(publicValue)).toEqual(publicValue);
  });

  it("shares the public projection budget across arguments and rejects before returning partial data", () => {
    const source = serverSchema.parse({
      id: "demo",
      name: "demo",
      transport: "stdio",
      command: "runner",
      args: Array.from({ length: 9 }, () => "x".repeat(1024 * 1024)),
    });
    expect(() => publicMcpConfig(source)).toThrow("redaction complexity limit");
    expect(source.args).toHaveLength(9);
    expect(source.args.every((value) => value.length === 1024 * 1024)).toBe(true);
  });

  it("does not swallow a public URL redaction budget failure", () => {
    const source = serverSchema.parse({
      id: "demo",
      name: "demo",
      transport: "streamable-http",
      url: "https://example.test/mcp",
      env: Object.fromEntries(
        Array.from({ length: 1025 }, (_, index) => [`ITEM_${index}`, `value-${index}`]),
      ),
    });
    expect(() => publicMcpConfig(source)).toThrow("redaction complexity limit");
  });

  it("rejects a save before writing a configuration that cannot be safely projected", () => {
    const f = fixture(),
      before = f.management.state({});
    expect(() =>
      f.management.save({
        revision: before.revision,
        server: serverSchema.parse({
          id: "demo",
          name: "demo",
          transport: "stdio",
          command: "runner",
        }),
        secretOperations: {
          env: Object.fromEntries(
            Array.from({ length: 1025 }, (_, index) => [
              `ITEM_${index}`,
              { action: "replace", value: `value-${index}` },
            ]),
          ),
        },
      }),
    ).toThrow("redaction complexity limit");
    expect(f.management.state({})).toEqual(before);
    expect(existsSync(path.join(f.home, ".agentkib/mcp.json"))).toBe(false);
    expect(existsSync(path.join(f.home, ".agentkib/mcp.local.json"))).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("includes inherited private values in the write preflight without changing either scope", () => {
    const f = fixture(),
      project = path.join(f.root, "project");
    mkdirSync(project);
    f.store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "registered",
      project,
      "fixture",
      "healthy",
      new Date().toISOString(),
    );
    const global = f.management.save({
      revision: f.management.state({}).revision,
      server: serverSchema.parse({
        id: "demo",
        name: "demo",
        transport: "stdio",
        command: "runner",
      }),
      secretOperations: {
        env: Object.fromEntries(
          Array.from({ length: 1024 }, (_, index) => [
            `ITEM_${index}`,
            { action: "replace", value: `value-${index}` },
          ]),
        ),
      },
    });
    const files = ["mcp.json", "mcp.local.json"].map((name) =>
      path.join(f.home, ".agentkib", name),
    );
    const original = files.map((file) => readFileSync(file));
    const before = f.management.state({ project });
    expect(() =>
      f.management.save({
        project,
        revision: before.revision,
        server: before.servers[0]!.config,
        overrideInherited: true,
        secretOperations: { env: { EXTRA: { action: "replace", value: "extra-private-value" } } },
      }),
    ).toThrow("redaction complexity limit");
    expect(f.management.state({})).toEqual(global);
    expect(f.management.state({ project })).toEqual(before);
    expect(files.map((file) => readFileSync(file))).toEqual(original);
    expect(existsSync(path.join(project, ".agentkib/mcp.json"))).toBe(false);
    expect(existsSync(path.join(project, ".agentkib/mcp.local.json"))).toBe(false);
  });
});
