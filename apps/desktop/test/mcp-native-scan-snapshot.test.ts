import { createHash } from "node:crypto";
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
import { afterEach, describe, expect, it } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
import { readNativeMcpImport, scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fingerprint(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-snapshot-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  const store = new BackendStore(path.join(root, "data/db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "registered",
    project,
    "fixture",
    "healthy",
    new Date().toISOString(),
  );
  const scan = () => scanNativeMcp({ project }, store, environment);
  return { root, home, project, store, environment, scan };
}

const nativeFormats = [
  {
    format: "TOML",
    agent: "codex",
    file: ".codex/config.toml",
    content:
      '[mcp_servers.alpha]\nurl = "https://example.test/alpha"\n[mcp_servers.beta]\nurl = "https://example.test/beta"\n[mcp_servers.beta.http_headers]\nAuthorization = "Bearer format-private"\n',
    malformed: "[mcp_servers.alpha\nurl = private-malformed",
  },
  {
    format: "JSON",
    agent: "claude-code",
    file: ".claude.json",
    content: JSON.stringify({
      mcpServers: {
        alpha: { url: "https://example.test/alpha" },
        beta: {
          url: "https://example.test/beta",
          headers: { Authorization: "Bearer format-private" },
        },
      },
    }),
    malformed: "{mcpServers: {}, private: 'private-malformed'}",
  },
  {
    format: "OpenCode JSONC",
    agent: "opencode",
    file: ".config/opencode/opencode.jsonc",
    content: `// Native comments and trailing commas are valid here.
      {mcp: {
        alpha: {type: 'remote', url: 'https://example.test/alpha'},
        beta: {type: 'remote', url: 'https://example.test/beta', headers: {Authorization: 'Bearer format-private'}},
      }}`,
    malformed: "{mcp: {alpha: private-malformed}}",
  },
  {
    format: "OpenClaw JSON5",
    agent: "open-claw",
    file: ".openclaw/openclaw.json",
    content: `// OpenClaw uses JSON5 even with a .json extension.
      {mcp: {servers: {
        alpha: {url: 'https://example.test/alpha'},
        beta: {url: 'https://example.test/beta', headers: {Authorization: 'Bearer format-private'}},
      }}}`,
    malformed: "{mcp: {servers: {alpha: private-malformed}}}",
  },
  {
    format: "YAML",
    agent: "hermes",
    file: ".hermes/config.yaml",
    content:
      "mcp_servers:\n  alpha:\n    url: https://example.test/alpha\n  beta:\n    url: https://example.test/beta\n    headers:\n      Authorization: Bearer format-private\n",
    malformed: "mcp_servers: [private-malformed",
  },
];

describe("native MCP scan file snapshots", () => {
  it.each(nativeFormats)(
    "preserves complete $format candidates and their shared source fingerprint",
    ({ agent, file, content }) => {
      const f = fixture(),
        source = path.join(f.home, file);
      write(source, content);
      const candidates = f.scan();
      expect(candidates).toHaveLength(2);
      expect(candidates).toEqual([
        expect.objectContaining({
          agent,
          scope: "home",
          name: "alpha",
          source_path: source,
          endpoint: "https://example.test/alpha",
          supported: true,
          has_secret_values: false,
          fingerprint: fingerprint(content),
        }),
        expect.objectContaining({
          agent,
          scope: "home",
          name: "beta",
          source_path: source,
          endpoint: "https://example.test/beta",
          supported: true,
          has_secret_values: true,
          fingerprint: fingerprint(content),
        }),
      ]);
      expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(2);
      expect(candidates[1]?.warning_messages).toContainEqual({
        key: "mcp.manage.diagnostic.native_secret_required",
      });
      expect(JSON.stringify(candidates)).not.toContain("format-private");
      const imported = readNativeMcpImport(candidates[1]!);
      expect(imported).toMatchObject({
        headers: {},
        required_headers: ["Authorization"],
        native_source: { fingerprint: fingerprint(content) },
      });
      expect(JSON.stringify(imported)).not.toContain("format-private");
    },
  );

  it("preserves credentials and independent names for services sharing a YAML alias", () => {
    const f = fixture(),
      source = path.join(f.home, ".hermes/config.yaml");
    const content =
      "shared: &remote\n  url: https://example.test/mcp\n  headers:\n    Authorization: Bearer alias-private\nmcp_servers:\n  alpha: *remote\n  beta: *remote\n";
    write(source, content);
    const candidates = f.scan();
    expect(candidates.map((candidate) => candidate.name)).toEqual(["alpha", "beta"]);
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({
        supported: true,
        has_secret_values: true,
        fingerprint: fingerprint(content),
        warning_messages: [{ key: "mcp.manage.diagnostic.native_secret_required" }],
      });
      expect(readNativeMcpImport(candidate)).toMatchObject({
        id: candidate.name,
        name: candidate.name,
        headers: {},
        required_headers: ["Authorization"],
      });
    }
    expect(JSON.stringify(candidates)).not.toContain("alias-private");
    expect(readFileSync(source, "utf8")).toBe(content);
  });

  it("keeps supported and rejected entries separate without exposing credentials", () => {
    const f = fixture(),
      source = path.join(f.project, ".mcp.json");
    const content = JSON.stringify({
      mcpServers: {
        agentkib: { url: "https://example.test/hub" },
        ready: { command: "node", env: { API_TOKEN: "env-private" } },
        remote: {
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer header-private" },
        },
        inline: { url: "https://example.test/mcp?token=url-private" },
        unsupported: { type: "sse", url: "https://user:password-private@example.test/mcp" },
        invalid: { url: "https://example.test/mcp", unexpected: "field-private" },
      },
    });
    write(source, content);
    const candidates = f.scan();
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "inline",
      "invalid",
      "ready",
      "remote",
      "unsupported",
    ]);
    expect(
      candidates.filter((candidate) => candidate.supported).map((candidate) => candidate.name),
    ).toEqual(["ready", "remote"]);
    for (const candidate of candidates) {
      expect(candidate.source_path).toBe(source);
      if (candidate.supported) expect(candidate.fingerprint).toBe(fingerprint(content));
      else {
        expect(candidate.endpoint).toBe("unavailable");
        expect(candidate.warning_messages?.length).toBeGreaterThan(0);
      }
    }
    const ready = candidates.find((candidate) => candidate.name === "ready")!;
    expect(readNativeMcpImport(ready, f.project)).toMatchObject({
      cwd: f.project,
      env: {},
      required_env: ["API_TOKEN"],
    });
    expect(JSON.stringify(candidates)).not.toMatch(
      /env-private|header-private|url-private|password-private|field-private/,
    );
  });

  it("rereads changed bytes for a new scan and an explicit import even when size and mtime match", () => {
    const f = fixture(),
      source = path.join(f.project, ".mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        alpha: { url: "https://example.test/v1" },
        beta: { url: "https://example.test/v1" },
      },
    });
    const changed = original.replaceAll("/v1", "/v2").replace("beta", "zeta");
    write(source, original);
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(source, timestamp, timestamp);
    const before = f.scan(),
      metadata = statSync(source);
    write(source, changed);
    utimesSync(source, metadata.atime, metadata.mtime);
    expect(statSync(source).size).toBe(metadata.size);
    expect(statSync(source).mtimeMs).toBe(metadata.mtimeMs);
    const imported = readNativeMcpImport(before[0]!, f.project);
    expect(imported).toMatchObject({
      url: "https://example.test/v2",
      native_source: { fingerprint: fingerprint(changed) },
    });
    expect(imported.native_source?.fingerprint).not.toBe(before[0]?.fingerprint);
    expect(() => readNativeMcpImport(before[1]!, f.project)).toThrow(
      "Native MCP entry no longer exists",
    );
    const after = f.scan();
    expect(after.map((candidate) => candidate.name)).toEqual(["alpha", "zeta"]);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(
      after.every(
        (candidate) =>
          candidate.endpoint === "https://example.test/v2" &&
          candidate.fingerprint === fingerprint(changed),
      ),
    ).toBe(true);
    rmSync(source);
    expect(f.scan()).toEqual([]);
    expect(() => readNativeMcpImport(before[0]!, f.project)).toThrow(
      "Native MCP source is unavailable",
    );
  });

  it.each(nativeFormats)(
    "isolates invalid $format and rejects it on an explicit import",
    ({ agent, file, content, malformed }) => {
      const f = fixture(),
        source = path.join(f.home, file);
      write(source, content);
      const candidate = f.scan()[0]!;
      write(source, malformed);
      write(
        path.join(f.project, ".cursor/mcp.json"),
        '{"mcpServers":{"healthy":{"url":"https://example.test/mcp"}}}',
      );
      const candidates = f.scan();
      expect(candidates.find((item) => item.name === "healthy")?.supported).toBe(true);
      expect(candidates.find((item) => item.agent === agent)).toMatchObject({
        name: "Configuration unavailable",
        supported: false,
        endpoint: "unavailable",
        warning_messages: [{ key: "mcp.manage.diagnostic.native_config_unavailable" }],
      });
      expect(JSON.stringify(candidates)).not.toContain("private-malformed");
      expect(() => readNativeMcpImport(candidate)).toThrow();
    },
  );

  it("retains the 1 MiB file limit for scans and fresh explicit imports", () => {
    const f = fixture(),
      source = path.join(f.home, ".claude.json");
    const content = '{"mcpServers":{"alpha":{"url":"https://example.test/mcp"}}}'.padEnd(
      1024 * 1024,
      " ",
    );
    write(source, content);
    const candidate = f.scan()[0]!;
    expect(candidate).toMatchObject({
      name: "alpha",
      supported: true,
      fingerprint: fingerprint(content),
    });
    write(source, content + " ");
    expect(f.scan()).toMatchObject([{ name: "Configuration unavailable", supported: false }]);
    expect(() => readNativeMcpImport(candidate)).toThrow("at most 1 MiB");
  });

  it("rechecks regular files and unsafe ancestors instead of reusing an earlier snapshot", () => {
    const f = fixture(),
      directory = path.join(f.home, ".cursor"),
      source = path.join(directory, "mcp.json");
    const content = '{"mcpServers":{"alpha":{"url":"https://example.test/mcp"}}}';
    write(source, content);
    const candidate = f.scan()[0]!;
    rmSync(source);
    mkdirSync(source);
    expect(f.scan()).toMatchObject([{ name: "Configuration unavailable", supported: false }]);
    expect(() => readNativeMcpImport(candidate)).toThrow("regular file");
    rmSync(directory, { recursive: true });
    const redirected = path.join(f.root, "redirected");
    write(path.join(redirected, "mcp.json"), content);
    symlinkSync(redirected, directory, "junction");
    expect(f.scan()).toMatchObject([{ name: "Configuration unavailable", supported: false }]);
    expect(() => readNativeMcpImport(candidate)).toThrow("unsafe path");
  });

  it("keeps project scans restricted to registered workspaces", () => {
    const f = fixture(),
      unregistered = path.join(f.root, "unregistered");
    write(path.join(unregistered, ".mcp.json"), '{"mcpServers":{"alpha":{"command":"node"}}}');
    expect(() => scanNativeMcp({ project: unregistered }, f.store, f.environment)).toThrow(
      "registered AgentKib workspace",
    );
    expect(() => scanNativeMcp({ project: 1 }, f.store, f.environment)).toThrow(
      "registered workspace path",
    );
  });

  it("scans a valid 128-service OpenClaw document within the synchronous latency budget", () => {
    const f = fixture();
    // Warm module and scope setup before measuring only the synchronous scan.
    expect(f.scan()).toEqual([]);
    const count = 128;
    const content = JSON.stringify({
      description: "ordinary text ".repeat(50_000),
      mcp: {
        servers: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `server${index.toString().padStart(3, "0")}`,
            { transport: "streamable-http", url: "https://example.invalid/mcp" },
          ]),
        ),
      },
    });
    expect(Buffer.byteLength(content)).toBeGreaterThan(700_000);
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    write(path.join(f.home, ".openclaw/openclaw.json"), content);
    const started = performance.now(),
      candidates = f.scan(),
      elapsed = performance.now() - started;
    expect(candidates).toHaveLength(count);
    expect(candidates.every((candidate) => candidate.supported)).toBe(true);
    expect(new Set(candidates.map((candidate) => candidate.fingerprint))).toEqual(
      new Set([fingerprint(content)]),
    );
    // A single JSON5 parse has ample CI headroom; reparsing for every service takes seconds.
    expect(
      elapsed,
      `Scanning ${Buffer.byteLength(content)} bytes and ${count} services took ${Math.round(elapsed)} ms`,
    ).toBeLessThan(1000);
  }, 15_000);
});
