import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import { serverSchema, type McpServer } from "../../../packages/backend/src/mcp-config-read";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const credentialMethods = ["saveOAuthCredentials", "clearOAuthCredentials", "saveLocal"] as const;
type CredentialMethod = (typeof credentialMethods)[number];
const originalCredentials = { fixture: "original" };
const replacementCredentials = { fixture: "replacement" };

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-legacy-local-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    data = path.join(root, "data");
  for (const directory of [home, project]) mkdirSync(directory);
  const environment = { HOME: home, USERPROFILE: home };
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
  const server = serverSchema.parse({
    id: "legacy",
    name: "Legacy service",
    transport: "streamable-http",
    url: "https://legacy.example.test/mcp",
    enabled: true,
    targets: ["codex"],
  });
  function configPath(scope: string | undefined, local: boolean) {
    return path.join(scope ?? home, ".agentkib", local ? "mcp.local.json" : "mcp.json");
  }
  return {
    home,
    project,
    manager,
    management,
    server,
    write(server: McpServer, scope: string | undefined, local: boolean) {
      const file = configPath(scope, local);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ schema_version: 1, servers: [server] }));
    },
    local(scope?: string): McpServer {
      return JSON.parse(readFileSync(configPath(scope, true), "utf8")).servers[0];
    },
    update(method: CredentialMethod, scope?: string) {
      if (method === "saveOAuthCredentials")
        manager.saveOAuthCredentials(server.id, replacementCredentials, scope);
      else if (method === "clearOAuthCredentials") manager.clearOAuthCredentials(server.id, scope);
      else
        manager.saveLocal(server.id, { KEY: "replacement" }, { "X-Fixture": "replacement" }, scope);
    },
  };
}

function expectCredentials(server: McpServer | null, method: CredentialMethod) {
  expect(server?.oauth_credentials).toEqual(
    method === "saveOAuthCredentials"
      ? replacementCredentials
      : method === "clearOAuthCredentials"
        ? undefined
        : originalCredentials,
  );
  expect(server?.env).toEqual({ KEY: method === "saveLocal" ? "replacement" : "original" });
  expect(server?.headers).toEqual({
    "X-Fixture": method === "saveLocal" ? "replacement" : "original",
  });
}

function deletedValuesFixture(scope: "global" | "workspace") {
  const f = fixture(),
    project = scope === "global" ? undefined : f.project;
  f.management.save({
    revision: f.management.state({}).revision,
    server: f.server,
    secretOperations: {
      env: {
        KEY: { action: "replace", value: "original" },
        UNRELATED: { action: "replace", value: "keep-revoked" },
      },
      headers: {
        "X-Fixture": { action: "replace", value: "original" },
        "X-Unrelated": { action: "replace", value: "keep-revoked" },
      },
    },
  });
  const state = f.management.state({ project });
  f.management.save({
    project,
    revision: state.revision,
    originalId: f.server.id,
    overrideInherited: scope === "workspace",
    server: state.servers[0]!.config,
    secretOperations: {
      env: { KEY: { action: "delete" }, UNRELATED: { action: "delete" } },
      headers: { "X-Fixture": { action: "delete" }, "X-Unrelated": { action: "delete" } },
    },
  });
  const effective = f.manager.getPrivate(f.server.id, project);
  expect(effective?.env).toEqual({});
  expect(effective?.headers).toEqual({});
  expect(f.local(project)).toMatchObject({
    deleted_env: ["KEY", "UNRELATED"],
    deleted_headers: ["X-Fixture", "X-Unrelated"],
  });
  return { ...f, project };
}

describe.each(["global", "workspace"] as const)(
  "legacy private-value writes after %s management deletes",
  (scope) => {
    it("restores only explicitly supplied keys, including an empty value", () => {
      const f = deletedValuesFixture(scope);
      f.manager.saveLocal(f.server.id, { KEY: "replacement" }, { "X-Fixture": "" }, f.project);
      const effective = f.manager.getPrivate(f.server.id, f.project);
      expect(effective?.env).toEqual({ KEY: "replacement" });
      expect(effective?.headers).toEqual({ "X-Fixture": "" });
      expect(f.local(f.project)).toMatchObject({
        local_values_only: true,
        deleted_env: ["UNRELATED"],
        deleted_headers: ["X-Unrelated"],
      });
      if (scope === "workspace")
        expect(f.manager.getPrivate(f.server.id)).toMatchObject({
          env: { KEY: "original", UNRELATED: "keep-revoked" },
          headers: { "X-Fixture": "original", "X-Unrelated": "keep-revoked" },
        });
    });

    it.each(["env", "headers"] as const)(
      "rejects invalid %s without changing either config",
      (kind) => {
        const f = deletedValuesFixture(scope),
          directory = path.join(f.project ?? f.home, ".agentkib"),
          publicFile = path.join(directory, "mcp.json"),
          privateFile = path.join(directory, "mcp.local.json"),
          publicBefore = readFileSync(publicFile, "utf8"),
          privateBefore = readFileSync(privateFile, "utf8");
        const invalid = { KEY: 42 } as unknown as Record<string, string>;
        expect(() =>
          f.manager.saveLocal(
            f.server.id,
            kind === "env" ? invalid : { KEY: "replacement" },
            kind === "headers" ? invalid : { "X-Fixture": "replacement" },
            f.project,
          ),
        ).toThrow("string maps");
        expect(readFileSync(publicFile, "utf8")).toBe(publicBefore);
        expect(readFileSync(privateFile, "utf8")).toBe(privateBefore);
      },
    );
  },
);

describe.each(["global", "workspace"] as const)("legacy %s local-only MCP definitions", (scope) => {
  it.each(credentialMethods)("preserves the service when calling %s", (method) => {
    const f = fixture(),
      project = scope === "global" ? undefined : f.project;
    f.write(
      {
        ...f.server,
        oauth_credentials: originalCredentials,
        env: { KEY: "original" },
        headers: { "X-Fixture": "original" },
      },
      project,
      true,
    );
    f.update(method, project);
    const effective = f.manager.getPrivate(f.server.id, project);
    expect(effective).toMatchObject(f.server);
    expectCredentials(effective, method);
    expect(f.local(project).local_values_only).toBeUndefined();
  });
});

describe("credential writes preserve local MCP overlay semantics", () => {
  it.each(credentialMethods)(
    "preserves a legacy workspace endpoint override during %s",
    (method) => {
      const f = fixture();
      f.write(
        {
          ...f.server,
          url: "https://global.example.test/mcp",
          enabled: false,
          targets: ["cursor"],
        },
        undefined,
        false,
      );
      f.write(
        {
          ...f.server,
          oauth_credentials: originalCredentials,
          env: { KEY: "original" },
          headers: { "X-Fixture": "original" },
        },
        f.project,
        true,
      );
      f.update(method, f.project);
      const effective = f.manager.getPrivate(f.server.id, f.project);
      expect(effective).toMatchObject(f.server);
      expectCredentials(effective, method);
      expect(f.local(f.project).local_values_only).toBeUndefined();
      expect(f.manager.getPrivate(f.server.id)).toMatchObject({
        url: "https://global.example.test/mcp",
        enabled: false,
        targets: ["cursor"],
      });
    },
  );

  it.each(credentialMethods)(
    "keeps private values separate after management converts a legacy entry during %s",
    (method) => {
      const f = fixture();
      f.write({ ...f.server, enabled: false }, f.project, true);
      f.management.save({
        project: f.project,
        revision: f.management.state({ project: f.project }).revision,
        originalId: f.server.id,
        server: { ...f.server, enabled: false },
        secretOperations: {
          env: { KEY: { action: "replace", value: "original" } },
          headers: { "X-Fixture": { action: "replace", value: "original" } },
        },
      });
      f.manager.saveOAuthCredentials(f.server.id, originalCredentials, f.project);
      f.update(method, f.project);
      f.manager.save(
        {
          ...f.server,
          url: "https://updated.example.test/mcp",
          enabled: true,
          targets: ["cursor"],
        },
        f.project,
      );
      const effective = f.manager.getPrivate(f.server.id, f.project);
      expect(effective).toMatchObject({
        url: "https://updated.example.test/mcp",
        enabled: true,
        targets: ["cursor"],
      });
      expectCredentials(effective, method);
      expect(f.local(f.project).local_values_only).toBe(true);
    },
  );

  it("creates a values-only entry when saving private values for an inherited public definition", () => {
    const f = fixture();
    f.write(f.server, undefined, false);
    f.update("saveLocal", f.project);
    f.manager.save({ ...f.server, url: "https://updated.example.test/mcp", enabled: false });
    expect(f.local(f.project).local_values_only).toBe(true);
    expect(f.manager.getPrivate(f.server.id, f.project)).toMatchObject({
      url: "https://updated.example.test/mcp",
      enabled: false,
      env: { KEY: "replacement" },
      headers: { "X-Fixture": "replacement" },
    });
  });

  it("clears inherited OAuth from a legacy override without changing other inheritance", () => {
    const f = fixture();
    f.write(f.server, undefined, false);
    f.write(
      {
        ...f.server,
        local_values_only: true,
        oauth_credentials: originalCredentials,
        env: { GLOBAL: "inherited" },
        headers: { "X-Global": "inherited" },
      },
      undefined,
      true,
    );
    f.write(
      { ...f.server, url: "https://workspace.example.test/mcp", targets: [] },
      f.project,
      true,
    );
    expect(f.manager.getPrivate(f.server.id, f.project)?.oauth_credentials).toEqual(
      originalCredentials,
    );
    f.update("clearOAuthCredentials", f.project);
    f.update("saveLocal", f.project);
    f.manager.save({ ...f.server, targets: ["cursor"] });
    expect(f.manager.getPrivate(f.server.id, f.project)).toMatchObject({
      url: "https://workspace.example.test/mcp",
      targets: ["cursor"],
      oauth_credentials: undefined,
      env: { GLOBAL: "inherited", KEY: "replacement" },
      headers: { "X-Global": "inherited", "X-Fixture": "replacement" },
    });
    expect(f.local(f.project).clear_oauth).toBe(true);
    expect(f.manager.getPrivate(f.server.id)?.oauth_credentials).toEqual(originalCredentials);
    f.update("saveOAuthCredentials", f.project);
    expect(f.local(f.project).clear_oauth).toBeUndefined();
    expect(f.manager.getPrivate(f.server.id, f.project)?.oauth_credentials).toEqual(
      replacementCredentials,
    );
  });
});
