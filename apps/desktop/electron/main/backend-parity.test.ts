import { ClaudeSessions } from "@agentkib/backend/claude-sessions";
import { GrokSessions } from "@agentkib/backend/grok-sessions";
import { OpenClawSessions } from "@agentkib/backend/openclaw-sessions";
import { HermesSessions } from "@agentkib/backend/hermes-sessions";
import { SessionPaging } from "@agentkib/backend/session-paging";
import { readHermesEvents } from "@agentkib/backend/hermes-events";
import { resolveCommand } from "@agentkib/backend/command-resolution";
import { Commands } from "@agentkib/backend/commands";
import {
  AntigravityAcp,
  acpCompatibility,
  verifyAcpControlIdentity,
  MAX_ACP_FRAME_BYTES,
} from "@agentkib/backend/antigravity-acp";
import { AntigravitySessions } from "@agentkib/backend/antigravity-sessions";
import { parseAntigravityReplay } from "@agentkib/backend/antigravity-replay";
import { parseAcpJson, stringifyAcpJson } from "@agentkib/backend/acp-json";
import { PassThrough, Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import {
  OpenCodeSessions,
  parseOpenCodeSessions,
  parseOpenCodeEvents,
  parseOpenCodeHandoff,
} from "@agentkib/backend/opencode-sessions";
import { CodexSessions } from "@agentkib/backend/codex-sessions";
import { SessionStore } from "@agentkib/backend/session-store";
import { Sql } from "@agentkib/backend/sql";
import { parseManifest } from "@agentkib/backend/manifest";
import { parse as parseYaml } from "yaml";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  BACKEND_INSPECT,
  NATIVE_DISCOVERY,
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
  const environment: NodeJS.ProcessEnv = {
    AGENTKIB_LOCALE: "zh-TW",
    AGENTKIB_SYSTEM_THEME: "dark",
  };

  function request(method: string, params: unknown = {}) {
    return backend.handle({ jsonrpc: "2.0", id: ++id, method, params });
  }

  async function typescriptEvents(params: unknown) {
    const response = await backend.handleAsync({
      jsonrpc: "2.0",
      id: ++id,
      method: RUNTIME_METHODS.sessionEvents,
      params,
    });
    expect(response.error).toBeUndefined();
    return response.result as any;
  }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "agentkib-backend-parity-")));
    Object.assign(environment, {
      HOME: path.join(directory, "user"),
      USERPROFILE: path.join(directory, "user"),
      XDG_CONFIG_HOME: path.join(directory, "user/.config"),
      DSH_HOME: path.join(directory, "user/.dsh"),
      GROK_HOME: path.join(directory, "user/.grok"),
      CODEX_HOME: path.join(directory, "codex"),
      CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
    });
    await mkdir(environment.HOME!, { recursive: true });
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

  it("matches all nine Agents' native instruction precedence, imports and MCP visibility", async () => {
    const project = path.join(directory, "contexts");
    const files: Record<string, string> = {
      "AGENTS.md": "root\n@instructions/shared.md\n",
      "AGENTS.override.md": "codex override\n",
      "instructions/shared.md": "shared 中文\n",
      "CLAUDE.md": "claude\n@instructions/shared.md\n",
      "CLAUDE.local.md": "local\n",
      ".claude/CLAUDE.md": "nested claude\n",
      ".claude/rules/a.md": "claude rule\n",
      ".cursor/rules/a.mdc": "---\nalwaysApply: true\n---\ncursor always\n",
      ".cursor/rules/b.mdc": "---\nalwaysApply: false\n---\ncursor conditional\n",
      "SOUL.md": "soul\n",
      "IDENTITY.md": "identity\n",
      "USER.md": "user\n",
      "TOOLS.md": "tools\n",
      "MEMORY.md": "memory\n",
      ".hermes.md": "hermes\n",
      "GEMINI.md": "gemini\n",
      ".agents/rules/a.md": "---\ntrigger: always_on\n---\nalways rule\n",
      ".agents/rules/b.md": "---\ntrigger: manual\n---\nmanual rule\n",
      ".agent/rules/a.md": "legacy shadowed\n",
      "opencode.json": JSON.stringify({ instructions: ["instructions/{shared,extra}.md"] }),
      "instructions/extra.md": "extra\n",
      "sub/AGENTS.md": "child\n",
      "sub/CLAUDE.md": "child claude\n",
      "sub/GEMINI.md": "child gemini\n",
      "sub/.git/HEAD": "ref: refs/heads/main\n",
      "sub/.agents/skills/local/SKILL.md": "skill\n",
      ".agentkib/mcp.json": JSON.stringify({
        schema_version: 1,
        servers: [
          { id: "all", name: "All", transport: "stdio", command: "node" },
          {
            id: "codex",
            name: "Codex only",
            transport: "stdio",
            command: "node",
            targets: ["codex"],
          },
          { id: "off", name: "Disabled", transport: "stdio", command: "node", enabled: false },
        ],
      }),
    };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project, name)), { recursive: true });
      await writeFile(path.join(project, name), content);
    }
    for (const agent of [
      "codex",
      "claude-code",
      "cursor",
      "opencode",
      "open-claw",
      "hermes",
      "grok-build",
      "antigravity",
      "deepseek-harness",
    ]) {
      const params = { project, cwd: "sub", agent };
      const actual = await backend.handleAsync({
        jsonrpc: "2.0",
        id: ++id,
        method: RUNTIME_METHODS.resolveContext,
        params,
      });
      expect(actual.error, agent).toBeUndefined();
      expect(actual.result, agent).toEqual(
        await rust.request(RUNTIME_METHODS.resolveContext, params),
      );
    }
  });

  it("matches global rules, plugin enablement, Git ignores and MCP overlays", async () => {
    const project = path.join(directory, "context-special");
    const put = async (base: string, name: string, content: string) => {
      const file = path.join(base, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    };
    const home = environment.HOME!;
    try {
      await put(home, ".config/opencode/AGENTS.md", "global opencode\n@rules/global.md\n");
      await put(home, ".config/opencode/rules/global.md", "global imported\n");
      await put(home, ".config/opencode/opencode.jsonc", "{instructions:['rules/*.md']}");
      await put(home, ".gemini/GEMINI.md", "global gemini\n");
      await put(
        home,
        ".gemini/antigravity-cli/rules/conditional.md",
        "---\ntrigger: model_decision\n---\nexclude\n",
      );
      await put(
        home,
        ".gemini/antigravity-cli/plugins/on/plugin.json",
        '{"name":"on","disabled":true}',
      );
      await put(home, ".gemini/antigravity-cli/plugins/on/rules/rule.md", "staged enabled\n");
      await put(home, ".gemini/antigravity-cli/plugins/off/plugin.json", '{"name":"off"}');
      await put(home, ".gemini/antigravity-cli/plugins/off/rules/rule.md", "staged excluded\n");
      await put(
        home,
        ".gemini/config/config.json",
        '{"plugins":{"on":{"enabled":true},"off":{"enabled":false}}}',
      );
      await put(home, ".gemini/config/plugins/collision/plugin.json", '{"name":"collision"}');
      await put(home, ".gemini/config/plugins/collision/rules/rule.md", "collision excluded\n");
      await put(home, ".dsh/AGENTS.md", "global dsh\n");
      await put(home, ".grok/AGENTS.md", "global grok\n");
      await put(home, ".claude/rules/global.md", "global claude\n");
      await put(
        home,
        ".agentkib/mcp.json",
        JSON.stringify({
          servers: [
            {
              id: "overlay",
              name: "Base",
              transport: "stdio",
              command: "node",
              targets: ["codex"],
            },
          ],
        }),
      );
      await put(project, "AGENTS.md", "project\n");
      await put(project, ".gitignore", ".grok/rules/ignored.md\n");
      await promisify(execFile)("git", ["init", "-b", "main"], { cwd: project });
      await put(project, ".grok/rules/ignored.md", "ignored\n");
      await put(project, ".grok/rules/visible.md", "---\nname: Rule\n---\ngrok body\n");
      await put(project, ".grok/config.toml", "[compat.claude]\nrules = false\n");
      await put(project, ".agents/plugins/collision/plugin.json", '{"name":"collision"}');
      await put(project, ".agents/plugins/collision/rules/rule.md", "collision excluded\n");
      await put(project, ".agents/plugins/invalid/plugin.json", '{"unknown":true}');
      await put(
        project,
        ".agentkib/mcp.local.json",
        JSON.stringify({
          servers: [
            {
              id: "overlay",
              name: "Overlay",
              transport: "stdio",
              command: "node",
              env: { SECRET: "never in preview" },
            },
          ],
        }),
      );
      const compare = async (agent: string) => {
        const params = { project, cwd: ".", agent };
        const actual = await backend.handleAsync({
          jsonrpc: "2.0",
          id: ++id,
          method: RUNTIME_METHODS.resolveContext,
          params,
        });
        expect(actual.error, agent).toBeUndefined();
        expect(actual.result, agent).toEqual(
          await rust.request(RUNTIME_METHODS.resolveContext, params),
        );
      };
      for (const agent of [
        "opencode",
        "grok-build",
        "antigravity",
        "deepseek-harness",
        "codex",
        "claude-code",
      ])
        await compare(agent);
      await put(home, ".gemini/config/config.json", "invalid JSON");
      await compare("antigravity");
    } finally {
      await rm(home, { recursive: true, force: true });
      await mkdir(home, { recursive: true });
    }
  });

  it("matches OpenCode glob syntax, private paths and symlink exclusion", async () => {
    const project = path.join(directory, "context-globs");
    await mkdir(path.join(project, "docs/nested"), { recursive: true });
    for (const name of [
      "team.md",
      "review.md",
      "draft.md",
      "final.md",
      "abba.md",
      "abccab.md",
      ".md",
      "规.md",
      "😀.md",
      "team[prod].md",
      "broken[.md",
      "secret.md",
      "nested/deep.md",
    ])
      await writeFile(path.join(project, "docs", name), name);
    await symlink(path.join(directory, "outside-context.md"), path.join(project, "docs/linked.md"));
    // The target need not exist: both readers skip directory and file symlinks.
    await symlink(path.join(project, "docs"), path.join(project, "alias"));
    for (const pattern of [
      "docs/@(team|review).md",
      "docs/+(a|b).md",
      "docs/?(team).md",
      "docs/*(ab|c).md",
      "docs/!(draft).md",
      "docs/?.md",
      "docs/[规约].md",
      "docs/\\[x\\].md",
      "docs/team\\[prod\\].md",
      "docs/broken[.md",
      "docs/**/*.{md,txt}",
      "alias/*.md",
    ]) {
      await writeFile(
        path.join(project, "opencode.json"),
        JSON.stringify({ instructions: [pattern] }),
      );
      const params = { project, cwd: ".", agent: "opencode" };
      const actual = await backend.handleAsync({
        jsonrpc: "2.0",
        id: ++id,
        method: RUNTIME_METHODS.resolveContext,
        params,
      });
      expect(actual.error, pattern).toBeUndefined();
      expect(actual.result, pattern).toEqual(
        await rust.request(RUNTIME_METHODS.resolveContext, params),
      );
    }
  });

  it("matches import cycles, project boundaries, invalid UTF-8 and Unicode preview limits", async () => {
    const project = path.join(directory, "context-limits");
    await mkdir(project, { recursive: true });
    const compare = async (agent = "codex", cwd = ".") => {
      const params = { project, cwd, agent };
      const actual = await backend.handleAsync({
        jsonrpc: "2.0",
        id: ++id,
        method: RUNTIME_METHODS.resolveContext,
        params,
      });
      expect(actual.error).toBeUndefined();
      expect(actual.result).toEqual(await rust.request(RUNTIME_METHODS.resolveContext, params));
    };
    await writeFile(path.join(project, "AGENTS.md"), "@cycle.md\n");
    await writeFile(path.join(project, "cycle.md"), "@AGENTS.md\n");
    await compare();
    await writeFile(path.join(directory, "outside-context.md"), "private\n");
    await writeFile(path.join(project, "AGENTS.md"), "@../outside-context.md\n");
    await compare();
    await writeFile(
      path.join(project, "AGENTS.md"),
      Buffer.concat([Buffer.from("valid\n"), Buffer.from([0xff])]),
    );
    await compare();
    await writeFile(path.join(project, "AGENTS.md"), "😀".repeat(128 * 1024 + 1));
    await compare();
    await writeFile(
      path.join(project, "AGENTS.md"),
      Buffer.concat([Buffer.alloc(128 * 1024 * 4 - 1, 0x61), Buffer.from([0xff, 0x61])]),
    );
    await compare();
    await writeFile(path.join(project, "AGENTS.md"), "@depth0.md\n");
    for (let depth = 0; depth < 7; depth++)
      await writeFile(
        path.join(project, `depth${depth}.md`),
        depth === 6 ? "end" : `@depth${depth + 1}.md\n`,
      );
    await compare();
    let nested = project;
    for (let depth = 0; depth < 5; depth++) {
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, "AGENTS.md"), "😀".repeat(128 * 1024));
      nested = path.join(nested, `child${depth}`);
    }
    await mkdir(nested, { recursive: true });
    await compare("codex", nested);
    await writeFile(path.join(project, "AGENTS.md"), "😀".repeat(20000));
    await compare("grok-build");
    await compare("deepseek-harness");
  });

  it("matches platform overrides, skill targets and approved memories in context", async () => {
    const project = path.join(directory, "context-manifest");
    await mkdir(path.join(project, ".agentkib"), { recursive: true });
    await writeFile(path.join(project, "AGENTS.md"), "native instructions\n");
    await writeFile(
      path.join(project, ".agentkib/manifest.yaml"),
      JSON.stringify({
        schema_version: 2,
        workspace: { id: "context-memory", name: "Context" },
        instructions: { platform_overrides: { codex: "codex extra", hermes: "hermes extra" } },
        skills: [
          { name: "shared", path: "skills/shared" },
          { name: "codex", path: "skills/codex", targets: ["codex"] },
        ],
      }),
    );
    const proposed = request(RUNTIME_METHODS.proposeMemory, {
      project,
      proposal: {
        project_id: "context-memory",
        memory_type: "decision",
        content: "approved context memory",
      },
    }).result as { id: string };
    expect(proposed.id).toBeDefined();
    expect(
      request(RUNTIME_METHODS.reviewMemory, { id: proposed.id, status: "approved" }).error,
    ).toBeUndefined();
    request(RUNTIME_METHODS.proposeMemory, {
      project,
      proposal: {
        project_id: "context-memory",
        memory_type: "decision",
        content: "pending context memory",
      },
    });
    for (const agent of ["codex", "hermes", "deepseek-harness"]) {
      const params = { project, cwd: ".", agent };
      const actual = await backend.handleAsync({
        jsonrpc: "2.0",
        id: ++id,
        method: RUNTIME_METHODS.resolveContext,
        params,
      });
      expect(actual.error, agent).toBeUndefined();
      expect(actual.result, agent).toEqual(
        await rust.request(RUNTIME_METHODS.resolveContext, params),
      );
    }
  });

  it("matches Doctor's matrix, evidence, stable IDs and conservative repair decisions", async () => {
    const project = path.join(directory, "doctor-parity"),
      workspaceId = "doctor-parity";
    await mkdir(path.join(project, ".agentkib"), { recursive: true });
    database
      .prepare(
        "INSERT INTO workspaces(id,canonical_path,name,status,asset_count,warning_count,last_discovered_at) VALUES (?,?,?,'healthy',0,0,?)",
      )
      .run(workspaceId, project, "Doctor", "2026-09-30T00:00:00Z");
    const put = async (name: string, content: string) => {
      const file = path.join(project, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    };
    const clean = (value: any) =>
      JSON.parse(JSON.stringify(value, (key, item) => (key === "checked_at" ? undefined : item)));
    const compare = async () => {
      const params = { id: workspaceId };
      const actual = await backend.handleAsync({
        jsonrpc: "2.0",
        id: ++id,
        method: RUNTIME_METHODS.workspaceDoctorReport,
        params,
      });
      expect(actual.error).toBeUndefined();
      const expected = await rust.request(RUNTIME_METHODS.workspaceDoctorReport, params);
      expect(clean(actual.result)).toEqual(clean(expected));
      return actual.result as any;
    };
    try {
      await compare();
      await put("AGENTS.md", "shared instructions\n");
      await put("CLAUDE.md", "shared instructions\n");
      await compare();
      const manifest = {
        schema_version: 2,
        workspace: { id: workspaceId, name: "Doctor" },
        instructions: {
          shared: "shared instructions",
          scoped: [{ path: "sub", content: "scoped instructions" }],
          platform_overrides: { codex: "codex override", hermes: "hermes override" },
        },
        skills: [{ name: "example", path: "source/example" }],
        connections: [{ name: "downstream", transport: "stdio", command: "node" }],
        adapters: {
          codex: { enabled: true, generated_hashes: { "missing.md": "abc" } },
          opencode: { enabled: true },
          "grok-build": { enabled: true },
          antigravity: { enabled: true },
        },
      };
      await put("source/example/SKILL.md", "---\nname: example\n---\nSkill\n");
      await put("source/example/nested/reference.md", "reference\n");
      await put(".agentkib/manifest.yaml", JSON.stringify(manifest));
      await mkdir(path.join(project, "sub"));
      await compare();
      await put("sub/AGENTS.md", "scoped instructions\n");
      await put(".agents/skills/example/SKILL.md", "---\nname: example\n---\nSkill\n");
      await put(".agents/skills/example/nested/reference.md", "reference\n");
      await put(".claude/skills/example/SKILL.md", "drift\n");
      await compare();
      await put(".claude/skills/example/user.md", "user file prevents overwrite\n");
      await compare();
      await symlink(
        path.join(project, "AGENTS.md"),
        path.join(project, ".agents/skills/example/link.md"),
      );
      const unsafe = await compare();
      expect(
        unsafe.issues.find(
          (issue: any) => issue.agent === "codex" && issue.code === "skill.target-missing",
        )?.repairable,
      ).toBe(false);
      await rm(path.join(project, ".agents/skills/example/link.md"));
      await put(
        ".agentkib/mcp.json",
        JSON.stringify({
          servers: [{ id: "downstream", name: "downstream", transport: "stdio", command: "node" }],
        }),
      );
      await compare();
      await rm(path.join(project, "source/example"), { recursive: true });
      const unreadable = await compare();
      expect(unreadable.summary.repairable_count).toBe(0);
      const params = { workspaceIds: [workspaceId, "does-not-exist"] };
      const actual = await backend.handleAsync({
        jsonrpc: "2.0",
        id: ++id,
        method: RUNTIME_METHODS.workspaceDoctorSummaries,
        params,
      });
      expect(clean(actual.result)).toEqual(
        clean(await rust.request(RUNTIME_METHODS.workspaceDoctorSummaries, params)),
      );
    } finally {
      database.prepare("DELETE FROM workspaces WHERE id=?").run(workspaceId);
    }
  });

  it("matches synchronization plans and preserves native settings and unmanaged instructions", async () => {
    const project = path.join(directory, "plan-parity"),
      put = async (name: string, content: string) => {
        const file = path.join(project, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
      };
    await put("AGENTS.md", "user instructions\n");
    await put("CLAUDE.md", "custom claude\n");
    await put("source/SKILL.md", "---\nname: Fixture\n---\nSkill text\n");
    await put("source/reference.json", '{"keep":true}\n');
    await put(".codex/config.toml", 'model = "custom"\n');
    await put(".grok/config.toml", "custom = true\n");
    await put(".cursor/mcp.json", '{"custom":true,"mcpServers":{"existing":{"command":"keep"}}}');
    await put(
      ".opencode/opencode.jsonc",
      "{ // comment\n theme:'dark', instructions:['docs/native.md'], mcp:{other:{enabled:false}} }",
    );
    await put(
      ".agents/mcp_config.json",
      '{"mcpServers":{"agentkib":{"command":"old","args":[],"type":"stdio","url":"old","enabledTools":["old"],"custom":true}}}',
    );
    const manifest = {
      schema_version: 2,
      workspace: { id: "plan/中文? id", name: "Plan" },
      instructions: {
        shared: "shared text",
        scoped: [{ path: "sub", content: "scoped text" }],
        platform_overrides: {
          codex: "codex only",
          "claude-code": "claude only",
          cursor: "cursor only",
          opencode: "opencode only",
          "open-claw": "openclaw only",
          hermes: "hermes only",
          antigravity: "antigravity only",
        },
      },
      skills: [{ name: "fixture", path: "source" }],
      connections: [
        {
          name: "legacy",
          transport: "stdio",
          command: "node",
          args: ["worker.js"],
          env: { KEY: "${SECRET}" },
          targets: ["codex"],
        },
      ],
      adapters: Object.fromEntries(
        [
          "codex",
          "claude-code",
          "cursor",
          "opencode",
          "open-claw",
          "hermes",
          "grok-build",
          "antigravity",
        ].map((agent) => [
          agent,
          {
            enabled: true,
            generated_hashes: { "old.md": "old", "/outside-retained.md": "retained" },
          },
        ]),
      ),
    };
    const normalize = (plan: any) => {
      const normalized = {
        ...plan,
        id: "generated",
        created_at: "now",
        changes: plan.changes.map((change: any) => ({
          ...change,
          after: change.target.endsWith("/.agentkib/manifest.yaml")
            ? parseManifest(change.after)
            : change.target.endsWith("/.hermes/config.yaml")
              ? parseYaml(change.after)
              : change.after,
        })),
      };
      const hermes = plan.changes.find((change: any) =>
        change.target.endsWith("/.hermes/config.yaml"),
      );
      if (hermes) {
        const persisted = normalized.changes.find((change: any) =>
          change.target.endsWith("/.agentkib/manifest.yaml"),
        ).after;
        expect(persisted.adapters.hermes.generated_hashes[hermes.target]).toBe(
          createHash("sha256").update(hermes.after).digest("hex"),
        );
        persisted.adapters.hermes.generated_hashes[hermes.target] = "verified-yaml-content";
      }
      return normalized;
    };
    const compare = async (value: unknown = manifest, includeHome = false) => {
      const params = { project, manifest: value, includeHome };
      const actual = request(RUNTIME_METHODS.planChanges, params);
      expect(actual.error).toBeUndefined();
      expect(normalize(actual.result)).toEqual(
        normalize(await rust.request(RUNTIME_METHODS.planChanges, params)),
      );
      return actual.result as any;
    };
    const plan = await compare();
    expect(
      plan.changes.find((change: any) => change.target.endsWith("/.agents/mcp_config.json")).after,
    ).not.toContain('"command": "old"');
    expect(plan.requires_home_approval).toBe(false);
    await compare({
      ...manifest,
      adapters: Object.fromEntries(
        [
          "codex",
          "claude-code",
          "cursor",
          "opencode",
          "open-claw",
          "hermes",
          "grok-build",
          "antigravity",
        ].map((agent) => [agent, { enabled: agent === "cursor", generated_hashes: {} }]),
      ),
    });
    await compare({ ...manifest, skills: [{ name: "fixture", path: "source/SKILL.md" }] });
    const home = environment.HOME!;
    await mkdir(path.join(home, ".openclaw"), { recursive: true });
    await mkdir(path.join(home, ".hermes"), { recursive: true });
    await writeFile(
      path.join(home, ".openclaw/openclaw.json"),
      '{"custom":{"nested":true},"mcp":{"servers":{"other":{"command":"keep"}}}}',
    );
    await writeFile(
      path.join(home, ".hermes/config.yaml"),
      "# keep user setting\ncustom:\n  nested: keep\nexternal_skill_dirs:\n- /existing\n",
    );
    const homePlan = await compare(manifest, true);
    expect(homePlan.requires_home_approval).toBe(true);
    expect(homePlan.changes.filter((change: any) => change.scope === "agent-home")).toHaveLength(2);
    await symlink(path.join(project, "source/SKILL.md"), path.join(project, "source/unsafe.md"));
    const params = { project, manifest, includeHome: false };
    expect(request(RUNTIME_METHODS.planChanges, params).error?.code).toBe(-32000);
    await expect(rust.request(RUNTIME_METHODS.planChanges, params)).rejects.toThrow(
      "symbolic links",
    );
  });

  it("applies reviewed changes, rejects stale or unsafe targets and rolls back invalid writes", async () => {
    const project = path.join(directory, "apply-parity");
    await mkdir(project, { recursive: true });
    const target = path.join(project, "config.json"),
      digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const change = (
      file: string,
      before: string | null,
      after: string,
      validator = "json",
      scope = "project",
    ) => ({
      target: file,
      scope,
      original_hash: before === null ? null : digest(before),
      before: before ?? "",
      after,
      risk: "medium",
      validator,
    });
    const plan = (changes: any[], requires_home_approval = false) => ({
      id: randomUUID(),
      project_root: project,
      created_at: "2026-09-30T00:00:00Z",
      changes,
      requires_home_approval,
    });
    await writeFile(target, '{"before":true}');
    const reviewed = plan([change(target, '{"before":true}', '{"after":true}')]);
    const actual = request(RUNTIME_METHODS.applyChanges, {
      changeSet: reviewed,
      approveHome: false,
    });
    expect(actual.error).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe('{"after":true}');
    expect(await readFile(path.join(directory, "backups", reviewed.id, "0.bak"), "utf8")).toBe(
      '{"before":true}',
    );
    await writeFile(target, '{"before":true}');
    expect(actual.result).toEqual(
      await rust.request(RUNTIME_METHODS.applyChanges, { changeSet: reviewed, approveHome: false }),
    );
    const stale = request(RUNTIME_METHODS.applyChanges, {
      changeSet: reviewed,
      approveHome: false,
    });
    expect(stale.error?.data).toMatchObject({
      detail: expect.stringContaining("modified externally"),
    });
    expect(await readFile(target, "utf8")).toBe('{"after":true}');
    const created = path.join(project, "created.json"),
      rollback = plan([
        change(target, '{"after":true}', '{"temporary":true}'),
        change(created, null, "invalid JSON"),
      ]);
    const failure = request(RUNTIME_METHODS.applyChanges, {
      changeSet: rollback,
      approveHome: false,
    });
    expect(failure.error?.data).toMatchObject({
      detail: expect.stringContaining("Post-write validation failed"),
    });
    expect(await readFile(target, "utf8")).toBe('{"after":true}');
    await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      rust.request(RUNTIME_METHODS.applyChanges, { changeSet: rollback, approveHome: false }),
    ).rejects.toThrow("Post-write validation failed");
    expect(await readFile(target, "utf8")).toBe('{"after":true}');
    const outside = path.join(directory, "outside-write.json");
    const bad = plan([change(outside, null, "{}")]);
    expect(
      request(RUNTIME_METHODS.applyChanges, { changeSet: bad, approveHome: false }).error?.code,
    ).toBe(-32000);
    await expect(readFile(outside)).rejects.toMatchObject({ code: "ENOENT" });
    await symlink(target, path.join(project, "linked.json"));
    const linked = plan([change(path.join(project, "linked.json"), '{"after":true}', "{}")]);
    expect(
      request(RUNTIME_METHODS.applyChanges, { changeSet: linked, approveHome: false }).error?.code,
    ).toBe(-32000);
    expect(await readFile(target, "utf8")).toBe('{"after":true}');
    const homeTarget = path.join(environment.HOME!, ".openclaw/openclaw.json"),
      homePlan = plan(
        [change(homeTarget, await readFile(homeTarget, "utf8"), "{}", "json", "agent-home")],
        true,
      );
    expect(
      request(RUNTIME_METHODS.applyChanges, { changeSet: homePlan, approveHome: false }).error
        ?.code,
    ).toBe(-32000);
    expect(
      request(RUNTIME_METHODS.applyChanges, { changeSet: homePlan, approveHome: true }).error,
    ).toBeUndefined();
    expect(await readFile(homeTarget, "utf8")).toBe("{}");
    const forged = plan([
      change(
        path.join(directory, "continuations/arbitrary/document.json"),
        null,
        "{}",
        "json",
        "application-data",
      ),
    ]);
    expect(
      request(RUNTIME_METHODS.applyChanges, { changeSet: forged, approveHome: true }).error?.code,
    ).toBe(-32000);
    const nativeTarget = path.join(environment.CODEX_HOME!, "sessions/2026/native.jsonl"),
      nativePlan = plan(
        [change(nativeTarget, null, '{"type":"fixture"}\n', "jsonl", "agent-home")],
        true,
      );
    expect(
      request(RUNTIME_METHODS.applyChanges, { changeSet: nativePlan, approveHome: true }).error,
    ).toBeUndefined();
    expect(await readFile(nativeTarget, "utf8")).toBe('{"type":"fixture"}\n');
    const workspaceId = "application-fixture";
    database
      .prepare(
        "INSERT INTO workspaces(id,canonical_path,name,status,asset_count,warning_count,last_discovered_at) VALUES (?,?,?,'healthy',0,0,?)",
      )
      .run(workspaceId, project, "Application", "2026-09-30T00:00:00Z");
    try {
      const archiveId = randomUUID(),
        archiveDirectory = path.join(
          directory,
          "continuations",
          digest(workspaceId).slice(0, 32),
          archiveId,
        ),
        document = JSON.stringify({
          schema_version: 1,
          source: {
            agent: "codex",
            workspace_id: workspaceId,
            title: null,
            created_at: null,
            updated_at: null,
            git_branch: null,
          },
          turns: [],
          losses: [],
          redaction_count: 0,
        }),
        chunks = "",
        metadata = JSON.stringify({
          schema_version: 1,
          archive_id: archiveId,
          workspace_id: workspaceId,
          source_fingerprint: "fixture",
          document_sha256: digest(document),
          chunks_sha256: digest(chunks),
          chunk_count: 0,
          created_at: "2026-09-30T00:00:00Z",
        }),
        archivePlan = plan([
          change(
            path.join(archiveDirectory, "manifest.json"),
            null,
            metadata,
            "json",
            "application-data",
          ),
          change(
            path.join(archiveDirectory, "document.json"),
            null,
            document,
            "json",
            "application-data",
          ),
          change(
            path.join(archiveDirectory, "chunks.jsonl"),
            null,
            chunks,
            "jsonl",
            "application-data",
          ),
        ]);
      const receipt = request(RUNTIME_METHODS.applyChanges, {
        changeSet: archivePlan,
        approveHome: false,
      });
      expect(receipt.error).toBeUndefined();
      expect(await readFile(path.join(archiveDirectory, "document.json"), "utf8")).toBe(document);
      await rm(archiveDirectory, { recursive: true });
      expect(receipt.result).toEqual(
        await rust.request(RUNTIME_METHODS.applyChanges, {
          changeSet: archivePlan,
          approveHome: false,
        }),
      );
    } finally {
      database.prepare("DELETE FROM workspaces WHERE id=?").run(workspaceId);
    }
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

  it("matches native assets and imported manifest instructions without Rust scanning", async () => {
    const project = path.join(directory, "native-assets");
    for (const name of [
      ".agents/skills/review/scripts",
      ".codex",
      ".cursor/rules",
      ".opencode",
      "src/nested",
      ".agents/rules",
      ".agent/rules",
    ])
      await mkdir(path.join(project, name), { recursive: true });
    for (const [name, content] of Object.entries({
      "AGENTS.md": "Shared instructions\n",
      "AGENTS.override.md": "Shared instructions\nCodex additions\n",
      "CLAUDE.md": "@AGENTS.md\nClaude additions\n",
      "GEMINI.md": "@AGENTS.md\nGemini additions\n",
      "src/nested/AGENTS.md": "Nested rules",
      ".cursor/rules/agentkib.mdc":
        "<!-- agentkib:managed:start -->\nCursor additions\n<!-- agentkib:managed:end -->",
      ".opencode/opencode.jsonc": '{instructions:[".opencode/agentkib-instructions.md"],}',
      ".opencode/agentkib-instructions.md":
        "<!-- agentkib:managed:start -->\nOpenCode additions\n<!-- agentkib:managed:end -->",
      ".codex/config.toml": 'model = "fixture"\n',
      ".agents/skills/review/SKILL.md": "---\nname: review-code\n---\nReview code\n",
      ".agents/skills/review/scripts/run.ts": "export {};",
      ".agents/skills/review/scripts/secret.key": "private",
      ".agents/rules/shared.md": "Preferred rule",
      ".agent/rules/shared.md": "Shadowed rule",
    }))
      await writeFile(path.join(project, name), content);
    expect(request(RUNTIME_METHODS.scanWorkspace, { project }).result).toEqual(
      await rust.request(RUNTIME_METHODS.scanWorkspace, { project }),
    );
    const actual = request(RUNTIME_METHODS.prepareManifest, { project }).result as {
      workspace: { id: string };
    };
    const expected = await rust.request<{ workspace: { id: string } }>(
      RUNTIME_METHODS.prepareManifest,
      { project },
    );
    actual.workspace.id = expected.workspace.id;
    expect(actual).toEqual(expected);
    const native = await rust.request<InspectedWorkspace[]>(NATIVE_INSPECT, {
      workspaces: [{ id: "fixture", path: project }],
    });
    const inspected = request(BACKEND_INSPECT, { workspaces: [{ id: "fixture", path: project }] })
      .result as InspectedWorkspace[];
    inspected[0]!.inspection.summary!.scanned_at = native[0]!.inspection.summary!.scanned_at;
    expect(inspected).toEqual(native);
  });

  it("matches bounded Git history, renamed paths, staged and worktree diffs", async () => {
    const project = path.join(directory, "git-fixture");
    await mkdir(project);
    const git = (...args: string[]) =>
      promisify(execFile)("git", args, {
        cwd: project,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.test",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.test",
          GIT_AUTHOR_DATE: "2026-09-01T12:00:00Z",
          GIT_COMMITTER_DATE: "2026-09-01T12:00:00Z",
        },
      });
    await git("init", "-b", "main");
    await writeFile(path.join(project, "old name.txt"), "first\n");
    await git("add", ".");
    await git("commit", "-m", "first");
    await git("mv", "old name.txt", "new name.txt");
    await git("commit", "-m", "renamed");
    await git("tag", "fixture-tag");
    await writeFile(path.join(project, "new name.txt"), "first\nstaged\n");
    await git("add", ".");
    await writeFile(path.join(project, "new name.txt"), "first\nstaged\nworktree\n");
    await writeFile(path.join(project, "untracked.txt"), "new");
    const added = await workspace(RUNTIME_METHODS.addWorkspace, { path: project });
    expect(added.error).toBeUndefined();
    const workspaceId = (added.result as { id: string }).id;
    const compare = async (method: string, params: unknown) => {
      const actual = await backend.handleAsync({ jsonrpc: "2.0", id: ++id, method, params });
      expect(actual.error).toBeUndefined();
      const expected = await rust.request(method, params);
      expect(actual.result).toEqual(expected);
      return actual.result;
    };
    await compare(RUNTIME_METHODS.workspaceGitSummary, { id: workspaceId });
    const page = (await compare(RUNTIME_METHODS.workspaceGitHistory, {
      workspaceId,
      query: { limit: 1, merges_only: false },
    })) as { commits: { oid: string }[]; next_cursor: string };
    await compare(RUNTIME_METHODS.workspaceGitHistory, {
      workspaceId,
      query: { cursor: page.next_cursor, limit: 1, merges_only: false },
    });
    await compare(RUNTIME_METHODS.gitCommitFiles, { workspaceId, oid: page.commits[0]!.oid });
    for (const kind of ["staged", "worktree", "commit"])
      await compare(RUNTIME_METHODS.gitDiff, {
        workspaceId,
        request: { kind, path: "new name.txt", oid: page.commits[0]!.oid },
      });
    const invalid = await backend.handleAsync({
      jsonrpc: "2.0",
      id: ++id,
      method: RUNTIME_METHODS.gitDiff,
      params: { workspaceId, request: { kind: "worktree", path: "../outside" } },
    });
    expect(invalid.error?.code).toBe(-32000);
  });

  it("matches filtered statistics, quality, milestones, and private Git identities", async () => {
    database.exec(`
      DELETE FROM usage_events;DELETE FROM usage_daily;DELETE FROM git_commits;DELETE FROM commit_attributions;DELETE FROM insight_cursors;DELETE FROM git_identities;
      INSERT INTO usage_events(source_key,surface_agent,workspace_id,occurred_at,day,model,total_tokens,input_tokens,output_tokens,cache_read_tokens,reasoning_tokens,session_count,date_precision,quality) VALUES
      ('fixture-codex','codex','recent','2026-09-28T01:00:00Z','2026-09-28','fixture-model',120000,80000,30000,10000,500,11,'day','exact'),
      ('fixture-claw','open-claw','recent','2026-09-29T01:00:00Z','2026-09-29',NULL,2000,1500,500,0,0,1,'day','estimated');
      INSERT INTO usage_daily(day,surface_agent,workspace_id,total_tokens,session_count,quality) VALUES ('2026-09-28','codex','recent',120000,11,'exact'),('2026-09-29','open-claw','recent',2000,1,'estimated');
      INSERT INTO git_commits VALUES ('group-a','hash-1','2026-09-28T01:00:00Z','2026-09-28','private-hash',1),('group-b','hash-2','2026-09-27T01:00:00Z','2026-09-27','other-hash',0);
      INSERT INTO commit_attributions VALUES ('group-a','hash-1','codex','exact','native');
      INSERT INTO insight_cursors(provider,available,quality,coverage_from,coverage_to,imported_events,updated_at) VALUES ('codex',1,'exact','2026-09-28','2026-09-28',11,'2026-09-30T01:00:00.123456789Z'),('open-claw',1,'estimated','2026-09-29','2026-09-29',1,'2026-09-30T01:00:00.123456788Z');
      INSERT INTO achievement_unlocks(code,unlocked_at,rule_version) VALUES ('token-100000','2026-09-28T00:00:00Z',1),('session-50','2026-09-29T00:00:00Z',0);
    `);
    for (const query of [
      { from: "2026-09-27", to: "2026-09-30" },
      { from: "2026-09-27", to: "2026-09-30", agent: "codex" },
      { from: "2026-09-27", to: "2026-09-30", workspace_id: "recent" },
      { from: "2026-09-27", to: "2026-09-30", repository_group_id: "group-b" },
    ])
      for (const method of [
        RUNTIME_METHODS.insightsSummary,
        RUNTIME_METHODS.insightsHeatmap,
        RUNTIME_METHODS.agentUsageBreakdown,
        RUNTIME_METHODS.modelUsageBreakdown,
        RUNTIME_METHODS.workspaceUsageBreakdown,
        RUNTIME_METHODS.repositoryCommitBreakdown,
        RUNTIME_METHODS.insightsView,
      ]) {
        const actual = request(method, { query });
        expect(actual.error).toBeUndefined();
        expect(actual.result).toEqual(await rust.request(method, { query }));
      }
    for (const method of [RUNTIME_METHODS.insightsStatus, RUNTIME_METHODS.achievements])
      expect(request(method).result).toEqual(await rust.request(method, {}));
    const alias = request(RUNTIME_METHODS.addGitIdentityAlias, { email: " Fixture@Example.Test " });
    expect(alias.error).toBeUndefined();
    expect(alias.result).toEqual(
      await rust.request(RUNTIME_METHODS.addGitIdentityAlias, { email: "fixture@example.test" }),
    );
    const identity = alias.result as { id: string };
    expect(
      request(RUNTIME_METHODS.setGitIdentityEnabled, { id: identity.id, enabled: false }).error,
    ).toBeUndefined();
    expect(request(RUNTIME_METHODS.gitIdentities).result).toEqual(
      await rust.request(RUNTIME_METHODS.gitIdentities, {}),
    );
    expect(
      request(RUNTIME_METHODS.setGitIdentityEnabled, { id: "missing", enabled: true }).error?.code,
    ).toBe(-32000);
  });

  it("keeps session relations, freshness, stable IDs, and last good rows on partial scans", async () => {
    const store = new SessionStore(new Sql(database), (id) =>
      String(
        database.prepare("SELECT canonical_path FROM workspaces WHERE id=?").get(id)!
          .canonical_path,
      ),
    );
    const native = {
      native_ref: "child",
      agent: "codex" as const,
      title: "Child session",
      origin: "auxiliary" as const,
      created_at: "2026-09-28T00:00:00.123456789Z",
      updated_at: "2026-09-29T00:00:00Z",
      message_count: 3,
      git_branch: "main",
      archived: false,
      sidechain: false,
      availability: "readable" as const,
      spawned_by_session_id: "parent",
      forked_from_session_id: "fork",
    };
    store.sync("recent", "codex", [native]);
    const first = store.list("recent")[0]!;
    expect(first.id).toHaveLength(64);
    expect(first.spawned_by_session_id).toHaveLength(64);
    expect(first.spawned_by_session_id).not.toBe("parent");
    store.sync(
      "recent",
      "codex",
      [{ ...native, native_ref: "second", spawned_by_session_id: "second" }],
      false,
    );
    store.failure("recent", "codex", "source failed");
    expect(store.list("recent")).toHaveLength(2);
    for (const method of [
      RUNTIME_METHODS.workspaceSessions,
      RUNTIME_METHODS.workspaceSessionStatus,
    ])
      expect(request(method, { workspaceId: "recent" }).result).toEqual(
        await rust.request(method, { workspaceId: "recent" }),
      );
    expect(store.status("recent")[0]).toMatchObject({
      freshness: "stale",
      session_count: 2,
      error_detail: "source failed",
    });
    store.sync("recent", "codex", [native]);
    expect(store.list("recent")).toHaveLength(1);
    expect(store.list("recent")[0]!.id).toBe(first.id);
    expect(() => store.sync("recent", "codex", [{ ...native, agent: "hermes" }])).toThrow(
      "different Agent",
    );
    expect(store.list("recent")).toHaveLength(1);
    store.clear("recent");
    expect(store.list("recent")).toEqual([]);
    expect(store.status("recent")).toEqual([]);
  });

  it("writes approved memories and catalog searches that remain readable by Rust", async () => {
    const project = path.join(directory, "memory-fixture");
    await mkdir(path.join(project, ".agentkib"), { recursive: true });
    await writeFile(
      path.join(project, ".agentkib/manifest.yaml"),
      "schema_version: 2\nworkspace:\n  id: memory-fixture\n  name: Memories\n",
    );
    const proposed = request(RUNTIME_METHODS.proposeMemory, {
      project,
      proposal: {
        project_id: "ignored",
        memory_type: "decision",
        content: "  Keep all functionality  ",
        source_agent: "codex",
      },
    });
    expect(proposed.error).toBeUndefined();
    const memory = proposed.result as { id: string };
    expect(memory).toMatchObject({
      project_id: "memory-fixture",
      content: "Keep all functionality",
      status: "pending",
    });
    const approved = request(RUNTIME_METHODS.reviewMemory, { id: memory.id, status: "approved" });
    expect(approved.error).toBeUndefined();
    for (const [method, params] of [
      [RUNTIME_METHODS.listMemories, { project }],
      [RUNTIME_METHODS.listGlobalMemories, { status: "approved" }],
      [RUNTIME_METHODS.searchMemories, { project, query: "functionality", limit: 10 }],
      [RUNTIME_METHODS.searchCatalogAssets, { query: "", limit: 0 }],
      [RUNTIME_METHODS.searchCatalogAssets, { query: "%_", limit: 500 }],
    ] as const) {
      const actual = request(method, params);
      expect(actual.error).toBeUndefined();
      expect(actual.result).toEqual(await rust.request(method, params));
    }
    expect(
      request(RUNTIME_METHODS.reviewMemory, { id: memory.id, status: "pending" }).error?.code,
    ).toBe(-32000);
  });

  it("reads Codex database versions and bounded headers before indexing stable relationships", async () => {
    const project = path.join(directory, "codex-session-fixture"),
      home = path.join(directory, "codex");
    await mkdir(project);
    await mkdir(home, { recursive: true });
    const child = path.join(home, "child.jsonl");
    await writeFile(
      child,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child",
          cwd: project,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent",
                agent_path: "root/reviewer",
                agent_nickname: "Review",
              },
            },
          },
          forked_from_id: "fork",
        },
      }) + "\n",
    );
    const state = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      state.exec(
        "CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,name TEXT,title TEXT,created_at_ms INTEGER,updated_at_ms INTEGER,source TEXT,parent_thread_id TEXT,forked_from_id TEXT,thread_source TEXT,git_branch TEXT,archived INTEGER)",
      );
      state
        .prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          "child",
          project,
          "child.jsonl",
          "",
          "",
          1788220800123,
          1788307200456,
          null,
          null,
          null,
          null,
          "main",
          0,
        );
      state
        .prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          "interactive",
          project,
          "missing.jsonl",
          "User task",
          "old title",
          1788220800123,
          1788307200456,
          "cli",
          null,
          null,
          "user",
          "main",
          1,
        );
    } finally {
      state.close();
    }
    const reader = new CodexSessions({ CODEX_HOME: home }),
      listing = reader.list(project);
    expect(listing.incomplete).toBe(false);
    expect(listing.sessions[0]!.session).toMatchObject({
      native_ref: "child",
      origin: "auxiliary",
      title: "reviewer",
      spawned_by_session_id: "parent",
      forked_from_session_id: "fork",
      availability: "readable",
    });
    const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project });
    const workspaceId = (registered.result as { id: string }).id;
    await rust.request(RUNTIME_METHODS.setSessionIndexEnabled, { value: true });
    await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
    const expected = (
      request(RUNTIME_METHODS.workspaceSessions, { workspaceId }).result as { agent: string }[]
    ).filter((value) => value.agent === "codex");
    const store = new SessionStore(new Sql(database), () => project);
    store.sync(
      workspaceId,
      "codex",
      listing.sessions.map((value) => value.session),
    );
    expect(store.list(workspaceId).filter((value) => value.agent === "codex")).toEqual(expected);
    const old = new DatabaseSync(path.join(home, "state_1.sqlite"));
    try {
      old.exec("CREATE TABLE threads(id TEXT)");
    } finally {
      old.close();
    }
    const incomplete = reader.list(project);
    expect(incomplete.incomplete).toBe(true);
    expect(incomplete.sessions).toHaveLength(2);
  });

  it("discovers Claude index and durable transcripts without loading message bodies", async () => {
    const project = path.join(directory, "claude-session-fixture"),
      home = path.join(directory, "claude"),
      source = path.join(home, "projects", "fixture");
    await mkdir(project);
    await mkdir(source, { recursive: true });
    const indexed = path.join(source, "indexed.jsonl"),
      durable = path.join(source, "durable.jsonl");
    await writeFile(
      indexed,
      JSON.stringify({
        type: "user",
        sessionId: "indexed",
        cwd: project,
        timestamp: "2026-09-29T12:00:00.123456789Z",
        message: { content: "private prompt" },
      }) + "\n",
    );
    await writeFile(
      durable,
      JSON.stringify({
        type: "user",
        sessionId: "durable",
        cwd: project,
        isSidechain: false,
        gitBranch: "main",
        timestamp: "2026-09-28T12:00:00Z",
        message: { content: "private prompt" },
      }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          sessionId: "durable",
          isSidechain: true,
          timestamp: "2026-09-29T12:00:00Z",
        }) +
        "\n",
    );
    await writeFile(
      path.join(source, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: "indexed",
            projectPath: project,
            summary: "Indexed title",
            created: "2026-09-28T00:00:00Z",
            modified: null,
            fileMtime: "2026-09-30T00:00:00Z",
            messageCount: 4,
            gitBranch: "feature",
            isSidechain: false,
          },
        ],
      }),
    );
    await writeFile(
      path.join(home, "history.jsonl"),
      JSON.stringify({ sessionId: "indexed", timestamp: "2026-09-27T00:00:00Z" }) +
        "\n" +
        '{"unfinished":',
    );
    const reader = new ClaudeSessions({ CLAUDE_CONFIG_DIR: home }),
      listing = reader.list(project);
    expect(listing.sessions).toHaveLength(2);
    expect(
      listing.sessions.find((value) => value.session.native_ref === "durable")!.session,
    ).toMatchObject({ title: null, sidechain: false, origin: "interactive" });
    const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
      workspaceId = (registered.result as { id: string }).id;
    await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
    const expected = (
      request(RUNTIME_METHODS.workspaceSessions, { workspaceId }).result as { agent: string }[]
    ).filter((value) => value.agent === "claude-code");
    const store = new SessionStore(new Sql(database), () => project);
    store.sync(
      workspaceId,
      "claude-code",
      listing.sessions.map((value) => value.session),
    );
    expect(store.list(workspaceId).filter((value) => value.agent === "claude-code")).toEqual(
      expected,
    );
  });

  it("keeps Grok session identity across archive moves and resolves ownership before duplicate filtering", async () => {
    const project = path.join(directory, "grok-session-fixture"),
      other = path.join(directory, "grok-other-fixture"),
      home = environment.GROK_HOME!;
    await mkdir(path.join(project, "nested"), { recursive: true });
    await mkdir(other);
    await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
    const create = async (relative: string, cwd: string, id: string, title: string) => {
      const source = path.join(home, relative);
      await mkdir(source, { recursive: true });
      await writeFile(
        path.join(source, "summary.json"),
        JSON.stringify({
          info: { id, cwd },
          generated_title: title,
          createdAt: 1788220800,
          last_active_at: "2026-09-29T12:00:00.123456789+08:00",
        }),
      );
      await writeFile(
        path.join(source, "chat_history.jsonl"),
        '{"type":"user","content":"private body"}\n',
      );
      return source;
    };
    const active = await create(
        "sessions/active",
        path.join(project, "nested"),
        "same",
        "Active title",
      ),
      archived = await create("archived_sessions/moved", other, "same", "Archive title");
    await create("sessions/metadata", project, "metadata", "Metadata title");
    await rm(path.join(home, "sessions/metadata/chat_history.jsonl"));
    await symlink(active, path.join(home, "sessions/linked"));
    const reader = new GrokSessions(environment),
      listing = reader.list(project);
    expect(listing.incomplete).toBe(false);
    expect(listing.sessions).toHaveLength(2);
    const nativeRef = listing.sessions.find((source) => source.session.title === "Active title")!
      .session.native_ref;
    expect(reader.resolve(nativeRef).transcript).toBe(path.join(active, "chat_history.jsonl"));
    expect(reader.list(other).sessions).toHaveLength(0);
    const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
      workspaceId = (registered.result as { id: string }).id,
      store = new SessionStore(new Sql(database), () => project);
    await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
    const expected = store.list(workspaceId).filter((session) => session.agent === "grok-build");
    store.sync(
      workspaceId,
      "grok-build",
      listing.sessions.map((source) => source.session),
    );
    expect(store.list(workspaceId).filter((session) => session.agent === "grok-build")).toEqual(
      expected,
    );
    await rm(active, { recursive: true });
    const restored = reader.list(other);
    expect(restored.sessions).toHaveLength(1);
    expect(restored.sessions[0]!.session).toMatchObject({
      native_ref: nativeRef,
      archived: true,
      title: "Archive title",
    });
    expect(reader.resolve(nativeRef).transcript).toBe(path.join(archived, "chat_history.jsonl"));
    await mkdir(path.join(home, "sessions/broken"));
    await writeFile(path.join(home, "sessions/broken/summary.json"), '{"info":{"id":" "}}');
    expect(reader.list(project).incomplete).toBe(true);
    expect(reader.list(project).sessions).toHaveLength(1);
  });

  it("discovers OpenClaw instance-scoped metadata from bounded transcript headers and UTF-8 tails", async () => {
    const project = path.join(directory, "openclaw-session-fixture"),
      home = path.join(environment.HOME!, ".openclaw"),
      source = path.join(home, "agents/main/sessions");
    await mkdir(path.join(project, "nested"), { recursive: true });
    await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
    await mkdir(source, { recursive: true });
    const header = (id: string) =>
      JSON.stringify({
        type: "session",
        id,
        cwd: path.join(project, "nested"),
        timestamp: "2026-09-28T00:00:00Z",
      }) + "\n";
    await writeFile(
      path.join(source, "sessions.json"),
      JSON.stringify({ main: { sessionId: "named", displayName: "Display title" } }),
    );
    await writeFile(
      path.join(source, "named.jsonl"),
      header("named") +
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Prompt title" },
              { type: "image", data: "private" },
            ],
          },
        }) +
        "\n" +
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "中".repeat(1024 * 1024) },
        }) +
        "\n" +
        '{"type":"message","timestamp":"2026-09-29T12:00:00.123456789+08:00"}\n',
    );
    await writeFile(
      path.join(source, "fallback.jsonl"),
      header("fallback") +
        '{"type":"message","message":{"role":"user","content":"Fallback title"}}\n',
    );
    await symlink(path.join(source, "fallback.jsonl"), path.join(source, "link.jsonl"));
    const reader = new OpenClawSessions({ OPENCLAW_STATE_DIR: home }),
      listing = reader.list(project);
    expect(listing.incomplete).toBe(false);
    expect(listing.sessions).toHaveLength(2);
    expect(listing.sessions[0]!.session).toMatchObject({
      title: "Display title",
      updated_at: "2026-09-29T04:00:00.123456789Z",
      origin: "unknown",
      availability: "readable",
    });
    expect(listing.sessions[1]!.session.title).toBe("Fallback title");
    expect(reader.resolve(listing.sessions[0]!.session.native_ref).transcript).toBe(
      path.join(source, "named.jsonl"),
    );
    const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
      workspaceId = (registered.result as { id: string }).id,
      store = new SessionStore(new Sql(database), () => project);
    await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
    const expected = store.list(workspaceId).filter((session) => session.agent === "open-claw");
    store.sync(
      workspaceId,
      "open-claw",
      listing.sessions.map((source) => source.session),
    );
    expect(store.list(workspaceId).filter((session) => session.agent === "open-claw")).toEqual(
      expected,
    );
    await writeFile(path.join(source, "broken.jsonl"), "not-json\n");
    expect(reader.list(project).incomplete).toBe(true);
    expect(reader.list(project).sessions).toHaveLength(2);
    await writeFile(path.join(source, "sessions.json"), "invalid-json");
    expect(reader.list(project).incomplete).toBe(true);
    expect(reader.list(project).sessions[0]!.session.title).toBe("Prompt title");
  });

  it("merges Hermes profile metadata with JSONL fallback while retaining database ownership and bounded scans", async () => {
    const project = path.join(directory, "hermes-session-fixture"),
      other = path.join(directory, "hermes-other-fixture"),
      home = path.join(environment.HOME!, ".hermes"),
      sessions = path.join(home, "sessions"),
      profile = path.join(home, "profiles/alternate");
    await mkdir(project);
    await mkdir(other);
    await mkdir(sessions, { recursive: true });
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
    const db = new DatabaseSync(path.join(home, "state.db"));
    try {
      db.exec(
        "CREATE TABLE sessions(id TEXT,title TEXT,directory TEXT,started_at REAL,ended_at TEXT)",
      );
      const insert = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)");
      insert.run("enrich", "Database title", null, 1788220800.9, "2026-09-29T12:00:00.123456789Z");
      insert.run("ownership", "Owner title", project, 1788220800000, null);
      insert.run("metadata", "Metadata only", project, 1788220800, null);
    } finally {
      db.close();
    }
    const write = async (root: string, id: string, cwd: string) => {
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, `${id}.jsonl`),
        JSON.stringify({ type: "init", id, cwd, title: "Transcript title", ts: 1788220800 }) +
          "\n" +
          '{"role":"user","content":"private body","timestamp":"2026-09-29T00:00:00Z"}\n',
      );
    };
    await write(sessions, "enrich", project);
    await write(sessions, "ownership", other);
    await write(path.join(profile, "sessions"), "enrich", project);
    const reader = new HermesSessions({ HERMES_HOME: home }),
      listing = reader.list(project);
    expect(listing.incomplete).toBe(false);
    expect(listing.sessions).toHaveLength(4);
    expect(reader.list(other).sessions).toHaveLength(0);
    const enriched = listing.sessions.find((value) => value.session.title === "Database title")!;
    expect(enriched).toMatchObject({
      cwd: project,
      source: { type: "jsonl" },
      session: {
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-29T12:00:00.123456789Z",
        availability: "readable",
      },
    });
    expect(listing.sessions.find((value) => value.session.title === "Owner title")!.cwd).toBe(
      project,
    );
    expect(
      listing.sessions.find((value) => value.session.title === "Metadata only")!.session
        .availability,
    ).toBe("metadata-only");
    expect(new Set(listing.sessions.map((value) => value.session.native_ref)).size).toBe(4);
    const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
      workspaceId = (registered.result as { id: string }).id,
      store = new SessionStore(new Sql(database), () => project);
    const compare = async () => {
      await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
      const expected = store.list(workspaceId).filter((session) => session.agent === "hermes"),
        actual = reader.list(project);
      store.sync(
        workspaceId,
        "hermes",
        actual.sessions.map((source) => source.session),
        !actual.incomplete,
      );
      expect(store.list(workspaceId).filter((session) => session.agent === "hermes")).toEqual(
        expected,
      );
    };
    await compare();
    const messageDb = new DatabaseSync(path.join(home, "state.db"));
    try {
      messageDb.exec("CREATE TABLE messages(sessionId TEXT,speaker TEXT,text TEXT)");
    } finally {
      messageDb.close();
    }
    expect(reader.resolve(enriched.session.native_ref).source.type).toBe("sqlite");
    await compare();
    await writeFile(
      path.join(sessions, "damaged.jsonl"),
      '{"type":"session","id":"damaged","cwd":' + JSON.stringify(project) + "}\ninvalid-json\n",
    );
    expect(reader.list(project).incomplete).toBe(true);
    await compare();
    const capped = path.join(home, "profiles/capped");
    await mkdir(capped);
    const cappedDb = new DatabaseSync(path.join(capped, "state.db"));
    try {
      cappedDb.exec(
        "CREATE TABLE sessions(id TEXT,cwd TEXT); WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n<501) INSERT INTO sessions(id,cwd) SELECT 'cap-'||n,NULL FROM counter",
      );
    } finally {
      cappedDb.close();
    }
    const cappedListing = reader.list(null);
    expect(cappedListing.incomplete).toBe(true);
    expect(
      cappedListing.sessions.filter(
        (source) => source.source.path === path.join(capped, "state.db"),
      ),
    ).toHaveLength(500);
  });

  it("matches bounded reverse pages for compatible providers, including replay, append and replacement", async () => {
    const pager = new SessionPaging();
    for (const agent of ["grok-build", "open-claw", "hermes"] as const) {
      const project = path.join(directory, `paging-${agent}`);
      await mkdir(project);
      await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
      const source =
          agent === "grok-build"
            ? path.join(environment.GROK_HOME!, "sessions/paging")
            : agent === "open-claw"
              ? path.join(environment.HOME!, ".openclaw/agents/paging/sessions")
              : path.join(environment.HOME!, ".hermes/sessions"),
        file = path.join(source, agent === "grok-build" ? "chat_history.jsonl" : "paging.jsonl");
      await mkdir(source, { recursive: true });
      if (agent === "grok-build")
        await writeFile(
          path.join(source, "summary.json"),
          JSON.stringify({ info: { id: "paging", cwd: project } }),
        );
      const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
        agent === "grok-build"
          ? { type: role, content, ...extra }
          : { type: "message", message: { role, content, ...extra } };
      const records = [
        { type: agent === "hermes" ? "init" : "session", id: "paging", cwd: project },
        message("user", "oldest"),
        { type: "reasoning", message: { role: "assistant", content: "must hide" } },
        message(
          "assistant",
          [
            { type: "toolCall", name: "first" },
            { type: "toolResult", name: "second", status: "error", content: "tool output" },
            { type: "text", text: "with tools" },
            { type: "image", data: "private" },
          ],
          { turn_id: "untrusted", phase: "final_answer" },
        ),
        message("tool", "status output", {
          toolName: " \u0001shell ",
          status: "SUCCESS",
          durationMs: 123,
        }),
        {
          type: agent === "grok-build" ? "assistant" : "message",
          role: "assistant",
          message: { role: null, content: null },
          content: "must hide null fallback",
        },
        message("assistant", "中".repeat(100_000)),
        message("user", "latest", { timestamp: "2026-09-29T12:00:00.123456789+08:00" }),
      ];
      await writeFile(
        file,
        records.map((record) => JSON.stringify(record)).join("\n") + "\ninvalid-json\n",
      );
      const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
        workspaceId = (registered.result as { id: string }).id;
      await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
      const store = new SessionStore(new Sql(database), () => project),
        session = store.list(workspaceId).find((value) => value.agent === agent)!;
      expect(session).toBeDefined();
      expect(await typescriptEvents({ sessionId: session.id, limit: 2 })).toMatchObject({
        ...pager.read(file, null, 2, agent),
        next_cursor: expect.any(String),
      });
      const normalized = (page: any) => ({ ...page, next_cursor: page.next_cursor !== null });
      let actualCursor: string | null = null,
        expectedCursor: string | null = null,
        firstActual: any,
        firstExpected: any;
      const collected: any[] = [];
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const actual = pager.read(file, actualCursor, 2, agent),
          expected: any = await rust.request(RUNTIME_METHODS.sessionEvents, {
            sessionId: session.id,
            cursor: expectedCursor,
            limit: 2,
          });
        expect(normalized(actual)).toEqual(normalized(expected));
        collected.unshift(...actual.events);
        if (pageNumber === 0) {
          firstActual = actual;
          firstExpected = expected;
        }
        actualCursor = actual.next_cursor;
        expectedCursor = expected.next_cursor;
        if (!actualCursor && !expectedCursor) break;
      }
      expect(actualCursor).toBeNull();
      expect(collected.map((event) => event.content).filter(Boolean)).not.toContain("must hide");
      expect(collected.map((event) => event.content).filter(Boolean)).not.toContain(
        "must hide null fallback",
      );
      expect(collected.some((event) => event.truncated)).toBe(true);
      expect(collected.every((event) => !event.turn_id && !event.message_phase)).toBe(true);
      const replay = pager.read(file, firstActual.next_cursor, 2, agent),
        replayExpected = await rust.request(RUNTIME_METHODS.sessionEvents, {
          sessionId: session.id,
          cursor: firstExpected.next_cursor,
          limit: 2,
        });
      expect(normalized(replay)).toEqual(normalized(replayExpected));
      await appendFile(file, JSON.stringify(message("user", "appended outside snapshot")) + "\n");
      expect(normalized(pager.read(file, firstActual.next_cursor, 2, agent))).toEqual(
        normalized(replay),
      );
      expect(
        normalized(
          await rust.request(RUNTIME_METHODS.sessionEvents, {
            sessionId: session.id,
            cursor: firstExpected.next_cursor,
            limit: 2,
          }),
        ),
      ).toEqual(normalized(replayExpected));
      const original = await readFile(file);
      await writeFile(file + ".replacement", original);
      await rename(file + ".replacement", file);
      expect(() => pager.read(file, firstActual.next_cursor, 2, agent)).toThrow(
        "TRANSCRIPT_CURSOR_STALE",
      );
      await expect(
        rust.request(RUNTIME_METHODS.sessionEvents, {
          sessionId: session.id,
          cursor: firstExpected.next_cursor,
          limit: 2,
        }),
      ).rejects.toThrow("TRANSCRIPT_CURSOR_STALE");
      await writeFile(
        file,
        JSON.stringify(records[0]) +
          "\n" +
          JSON.stringify(message("user", "before oversized")) +
          "\n" +
          "x".repeat(20 * 1024 * 1024) +
          "\n" +
          JSON.stringify(message("user", "after oversized")),
      );
      const budgetPage = pager.read(file, null, 100, agent),
        budgetExpected: any = await rust.request(RUNTIME_METHODS.sessionEvents, {
          sessionId: session.id,
          limit: 100,
        });
      expect(normalized(budgetPage)).toEqual(normalized(budgetExpected));
      expect(budgetPage.warnings).toContain("TRANSCRIPT_SCAN_BUDGET");
      expect(budgetPage.events[0]!.content).toBe("after oversized");
      const olderPage = pager.read(file, budgetPage.next_cursor, 100, agent),
        olderExpected = await rust.request(RUNTIME_METHODS.sessionEvents, {
          sessionId: session.id,
          cursor: budgetExpected.next_cursor,
          limit: 100,
        });
      expect(normalized(olderPage)).toEqual(normalized(olderExpected));
      expect(olderPage.warnings).toContain("TRANSCRIPT_OVERSIZED_LINES");
      expect(olderPage.events[0]!.content).toBe("before oversized");
      expect(olderPage.next_cursor).toBeNull();
      expect(() => pager.read(file, "wrong", 1, agent)).toThrow("TRANSCRIPT_CURSOR_INVALID");
    }
  });

  it("matches Codex turn and mirror boundaries and Claude tool association across page cuts", async () => {
    const normalize = (page: any) => ({ ...page, next_cursor: page.next_cursor !== null });
    for (const agent of ["codex", "claude-code"] as const) {
      const project = path.join(directory, `native-paging-${agent}`);
      await mkdir(project);
      await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
      let file: string, records: unknown[];
      if (agent === "codex") {
        const home = environment.CODEX_HOME!;
        file = path.join(home, "paging.jsonl");
        const state = new DatabaseSync(path.join(home, "state_5.sqlite"));
        try {
          state
            .prepare("INSERT INTO threads(id,cwd,rollout_path,source) VALUES (?,?,?,?)")
            .run("paging", project, file, "cli");
        } finally {
          state.close();
        }
        const item = (payload: unknown) => ({
          type: "response_item",
          timestamp: "2026-09-29T00:00:00Z",
          payload,
        });
        const event = (payload: unknown) => ({
          type: "event_msg",
          timestamp: "2026-09-29T00:00:00Z",
          payload,
        });
        records = [
          { type: "session_meta", payload: { id: "paging", cwd: project, source: "cli" } },
          item({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "older unclassified" }],
          }),
          ...["one", "two"].flatMap((turn) => [
            event({ type: "task_started", turn_id: turn }),
            item({
              type: "message",
              role: "user",
              internal_chat_message_metadata_passthrough: { turn_id: turn },
              content: [
                { type: "input_text", text: "# AGENTS.md instructions private injected context" },
              ],
            }),
            event({
              type: "user_message",
              message: `user-${turn}`,
              turn_id: turn,
              images: ["attachment"],
            }),
            item({
              type: "message",
              role: "user",
              internal_chat_message_metadata_passthrough: { turn_id: turn },
              content: [{ type: "input_text", text: `user-${turn}` }],
            }),
            { type: "turn_context", payload: { turn_id: turn } },
            item({
              type: "message",
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: `comment-${turn}` }],
            }),
            item({ type: "function_call", call_id: `call-${turn}`, name: "exec" }),
            item({
              type: "function_call_output",
              call_id: `call-${turn}`,
              output: "private output",
              turn_id: turn,
            }),
            event({
              type: "exec_command_end",
              call_id: `call-${turn}`,
              success: true,
              duration: 0.0122,
              turn_id: turn,
            }),
            item({
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: `final-${turn}` }],
            }),
            event({ type: "task_complete", turn_id: turn }),
          ]),
          event({
            type: "agent_message",
            message: "conflicting mirror",
            turn_id: "conflict",
            phase: "commentary",
          }),
          item({
            type: "message",
            role: "assistant",
            turn_id: "conflict",
            phase: "final_answer",
            content: [{ type: "output_text", text: "conflicting mirror" }],
          }),
          event({ type: "user_message", message: "ambiguous", turn_id: "ambiguous" }),
          item({
            type: "message",
            role: "user",
            turn_id: "ambiguous",
            content: [{ type: "input_text", text: "ambiguous" }],
          }),
          item({
            type: "message",
            role: "user",
            turn_id: "ambiguous",
            content: [{ type: "input_text", text: "ambiguous" }],
          }),
        ];
      } else {
        const source = path.join(environment.CLAUDE_CONFIG_DIR!, "projects/paging");
        await mkdir(source, { recursive: true });
        file = path.join(source, "paging.jsonl");
        const record = (type: string, content: unknown, extra: unknown = {}) => ({
          type,
          sessionId: "paging",
          cwd: project,
          timestamp: "2026-09-29T00:00:00Z",
          message: { role: type, content },
          ...(extra as Record<string, unknown>),
        });
        records = [
          record("user", "start"),
          record("assistant", [
            { type: "text", text: "tools" },
            { type: "tool_use", id: "a", name: "first" },
            { type: "tool_use", id: "b", name: "second" },
            { type: "thinking", thinking: "private reasoning" },
            { type: "image", data: "private image" },
          ]),
          record("user", [
            { type: "tool_result", tool_use_id: "a", content: "private output" },
            { type: "tool_result", tool_use_id: "b", is_error: true, content: "private failure" },
          ]),
          record("user", "<command-name>/clear</command-name>"),
          record("user", "private compact", { isCompactSummary: true }),
          record("assistant", "done", { turn_id: "untrusted", phase: "final_answer" }),
        ];
      }
      await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
        workspaceId = (registered.result as { id: string }).id;
      await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
      const store = new SessionStore(new Sql(database), () => project),
        session = store.list(workspaceId).find((value) => value.agent === agent)!;
      expect(session).toBeDefined();
      const initialPublicPage = await typescriptEvents({ sessionId: session.id, limit: 2 });
      const publicReferencePager = new SessionPaging();
      const initialModulePage = publicReferencePager.read(file, null, 2, agent);
      expect(normalize(initialPublicPage)).toEqual(normalize(initialModulePage));
      expect(
        normalize(
          await typescriptEvents({
            sessionId: session.id,
            cursor: initialPublicPage.next_cursor,
            limit: 2,
          }),
        ),
      ).toEqual(
        normalize(publicReferencePager.read(file, initialModulePage.next_cursor, 2, agent)),
      );
      for (const limit of [1, 2, 100]) {
        const pager = new SessionPaging();
        let actualCursor: string | null = null,
          expectedCursor: string | null = null;
        const events: any[] = [];
        for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
          const actual = pager.read(file, actualCursor, limit, agent),
            expected: any = await rust.request(RUNTIME_METHODS.sessionEvents, {
              sessionId: session.id,
              cursor: expectedCursor,
              limit,
            });
          expect(normalize(actual)).toEqual(normalize(expected));
          events.unshift(...actual.events);
          actualCursor = actual.next_cursor;
          expectedCursor = expected.next_cursor;
          if (!actualCursor && !expectedCursor) break;
        }
        expect(actualCursor).toBeNull();
        expect(events.every((event) => !event.content?.includes("private"))).toBe(true);
        if (agent === "claude-code")
          expect(
            events
              .filter((event) => event.kind === "tool-summary")
              .map((event) => event.tool_status),
          ).toEqual(["completed", "failed"]);
        if (agent === "codex")
          expect(
            events
              .filter((event) => event.kind === "tool-summary")
              .every((event) => event.duration_ms === 12),
          ).toBe(true);
      }
    }
  });

  it("matches Hermes SQLite high-water cursors, bounded UTF-8 pages and database replacement checks", async () => {
    const project = path.join(directory, "hermes-sqlite-pages"),
      profile = path.join(environment.HOME!, ".hermes/profiles/sqlite-pages"),
      file = path.join(profile, "state.db"),
      nativeId = "sqlite-pages";
    await mkdir(project);
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT); CREATE TABLE messages(sessionId TEXT,speaker TEXT,text TEXT,created_at REAL,status TEXT,toolName TEXT,is_error INTEGER)",
      );
      db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(nativeId, project, "SQLite pages");
      const insert = db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)");
      insert.run(nativeId, "user", "中older row", 1788220800.5, null, null, 0);
      insert.run(nativeId, "assistant", "中".repeat(100_000), 1788220800000, null, null, 0);
      for (let row = 0; row < 7; row++)
        insert.run(nativeId, "assistant", "a".repeat(256 * 1024), 1788220800, null, null, 0);
      insert.run(nativeId, "toolResult", "", 1788220800, "SUCCESS", " \u0001shell ", 1);
      insert.run(nativeId, "system", "private provider metadata", 1788220800, null, null, 0);
    } finally {
      db.close();
    }
    const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
      workspaceId = (registered.result as { id: string }).id;
    await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
    const store = new SessionStore(new Sql(database), () => project),
      session = store.list(workspaceId).find((value) => value.agent === "hermes")!;
    expect(session).toBeDefined();
    const compare = async (cursor: string | null, limit: number) => {
      const actual = readHermesEvents(file, nativeId, cursor, limit),
        expected = await rust.request(RUNTIME_METHODS.sessionEvents, {
          sessionId: session.id,
          cursor,
          limit,
        });
      expect(actual).toEqual(expected);
      expect(await typescriptEvents({ sessionId: session.id, cursor, limit })).toEqual(expected);
      return actual;
    };
    for (const limit of [1, 2, 100]) {
      let cursor: string | null = null;
      const collected: any[] = [];
      for (let page = 0; page < 15; page++) {
        const actual = await compare(cursor, limit);
        collected.unshift(...actual.events);
        cursor = actual.next_cursor;
        if (cursor === null) break;
      }
      expect(cursor).toBeNull();
      expect(collected).toHaveLength(10);
      expect(collected[0]!.content).toBe("中older row");
      expect(collected.find((event) => event.kind === "tool-summary")).toMatchObject({
        tool_name: "shell",
        tool_status: "completed",
        content: null,
      });
      expect(collected.every((event) => !event.content?.includes("private"))).toBe(true);
    }
    const first = await compare(null, 100);
    expect(first.next_cursor).not.toBeNull();
    expect(
      first.events.reduce(
        (size, event) => size + (event.content ? Buffer.byteLength(event.content) : 0),
        0,
      ),
    ).toBe(2 * 1024 * 1024 - 1);
    const oldPage = await compare(first.next_cursor, 100);
    expect(oldPage.events[0]!.content).toBe("中older row");
    const writable = new DatabaseSync(file);
    try {
      writable
        .prepare("INSERT INTO messages(sessionId,speaker,text) VALUES (?,?,?)")
        .run(nativeId, "user", "outside snapshot");
    } finally {
      writable.close();
    }
    expect(await compare(first.next_cursor, 100)).toEqual(oldPage);
    const mutate = new DatabaseSync(file);
    try {
      mutate.exec("UPDATE messages SET text='modified anchor' WHERE rowid=11");
    } finally {
      mutate.close();
    }
    expect(() => readHermesEvents(file, nativeId, first.next_cursor, 1)).toThrow(
      "TRANSCRIPT_CURSOR_STALE",
    );
    await expect(
      rust.request(RUNTIME_METHODS.sessionEvents, {
        sessionId: session.id,
        cursor: first.next_cursor,
        limit: 1,
      }),
    ).rejects.toThrow("TRANSCRIPT_CURSOR_STALE");
    const fresh = await compare(null, 1),
      bytes = await readFile(file);
    await writeFile(file + ".replacement", bytes);
    await rename(file + ".replacement", file);
    expect(() => readHermesEvents(file, nativeId, fresh.next_cursor, 1)).toThrow(
      "TRANSCRIPT_CURSOR_STALE",
    );
    await expect(
      rust.request(RUNTIME_METHODS.sessionEvents, {
        sessionId: session.id,
        cursor: fresh.next_cursor,
        limit: 1,
      }),
    ).rejects.toThrow("TRANSCRIPT_CURSOR_STALE");
    await expect(
      rust.request(RUNTIME_METHODS.sessionEvents, {
        sessionId: session.id,
        cursor: "wrong",
        limit: 1,
      }),
    ).rejects.toThrow("TRANSCRIPT_CURSOR_INVALID");
    expect(() => readHermesEvents(file, nativeId, "wrong", 1)).toThrow("TRANSCRIPT_CURSOR_INVALID");
    const noisy = new DatabaseSync(file);
    try {
      const insert = noisy.prepare("INSERT INTO messages(sessionId,speaker,text) VALUES (?,?,?)");
      noisy.exec("BEGIN");
      for (let row = 0; row < 501; row++) insert.run(nativeId, "system", "private metadata");
      noisy.exec("COMMIT");
    } finally {
      noisy.close();
    }
    const empty = await compare(null, 100);
    expect(empty.events).toHaveLength(0);
    expect(empty.next_cursor).not.toBeNull();
    expect((await compare(empty.next_cursor, 100)).events.length).toBeGreaterThan(0);
    const damaged = new DatabaseSync(file);
    try {
      damaged
        .prepare(
          "INSERT INTO messages(sessionId,speaker,text) VALUES (?,'assistant',CAST(x'ff' AS TEXT))",
        )
        .run(nativeId);
    } finally {
      damaged.close();
    }
    expect(() => readHermesEvents(file, nativeId, null, 1)).toThrow();
    await expect(
      rust.request(RUNTIME_METHODS.sessionEvents, {
        sessionId: session.id,
        cursor: null,
        limit: 1,
      }),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "matches OpenCode CLI metadata and exported event pages",
    async () => {
      const project = path.join(directory, "opencode-history"),
        bin = path.join(environment.HOME!, ".local/bin"),
        executable = path.join(bin, "opencode"),
        listFile = path.join(bin, "opencode-list.json"),
        exportFile = path.join(bin, "opencode-export.json"),
        nativeRef = 'session with spaces & "quotes"';
      await mkdir(project);
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
      const listings = Buffer.from(
        JSON.stringify([
          {
            id: nativeRef,
            title: " \u0001Unicode\u2003title 😀 ",
            created: 1788220800001,
            updated: 1788220800123,
            directory: project,
          },
          { id: "metadata", title: "😀".repeat(210), directory: null },
          { id: "empty-directory", title: "\u2003", created: -1, directory: "" },
          { id: "foreign-directory", directory: "/different/workspace" },
        ]),
      );
      const exported = Buffer.from(
        JSON.stringify({
          info: { id: nativeRef },
          messages: [
            {
              info: { id: "message-user", role: "user", time: { created: 1788220800001 } },
              parts: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
              ],
            },
            {
              info: { id: "message-system", role: "system" },
              parts: [{ type: "text", text: "private system data" }],
            },
            {
              info: { id: "message-tools", role: "assistant" },
              parts: [
                { type: "reasoning", text: "private reasoning" },
                { type: "tool", tool: "shell", state: { output: "private output" } },
              ],
            },
            {
              info: { id: "message-attachment", role: "user", time: { created: -1 } },
              parts: [
                { type: "text", text: "\u2003" },
                { type: "file", url: "data:image/png;base64,ZmFrZQ==" },
                { type: "tool" },
              ],
            },
            {
              info: { id: "message-empty", role: "assistant", time: null },
              parts: [null, 3, {}, { type: "reasoning" }, { type: "text", text: "\u2003" }],
            },
            {
              info: { id: "message-large", role: "assistant", time: { created: 0 } },
              parts: [{ type: "text", text: "中".repeat(100_000) }],
            },
          ],
        }),
      );
      await writeFile(listFile, listings);
      await writeFile(exportFile, exported);
      await writeFile(
        executable,
        `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') === 'session list --format json') process.stdout.write(fs.readFileSync(path.join(__dirname, 'opencode-list.json')));
else if (args.length === 2 && args[0] === 'export' && args[1] === ${JSON.stringify(nativeRef)}) process.stdout.write(fs.readFileSync(path.join(__dirname, 'opencode-export.json')));
else process.exit(2);
`,
      );
      await chmod(executable, 0o755);
      const commands = new Commands();
      try {
        const provider = new OpenCodeSessions(commands, {
          ...process.env,
          ...environment,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        });
        expect(resolveCommand("opencode", { ...environment, PATH: bin })).toBe(executable);
        await chmod(executable, 0o644);
        expect(resolveCommand(executable, environment)).toBeNull();
        await chmod(executable, 0o755);
        expect(resolveCommand(executable, environment)).toBe(executable);
        expect(
          (
            await commands.run(executable, ["session", "list", "--format", "json"], {
              cwd: project,
              env: { ...process.env, ...environment },
              limit: 16 * 1024 * 1024,
              timeout: 30_000,
              strictOutput: true,
              terminateDescendantsOnExit: true,
            })
          ).bytes,
        ).toEqual(listings);
        for (const stream of ["stdout", "stderr"]) {
          await expect(
            commands.run(
              process.execPath,
              ["-e", `process.${stream}.write(Buffer.alloc(1024 * 1024));setInterval(()=>{},1000)`],
              {
                limit: 32,
                timeout: 2000,
                strictOutput: true,
                terminateDescendantsOnExit: true,
              },
            ),
          ).rejects.toThrow(`output exceeds the ${stream === "stdout" ? 32 : 65536}-byte limit`);
        }
        const descendants = await commands.run(
          process.execPath,
          [
            "-e",
            `
          require('node:child_process').spawn(process.execPath, ['-e','console.log(process.pid);setInterval(()=>{},1000)'], {stdio:'inherit'});
          setTimeout(()=>process.exit(0),300);
        `,
          ],
          { timeout: 2000, strictOutput: true, terminateDescendantsOnExit: true },
        );
        expect(descendants.success).toBe(true);
        expect(Number(descendants.bytes.toString("utf8").trim())).toBeGreaterThan(0);
        const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
          workspaceId = (registered.result as { id: string }).id;
        await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
        const store = new SessionStore(new Sql(database), () => project),
          expected = store.list(workspaceId).filter((session) => session.agent === "opencode");
        const parsed = parseOpenCodeSessions(listings);
        expect(await provider.list(project)).toEqual(parsed);
        expect(parsed).toHaveLength(4);
        store.sync(workspaceId, "opencode", parsed);
        expect(store.list(workspaceId).filter((session) => session.agent === "opencode")).toEqual(
          expected,
        );
        const session = expected.find((value) => value.id === store.id("opencode", nativeRef))!;
        expect(session).toBeDefined();
        expect(await typescriptEvents({ sessionId: session.id, limit: 100 })).toEqual(
          await provider.readEvents(project, nativeRef, null, 100),
        );
        expect(await provider.readEvents(project, nativeRef, null, 100)).toEqual(
          await rust.request(RUNTIME_METHODS.sessionEvents, {
            sessionId: session.id,
            cursor: null,
            limit: 100,
          }),
        );
        for (const limit of [0, 1, 2, 100]) {
          let cursor: string | null = null;
          const collected: any[] = [];
          for (let page = 0; page < 10; page++) {
            const actual = parseOpenCodeEvents(exported, cursor, limit);
            expect(actual).toEqual(
              await rust.request(RUNTIME_METHODS.sessionEvents, {
                sessionId: session.id,
                cursor,
                limit,
              }),
            );
            collected.unshift(...actual.events);
            cursor = actual.next_cursor;
            if (cursor === null) break;
          }
          expect(collected).toHaveLength(4);
          expect(collected[0]!.content).toBe("first\nsecond");
          expect(collected[1]!.content).toBeNull();
          expect(collected[3]!.content).toHaveLength(100_000);
          expect(collected[3]!.truncated).toBe(false);
        }
        for (const cursor of ["invalid", "-1", "18446744073709551616", "999", "+2", "0", " 2"]) {
          expect(parseOpenCodeEvents(exported, cursor, 2)).toEqual(
            await rust.request(RUNTIME_METHODS.sessionEvents, {
              sessionId: session.id,
              cursor,
              limit: 2,
            }),
          );
        }
        expect(parseOpenCodeHandoff(exported)).toMatchObject({
          compact_summary: null,
          omitted_tool_count: 2,
          warnings: [],
        });
        expect(await provider.readHandoff(project, nativeRef)).toEqual(
          parseOpenCodeHandoff(exported),
        );
        expect(parseOpenCodeHandoff(exported).messages.map((message) => message.id)).toEqual([
          "message-user",
          "message-attachment",
          "message-large",
        ]);
        for (const invalid of [
          '{"info":{},"messages":[{"info":{"id":"a","role":"system","time":{"created":1.5}},"parts":[]}]}',
          '{"info":{},"messages":[{"info":{"id":"a","role":"user","time":{"created":9223372036854775808}},"parts":[]}]}',
          '{"info":{},"messages":[{"info":{"id":"a","role":"user"},"parts":null}]}',
        ]) {
          await writeFile(exportFile, invalid);
          expect(() => parseOpenCodeEvents(Buffer.from(invalid), null, 1)).toThrow();
          await expect(
            rust.request(RUNTIME_METHODS.sessionEvents, {
              sessionId: session.id,
              cursor: null,
              limit: 1,
            }),
          ).rejects.toThrow();
        }
      } finally {
        commands.close();
        await rm(executable, { force: true });
        await rm(listFile, { force: true });
        await rm(exportFile, { force: true });
      }
    },
    20_000,
  );

  it("preserves ACP replay attachment, explicit permission choices, cancellation and unsupported requests", async () => {
    const incoming = new PassThrough(),
      outgoing = new PassThrough(),
      sent: any[] = [],
      client = new AntigravityAcp(incoming, outgoing);
    outgoing.on("data", (bytes: Buffer) =>
      sent.push(
        ...bytes
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => parseAcpJson(Buffer.from(line))),
      ),
    );
    const peer = (value: unknown) => incoming.write(stringifyAcpJson(value) + "\n");
    const reply = (id: bigint | string, result: unknown) => peer({ jsonrpc: "2.0", id, result });
    const permission = (id: bigint | string) =>
      peer({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: {
          sessionId: "native",
          toolCall: { toolCallId: "tool", rawInput: { command: "untrusted" } },
          options: [
            { optionId: "allow", name: "Allow", kind: "future_kind" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
    const cwd = process.platform === "win32" ? "C:\\workspace" : "/workspace";
    try {
      await expect(client.listSessions(null, null)).rejects.toThrow("initialize has not succeeded");
      const initialize = await client.initialize();
      expect(sent.at(-1).params).toMatchObject({ protocolVersion: 1n, clientCapabilities: {} });
      reply(initialize, {
        protocolVersion: 1n,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } },
      });
      expect(await client.nextEvent()).toMatchObject({
        type: "response",
        id: initialize,
        method: "initialize",
      });
      expect(client.compatibility).toEqual({
        loadSession: true,
        listSessions: true,
        resumeSession: true,
      });
      const queued = Array.from({ length: 32 }, () => client.listSessions(null, null));
      peer({
        jsonrpc: "2.0",
        method: "status",
        params: { text: "queued transport remains readable" },
      });
      const notice = client.nextEvent();
      const ids = await Promise.all(queued);
      expect(await notice).toMatchObject({ type: "notification", method: "status" });
      for (const request of ids) {
        reply(request, { sessions: [] });
        await client.nextEvent();
      }
      const list = await client.listSessions(cwd, "cursor with spaces");
      expect(sent.at(-1).params).toEqual({ cwd, cursor: "cursor with spaces" });
      reply(list, { sessions: [] });
      await client.nextEvent();
      const load = await client.loadSession("native", cwd);
      peer({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "history" },
          },
        },
      });
      expect(await client.nextEvent()).toMatchObject({
        type: "session-update",
        sessionId: "native",
      });
      reply(load, {});
      await client.nextEvent();
      const prompt = await client.prompt("native", "continue");
      await expect(client.prompt("native", "second turn")).rejects.toThrow("active turn");
      permission(9007199254740993n);
      expect(await client.nextEvent()).toMatchObject({ type: "permission", id: 9007199254740993n });
      const before = sent.length;
      await expect(client.respondPermission(9007199254740993n, "not-offered")).rejects.toThrow(
        "not available",
      );
      expect(sent).toHaveLength(before);
      await client.respondPermission(9007199254740993n, "allow");
      expect(sent.at(-1)).toEqual({
        jsonrpc: "2.0",
        id: 9007199254740993n,
        result: { outcome: { outcome: "selected", optionId: "allow" } },
      });
      permission("pending");
      await client.nextEvent();
      await client.cancel("native");
      expect(sent.at(-1).result.outcome).toEqual({ outcome: "cancelled" });
      await expect(client.respondPermission("pending", "allow")).rejects.toThrow(
        "no longer pending",
      );
      permission("late");
      expect(await client.nextEvent()).toEqual({
        type: "permission-cancelled",
        id: "late",
        sessionId: "native",
      });
      reply(prompt, { stopReason: "cancelled" });
      await client.nextEvent();
      const nextPrompt = await client.prompt("native", "new turn");
      permission("finished");
      await client.nextEvent();
      reply(nextPrompt, { stopReason: "end_turn" });
      await client.nextEvent();
      await expect(client.respondPermission("finished", "allow")).rejects.toThrow(
        "no longer pending",
      );
      peer({
        jsonrpc: "2.0",
        id: "fs",
        method: "fs/read_text_file",
        params: { path: "untrusted" },
      });
      expect(await client.nextEvent()).toEqual({
        type: "unsupported-request",
        id: "fs",
        method: "fs/read_text_file",
      });
      expect(sent.at(-1).error.code).toBe(-32601n);
      const missing = await client.loadSession("missing", cwd);
      peer({ jsonrpc: "2.0", id: missing, error: { code: -32000n, message: "not found" } });
      expect(await client.nextEvent()).toMatchObject({
        type: "response",
        error: { code: -32000n, message: "not found" },
      });
      await expect(client.prompt("missing", "try")).rejects.toThrow("not attached");
      expect(
        acpCompatibility(
          parseAcpJson(
            Buffer.from(
              '{"protocolVersion":1,"agentCapabilities":{"loadSession":"true","sessionCapabilities":{"list":false,"resume":null}}}',
            ),
          ),
        ),
      ).toEqual({ loadSession: false, listSessions: false, resumeSession: false });
      expect(() =>
        acpCompatibility(
          parseAcpJson(Buffer.from('{"protocolVersion":1.0,"agentCapabilities":{}}')),
        ),
      ).toThrow();
      verifyAcpControlIdentity({
        agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.1.1" },
      });
      expect(() =>
        verifyAcpControlIdentity({
          agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.1.2" },
        }),
      ).toThrow();
    } finally {
      client.shutdown();
    }
  });

  it("bounds ACP frames and preserves partial UTF-8 input across observation timeouts", async () => {
    const incoming = new PassThrough(),
      outgoing = new PassThrough(),
      client = new AntigravityAcp(incoming, outgoing);
    outgoing.resume();
    try {
      const initialize = await client.initialize(),
        bytes = Buffer.from(
          stringifyAcpJson({
            jsonrpc: "2.0",
            id: initialize,
            result: { protocolVersion: 1n, agentCapabilities: {}, title: "中文" },
          }) + "\n",
        ),
        split = bytes.indexOf(Buffer.from("中文")) + 1;
      incoming.write(bytes.subarray(0, split));
      expect(await client.nextEvent(5)).toBeNull();
      incoming.write(bytes.subarray(split));
      expect(await client.nextEvent()).toMatchObject({
        type: "response",
        result: { title: "中文" },
      });
      const next = client.nextEvent(1000);
      client.shutdown();
      await expect(next).rejects.toThrow("closed");
    } finally {
      client.shutdown();
    }
    for (const bytes of [
      Buffer.alloc(MAX_ACP_FRAME_BYTES + 1, 32),
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":null}\n'),
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"unattached","update":{"sessionUpdate":"agent_message_chunk"}}}\n',
      ),
    ]) {
      const input = new PassThrough(),
        output = new PassThrough(),
        invalid = new AntigravityAcp(input, output);
      output.resume();
      input.write(bytes);
      try {
        await expect(invalid.nextEvent()).rejects.toThrow();
        await expect(invalid.initialize()).rejects.toThrow();
      } finally {
        invalid.shutdown();
      }
    }
    expect(() => parseAcpJson(Buffer.from('{"bad":"\\ud800"}'))).toThrow("Unicode");
    expect(() => parseAcpJson(Buffer.from("[".repeat(128) + "0" + "]".repeat(128)))).toThrow(
      "recursion",
    );
  });

  it("poisons ACP partial writes and enforces a shared operation deadline", async () => {
    let writes = 0;
    const writer = new Writable({
        write(_bytes, _encoding, _callback) {
          writes++;
        },
      }),
      client = new AntigravityAcp(new PassThrough(), writer, { timeout: 15 });
    try {
      await expect(client.initialize()).rejects.toThrow("completion is unknown");
      await expect(client.initialize()).rejects.toThrow("completion is unknown");
      expect(writes).toBe(1);
    } finally {
      client.shutdown();
    }
    const input = new PassThrough(),
      output = new PassThrough(),
      start = performance.now(),
      bounded = new AntigravityAcp(input, output, { deadline: start + 30 });
    output.resume();
    try {
      await bounded.initialize();
      await expect(bounded.nextEvent(1000)).rejects.toThrow("timed out");
      expect(performance.now() - start).toBeLessThan(500);
      await expect(bounded.initialize()).rejects.toThrow("timed out");
    } finally {
      bounded.shutdown();
    }
  });

  it.skipIf(process.platform === "win32")(
    "matches Antigravity ACP paginated native metadata and read-only replay failures",
    async () => {
      const project = path.join(directory, "antigravity-history"),
        foreign = path.join(directory, "antigravity-foreign"),
        bin = path.join(environment.HOME!, ".local/bin"),
        executable = path.join(bin, "agy_acp_server.par"),
        configFile = path.join(bin, "acp-fixture.json"),
        logFile = path.join(bin, "acp-fixture.log");
      await mkdir(project);
      await mkdir(foreign);
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.\n");
      let config: any = {
        mode: "normal",
        load: true,
        project,
        foreign,
        pages: [
          [
            {
              sessionId: "native-1",
              cwd: project,
              title: "old",
              createdAt: 1788220800,
              updatedAt: 1788220800001,
            },
            { sessionId: "missing-cwd" },
            { sessionId: "relative", cwd: "relative" },
            { sessionId: "foreign", cwd: foreign },
            { sessionId: "missing-path", cwd: path.join(project, "removed") },
          ],
          [
            {
              sessionId: "native-2",
              cwd: project,
              title: " \u0001Unicode\u2003title 😀 ",
              createdAt: "2026-09-01T08:00:00.123456+08:00",
              updatedAt: null,
              lastActiveAt: 1788220800002,
            },
            {
              sessionId: "native-1",
              cwd: project,
              title: "<path>private context",
              createdAt: 1788220800,
              lastActiveAt: 1788220800003,
            },
          ],
        ],
      };
      const save = () => writeFile(configFile, JSON.stringify(config));
      await save();
      await writeFile(
        executable,
        `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)},'utf8'));
const log = value => fs.appendFileSync(${JSON.stringify(logFile)},JSON.stringify(value)+'\\n');
log({pid:process.pid});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message = JSON.parse(line); log(message);
 if (message.method === 'initialize') send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:config.load,sessionCapabilities:{list:{}}},agentInfo:{name:'antigravity-acp',version:'future-read-only-version'}}});
 else if (message.method === 'session/list') {
  if (config.mode === 'silent') return;
  if (config.mode === 'unsupported') {send({jsonrpc:'2.0',id:'filesystem',method:'fs/read_text_file',params:{path:'untrusted'}});return;}
  if (config.mode === 'cycle') {send({jsonrpc:'2.0',id:message.id,result:{sessions:[],nextCursor:'same'}});return;}
  const index = message.params.cursor ? Number(message.params.cursor) : 0;
  send({jsonrpc:'2.0',id:message.id,result:{sessions:config.pages[index],nextCursor:index+1<config.pages.length?String(index+1):null}});
 } else if (message.method === 'session/load') {
  if (config.mode === 'permission') {send({jsonrpc:'2.0',id:'read-permission',method:'session/request_permission',params:{sessionId:message.params.sessionId,toolCall:{toolCallId:'call'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});return;}
  if (config.replayRaw) {for (const update of config.replayRaw) process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":'+JSON.stringify(message.params.sessionId)+',"update":'+update+'}}\\n');send({jsonrpc:'2.0',id:message.id,result:{}});return;}
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:message.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'native history'}}}});
  if (config.updateRaw) process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":'+JSON.stringify(message.params.sessionId)+',"update":'+config.updateRaw+'}}\\n');
  send({jsonrpc:'2.0',id:message.id,result:{}});
 }
});
`,
      );
      await chmod(executable, 0o755);
      const provider = new AntigravitySessions({
        ...process.env,
        ...environment,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      try {
        const registered = await workspace(RUNTIME_METHODS.addWorkspace, { path: project }),
          workspaceId = (registered.result as { id: string }).id;
        await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
        const store = new SessionStore(new Sql(database), () => project),
          expected = store.list(workspaceId).filter((session) => session.agent === "antigravity"),
          actual = await provider.list(project);
        const refreshed = await backend.handleAsync({
          jsonrpc: "2.0",
          id: ++id,
          method: RUNTIME_METHODS.refreshWorkspaceSessions,
          params: { workspaceId, force: true },
        });
        expect(refreshed.error).toBeUndefined();
        expect(
          (refreshed.result as any[]).filter((session) => session.agent === "antigravity"),
        ).toEqual(expected);
        expect(
          store.status(workspaceId).find((status) => status.agent === "antigravity"),
        ).toMatchObject({
          freshness: "stale",
          session_count: expected.length,
          error_key: "errors.conversations.sourceUnavailable",
        });
        expect(actual.incomplete).toBe(true);
        expect(actual.sessions.map((session) => session.native_ref)).toEqual([
          "native-1",
          "native-2",
        ]);
        expect(actual.sessions[0]).toMatchObject({
          title: null,
          origin: "interactive",
          updated_at: "2026-09-01T00:00:00.003Z",
          availability: "readable",
        });
        expect(actual.sessions[1]).toMatchObject({ title: "Unicode title 😀", updated_at: null });
        store.sync(workspaceId, "antigravity", actual.sessions, !actual.incomplete);
        expect(
          store.list(workspaceId).filter((session) => session.agent === "antigravity"),
        ).toEqual(expected);
        const replay = await provider.readReplay("native-1");
        expect(replay.session.workspace).toBe(project);
        expect(replay.updates).toEqual([
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "native history" },
          },
        ]);
        const nativeId = store.id("antigravity", "native-1");
        for (const invalidParams of [
          { sessionId: nativeId, limit: -1 },
          { sessionId: nativeId, cursor: 1 },
          { sessionId: 1 },
        ]) {
          expect(
            (
              await backend.handleAsync({
                jsonrpc: "2.0",
                id: ++id,
                method: RUNTIME_METHODS.sessionEvents,
                params: invalidParams,
              })
            ).error?.code,
          ).toBe(-32602);
        }
        expect(
          (
            await backend.handleAsync({
              jsonrpc: "2.0",
              id: ++id,
              method: RUNTIME_METHODS.sessionEvents,
              params: { sessionId: "not-indexed" },
            })
          ).error,
        ).toMatchObject({
          code: -32000,
          data: { detail: "Conversation metadata is no longer available" },
        });

        expect(
          await rust.request(RUNTIME_METHODS.sessionEvents, {
            sessionId: nativeId,
            cursor: null,
            limit: 1,
          }),
        ).toMatchObject({ events: [{ id: "antigravity-update-0", content: "native history" }] });
        config.updateRaw =
          '{"sessionUpdate":"tool_call","toolCallId":"call","title":"shell","status":"pending","rawInput":{"z":1.0,"a":1e-7,"small":0.00001,"positive":1e16,"negative":-0.0,"2":2,"10":10}}';
        await save();
        const toolReplay = await provider.readReplay("native-1"),
          toolPage = await rust.request<any>(RUNTIME_METHODS.sessionEvents, {
            sessionId: nativeId,
            cursor: null,
            limit: 100,
          });
        expect(stringifyAcpJson(toolReplay.updates[1]!.rawInput)).toBe(
          toolPage.events.find((event: any) => event.kind === "tool-summary").content,
        );
        delete config.updateRaw;
        const vector: any[] = [
          { sessionUpdate: "user_message_chunk", content: "hello " },
          { sessionUpdate: "user_message_chunk", content: { type: "text", text: "world" } },
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private reasoning" },
          },
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "assistant-1",
            content: { type: "text", text: "first" },
          },
          { sessionUpdate: "agent_message_chunk", messageId: "assistant-2", content: "second" },
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "assistant-1",
            content: { type: "image", name: "image.png", mimeType: "image/png", data: "aW1hZ2U=" },
          },
          { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: "tail" },
          { sessionUpdate: "agent_message_chunk", content: "legacy new" },
          { sessionUpdate: "agent_message_chunk", content: " continuation" },
          {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "image",
              name: null,
              title: "hidden fallback",
              mimeType: "image/png",
              data: "aW1hZ2U=",
            },
          },
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
          },
          {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "resource",
              resource: { uri: "notes.txt", mimeType: "image/png", text: "plain notes" },
            },
          },
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "resource", resource: { uri: "external.txt" } },
          },
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "resource_link", name: "linked.md", mimeType: "text/markdown" },
          },
          { sessionUpdate: "user_message_chunk", content: { type: "future_video" } },
          {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "initial",
            status: "pending",
            rawInput: { beta: true, alpha: "input" },
            locations: [{ path: "file" }],
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "in_progress",
            rawOutput: { value: 1 },
            content: [
              { type: "content", content: { type: "text", text: "working" } },
              {
                type: "content",
                content: { type: "resource", resource: { text: "resource text" } },
              },
            ],
          },
          { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "completed",
            title: "renamed",
            rawInput: { updated: true },
            rawOutput: { value: 2 },
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            rawOutput: null,
            content: [
              { type: "content", content: { type: "text", text: "latest" } },
              {
                type: "content",
                content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
              },
              { type: "diff" },
              { type: "terminal" },
              { type: "future_block" },
            ],
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            title: "final",
            status: "completed",
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            name: "lower priority",
            locations: [{ path: "repeated" }],
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "call-2",
            title: null,
            name: "fallback",
            status: "completed",
            rawInput: null,
            content: [],
          },
          {
            sessionUpdate: "session_info_update",
            title: "raw\nmetadata",
            updatedAt: "2026-09-01T00:00:00.123456Z",
            extra: true,
          },
          { sessionUpdate: "session_info_update", title: null, updatedAt: null, extra: null },
          ...[
            "plan",
            "available_commands_update",
            "current_mode_update",
            "config_option_update",
            "usage_update",
          ].map((sessionUpdate) => ({ sessionUpdate })),
          { sessionUpdate: "user_message_chunk", content: "final user message" },
        ];
        config.replayRaw = vector.map((update) => JSON.stringify(update));
        await save();
        const normalized = (page: any) => ({
          ...page,
          next_cursor:
            page.next_cursor?.replace(/^antigravity-v2-\d+-/, "antigravity-v2-ID-") ?? null,
        });
        const comparePage = async (
          tsCursor: string | null,
          rustCursor: string | null,
          limit: number,
        ) => {
          const actual = await provider.readEvents("native-1", tsCursor, limit),
            expected = await rust.request<any>(RUNTIME_METHODS.sessionEvents, {
              sessionId: nativeId,
              cursor: rustCursor,
              limit,
            });
          expect(normalized(actual)).toEqual(normalized(expected));
          return { actual, expected };
        };
        const publicAntigravityPage = await typescriptEvents({ sessionId: nativeId, limit: 2 });
        expect(normalized(publicAntigravityPage)).toEqual(
          normalized(await provider.readEvents("native-1", null, 2)),
        );
        expect(
          normalized(
            await typescriptEvents({
              sessionId: nativeId,
              cursor: publicAntigravityPage.next_cursor,
              limit: 2,
            }),
          ),
        ).toEqual(
          normalized(await provider.readEvents("native-1", publicAntigravityPage.next_cursor, 2)),
        );
        for (const limit of [1, 2, 500]) {
          let tsCursor: string | null = null,
            rustCursor: string | null = null;
          const collected: any[] = [];
          for (let count = 0; count < 40; count++) {
            const { actual, expected } = await comparePage(tsCursor, rustCursor, limit);
            collected.unshift(...actual.events);
            tsCursor = actual.next_cursor;
            rustCursor = expected.next_cursor;
            if (tsCursor === null) break;
          }
          expect(tsCursor).toBeNull();
          expect(collected[0].content).toBe("hello world");
          expect(collected.find((event) => event.id === "antigravity-update-3")).toMatchObject({
            content: "first\nimage.png\ntail",
            attachment_count: 1,
          });
          expect(collected.every((event) => !event.content?.includes("private reasoning"))).toBe(
            true,
          );
          expect(collected.filter((event) => event.id.endsWith("-result"))).toHaveLength(2);
        }
        const parsed = parseAntigravityReplay((await provider.readReplay("native-1")).updates);
        expect(parsed.title).toBeNull();
        expect(parsed.updated_at).toBeNull();
        expect(parsed.losses.get("reasoning-excluded")).toBe(1);
        expect(parsed.losses.get("external-attachment")).toBe(2);
        expect(
          parsed.turns.find((turn) => turn.blocks[0]?.type === "tool-call")?.blocks[0],
        ).toMatchObject({ name: "final", input: '{"updated":true}' });
        expect(
          parsed.turns.find(
            (turn) =>
              turn.blocks[0]?.type === "attachment" && turn.blocks[0].filename === "notes.txt",
          )?.blocks[0],
        ).toMatchObject({
          media_type: "text/plain",
          inline_base64: Buffer.from("plain notes").toString("base64"),
        });
        const handoff = await provider.readHandoff("native-1");
        expect(handoff.messages).toEqual(parsed.events);
        expect(handoff.omitted_tool_count).toBe(0);
        await comparePage("antigravity-v1-2", "antigravity-v1-2", 1);
        await comparePage(
          "antigravity-v2-18446744073709551615-2",
          "antigravity-v2-18446744073709551615-2",
          1,
        );
        const frozen = await comparePage(null, null, 2);
        config.replayRaw = [
          ...config.replayRaw,
          JSON.stringify({ sessionUpdate: "agent_message_chunk", content: "outside old snapshot" }),
        ];
        await save();
        const same = await comparePage(frozen.actual.next_cursor, frozen.expected.next_cursor, 2);
        expect(same.actual.events).toEqual(
          parsed.events.slice(parsed.events.length - 4, parsed.events.length - 2),
        );
        for (let count = 0; count < 5; count++) await comparePage(null, null, 2);
        const renewed = await comparePage(
          frozen.actual.next_cursor,
          frozen.expected.next_cursor,
          2,
        );
        expect(renewed.actual.next_cursor).not.toBe(frozen.actual.next_cursor);
        const reassigned = await comparePage(null, null, 2);
        for (const page of config.pages)
          for (const session of page) if (session.sessionId === "native-1") session.cwd = foreign;
        config.replayRaw[0] = JSON.stringify({
          sessionUpdate: "user_message_chunk",
          content: "foreign ",
        });
        await save();
        const moved = await provider.readEvents("native-1", reassigned.actual.next_cursor, 500);
        expect(moved.events[0]!.content).toBe("foreign world");
        // The global provider follows a reassigned ID; the public runtime additionally checks its indexed workspace.
        const stalePublic = await backend.handleAsync({
          jsonrpc: "2.0",
          id: ++id,
          method: RUNTIME_METHODS.sessionEvents,
          params: { sessionId: nativeId, cursor: publicAntigravityPage.next_cursor, limit: 500 },
        });
        expect(stalePublic.error).toMatchObject({
          code: -32000,
          data: { detail: "Conversation transcript is no longer available" },
        });
        await expect(
          rust.request(RUNTIME_METHODS.sessionEvents, {
            sessionId: nativeId,
            cursor: reassigned.expected.next_cursor,
            limit: 500,
          }),
        ).rejects.toThrow("transcript is no longer available");
        for (const page of config.pages)
          for (const session of page) if (session.sessionId === "native-1") session.cwd = project;
        config.replayRaw = vector.map((update) => JSON.stringify(update));
        await save();
        for (const badCursor of [
          "wrong",
          "antigravity-v2-0-1",
          "antigravity-v1--1",
          "antigravity-v1-99999",
          "antigravity-v2-1-invalid",
        ]) {
          await expect(provider.readEvents("native-1", badCursor, 1)).rejects.toThrow(
            "Invalid Antigravity event cursor",
          );
          await expect(
            rust.request(RUNTIME_METHODS.sessionEvents, {
              sessionId: nativeId,
              cursor: badCursor,
              limit: 1,
            }),
          ).rejects.toThrow("Invalid Antigravity event cursor");
        }
        for (const invalid of [
          [{ sessionUpdate: "tool_call_update", toolCallId: "orphan", status: "completed" }],
          [
            { sessionUpdate: "tool_call", toolCallId: "duplicate" },
            { sessionUpdate: "tool_call", toolCallId: "duplicate" },
          ],
          [
            { sessionUpdate: "user_message_chunk", messageId: "changed", content: "user" },
            { sessionUpdate: "agent_message_chunk", messageId: "changed", content: "agent" },
          ],
          [
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "image", mimeType: "image/png", data: "Zh==" },
            },
          ],
          [
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "resource", resource: { blob: "YQ", mimeType: "text/plain" } },
            },
          ],
          [{ sessionUpdate: "user_message_chunk", content: null }],
          [{ sessionUpdate: "unsupported_update" }],
          [{ sessionUpdate: "tool_call", toolCallId: "call", status: "unknown" }],
          [
            { sessionUpdate: "tool_call", toolCallId: "call", status: "completed" },
            { sessionUpdate: "tool_call_update", toolCallId: "call", status: "failed" },
          ],
          [{ sessionUpdate: "session_info_update", title: 3 }],
          [{ sessionUpdate: "session_info_update", updatedAt: 1.5 }],
          [
            {
              sessionUpdate: "tool_call",
              toolCallId: "call",
              content: [{ type: "content", content: { type: "text", text: false } }],
            },
          ],
          [{ sessionUpdate: "tool_call", toolCallId: "call", locations: {} }],
        ]) {
          config.replayRaw = invalid.map((update) => JSON.stringify(update));
          await save();
          await expect(provider.readEvents("native-1", null, 100)).rejects.toThrow();
          await expect(
            rust.request(RUNTIME_METHODS.sessionEvents, {
              sessionId: nativeId,
              cursor: null,
              limit: 100,
            }),
          ).rejects.toThrow();
        }
        expect(() => parseAntigravityReplay([], performance.now() - 1)).toThrow("timed out");
        for (const cap of ["names", "output"]) {
          const content = "x".repeat(cap === "names" ? 512 * 1024 : 1024 * 1024 - 512);
          config.replayRaw = Array.from({ length: cap === "names" ? 17 : 33 }, (_, index) =>
            JSON.stringify({
              sessionUpdate: "tool_call",
              toolCallId: `bounded-${index}`,
              status: cap === "names" ? "pending" : "completed",
              ...(cap === "names" ? { title: content } : { rawOutput: content }),
            }),
          );
          await save();
          const reason =
            cap === "names"
              ? "parsed tool names exceed 16 MiB"
              : "parsed tool output exceeds 64 MiB";
          await expect(provider.readEvents("native-1", null, 100)).rejects.toThrow(reason);
          await expect(
            rust.request(RUNTIME_METHODS.sessionEvents, {
              sessionId: nativeId,
              cursor: null,
              limit: 100,
            }),
          ).rejects.toThrow(reason);
        }
        delete config.replayRaw;
        config.load = false;
        await save();
        const metadata = await provider.list(project);
        expect(metadata.sessions.every((session) => session.availability === "metadata-only")).toBe(
          true,
        );
        await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
        const metadataExpected = store
          .list(workspaceId)
          .filter((session) => session.agent === "antigravity");
        store.sync(workspaceId, "antigravity", metadata.sessions, !metadata.incomplete);
        expect(
          store.list(workspaceId).filter((session) => session.agent === "antigravity"),
        ).toEqual(metadataExpected);
        await expect(provider.readReplay("native-1")).rejects.toThrow(
          "does not support session/load",
        );
        config.load = true;
        config.mode = "cycle";
        await save();
        await expect(provider.list(project)).rejects.toThrow("cursor repeated");
        await rust.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId, force: true });
        expect(
          store.list(workspaceId).filter((session) => session.agent === "antigravity"),
        ).toEqual(metadataExpected);
        config.mode = "normal";
        config.pages[1].push({ sessionId: "native-1", cwd: foreign });
        await save();
        await expect(provider.resolve("native-1")).rejects.toThrow("multiple workspaces");
        expect((await provider.list(project)).sessions).toHaveLength(2);
        config.pages[1].pop();
        config.mode = "unsupported";
        await save();
        await expect(provider.list(project)).rejects.toThrow("invalid event");
        config.mode = "permission";
        await save();
        await expect(provider.readReplay("native-1")).rejects.toThrow("invalid event");
        await expect(
          rust.request(RUNTIME_METHODS.sessionEvents, {
            sessionId: nativeId,
            cursor: null,
            limit: 1,
          }),
        ).rejects.toThrow("invalid event");
        config.mode = "silent";
        await save();
        const start = performance.now();
        await expect(provider.list(project, start + 250)).rejects.toThrow("timed out");
        expect(performance.now() - start).toBeLessThan(1000);
        const invalid = new AntigravitySessions({
          ...environment,
          AGENTKIB_ANTIGRAVITY_ACP_BIN: "relative/server",
        });
        expect(() => invalid.optionalExecutable()).toThrow("absolute");
        invalid.close();
        const logs = (await readFile(logFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          logs
            .filter((entry) => entry.method === "initialize")
            .every(
              (entry) =>
                entry.params.clientCapabilities &&
                Object.keys(entry.params.clientCapabilities).length === 0,
            ),
        ).toBe(true);
        expect(logs.some((entry) => entry.method === "session/prompt")).toBe(false);
        const cleared = await backend.handleAsync({
          jsonrpc: "2.0",
          id: ++id,
          method: RUNTIME_METHODS.clearSessionIndex,
          params: { workspaceId },
        });
        expect(cleared.error).toBeUndefined();
        expect(store.list(workspaceId)).toEqual([]);
        expect(store.status(workspaceId)).toEqual([]);
      } finally {
        provider.close();
        await rm(executable, { force: true });
        await rm(configFile, { force: true });
        await rm(logFile, { force: true });
      }
    },
    45_000,
  );

  async function workspace(method: string, params: { path?: string; id?: string }) {
    const context = await rust.request<NativeContext>(NATIVE_CONTEXT, {});
    const planning = request(BACKEND_PLAN_WORKSPACE, {
      ...params,
      operation: method === RUNTIME_METHODS.addWorkspace ? "add" : "refresh",
      context,
    });
    if (planning.error) return planning;
    const plan = planning.result as WorkspacePlan;
    const scans = request(BACKEND_INSPECT, { workspaces: [plan] }).result as InspectedWorkspace[];
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
    const originalPreferences = await readFile(path.join(directory, "preferences.json"), "utf8");
    database
      .prepare(
        "INSERT INTO conversation_index_status(workspace_id, agent, last_attempt_at, session_count) VALUES (?, 'codex', ?, 0)",
      )
      .run(retainedWorkspaceId(), "2026-09-30T00:00:00Z");
    const disabled = await backend.handleAsync({
      jsonrpc: "2.0",
      id: ++id,
      method: RUNTIME_METHODS.setSessionIndexEnabled,
      params: { value: false },
    });
    expect(disabled.error).toBeUndefined();
    await writeFile(path.join(directory, "preferences.json"), originalPreferences);
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
