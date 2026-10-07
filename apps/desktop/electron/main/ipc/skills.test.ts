import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { registerRuntimeIpc } from "./runtime";
import type { DesktopRuntimeHost } from "../runtime-host";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/trusted/desktop" },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));
const event = {} as IpcMainInvokeEvent;
const request = vi.fn();
const trusted = vi.fn();
function handler(channel: string) {
  const entry = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([name]) => name === `agentkib:skills:${channel}`);
  if (!entry) throw new Error(`Missing Skill IPC ${channel}`);
  return entry[1];
}
beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  request.mockReset();
  trusted.mockReset();
  registerRuntimeIpc({
    runtime: () => ({ request }) as unknown as DesktopRuntimeHost,
    assertTrustedRenderer: trusted,
    withRuntimeCapabilities: (value) => value,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Skill manager IPC", () => {
  it("forwards version choices and paginated sources without accepting arbitrary roots", () => {
    handler("list-versions")(event, { library_id: "reviewer", type: "tag", page: 2 });
    expect(request).toHaveBeenLastCalledWith("skills.listVersions", {
      library_id: "reviewer",
      type: "tag",
      page: 2,
    });
    handler("prepare-version-change")(event, "reviewer", {
      type: "branch",
      value: "feature/review",
    });
    expect(request).toHaveBeenLastCalledWith("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "branch", value: "feature/review" },
    });
    handler("prepare-version-change")(event, "reviewer", { type: "commit", value: "a1b2c3d" });
    expect(request).toHaveBeenLastCalledWith("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "commit", value: "a1b2c3d" },
    });
  });
  it("lists versions for a discovered public source with an explicit reference type", () => {
    const source = {
      kind: "github",
      repository: "owner/repo",
      ref: "release/v1",
      ref_type: "tag",
      path: "skills/reviewer",
      resolved_commit: "a".repeat(40),
      tree_sha: "b".repeat(40),
    };
    handler("list-versions")(event, { source, type: "branch" });
    expect(request).toHaveBeenLastCalledWith("skills.listVersions", {
      source,
      type: "branch",
      page: 1,
    });
    expect(() =>
      handler("list-versions")(event, {
        source: { ...source, path: "../secret" },
        type: "branch",
      }),
    ).toThrow(TypeError);
    expect(() =>
      handler("list-versions")(event, {
        source: { ...source, root: "/secret" },
        type: "branch",
      }),
    ).toThrow(TypeError);
  });
  it.each([
    {},
    { library_id: "reviewer", source: {}, type: "tag" },
    { library_id: "reviewer", type: "commit" },
    { library_id: "reviewer", type: "tag", page: 0 },
    { library_id: "reviewer", type: "tag", page: 1.5 },
    { library_id: "reviewer", type: "tag", root: "/private" },
  ])("rejects invalid version listings %j", (input) => {
    expect(() => handler("list-versions")(event, input)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { type: "release", value: "v1" },
    { type: "commit", value: "main" },
    { type: "branch", value: "main\0" },
    { type: "tag", value: "" },
    { type: "tag", value: "v1", repository: "other/repo" },
  ])("rejects invalid version selectors %j", (selector) => {
    expect(() => handler("prepare-version-change")(event, "reviewer", selector)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it("prepares selected observations and reads frozen batch items by identity", () => {
    handler("prepare-imports")(event, ["observation-a", "observation-b"]);
    expect(request).toHaveBeenLastCalledWith("skills.prepareImports", {
      observation_ids: ["observation-a", "observation-b"],
    });
    handler("read-preview-file")(event, "batch", "SKILL.md", undefined, "item-a");
    expect(request).toHaveBeenLastCalledWith("skills.readPreviewFile", {
      token: "batch",
      path: "SKILL.md",
      item_id: "item-a",
    });
    handler("apply-imports")(event, "batch");
    expect(request).toHaveBeenLastCalledWith("skills.applyImports", {
      token: "batch",
      confirmed: true,
    });
    handler("discard-preview")(event, "batch");
    expect(request).toHaveBeenLastCalledWith("skills.discardPreview", { token: "batch" });
  });
  it.each(
    [[], ["a", "a"], ["a", null], [""], Array.from({ length: 4097 }, (_, i) => String(i))].map(
      (ids) => [ids],
    ),
  )("rejects invalid observation selections %#", (ids) => {
    expect(() => handler("prepare-imports")(event, ids)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects mixed deployment and import preview identities", () => {
    expect(() =>
      handler("read-preview-file")(event, "preview", "SKILL.md", "target", "item"),
    ).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ["inventory", "skills.inventory"],
    ["targets", "skills.targets"],
    ["list-deployments", "skills.listDeployments"],
  ])("exposes only the fixed %s request", (channel, method) => {
    handler(channel)(event);
    expect(trusted).toHaveBeenCalledWith(event);
    expect(request).toHaveBeenCalledWith(method, {});
  });
  it("reads an observed package by identity and previews by token, without accepting a root path", () => {
    handler("read-detail-file")(event, {
      observation_id: "observation-1",
      path: "references/guide.md",
    });
    expect(request).toHaveBeenLastCalledWith("skills.readDetailFile", {
      observation_id: "observation-1",
      path: "references/guide.md",
    });
    handler("read-preview-file")(event, "preview-1", "SKILL.md", "target-1");
    expect(request).toHaveBeenLastCalledWith("skills.readPreviewFile", {
      token: "preview-1",
      path: "SKILL.md",
      target_id: "target-1",
    });
  });
  it.each([
    { library_id: "library", observation_id: "observation" },
    { library_id: "library", root: "/private" },
    {},
  ])("rejects ambiguous or arbitrary detail roots %j", (input) => {
    expect(() => handler("get-detail")(event, input)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "../secret",
    "/etc/passwd",
    "C:\\secret",
    "scripts/../../secret",
    "scripts\\..\\secret",
    "resources\\guide.md",
    "resources/\0secret",
  ])("rejects escaping file path %s", (path) => {
    expect(() => handler("read-detail-file")(event, { library_id: "library", path })).toThrow(
      TypeError,
    );
    expect(() => handler("read-preview-file")(event, "preview", path)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["darwin", "linux"])("preserves Unix resource names on %s", (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    for (const path of ["C:notes.md", "c:/notes.md", "resources/C:notes.md"]) {
      handler("read-detail-file")(event, { library_id: "library", path });
      expect(request).toHaveBeenLastCalledWith("skills.readDetailFile", {
        library_id: "library",
        path,
      });
      handler("read-preview-file")(event, "preview", path);
      expect(request).toHaveBeenLastCalledWith("skills.readPreviewFile", {
        token: "preview",
        path,
      });
    }
  });
  it.each(["C:notes.md", "c:/notes.md", "C:"])("rejects Windows drive paths %s", (path) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(() => handler("read-detail-file")(event, { library_id: "library", path })).toThrow(
      TypeError,
    );
    expect(() => handler("read-preview-file")(event, "preview", path)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it("forwards capability identities and requires explicit home approval", () => {
    handler("prepare-deployment")(event, {
      operation: "deploy",
      library_id: "library",
      target_ids: ["codex-location", "claude-location"],
    });
    expect(request).toHaveBeenLastCalledWith("skills.prepareDeployment", {
      operation: "deploy",
      library_id: "library",
      target_ids: ["codex-location", "claude-location"],
    });
    handler("apply-deployment")(event, "prepared-token", true);
    expect(request).toHaveBeenLastCalledWith("skills.applyDeployment", {
      token: "prepared-token",
      confirmed: true,
      approve_home: true,
    });
    expect(() => handler("apply-deployment")(event, "prepared-token", undefined)).toThrow(
      TypeError,
    );
  });
  it.each([
    { operation: "deploy", library_id: "library", target_ids: [] },
    { operation: "deploy", library_id: "library", target_ids: ["a", "a"] },
    { operation: "deploy", library_id: "library", target_ids: ["a"], root: "/external" },
    { operation: "disable", deployment_id: "deployment" },
    { operation: "undeploy", deployment_id: "deployment", library_id: "library" },
  ])("rejects unsupported deployment requests %j", (input) => {
    expect(() => handler("prepare-deployment")(event, input)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it("copies external packages through prepare only and withdraws by owned deployment identity", () => {
    handler("prepare-import")(event, "cc-switch-observation");
    expect(request).toHaveBeenLastCalledWith("skills.prepareImport", {
      observation_id: "cc-switch-observation",
    });
    handler("prepare-deployment")(event, {
      operation: "undeploy",
      deployment_id: "owned-deployment",
    });
    expect(request).toHaveBeenLastCalledWith("skills.prepareDeployment", {
      operation: "undeploy",
      deployment_id: "owned-deployment",
    });
  });
  it("rejects untrusted renderer access before a runtime call", () => {
    trusted.mockImplementation(() => {
      throw new Error("Untrusted renderer");
    });
    expect(() => handler("inventory")(event)).toThrow("Untrusted renderer");
    expect(request).not.toHaveBeenCalled();
  });
});
