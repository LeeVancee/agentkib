import { beforeEach, describe, expect, it, vi } from "vitest";
import { claudeSections } from "../../../packages/backend/src/context-claude";
import type { OutsideMode } from "../../../packages/backend/src/context-claude-sources";
import { virtualIo } from "./fixtures/claude-virtual-io";

const { hostFileChecks } = vi.hoisted(() => ({ hostFileChecks: vi.fn(() => false) }));
vi.mock("../../../packages/backend/src/files", async (original) => ({
  ...(await original<typeof import("../../../packages/backend/src/files")>()),
  // A regression must never contact the real automounter while this test records unsafe calls.
  isFile: hostFileChecks,
}));

beforeEach(() => hostFileChecks.mockClear());

async function preview(
  fake: ReturnType<typeof virtualIo>,
  outside: OutsideMode,
  root = "/w",
  platform: NodeJS.Platform = "linux",
) {
  const warnings: string[] = [];
  const sections = await claudeSections({
    root,
    cwd: root,
    dirs: [root],
    environment: { HOME: platform === "win32" ? "C:\\Users\\u" : "/home/u" },
    budget: { remaining: 100000 },
    warnings,
    externalBodies: true,
    outside,
    version: async () => null,
    managedDir: null,
    platform,
    io: fake.io,
  });
  return { content: sections.map((section) => section.content), warnings };
}

describe("safe import discovery", () => {
  it.each(["linux", "win32"] as const)(
    "does not add the expanded home to metadata diagnostics on %s",
    async (platform) => {
      const windows = platform === "win32";
      const root = windows ? "C:\\w" : "/w";
      const home = windows ? "C:\\Users\\u" : "/home/u";
      const join = (...parts: string[]) => parts.join(windows ? "\\" : "/");
      const sensitive = windows ? "~\\.ssh\\id_ed25519" : "~/.ssh/id_ed25519";
      const body = `@~/private-notes/missing.md\n@${sensitive}\n@~/notes.md\n`;
      const fake = virtualIo(
        {
          [join(root, "CLAUDE.md")]: body,
          [join(home, ".ssh", "id_ed25519")]: "SENSITIVE-CANARY\n",
          [join(home, "notes.md")]: "EXTERNAL-CANARY\n",
        },
        windows ? "win32" : "posix",
      );
      const result = await preview(fake, "metadata", root, platform);
      expect(result.content).toEqual([body]);
      expect(JSON.stringify(result)).not.toContain(home.replaceAll("\\", "\\\\"));
      expect(JSON.stringify(result)).not.toContain("CANARY");
      expect(result.warnings).toEqual([
        "Note: External instruction sources exist (1 file, 16 bytes, 2 skipped); its content is not included in this result.",
      ]);
      expect(
        fake.calls.filter((call) => call.call === "readFile").map((call) => call.path),
      ).toEqual([join(root, "CLAUDE.md")]);
    },
  );

  it.each(["full", "metadata", "none"] as const)(
    "refuses Windows UNC and device imports without touching them in %s mode",
    async (outside) => {
      const targets = [
        "\\\\server\\share\\direct.md",
        "\\\\?\\UNC\\server\\share\\direct.md",
        "\\\\?\\C:\\private\\direct.md",
        "\\\\.\\PhysicalDrive0",
      ];
      const body = `${targets.map((target) => `@${target}`).join("\n")}\n@linked.md\n@folder/nested.md\n`;
      const fake = virtualIo(
        {
          "C:\\w\\CLAUDE.md": body,
          "C:\\w\\linked.md": { link: "\\\\server\\share\\linked.md" },
          "C:\\w\\folder": { link: "\\\\server\\share\\folder" },
          "\\\\server\\share\\linked.md": "NETWORK-BODY\n",
          "\\\\server\\share\\folder\\nested.md": "NETWORK-BODY\n",
        },
        "win32",
      );
      const result = await preview(fake, outside, "C:\\w", "win32");
      expect(hostFileChecks).not.toHaveBeenCalled();
      expect(fake.calls.filter((call) => call.path.startsWith("\\\\"))).toEqual([]);
      expect(
        fake.calls.filter((call) => call.call === "readlink").map((call) => call.path),
      ).toEqual(["C:\\w\\linked.md", "C:\\w\\folder"]);
      expect(result.content).toEqual([body]);
      expect(
        result.warnings.filter((warning) => warning.includes("skipped (network path)")),
      ).toHaveLength(outside === "metadata" ? 0 : 6);
      if (outside === "metadata")
        expect(result.warnings).toEqual([
          "Note: External instruction sources exist (0 files, 0 bytes, 6 skipped); its content is not included in this result.",
        ]);
    },
  );

  it.each(["full", "metadata", "none"] as const)(
    "reads Windows local linked imports in %s mode",
    async (outside) => {
      const fake = virtualIo(
        {
          "C:\\w\\CLAUDE.md": "@linked.md\n",
          "C:\\w\\linked.md": { link: "docs\\real.md" },
          "C:\\w\\docs\\real.md": "local\n@nested.md\n",
          "C:\\w\\docs\\nested.md": "nested\n",
        },
        "win32",
      );
      const result = await preview(fake, outside, "C:\\w", "win32");
      expect(result.content).toEqual(["local\nnested\n\n\n"]);
      expect(result.warnings).toEqual([]);
      expect(hostFileChecks).not.toHaveBeenCalled();
      expect(
        fake.calls.filter((call) => call.call === "readFile").map((call) => call.path),
      ).toEqual(["C:\\w\\CLAUDE.md", "C:\\w\\docs\\real.md", "C:\\w\\docs\\nested.md"]);
    },
  );

  it.each(["full", "metadata", "none"] as const)(
    "does not touch network imports before the %s policy is applied",
    async (outside) => {
      const body =
        "@/net/remote/direct.md\n@/Network/remote/direct.md\n@linked.md\n@folder/nested.md\n";
      const fake = virtualIo({
        "/w/CLAUDE.md": body,
        "/w/linked.md": { link: "/net/remote/linked.md" },
        "/w/folder": { link: "/Network/remote" },
        "/net/remote/direct.md": "NETWORK-BODY\n",
        "/net/remote/linked.md": "NETWORK-BODY\n",
        "/Network/remote/direct.md": "NETWORK-BODY\n",
        "/Network/remote/nested.md": "NETWORK-BODY\n",
      });
      const result = await preview(fake, outside);
      expect(hostFileChecks).not.toHaveBeenCalled();
      expect(fake.below("/net")).toEqual([]);
      expect(fake.below("/Network")).toEqual([]);
      expect(
        fake.calls.filter((call) => call.call === "readlink").map((call) => call.path),
      ).toEqual(["/w/linked.md", "/w/folder"]);
      expect(result.content).toEqual([body]);
      expect(
        result.warnings.filter((warning) => warning.includes("skipped (network path)")),
      ).toHaveLength(outside === "metadata" ? 0 : 4);
      if (outside === "metadata")
        expect(result.warnings).toEqual([
          "Note: External instruction sources exist (0 files, 0 bytes, 4 skipped); its content is not included in this result.",
        ]);
    },
  );

  it.each(["/", "/net", "/Network"])(
    "does not treat the broad workspace root %s as an existing network share",
    async (root) => {
      const target = root === "/Network" ? "/Network/remote/private.md" : "/net/remote/private.md";
      const file = root === "/" ? "/CLAUDE.md" : `${root}/CLAUDE.md`;
      const fake = virtualIo({
        [file]: `@${target}\n`,
        [target]: "NETWORK-BODY\n",
      });
      const result = await preview(fake, "none", root);
      expect(result.content).toEqual([`@${target}\n`]);
      expect(fake.below(target)).toEqual([]);
      expect(
        fake.calls.some((call) => call.path === target.slice(0, target.lastIndexOf("/"))),
      ).toBe(false);
      expect(result.warnings).toEqual([
        `Instruction import skipped (network path): ${target} (source: ${file})`,
      ]);
    },
  );

  it.each(["full", "metadata", "none"] as const)(
    "keeps local linked imports and missing-file behavior in %s mode",
    async (outside) => {
      const fake = virtualIo({
        "/w/CLAUDE.md": "@linked.md\n@missing.md\nSee @also-missing.md\n",
        "/w/linked.md": { link: "docs/real.md" },
        "/w/docs/real.md": "local\n@nested.md\n",
        "/w/docs/nested.md": "nested\n",
      });
      const result = await preview(fake, outside);
      expect(result.content).toEqual(["local\nnested\n\n\n@missing.md\nSee @also-missing.md\n"]);
      expect(result.warnings).toEqual([
        "Imported file is missing: /w/missing.md (source: /w/CLAUDE.md)",
      ]);
      expect(hostFileChecks).not.toHaveBeenCalled();
      expect(
        fake.calls.filter((call) => call.call === "readFile").map((call) => call.path),
      ).toEqual(["/w/CLAUDE.md", "/w/docs/real.md", "/w/docs/nested.md"]);
    },
  );

  it("detects a circular import through a local link", async () => {
    const fake = virtualIo({
      "/w/CLAUDE.md": "@docs/a.md\n",
      "/w/docs/a.md": "a\n@../again.md\n",
      "/w/again.md": { link: "docs/a.md" },
    });
    const result = await preview(fake, "full");
    expect(result.content).toEqual(["a\n@../again.md\n\n"]);
    expect(result.warnings).toEqual([
      "Instruction import skipped (circular reference): /w/again.md (source: /w/docs/a.md)",
    ]);
  });

  it("uses the real path spelling for scope and circular imports on a case-insensitive disk", async () => {
    const fake = virtualIo({
      "/w/CLAUDE.md": "@../W/docs/a.md\n",
      "/W/docs/a.md": "a\n@A.md\n",
      "/w/docs/a.md": "a\n@A.md\n",
      "/w/docs/A.md": "a\n@A.md\n",
    });
    const realpath = fake.io.realpath;
    fake.io.realpath = (file) =>
      realpath(file)
        .replace(/^\/W\//, "/w/")
        .replace(/\/A\.md$/, "/a.md");
    const result = await preview(fake, "metadata");
    expect(result.content).toEqual(["a\n@A.md\n\n"]);
    expect(result.warnings).toEqual([
      "Instruction import skipped (circular reference): /w/docs/A.md (source: /w/docs/a.md)",
    ]);
  });

  it("keeps the containing file when an import cannot be examined", async () => {
    const fake = virtualIo({ "/w/CLAUDE.md": "before\n@locked/a.md\nafter\n" });
    const lstat = fake.io.lstat;
    fake.io.lstat = (file) => {
      if (file === "/w/locked") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return lstat(file);
    };
    const result = await preview(fake, "full");
    expect(result.content).toEqual(["before\n@locked/a.md\nafter\n"]);
    expect(result.warnings).toEqual([
      "Instruction import could not be read: /w/locked/a.md (source: /w/CLAUDE.md)",
    ]);
    expect(fake.calls.some((call) => call.path === "/w/locked/a.md")).toBe(false);
  });

  it("stops at a network link outside the workspace", async () => {
    const fake = virtualIo({
      "/w/CLAUDE.md": "@/srv/shared/a.md\n",
      "/srv/shared": { link: "../bridge" },
      "/bridge": { link: "/net/remote" },
      "/net/remote/a.md": "NETWORK-BODY\n",
    });
    const result = await preview(fake, "full");
    expect(fake.below("/net")).toEqual([]);
    expect(result.warnings).toEqual([
      "Instruction import skipped (network path): /srv/shared/a.md (source: /w/CLAUDE.md)",
    ]);
  });

  it.each(["full", "metadata", "none"] as const)(
    "keeps imports inside an existing network workspace readable in %s mode",
    async (outside) => {
      const root = "/net/host/share/project";
      const fake = virtualIo({
        [`${root}/CLAUDE.md`]: "@docs/a.md\n@/net/other-host/a.md\n",
        [`${root}/docs/a.md`]: "workspace import\n",
        "/net/other-host/a.md": "NETWORK-BODY\n",
      });
      const result = await preview(fake, outside, root);
      expect(result.content).toEqual(["workspace import\n\n@/net/other-host/a.md\n"]);
      expect(fake.below("/net/other-host")).toEqual([]);
      expect(result.warnings).toContain(
        outside === "metadata"
          ? "Note: External instruction sources exist (0 files, 0 bytes, 1 skipped); its content is not included in this result."
          : `Instruction import skipped (network path): /net/other-host/a.md (source: ${root}/CLAUDE.md)`,
      );
    },
  );
});
