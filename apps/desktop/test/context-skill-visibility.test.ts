import { mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { BackendStore } from "../../../packages/backend/src/store";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { RuntimeRouter } from "../electron/main/runtime-router";
import { createStdioTransport, type RuntimeTransport } from "../electron/main/runtime-transport";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const fixtures: ContextFixture[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture() {
  const f = contextFixture();
  fixtures.push(f);
  f.mkdir(".git");
  f.write("AGENTS.md", "Project instructions.\n");
  f.write(".agents/skills/reviewer/SKILL.md", "---\nname: reviewer\n---\nPRIVATE-SKILL-BODY\n");
  return f;
}
const request = (f: ContextFixture, agent: string, restricted = false) =>
  f.context.request(
    { project: f.project, cwd: f.project, agent },
    restricted ? { externalBodies: false } : {},
  );

describe("target-specific native Skill visibility", () => {
  it.each([
    ["disabled", "skills:\n  project_discovery: false\n"],
    ["untrusted", "skills:\n  project_discovery: true\n"],
    ["unknown", "skills: [invalid\n"],
  ])("does not promote a shared Skill with %s Hermes discovery", async (_label, config) => {
    const f = fixture();
    f.write(f.inHome(".hermes/config.yaml"), config);
    expect((await request(f, "hermes")).visible_skills).toEqual([]);
    if (_label !== "unknown")
      expect((await request(f, "codex")).visible_skills).toEqual(["reviewer"]);
    else
      expect((await request(f, "codex")).warnings.join("\n")).toContain(
        "Native Skill visibility could not be verified",
      );
  });

  it("retains a shared Skill in a trusted Hermes Git root", async () => {
    const f = fixture();
    f.write(
      f.inHome(".hermes/config.yaml"),
      `skills:\n  trusted_project_dirs: [${JSON.stringify(f.project)}]\n`,
    );
    expect((await request(f, "hermes")).visible_skills).toEqual(["reviewer"]);
  });

  it.each(["no Git root", "nested project"])("excludes Hermes discovery with %s", async (kind) => {
    const f = fixture();
    f.write(
      f.inHome(".hermes/config.yaml"),
      `skills:\n  trusted_project_dirs: [${JSON.stringify(f.project)}]\n`,
    );
    let project = f.project;
    if (kind === "no Git root") rmSync(f.at(".git"), { recursive: true });
    else {
      project = f.mkdir("nested");
      f.write("nested/.agents/skills/reviewer/SKILL.md", "PRIVATE-SKILL-BODY\n");
    }
    expect(
      (await f.context.request({ project, cwd: project, agent: "hermes" })).visible_skills,
    ).toEqual([]);
  });

  it.each(["disabled", "excluded", "unconfigured", "unknown"])(
    "does not promote a shared Skill with %s OpenClaw visibility",
    async (kind) => {
      const f = fixture();
      f.write(
        f.inHome(".openclaw/openclaw.json"),
        kind === "unknown"
          ? "{"
          : JSON.stringify({
              ...(kind === "unconfigured"
                ? {}
                : {
                    agents: {
                      defaults: {
                        workspace: f.project,
                        ...(kind === "excluded" ? { skills: [] } : {}),
                      },
                    },
                  }),
              ...(kind === "disabled"
                ? { skills: { entries: { reviewer: { enabled: false } } } }
                : {}),
            }),
      );
      expect((await request(f, "open-claw")).visible_skills).toEqual([]);
      expect((await request(f, "codex")).visible_skills).toEqual(["reviewer"]);
    },
  );

  it("keeps a Skill allowed by one of the matching native OpenClaw Agents", async () => {
    const f = fixture();
    f.write(
      f.inHome(".openclaw/openclaw.json"),
      JSON.stringify({
        agents: {
          entries: {
            denied: { workspace: f.project, skills: [] },
            allowed: { workspace: f.project, skills: ["reviewer"] },
          },
        },
      }),
    );
    expect((await request(f, "open-claw")).visible_skills).toEqual(["reviewer"]);
  });
});

describe("restricted Skill visibility", () => {
  it.each([
    [{ "review*": "deny", "*": "allow" }, "allow"],
    [{ "*": "allow", "review*": "deny" }, "deny"],
  ] as const)("shares native OpenCode wildcard ordering for %j", async (rules, expected) => {
    const f = fixture();
    f.write("opencode.json", JSON.stringify({ permission: { skill: rules } }));
    expect((await request(f, "opencode")).visible_skills).toEqual(
      expected === "deny" ? [] : ["reviewer"],
    );
    const restricted = await request(f, "opencode", true);
    expect(restricted.visible_skills).toEqual([]);
    expect(restricted.warnings.join("\n")).toContain(
      "Native Skill visibility could not be verified",
    );
  });

  it("preserves native project, local, explicit workspace and environment ordering", async () => {
    const f = fixture();
    f.write("opencode.json", JSON.stringify({ permission: "allow" }));
    f.write(
      ".opencode/opencode.jsonc",
      "{ // local policy\n permission: {skill: {reviewer: 'ask'}} }",
    );
    f.environment.OPENCODE_CONFIG_DIR = f.mkdir("config");
    f.write("config/opencode.json", JSON.stringify({ permission: { skill: "deny" } }));
    expect((await request(f, "opencode")).visible_skills).toEqual([]);
    f.environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { skill: "allow" } });
    expect((await request(f, "opencode")).visible_skills).toEqual(["reviewer"]);
    f.environment.OPENCODE_PERMISSION = JSON.stringify({ reviewer: "ask" });
    expect((await request(f, "opencode")).visible_skills).toEqual(["reviewer"]);
    expect((await request(f, "opencode", true)).visible_skills).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "does not open personal policy through external configuration or project aliases",
    async () => {
      const f = fixture();
      const personal = f.write(
        f.inHome(".opencode/opencode.json"),
        JSON.stringify({
          permission: { skill: { reviewer: "allow" } },
          private: "PRIVATE-POLICY-BODY",
        }),
      );
      f.link(personal, f.at(".opencode/opencode.json"));
      f.environment.OPENCODE_CONFIG = personal;
      f.environment.OPENCODE_CONFIG_DIR = path.dirname(personal);
      vi.mocked(openSync).mockClear();
      const result = await request(f, "opencode", true);
      expect(result.visible_skills).toEqual([]);
      expect(result.warnings.join("\n")).toContain("Native Skill visibility could not be verified");
      expect(vi.mocked(openSync).mock.calls.map(([file]) => String(file))).not.toContain(personal);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-POLICY-BODY");
      expect(JSON.stringify(result)).not.toContain(f.home);
    },
  );

  it.each(["{", JSON.stringify({ padding: "x".repeat(1024 * 1024) })])(
    "keeps unreadable or oversized project permission unverified",
    async (text) => {
      const f = fixture();
      f.write(".opencode/opencode.json", text);
      vi.mocked(openSync).mockClear();
      const result = await request(f, "opencode", true);
      expect(result.visible_skills).toEqual([]);
      expect(result.warnings.join("\n")).toContain("Native Skill visibility could not be verified");
      // Instruction discovery already reads project config once; Skill visibility adds no read.
      expect(
        vi
          .mocked(openSync)
          .mock.calls.filter(([file]) => String(file) === f.at(".opencode/opencode.json")),
      ).toHaveLength(1);
    },
  );

  it("keeps complex native Skill policy unverified without evaluating its rules", async () => {
    const f = fixture();
    f.write(
      ".opencode/opencode.json",
      JSON.stringify({ permission: { skill: { [`${"*a".repeat(20)}Z`]: "deny" } } }),
    );
    vi.mocked(openSync).mockClear();
    expect((await request(f, "opencode", true)).visible_skills).toEqual([]);
    expect(
      vi
        .mocked(openSync)
        .mock.calls.filter(([file]) => String(file) === f.at(".opencode/opencode.json")),
    ).toHaveLength(1);
  });
  it.each([".opencode/skills", ".agents/skills"])(
    "does not report a project-denied OpenCode Skill in %s",
    async (location) => {
      const f = fixture();
      f.write(`${location}/reviewer/SKILL.md`, "PRIVATE-SKILL-BODY\n");
      f.write("opencode.json", JSON.stringify({ permission: { skill: { reviewer: "deny" } } }));
      expect((await request(f, "opencode")).visible_skills).toEqual([]);
      expect((await request(f, "opencode", true)).visible_skills).toEqual([]);
      expect((await f.mcp(f.project, "opencode")).visible_skills).toEqual([]);
    },
  );

  it.each(["codex", "hermes", "open-claw", "grok-build", "opencode"])(
    "marks %s visibility unverified when personal restrictions were not inspected",
    async (agent) => {
      const f = fixture();
      const result = await request(f, agent, true);
      expect(result.visible_skills).toEqual([]);
      expect(result.warnings.join("\n")).toContain("Native Skill visibility could not be verified");
      expect(JSON.stringify(result)).not.toContain("PRIVATE-SKILL-BODY");
      expect(JSON.stringify(result)).not.toContain(f.home);
    },
  );

  it.each(["cursor", "antigravity"])(
    "preserves workspace directory visibility for %s",
    async (agent) => {
      const f = fixture();
      expect((await request(f, agent, true)).visible_skills).toEqual(["reviewer"]);
    },
  );
});

it("keeps real Backend Context and MCP visibility restricted within a one-second request budget", async () => {
  const f = fixture();
  f.write(f.inHome(".hermes/config.yaml"), "skills:\n  project_discovery: false\n");
  f.write("opencode.json", JSON.stringify({ permission: { skill: { reviewer: "deny" } } }));
  f.write(
    ".agentkib/manifest.yaml",
    "schema_version: 2\nworkspace: {id: registered, name: Fixture}\nskills:\n  - {name: declared-only, path: missing, targets: [hermes, opencode]}\n",
  );
  const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
    "../scripts/backend-worker-smoke-environment.cjs",
  ) as { createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv };
  const dataDir = f.inHome("data");
  for (const directory of [dataDir, f.inHome("tmp")]) mkdirSync(directory, { recursive: true });
  const store = new BackendStore(path.join(dataDir, "agentkib.db"));
  try {
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "registered",
      f.project,
      "Fixture",
      "healthy",
      "2026-10-15T00:00:00Z",
    );
  } finally {
    store.close();
  }
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      session_index_enabled: false,
      session_content_search_enabled: false,
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  const environment = { ...createIsolatedWorkerEnvironment(f.home), PATH: f.bin };
  let transport: RuntimeTransport | undefined;
  const host = new DesktopRuntimeHost({
    executablePath: process.execPath,
    args: [path.resolve("dist-electron/backend.cjs")],
    clientVersion: "test",
    maxRestarts: 0,
    createTransport: (options) => (transport = createStdioTransport({ ...options, environment })),
  });
  const router = new RuntimeRouter(host, dataDir);
  cleanups.push(async () => {
    await router.stop();
    expect(transport?.hasExited).toBe(true);
  });
  await router.start();
  const requireBackend = createRequire(
    new URL("../../../packages/backend/package.json", import.meta.url),
  );
  const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = requireBackend(
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
  );
  const client = new Client({ name: "skill-visibility-runtime-fixture", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp/v1/workspaces/registered/agents/opencode`),
    ),
  );
  type Result = { visible_skills: string[]; legacy_declared_skills: string[] };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const [full, restricted, workspaces] = await Promise.race([
      Promise.all([
        router.request<Result>(RUNTIME_METHODS.resolveContext, {
          project: f.project,
          cwd: f.project,
          agent: "hermes",
        }),
        client
          .callTool({ name: "workspace_get_context", arguments: { cwd: f.project } })
          .then((result: { structuredContent?: unknown }) => {
            expect(result.structuredContent).toBeDefined();
            return result.structuredContent as Result;
          }),
        router.request(RUNTIME_METHODS.listWorkspaces, {}),
      ]),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          transport?.forceKill();
          reject(new Error("Native Skill visibility blocked Backend requests for over 1 second"));
        }, 1_000);
      }),
    ]);
    expect(JSON.stringify(workspaces)).toContain("registered");
    for (const result of [full, restricted]) {
      expect(result.visible_skills).toEqual([]);
      expect(result.legacy_declared_skills).toEqual(["declared-only"]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-SKILL-BODY");
    }
    expect(JSON.stringify(restricted)).not.toContain(f.home);
  } finally {
    clearTimeout(watchdog);
  }
}, 15_000);
