import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRequest } from "../../../packages/backend/src/changes";
import { planMcpConnection } from "../../../packages/backend/src/mcp-connection";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-change-audit-")));
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
  const plan = planMcpConnection(
    { workspaceId: "registered", targetAgent: "hermes" },
    store,
    { running: true, port: 47653 },
    environment,
  );
  const apply = () =>
    applyRequest({ changeSet: plan, approveHome: true }, store, data, environment);
  return { plan, apply, store };
}

describe("change set audit", () => {
  it("keeps a successful apply result when the audit event cannot be recorded, but leaves a trace", () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(f.store.sql, "audit").mockImplementation(() => {
      throw new Error("audit unavailable");
    });
    const result = f.apply();
    expect(result.applied).toEqual([f.plan.changes[0]!.target]);
    expect(existsSync(f.plan.changes[0]!.target)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/audit/i);
  });

  it("surfaces the apply error, not the audit error, when both fail", () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(f.store.sql, "audit").mockImplementation(() => {
      throw new Error("audit unavailable");
    });
    const target = f.plan.changes[0]!.target;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "model: changed-after-preview\n");
    let error: unknown;
    try {
      f.apply();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/audit unavailable/);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when the audit event is recorded", () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.apply();
    expect(warn).not.toHaveBeenCalled();
    expect(
      f.store.sql.rows("SELECT action FROM audit_events WHERE action='changeset.apply'"),
    ).toHaveLength(1);
  });
});
