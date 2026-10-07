import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentMcpHome, hermesTargetHome } from "../../../packages/backend/src/agent-home";
import { applyRequest } from "../../../packages/backend/src/changes";
import { mcpConnectionInfo, planMcpConnection } from "../../../packages/backend/src/mcp-connection";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-home-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    home = path.join(root, "home"),
    data = path.join(root, "data");
  mkdirSync(project);
  mkdirSync(home);
  const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  const store = new BackendStore(path.join(data, "db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "registered",
    project,
    "fixture",
    "healthy",
    "2026-10-07T00:00:00Z",
  );
  const hub = { running: true, port: 47653 };
  const plan = (agent: "open-claw" | "hermes" | "codex") =>
    planMcpConnection({ workspaceId: "registered", targetAgent: agent }, store, hub, environment);
  const apply = (changeSet: ReturnType<typeof plan>, approveHome = true) =>
    applyRequest({ changeSet, approveHome }, store, data, environment);
  const info = (agent: "open-claw" | "hermes" | "codex") =>
    mcpConnectionInfo({ workspaceId: "registered", targetAgent: agent }, store, hub, environment);
  return { root, project, home, data, store, environment, plan, apply, info };
}

function write(target: string, content: string) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

describe("MCP Agent Home profile selection", () => {
  it("uses the active Hermes profile for both native imports and MCP plan/apply", () => {
    const f = fixture();
    const base = path.join(f.root, "independent-hermes");
    f.environment.HERMES_HOME = base;
    write(path.join(base, "active_profile"), "work\n");
    const selected = path.join(base, "profiles", "work");
    write(path.join(selected, "config.yaml"), "model: fixture-model\n");
    expect(hermesTargetHome(f.environment)).toEqual({ home: selected, profile: "work" });
    expect(f.info("hermes").target).toBe(path.join(selected, "config.yaml"));
    const plan = f.plan("hermes");
    expect(() => f.apply(plan, false)).toThrow(/authorization/);
    f.apply(plan);
    expect(readFileSync(path.join(selected, "config.yaml"), "utf8")).toContain("fixture-model");
    expect(readFileSync(path.join(selected, "config.yaml"), "utf8")).toContain("mcp_servers:");
    expect(existsSync(path.join(base, "config.yaml"))).toBe(false);
    expect(existsSync(path.join(f.home, ".hermes", "config.yaml"))).toBe(false);
  });

  it("accepts a directly selected Hermes profile and refuses profile drift after preview", () => {
    const f = fixture();
    const base = path.join(f.home, ".hermes");
    write(path.join(base, "active_profile"), "alpha");
    const plan = f.plan("hermes");
    write(path.join(base, "active_profile"), "beta");
    expect(() => f.apply(plan)).toThrow(/no longer approved/);
    expect(existsSync(plan.changes[0]!.target)).toBe(false);
    f.environment.HERMES_HOME = path.join(base, "profiles", "alpha");
    expect(hermesTargetHome(f.environment).profile).toBe("alpha");
    f.apply(plan);
    expect(existsSync(plan.changes[0]!.target)).toBe(true);
  });

  it("resolves OpenClaw root, profile, state, and explicit config with native precedence", () => {
    const f = fixture();
    f.environment.OPENCLAW_HOME = path.join(f.root, "independent-openclaw");
    f.environment.OPENCLAW_PROFILE = "work";
    expect(f.info("open-claw").target).toBe(
      path.join(f.environment.OPENCLAW_HOME, ".openclaw-work", "openclaw.json"),
    );
    f.environment.OPENCLAW_STATE_DIR = "${HOME}/state-override";
    expect(f.info("open-claw").target).toBe(path.join(f.home, "state-override", "openclaw.json"));
    f.environment.OPENCLAW_CONFIG_PATH = path.join(f.root, "independent-config", "custom.json");
    const target = f.environment.OPENCLAW_CONFIG_PATH;
    write(target, '{"model":"existing"}\n');
    const plan = f.plan("open-claw");
    expect(plan.changes[0]!.target).toBe(target);
    f.apply(plan);
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      model: "existing",
      mcp: {
        servers: { agentkib: { url: expect.stringContaining("/registered/agents/open-claw") } },
      },
    });
    expect(existsSync(path.join(f.home, ".openclaw", "openclaw.json"))).toBe(false);
  });

  it("rechecks OpenClaw config selection before apply and protects the previous target", () => {
    const f = fixture();
    const plan = f.plan("open-claw");
    f.environment.OPENCLAW_STATE_DIR = path.join(f.home, "different-state");
    expect(() => f.apply(plan)).toThrow(/no longer approved/);
    expect(existsSync(plan.changes[0]!.target)).toBe(false);
    f.apply(f.plan("open-claw"));
    expect(existsSync(path.join(f.environment.OPENCLAW_STATE_DIR, "openclaw.json"))).toBe(true);
  });

  it("does not let a previous Agent Home target bypass profile validation merely because it is inside the project", () => {
    const f = fixture();
    f.environment.OPENCLAW_STATE_DIR = path.join(f.project, "old-state");
    const plan = f.plan("open-claw");
    f.environment.OPENCLAW_STATE_DIR = path.join(f.project, "new-state");
    expect(() => f.apply(plan)).toThrow(/no longer approved/);
    expect(existsSync(plan.changes[0]!.target)).toBe(false);
  });

  it("applies OpenClaw when an unrelated Hermes active_profile is corrupt", () => {
    const f = fixture();
    write(path.join(f.home, ".hermes", "active_profile"), "../broken");
    const plan = f.plan("open-claw");
    f.apply(plan);
    expect(existsSync(plan.changes[0]!.target)).toBe(true);
  });

  it("applies Hermes when unrelated OpenClaw configuration is invalid", () => {
    const f = fixture();
    f.environment.OPENCLAW_PROFILE = "../broken";
    const plan = f.plan("hermes");
    f.apply(plan);
    expect(existsSync(plan.changes[0]!.target)).toBe(true);
  });

  it("binds an OpenClaw MCP plan to its selected config even when that path is also another Agent's fixed Home target", () => {
    const f = fixture();
    f.environment.OPENCLAW_CONFIG_PATH = path.join(f.home, ".claude.json");
    const plan = f.plan("open-claw");
    f.environment.OPENCLAW_CONFIG_PATH = path.join(f.home, "different-openclaw.json");
    expect(() => f.apply(plan)).toThrow(/no longer approved/);
    expect(existsSync(path.join(f.home, ".claude.json"))).toBe(false);
  });

  it.each([
    ["hermes", "HERMES_HOME", "relative-home"],
    ["open-claw", "OPENCLAW_CONFIG_PATH", "relative-config"],
    ["open-claw", "OPENCLAW_HOME", "${UNKNOWN_HOME}/state"],
    ["open-claw", "OPENCLAW_PROFILE", "../other"],
  ] as const)("refuses invalid %s %s without falling back to default Home", (agent, key, value) => {
    const f = fixture();
    f.environment[key] = value;
    expect(() => f.info(agent)).toThrow();
    expect(() => f.plan(agent)).toThrow();
    expect(f.info("codex").scope).toBe("project");
  });

  it("refuses corrupt Hermes active_profile rather than writing default config", () => {
    const f = fixture();
    write(path.join(f.home, ".hermes", "active_profile"), "../outside");
    expect(() => f.plan("hermes")).toThrow(/profile name/);
    write(path.join(f.home, ".hermes", "active_profile"), "a".repeat(257));
    expect(() => f.plan("hermes")).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a profile ancestor replaced by a link between preview and apply",
    () => {
      const f = fixture();
      f.environment.OPENCLAW_CONFIG_PATH = path.join(f.root, "external-config", "openclaw.json");
      const plan = f.plan("open-claw");
      const unrelated = path.join(f.root, "unrelated");
      mkdirSync(unrelated);
      symlinkSync(unrelated, path.dirname(f.environment.OPENCLAW_CONFIG_PATH));
      expect(() => f.apply(plan)).toThrow(/unsafe path/);
      expect(existsSync(path.join(unrelated, "openclaw.json"))).toBe(false);
      expect(() => agentMcpHome("open-claw", f.environment)).toThrow(/unsafe path/);
    },
  );
});
