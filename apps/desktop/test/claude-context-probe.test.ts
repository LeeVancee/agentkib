import { describe, expect, it } from "vitest";
import { claudeSections } from "../../../packages/backend/src/context-claude";
import {
  ancestorDirs,
  isNetworkOrDevicePath,
  isNetworkPath,
  probe,
} from "../../../packages/backend/src/context-claude-sources";
import { virtualIo } from "./fixtures/claude-virtual-io";

// How Claude Code instruction files are classified before anything is read. Memory page: "a
// symlink to a network path (a UNC share, /net or /Network) is not followed"; \\wsl$ is not a
// network path. A workspace that itself lives on a share must keep working, so only paths reached
// through a link are judged, never the location of the workspace.

describe("isNetworkPath", () => {
  it.each([
    ["/net", true],
    ["/net/host/share", true],
    ["/NET/host", true],
    ["/Network/Servers/h", true],
    ["/network", true],
    ["//net/host", true],
    ["/tmp/../net/host", true],
    ["/netx/host", false],
    ["/home/net/x", false],
    ["/mnt/nas/x", false],
    ["/tmp", false],
  ])("posix %s -> %s", (value, expected) => {
    expect(isNetworkPath(value, "linux")).toBe(expected);
    expect(isNetworkPath(value, "darwin")).toBe(expected);
  });

  it.each([
    ["\\\\server\\share\\dir", true],
    ["//server/share/dir", true],
    ["\\\\?\\UNC\\server\\share\\dir", true],
    ["\\\\wsl.localhost\\Ubuntu\\home\\u", true],
    ["\\\\wsl$\\Ubuntu\\home\\u", false],
    ["\\\\WSL$\\Ubuntu", false],
    ["\\\\wsl$", false],
    ["\\\\?\\C:\\dir", false],
    ["\\\\.\\C:", false],
    ["C:\\Users\\u", false],
    ["D:/work", false],
    ["/net/host", false],
  ])("win32 %s -> %s", (value, expected) => {
    expect(isNetworkPath(value, "win32")).toBe(expected);
  });

  it("refuses device namespaces on top of shares for paths taken from untrusted text", () => {
    expect(isNetworkOrDevicePath("\\\\?\\C:\\dir", "win32")).toBe(true);
    expect(isNetworkOrDevicePath("\\\\.\\PhysicalDrive0", "win32")).toBe(true);
    expect(isNetworkOrDevicePath("\\\\server\\share", "win32")).toBe(true);
    expect(isNetworkOrDevicePath("\\\\wsl$\\Ubuntu", "win32")).toBe(false);
    expect(isNetworkOrDevicePath("C:\\dir", "win32")).toBe(false);
    expect(isNetworkOrDevicePath("/net/host", "linux")).toBe(true);
    expect(isNetworkOrDevicePath("/home/u", "linux")).toBe(false);
  });
});

describe("ancestorDirs", () => {
  it("lists the directories above the root from the farthest, without the file system root", () => {
    expect(ancestorDirs("/a/b/c", "linux")).toEqual({ dirs: ["/a", "/a/b"], limited: false });
    expect(ancestorDirs("/a", "linux")).toEqual({ dirs: [], limited: false });
    expect(ancestorDirs("/", "linux")).toEqual({ dirs: [], limited: false });
    expect(ancestorDirs("C:\\a\\b", "win32")).toEqual({ dirs: ["C:\\a"], limited: false });
    expect(ancestorDirs("\\\\server\\share\\a\\b", "win32")).toEqual({
      dirs: ["\\\\server\\share\\a"],
      limited: false,
    });
  });

  it("keeps the nearest 32 and says that it cut", () => {
    const deep = `/${Array.from({ length: 40 }, (_, index) => `d${index}`).join("/")}`;
    const { dirs, limited } = ancestorDirs(deep, "linux");
    expect(limited).toBe(true);
    expect(dirs).toHaveLength(32);
    expect(dirs.at(-1)).toBe(deep.slice(0, deep.lastIndexOf("/")));
    expect(dirs[0]).toBe(`/${Array.from({ length: 8 }, (_, index) => `d${index}`).join("/")}`);
  });
});

describe("probe", () => {
  const context = (
    io: ReturnType<typeof virtualIo>["io"],
    platform: NodeJS.Platform = "linux",
  ) => ({
    io,
    platform,
  });

  it("classifies files, directories and absent paths", () => {
    const fs = virtualIo({ "/w/CLAUDE.md": "hello", "/w/.claude/rules/a.md": "x" });
    expect(probe("/w/CLAUDE.md", "/w", context(fs.io))).toMatchObject({
      kind: "file",
      real: "/w/CLAUDE.md",
      size: 5,
      linked: false,
    });
    expect(probe("/w/.claude/rules", "/w", context(fs.io))).toMatchObject({ kind: "dir" });
    expect(probe("/w/nope.md", "/w", context(fs.io))).toEqual({ kind: "missing" });
    // A file where a directory is expected is the same as absent.
    expect(probe("/w/CLAUDE.md/inner", "/w", context(fs.io))).toEqual({ kind: "missing" });
  });

  it("follows a link inside the workspace and reports where it led", () => {
    const fs = virtualIo({ "/w/real.md": "x", "/w/CLAUDE.md": { link: "real.md" } });
    expect(probe("/w/CLAUDE.md", "/w", context(fs.io))).toMatchObject({
      kind: "file",
      real: "/w/real.md",
      linked: true,
      link: "/w/CLAUDE.md",
    });
  });

  it("stops after eight links", () => {
    const nodes: Record<string, { link: string } | string> = { "/w/end.md": "x" };
    for (let hop = 1; hop <= 9; hop++)
      nodes[`/w/l${hop}.md`] = { link: hop === 9 ? "end.md" : `l${hop + 1}.md` };
    const fs = virtualIo(nodes);
    expect(probe("/w/l9.md", "/w", context(fs.io)).kind).toBe("file");
    expect(probe("/w/l1.md", "/w", context(fs.io)).kind).toBe("unreadable");
  });

  describe("a link to a network path", () => {
    it("does not touch anything below /net after the link", () => {
      const fs = virtualIo({
        "/w/CLAUDE.md": { link: "/net/h2/shared/CLAUDE.md" },
        "/net/h2/shared/CLAUDE.md": "NETWORK-BODY",
      });
      expect(probe("/w/CLAUDE.md", "/w", context(fs.io))).toEqual({ kind: "network" });
      expect(fs.below("/net")).toEqual([]);
      expect(fs.calls.map((entry) => entry.call)).toEqual(["lstat", "readlink"]);
    });

    it.each([
      ["a text with ..", "/tmp/../net/h/x"],
      ["a relative text", "../../../net/h/x"],
    ])("sees through %s", (_name, text) => {
      const fs = virtualIo({
        "/a/b/w/CLAUDE.md": { link: text },
        "/net/h/x": "NETWORK-BODY",
        "/tmp": { dir: true },
      });
      expect(probe("/a/b/w/CLAUDE.md", "/a/b/w", context(fs.io))).toEqual({ kind: "network" });
      expect(fs.below("/net")).toEqual([]);
    });

    it("stops at the second link of a chain", () => {
      const fs = virtualIo({
        "/w/A.md": { link: "/srv/B.md" },
        "/srv/B.md": { link: "/net/x/C.md" },
        "/net/x/C.md": "NETWORK-BODY",
      });
      expect(probe("/w/A.md", "/w", context(fs.io))).toEqual({ kind: "network" });
      expect(fs.below("/net")).toEqual([]);
      // The second link was read, never followed: no realpath, no listing, no file read.
      expect(fs.below("/srv").map((entry) => `${entry.call} ${entry.path}`)).toEqual([
        "lstat /srv",
        "lstat /srv/B.md",
        "readlink /srv/B.md",
      ]);
      expect(
        fs.calls.some((entry) => ["realpath", "readdir", "readFile"].includes(entry.call)),
      ).toBe(false);
    });

    it("judges a folder that is a link, not only the file at the end", () => {
      const fs = virtualIo({
        "/w/.claude": { link: "/net/x" },
        "/net/x/CLAUDE.md": "NETWORK-BODY",
        "/net/x/rules/r.md": "NETWORK-BODY",
      });
      expect(probe("/w/.claude/CLAUDE.md", "/w", context(fs.io))).toEqual({ kind: "network" });
      expect(probe("/w/.claude/rules", "/w", context(fs.io))).toEqual({ kind: "network" });
      // Only the link itself was looked at, twice over.
      expect(new Set(fs.calls.map((entry) => entry.path))).toEqual(new Set(["/w/.claude"]));
      expect(fs.below("/net")).toEqual([]);
    });

    it("follows a Windows link into the local Linux file system but not into a share", () => {
      const nodes = {
        "C:\\w\\wsl.md": { link: "\\\\wsl$\\Ubuntu\\home\\u\\x.md" },
        "\\\\wsl$\\Ubuntu\\home\\u\\x.md": "LOCAL",
        "C:\\w\\share.md": { link: "\\\\server\\share\\x.md" },
        "\\\\server\\share\\x.md": "NETWORK-BODY",
        "C:\\w\\localhost.md": { link: "\\\\wsl.localhost\\Ubuntu\\x.md" },
      };
      const fs = virtualIo(nodes, "win32");
      const win = context(fs.io, "win32");
      expect(probe("C:\\w\\wsl.md", "C:\\w", win)).toMatchObject({ kind: "file", linked: true });
      expect(probe("C:\\w\\share.md", "C:\\w", win)).toEqual({ kind: "network" });
      expect(probe("C:\\w\\localhost.md", "C:\\w", win)).toEqual({ kind: "network" });
      expect(fs.below("\\\\server\\share")).toEqual([]);
      expect(fs.below("\\\\wsl.localhost")).toEqual([]);
    });
  });

  describe("a workspace that itself lives on a network path", () => {
    // The check applies to what a link leads to. Where the workspace is does not matter: Round 1
    // read these files and still has to.
    it.each([
      ["posix /net/h/ws", "linux", "/net/h/ws", "/home/u"],
      ["a share", "win32", "\\\\server\\share\\ws", "C:\\Users\\u"],
      ["WSL localhost", "win32", "\\\\wsl.localhost\\Ubuntu\\home\\u\\ws", "C:\\Users\\u"],
    ] as const)(
      "%s keeps its own CLAUDE.md and rules readable",
      async (_name, platform, root, home) => {
        const sep = platform === "win32" ? "\\" : "/";
        const at = (...parts: string[]) => [root, ...parts].join(sep);
        const fs = virtualIo(
          {
            [at("CLAUDE.md")]: "workspace claude\n",
            [at(".claude", "rules", "x.md")]: "workspace rule\n",
          },
          platform === "win32" ? "win32" : "posix",
        );
        const warnings: string[] = [];
        const sections = await claudeSections({
          root,
          cwd: root,
          dirs: [root],
          environment: { HOME: home, USERPROFILE: home },
          budget: { remaining: 100_000 },
          warnings,
          externalBodies: true,
          version: async () => null,
          managedDir: null,
          platform,
          io: fs.io,
        });
        expect(sections.map((section) => section.content)).toEqual([
          "workspace claude\n",
          "workspace rule\n",
        ]);
        expect(sections.map((section) => section.scope)).toEqual([
          "",
          platform === "win32" ? ".claude\\rules" : ".claude/rules",
        ]);
        expect(warnings.filter((warning) => !warning.startsWith("Note: "))).toEqual([]);
        expect(warnings.some((warning) => warning.includes("network path"))).toBe(false);
      },
    );

    const run = (fs: ReturnType<typeof virtualIo>, root: string, outside?: "metadata" | "none") => {
      const warnings: string[] = [];
      return claudeSections({
        root,
        cwd: root,
        dirs: [root],
        environment: { HOME: "/home/u" },
        budget: { remaining: 100_000 },
        warnings,
        externalBodies: true,
        ...(outside ? { outside } : {}),
        version: async () => "2.1.296 (Claude Code)",
        managedDir: null,
        platform: "linux",
        io: fs.io,
      }).then((sections) => ({ sections, warnings }));
    };

    it("does not count a network link as a CLAUDE.md, so AGENTS.md is still read", async () => {
      const fs = virtualIo({
        "/w/CLAUDE.md": { link: "/net/h2/CLAUDE.md" },
        "/w/AGENTS.md": "agents\n",
        "/net/h2/CLAUDE.md": "NETWORK-BODY",
      });
      const { sections, warnings } = await run(fs, "/w");
      expect(sections.map((section) => section.content)).toEqual(["agents\n"]);
      expect(warnings).toContain("Note: Instruction source skipped (network path): /w/CLAUDE.md");
      expect(fs.below("/net/h2")).toEqual([]);
    });

    it("does not follow a .claude folder that links to a share, and does not count it either", async () => {
      const fs = virtualIo({
        "/w/.claude": { link: "/net/x" },
        "/w/AGENTS.md": "agents\n",
        "/net/x/CLAUDE.md": "NETWORK-BODY",
        "/net/x/rules/r.md": "NETWORK-BODY",
      });
      for (const mode of [undefined, "metadata", "none"] as const) {
        const { sections, warnings } = await run(fs, "/w", mode);
        expect(sections.map((section) => section.content)).toEqual(["agents\n"]);
        expect(JSON.stringify(warnings)).not.toContain("NETWORK-BODY");
      }
      // Only the link itself was ever looked at below /w/.claude, and nothing below the share.
      expect(fs.below("/net")).toEqual([]);
      expect(new Set(fs.below("/w/.claude").map((entry) => entry.path))).toEqual(
        new Set(["/w/.claude"]),
      );
    });

    it("does not list a rules folder that links to a share", async () => {
      const fs = virtualIo({
        "/w/CLAUDE.md": "main\n",
        "/w/.claude/rules/shared": { link: "/net/h/x" },
        "/w/.claude/rules/own.md": "own rule\n",
        "/net/h/x/theirs.md": "NETWORK-BODY",
      });
      const { sections, warnings } = await run(fs, "/w");
      expect(sections.map((section) => section.content)).toEqual(["main\n", "own rule\n"]);
      expect(warnings).toContain(
        "Note: Instruction source skipped (network path): /w/.claude/rules",
      );
      expect(fs.below("/net")).toEqual([]);
    });

    it("still refuses a link inside such a workspace that leads to another share", async () => {
      const root = "/net/h/ws";
      const fs = virtualIo({
        "/net/h/ws/CLAUDE.md": { link: "/net/h2/other/CLAUDE.md" },
        "/net/h2/other/CLAUDE.md": "NETWORK-BODY",
      });
      const warnings: string[] = [];
      const sections = await claudeSections({
        root,
        cwd: root,
        dirs: [root],
        environment: { HOME: "/home/u" },
        budget: { remaining: 100_000 },
        warnings,
        externalBodies: true,
        version: async () => null,
        managedDir: null,
        platform: "linux",
        io: fs.io,
      });
      expect(sections).toEqual([]);
      expect(warnings).toContain(
        "Note: Instruction source skipped (network path): /net/h/ws/CLAUDE.md",
      );
      expect(fs.below("/net/h2")).toEqual([]);
    });
  });
});
