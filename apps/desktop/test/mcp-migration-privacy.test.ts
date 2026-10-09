import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { McpStdioTransport } from "../../../packages/backend/src/mcp-stdio-transport";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture(realProbe = false) {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-migration-privacy-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    data = path.join(root, "data");
  mkdirSync(home);
  mkdirSync(project);
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
  // Preview exercises real collection/planning with no process or network access.
  // Only the apply test explicitly probes its synthetic local stdio fixture.
  if (!realProbe) vi.spyOn(manager, "hasCurrentProbe").mockReturnValue(true);
  const start = vi.spyOn(McpStdioTransport.prototype, "start");
  if (!realProbe) start.mockRejectedValue(new Error("Preview must not launch a process"));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in fixture"));
  const sources = new Map<string, Buffer>();
  const write = (source: string, content: string) => {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, content);
    sources.set(source, readFileSync(source));
    return source;
  };
  const candidates = () => scanNativeMcp({ project }, store, environment);
  const prepare = (names: string[]) => {
    const selected = names.map((name) => {
      const candidate = candidates().find((item) => item.name === name)!;
      expect(candidate.supported).toBe(true);
      return candidate;
    });
    const imported = management.previewImport({
      project,
      candidateIds: selected.map((item) => item.id),
    });
    management.applyImport({
      project,
      token: imported.token,
      revision: imported.revision,
      selections: selected.map((item) => ({ key: item.id, action: "add" })),
    });
    for (const item of imported.items) {
      const state = management.state({ project });
      const config = state.servers.find((entry) => entry.config.id === item.config!.id)!.config;
      management.save({
        project,
        revision: state.revision,
        originalId: config.id,
        server: { ...config, enabled: true },
        secretOperations: {
          env: Object.fromEntries(
            item.required_env.map((key) => [
              key,
              { action: "replace", value: "entered-env-fixture" },
            ]),
          ),
          headers: Object.fromEntries(
            item.required_headers.map((key) => [
              key,
              { action: "replace", value: "entered-header-fixture" },
            ]),
          ),
        },
      });
    }
    const managed = path.join(project, ".agentkib/mcp.json");
    const managedSnapshots = [managed, path.join(project, ".agentkib/mcp.local.json")]
      .filter((file) => existsSync(file))
      .map((file) => [file, readFileSync(file)] as const);
    const assertManagedUnchanged = () => {
      for (const [file, before] of managedSnapshots) expect(readFileSync(file)).toEqual(before);
    };
    const revision = management.state({ project }).revision;
    return {
      selected,
      preview: (candidateNames = names) =>
        management.previewMigration(
          {
            project,
            revision,
            candidateIds: selected
              .filter((item) => candidateNames.includes(item.name))
              .map((item) => item.id),
          },
          hub,
        ),
      assertUnchanged: () => {
        for (const [source, before] of sources) expect(readFileSync(source)).toEqual(before);
        assertManagedUnchanged();
        expect(management.state({ project }).revision).toBe(revision);
      },
      assertManagedUnchanged,
    };
  };
  const assertNoExecution = () => {
    expect(start).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  };
  return {
    root,
    home,
    project,
    write,
    candidates,
    prepare,
    management,
    manager,
    start,
    assertNoExecution,
  };
}

const hub = { running: true, port: 47653 };
const publicArgs = ["--mode", "ordinary-value", "--limit=42"];
const complexityLimit =
  "MCP migration preview exceeds the redaction complexity limit; simplify the configuration and preview again";
type Preview = Awaited<ReturnType<McpManagement["previewMigration"]>>;
function assertPrivate(preview: Preview, secrets: string[]) {
  const visit = (value: unknown) => {
    if (typeof value === "string")
      for (const secret of secrets) expect(value).not.toContain(secret);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        visit(key);
        visit(child);
      }
  };
  for (const change of preview.changes) {
    // The preview is JSON regardless of its native source format. Parse escaped
    // strings so Unicode, quotes, backslashes and newlines cannot hide a leak.
    visit(JSON.parse(change.before));
    visit(JSON.parse(change.after));
  }
}

describe("MCP migration preview privacy", () => {
  it("rejects nested credential derivation before it blocks unrelated work", async () => {
    const f = fixture(),
      secret = "synthetic-budget-private-1729";
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          safe: { url: "https://example.test/mcp" },
          blocked: {
            command: "must-not-run",
            args: [`${"token=".repeat(10_000)}${secret}`],
          },
        },
      }),
    );
    const prepared = f.prepare(["safe"]),
      started = performance.now(),
      unrelatedWork = new Promise<number>((resolve) =>
        setTimeout(() => resolve(performance.now() - started), 0),
      );
    const error = await prepared.preview().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const unrelatedDelay = await unrelatedWork;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(complexityLimit);
    expect((error as Error).message).not.toContain(secret);
    expect(unrelatedDelay).toBeLessThan(1_000);
    prepared.assertUnchanged();
    f.assertNoExecution();
  }, 15_000);

  it("keeps bounded nested assignment, header, URL and quoted credentials private", async () => {
    const f = fixture(),
      privateValues = [
        "synthetic-bounded-nested-9341",
        "synthetic-bounded-bearer-5418",
        "synthetic-bounded-url-key-2086",
      ];
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          safe: { url: "https://example.test/mcp" },
          blocked: {
            command: "must-not-run",
            args: [
              `token=token=token=${privateValues[0]}`,
              `--token="Authorization: Bearer ${privateValues[1]}"`,
              `--password='https://example.test/mcp?key=${privateValues[2]}'`,
              "ordinary-value",
              ...privateValues,
            ],
          },
        },
        extensions: { copies: privateValues, ordinary: "ordinary-value" },
      }),
    );
    const prepared = f.prepare(["safe"]),
      preview = await prepared.preview();
    assertPrivate(preview, privateValues);
    for (const side of [preview.changes[0]!.before, preview.changes[0]!.after]) {
      const document = JSON.parse(side);
      expect(document.mcpServers.blocked.args[3]).toBe("ordinary-value");
      expect(document.extensions.copies).toEqual(privateValues.map(() => "[redacted]"));
      expect(document.extensions.ordinary).toBe("ordinary-value");
    }
    prepared.assertUnchanged();
    f.assertNoExecution();
  });

  it("does not retain a pending migration token for repeated unsafe previews", async () => {
    const f = fixture(),
      secret = "synthetic-repeated-budget-8304";
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          unsafeSource: { url: "https://example.test/unsafe-source" },
          blocked: {
            command: "must-not-run",
            args: [
              Array.from({ length: 1_025 }, (_, index) => `token=${secret}-${index}`).join(" "),
            ],
          },
        },
      }),
    );
    f.write(
      path.join(f.project, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: { safeSource: { url: "https://example.test/safe-source" } },
      }),
    );
    const prepared = f.prepare(["unsafeSource", "safeSource"]);
    // Successful previews have 32 pending slots. Rejection must never consume
    // one or eventually replace its safe error with a capacity error.
    for (let attempt = 0; attempt < 33; attempt++) {
      const error = await prepared.preview(["unsafeSource"]).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toContain(secret);
      expect(message).toBe(complexityLimit);
    }
    const preview = await prepared.preview(["safeSource"]);
    expect(preview.token).toEqual(expect.any(String));
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]!.target).toBe(path.join(f.project, ".cursor/mcp.json"));
    prepared.assertUnchanged();
    f.assertNoExecution();
  }, 15_000);

  it("shares the derivation budget across every file and both snapshots in a migration", async () => {
    const f = fixture(),
      secrets = ["synthetic-budget-first-1367", "synthetic-budget-second-5803"];
    for (const [index, relative] of [".mcp.json", ".cursor/mcp.json"].entries())
      f.write(
        path.join(f.project, relative),
        JSON.stringify({
          mcpServers: {
            [`safe${index}`]: { url: `https://example.test/source-${index}` },
            blocked: {
              command: "must-not-run",
              args: [`${"token=".repeat(300)}${secrets[index]}`],
            },
          },
        }),
      );
    const prepared = f.prepare(["safe0", "safe1"]);
    for (const name of ["safe0", "safe1"]) {
      const preview = await prepared.preview([name]);
      expect(preview.changes).toHaveLength(1);
      assertPrivate(preview, secrets);
    }
    await expect(prepared.preview()).rejects.toThrow(complexityLimit);
    prepared.assertUnchanged();
    f.assertNoExecution();
  });

  it("bounds masking work when many short private values meet a large ordinary field", async () => {
    const f = fixture(),
      values = Array.from({ length: 64 }, (_, index) => `synthetic-mask-budget-${index}-7519`);
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          safe: { url: "https://example.test/mcp" },
          blocked: {
            command: "must-not-run",
            env: Object.fromEntries(values.map((value, index) => [`REGION_${index}`, value])),
          },
        },
        extensions: { text: "ordinary-value:" + "x".repeat(600_000) },
      }),
    );
    const prepared = f.prepare(["safe"]);
    await expect(prepared.preview()).rejects.toThrow(complexityLimit);
    prepared.assertUnchanged();
    f.assertNoExecution();
  });

  it.each(["URL query parameters", "credential map values"])(
    "safely rejects excessive private values found in %s",
    async (source) => {
      const f = fixture(),
        values = Array.from({ length: 1_025 }, (_, index) => `synthetic-many-values-${index}-3427`);
      const blocked =
        source === "URL query parameters"
          ? {
              command: "must-not-run",
              args: [
                "https://example.test/mcp?" +
                  values.map((value, index) => `token${index}=${value}`).join("&"),
              ],
            }
          : {
              command: "must-not-run",
              env: Object.fromEntries(values.map((value, index) => [`REGION_${index}`, value])),
            };
      f.write(
        path.join(f.project, ".mcp.json"),
        JSON.stringify({
          mcpServers: { safe: { url: "https://example.test/mcp" }, blocked },
        }),
      );
      const prepared = f.prepare(["safe"]);
      await expect(prepared.preview()).rejects.toThrow(complexityLimit);
      prepared.assertUnchanged();
      f.assertNoExecution();
    },
  );

  it.each(["JSON", "TOML", "YAML", "JSON5"])(
    "redacts arbitrary env/header values repeated in blocked %s services without execution or writes",
    async (format) => {
      const f = fixture(),
        envValue = "synthetic-opaque-env-4938",
        headerValue = "synthetic-opaque-header-6712",
        args = [...publicArgs, envValue, `prefix:${headerValue}:suffix`, envValue];
      let source: string;
      if (format === "TOML") {
        source = f.write(
          path.join(f.project, ".codex/config.toml"),
          `[mcp_servers.safe]\nurl = "https://example.test/mcp"\n[mcp_servers.blocked]\ncommand = "must-not-run"\nargs = ${JSON.stringify(args)}\n[mcp_servers.blocked.env]\nREGION = "${envValue}"\n[mcp_servers.blocked.http_headers]\nX-Region = "${headerValue}"\n`,
        );
      } else if (format === "YAML") {
        source = f.write(
          path.join(f.home, ".hermes/config.yaml"),
          `mcp_servers:\n  safe:\n    url: https://example.test/mcp\n  blocked:\n    command: must-not-run\n    args: ${JSON.stringify(args)}\n    environment:\n      REGION: ${envValue}\n    headers:\n      X-Region: ${headerValue}\n`,
        );
      } else if (format === "JSON5") {
        source = f.write(
          path.join(f.home, ".openclaw/openclaw.json"),
          `{ // native comment\n mcp: { servers: { safe: { url: 'https://example.test/mcp' }, blocked: { command: 'must-not-run', args: ${JSON.stringify(args)}, environment: { REGION: '${envValue}' }, http_headers: { 'X-Region': '${headerValue}' }, }, }, }, }\n`,
        );
      } else {
        source = f.write(
          path.join(f.project, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              safe: { url: "https://example.test/mcp" },
              blocked: {
                command: "must-not-run",
                args,
                env: { REGION: envValue },
                headers: { "X-Region": headerValue },
              },
            },
          }),
        );
      }
      expect(f.candidates().find((item) => item.name === "blocked")?.supported).toBe(false);
      const prepared = f.prepare(["safe"]),
        preview = await prepared.preview();
      prepared.assertUnchanged();
      f.assertNoExecution();
      expect(preview.changes).toHaveLength(1);
      expect(preview.changes[0]!.target).toBe(source);
      assertPrivate(preview, [envValue, headerValue]);
      for (const side of [preview.changes[0]!.before, preview.changes[0]!.after])
        for (const arg of publicArgs) expect(side).toContain(arg);
    },
  );

  it("retains knowledge of a selected service's secret after its env map is removed", async () => {
    const f = fixture(),
      secret = "synthetic-removed-env-8354";
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          safe: { url: "https://example.test/mcp", env: { REGION: secret } },
          other: { command: "must-not-run", args: ["ordinary-value", secret] },
        },
      }),
    );
    const prepared = f.prepare(["safe"]),
      preview = await prepared.preview();
    prepared.assertUnchanged();
    f.assertNoExecution();
    const after = JSON.parse(preview.changes[0]!.after);
    expect(after.mcpServers.safe).toBeUndefined();
    expect(after.mcpServers.other.args[0]).toBe("ordinary-value");
    assertPrivate(preview, [secret]);
  });

  it("redacts a value identified by a credential argument wherever it is repeated", async () => {
    const f = fixture(),
      secret = "synthetic-positional-value-4285";
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          safe: { url: "https://example.test/mcp" },
          blocked: {
            command: "must-not-run",
            args: ["--token", secret, `again:${secret}`, "ordinary-value"],
          },
          other: { command: "must-not-run", args: [secret] },
        },
        extensions: { nested: [{ value: secret }] },
      }),
    );
    expect(f.candidates().find((item) => item.name === "blocked")?.supported).toBe(false);
    const prepared = f.prepare(["safe"]),
      preview = await prepared.preview();
    prepared.assertUnchanged();
    f.assertNoExecution();
    assertPrivate(preview, [secret]);
    for (const side of [preview.changes[0]!.before, preview.changes[0]!.after]) {
      const document = JSON.parse(side);
      expect(document.mcpServers.blocked.args).toEqual([
        "--token",
        "[redacted]",
        "again:[redacted]",
        "ordinary-value",
      ]);
      expect(document.extensions.nested).toEqual([{ value: "[redacted]" }]);
    }
  });

  it.each([
    {
      name: "an inline credential flag",
      source: "--token=opaque-inline-6284",
      privateValues: ["opaque-inline-6284"],
      publicFragment: "--token=",
    },
    {
      name: "URL userinfo with an escaped password",
      source: `https://fixture-account-2819:${encodeURIComponent("密碼/páss-6273")}@example.test/mcp?mode=ordinary-value`,
      privateValues: [
        "fixture-account-2819",
        "密碼/páss-6273",
        encodeURIComponent("密碼/páss-6273"),
      ],
      publicFragment: "example.test/mcp?mode=ordinary-value",
    },
    {
      name: "duplicate credential query parameters",
      source:
        "https://example.test/mcp?mode=ordinary-value&token=opaque-query-first-9321&token=opaque-query-second-5782",
      privateValues: ["opaque-query-first-9321", "opaque-query-second-5782"],
      publicFragment: "mode=ordinary-value",
    },
    {
      name: "an Authorization header containing a Bearer token",
      source: "Authorization: Bearer opaque-bearer-8721",
      privateValues: ["Bearer opaque-bearer-8721", "opaque-bearer-8721"],
      publicFragment: "Authorization:",
    },
    {
      name: "an inline Cookie header and its whole repeated value",
      source: "--header=Cookie: session=opaque-cookie-3179; region=fixture-region",
      privateValues: ["session=opaque-cookie-3179; region=fixture-region"],
      publicFragment: "--header=Cookie:",
    },
    {
      name: "a sensitive assignment embedded in ordinary text",
      source: "launch password=opaque-assignment-9274 mode=ordinary-value",
      privateValues: ["opaque-assignment-9274"],
      publicFragment: "mode=ordinary-value",
    },
    {
      name: "a single-quoted literal credential",
      source: "--token='opaque-single-4386' mode=ordinary-value",
      privateValues: ["opaque-single-4386"],
      publicFragment: "mode=ordinary-value",
    },
    {
      name: "a double-quoted literal credential",
      source: '--api_key="opaque-double-8291" mode=ordinary-value',
      privateValues: ["opaque-double-8291"],
      publicFragment: "mode=ordinary-value",
    },
    {
      name: "a quoted credential containing spaces",
      source: '--auth="opaque spaced credential 1294" mode=ordinary-value',
      privateValues: ["opaque spaced credential 1294"],
      publicFragment: "mode=ordinary-value",
    },
    {
      name: "a literal credential with escaped quotes and backslashes before an ambiguous suffix",
      source: String.raw`launch --password="opaque\"quoted\\path-8431";printf ordinary-value`,
      privateValues: [String.raw`opaque\"quoted\\path-8431`, String.raw`opaque"quoted\path-8431`],
      // This is argv text, so adjacent punctuation may belong to the credential.
      // Only the whitespace-separated ordinary value must remain visible.
      publicFragment: "ordinary-value",
    },
    {
      name: "a token composed of single-quoted and bare literal fragments",
      source: "launch --token='quoted-'opaque-suffix-6319;printf ordinary-value",
      privateValues: ["'quoted-'opaque-suffix-6319", "quoted-opaque-suffix-6319"],
      publicFragment: "ordinary-value",
    },
    {
      name: "an auth value composed of double-quoted and bare literal fragments",
      source: 'launch --auth="quoted-"opaque-authsuffix-7914&&printf ordinary-value',
      privateValues: ['"quoted-"opaque-authsuffix-7914', "quoted-opaque-authsuffix-7914"],
      publicFragment: "&&printf ordinary-value",
    },
  ])(
    "redacts repeats identified by $name while preserving ordinary arguments",
    async ({ source, privateValues, publicFragment }) => {
      const f = fixture();
      f.write(
        path.join(f.project, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            safe: { url: "https://example.test/mcp" },
            blocked: {
              command: "must-not-run",
              args: [source, "ordinary-value", ...privateValues],
            },
          },
          extensions: { copies: privateValues, ordinary: "ordinary-value", count: 42 },
        }),
      );
      expect(f.candidates().find((item) => item.name === "blocked")?.supported).toBe(false);
      const prepared = f.prepare(["safe"]),
        preview = await prepared.preview();
      prepared.assertUnchanged();
      f.assertNoExecution();
      assertPrivate(preview, privateValues);
      for (const side of [preview.changes[0]!.before, preview.changes[0]!.after]) {
        const document = JSON.parse(side);
        expect(document.mcpServers.blocked.args[0]).toContain(publicFragment);
        expect(document.mcpServers.blocked.args[1]).toBe("ordinary-value");
        expect(document.extensions.ordinary).toBe("ordinary-value");
        expect(document.extensions.count).toBe(42);
      }
    },
  );

  it.each([
    {
      name: "a raw password containing a literal semicolon",
      flag: "password",
      privateValue: "opaque-argv-prefix;OPAQUE_ARGV_TAIL_7592",
      suffix: "OPAQUE_ARGV_TAIL_7592",
    },
    {
      name: "a raw token containing a literal pipe",
      flag: "token",
      privateValue: "opaque-argv-prefix|OPAQUE_ARGV_TAIL_7592",
      suffix: "OPAQUE_ARGV_TAIL_7592",
    },
    {
      name: "an unquoted password ending in a backslash",
      flag: "password",
      privateValue: "opaque-tail-unquoted-2837\\",
      suffix: "opaque-tail-unquoted-2837",
    },
    {
      name: "an unterminated double-quoted password ending in a backslash",
      flag: "password",
      privateValue: '"opaque-tail-quoted-9182\\',
      suffix: "opaque-tail-quoted-9182",
    },
  ])("redacts the whole argv value of $name", async ({ flag, privateValue, suffix }) => {
    const f = fixture();
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          safe: { url: "https://example.test/mcp" },
          blocked: {
            command: "must-not-run",
            args: [`--${flag}=${privateValue}`, "ordinary-value", privateValue],
          },
        },
        extensions: { copied: privateValue, ordinary: "ordinary-value" },
      }),
    );
    expect(f.candidates().find((item) => item.name === "blocked")?.supported).toBe(false);
    const prepared = f.prepare(["safe"]),
      preview = await prepared.preview();
    prepared.assertUnchanged();
    f.assertNoExecution();
    // Checking the suffix independently catches partial masking of the raw value.
    assertPrivate(preview, [privateValue, suffix]);
    for (const side of [preview.changes[0]!.before, preview.changes[0]!.after]) {
      const document = JSON.parse(side);
      expect(document.mcpServers.blocked.args).toEqual([
        `--${flag}=[redacted]`,
        "ordinary-value",
        "[redacted]",
      ]);
      expect(document.extensions).toEqual({ copied: "[redacted]", ordinary: "ordinary-value" });
    }
  });

  it("shares known private values across every file in one migration plan", async () => {
    const f = fixture(),
      secret = "synthetic-cross-file-6201";
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          safe: { url: "https://example.test/mcp", env: { REGION: secret } },
        },
      }),
    );
    const second = f.write(
      path.join(f.project, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          cursorSafe: { url: "https://example.test/cursor" },
          other: { command: "must-not-run", args: [secret, "ordinary-value"] },
        },
      }),
    );
    const prepared = f.prepare(["safe", "cursorSafe"]),
      preview = await prepared.preview();
    prepared.assertUnchanged();
    f.assertNoExecution();
    expect(preview.changes).toHaveLength(2);
    expect(preview.changes.find((item) => item.target === second)!.after).toContain(
      "ordinary-value",
    );
    assertPrivate(preview, [secret]);
  });

  it("redacts repeated sensitive-field values nested in ordinary arrays and objects", async () => {
    const f = fixture(),
      secret = '私密-雪☃-"quoted"\\path\n尾-8271';
    f.write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        account: { access_token: secret },
        extensions: {
          nested: [
            {
              text: `begin:${secret}:end`,
              values: [secret, secret, "ordinary-value"],
              indexed: { [secret]: "ordinary-value" },
            },
          ],
        },
        mcpServers: { safe: { url: "https://example.test/mcp" } },
      }),
    );
    const prepared = f.prepare(["safe"]),
      preview = await prepared.preview();
    prepared.assertUnchanged();
    f.assertNoExecution();
    assertPrivate(preview, [secret]);
    for (const side of [preview.changes[0]!.before, preview.changes[0]!.after]) {
      const nested = JSON.parse(side).extensions.nested[0];
      expect(nested.text).toBe("begin:[redacted]:end");
      expect(nested.values).toEqual(["[redacted]", "[redacted]", "ordinary-value"]);
      expect(nested.indexed).toEqual({ "[redacted]": "ordinary-value" });
    }
  });

  it("redacts YAML aliases without treating repeated shared objects as cycles", async () => {
    const f = fixture(),
      secret = "synthetic-aliased-header-1972";
    f.write(
      path.join(f.home, ".hermes/config.yaml"),
      `extensions:\n  headers: &headers\n    X-Region: ${secret}\n  copied: *headers\n  nested: &nested\n    values: [${secret}, ordinary-value, ${secret}]\n  repeated: [*nested, *nested]\nmcp_servers:\n  safe:\n    url: https://example.test/mcp\n  blocked:\n    command: must-not-run\n    args: [${secret}, ordinary-value]\n    headers: *headers\n`,
    );
    const prepared = f.prepare(["safe"]),
      preview = await prepared.preview();
    prepared.assertUnchanged();
    f.assertNoExecution();
    assertPrivate(preview, [secret]);
    for (const side of [preview.changes[0]!.before, preview.changes[0]!.after])
      expect(JSON.parse(side).extensions.repeated).toEqual([
        { values: ["[redacted]", "ordinary-value", "[redacted]"] },
        { values: ["[redacted]", "ordinary-value", "[redacted]"] },
      ]);
  });

  it("fails closed for cyclic unrelated YAML without execution or source changes", async () => {
    const f = fixture();
    f.write(
      path.join(f.home, ".hermes/config.yaml"),
      "unrelated: &cycle\n  self: *cycle\nmcp_servers:\n  safe:\n    url: https://example.test/mcp\n",
    );
    const prepared = f.prepare(["safe"]);
    await expect(prepared.preview()).rejects.toThrow(/Cyclic/);
    prepared.assertUnchanged();
    f.assertNoExecution();
  });

  it("applies the private plan unchanged after a real local probe while public preview stays redacted", async () => {
    const f = fixture(true),
      secret = "synthetic-apply-private-5703",
      script = path.join(f.root, "fixture.cjs"),
      calls = path.join(f.root, "calls.jsonl");
    writeFileSync(
      script,
      String.raw`
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify(request.method) + '\n');
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'privacy-fixture', version: '1' } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`,
    );
    const untouched = {
      command: "must-not-run",
      args: [
        ...publicArgs,
        secret,
        "--token=opaque-inline-apply-8216",
        "ordinary-value",
        "opaque-inline-apply-8216",
      ],
      env: { REGION: secret },
    };
    const document = {
      mcpServers: {
        safe: { command: process.execPath, args: [script, calls] },
        blocked: untouched,
      },
      extensions: { headers: { "X-Region": secret }, copied: secret },
    };
    const source = f.write(path.join(f.project, ".mcp.json"), JSON.stringify(document));
    const prepared = f.prepare(["safe"]);
    await f.manager.probe("safe", f.project);
    expect(f.manager.hasCurrentProbe("safe", f.project)).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(1);
    f.start.mockClear();
    const preview = await prepared.preview();
    prepared.assertUnchanged();
    f.assertNoExecution();
    // Apply the actual host-held plan before asserting public output so this
    // regression also proves a redaction fix cannot corrupt persisted values.
    f.management.applyMigration({ token: preview.token, approveHome: false }, hub);
    expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
      ...document,
      mcpServers: {
        blocked: untouched,
        agentkib: {
          type: "http",
          url: "http://127.0.0.1:47653/mcp/v1/workspaces/registered/agents/claude-code",
        },
      },
    });
    prepared.assertManagedUnchanged();
    expect(readFileSync(calls, "utf8")).toContain('"initialize"');
    expect(readFileSync(calls, "utf8")).toContain('"tools/list"');
    expect(readFileSync(calls, "utf8")).not.toContain('"tools/call"');
    f.assertNoExecution();
    assertPrivate(preview, [secret, "opaque-inline-apply-8216"]);
  });
});
