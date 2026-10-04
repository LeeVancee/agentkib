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
