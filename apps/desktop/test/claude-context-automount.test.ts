import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeSections } from "../../../packages/backend/src/context-claude";
import {
  ancestorDirs,
  isAutomountRoot,
} from "../../../packages/backend/src/context-claude-sources";
import { virtualIo } from "./fixtures/claude-virtual-io";

// A workspace on a network share is found under /net or /Network. Looking for a file directly
// inside those folders (/net/CLAUDE.md, /net/.git) can make an automounter try the file name as a
// host name, so the search for instruction files and for the repository root steps over them.

describe("the automount roots", () => {
  it("are exactly /net and /Network, in any case and with a trailing slash", () => {
    for (const value of ["/net", "/Network", "/NET/", "/network"])
      expect(isAutomountRoot(value, "linux")).toBe(true);
    for (const value of ["/net/host", "/networks", "/home/net", "/", "/mnt/net"])
      expect(isAutomountRoot(value, "linux")).toBe(false);
    expect(isAutomountRoot("/net", "win32")).toBe(false);
  });

  it("are left out of the parent directories of a workspace, the hosts below them are not", () => {
    expect(ancestorDirs("/net/host/share/project", "linux").dirs).toEqual([
      "/net/host",
      "/net/host/share",
    ]);
    expect(ancestorDirs("/Network/Servers/project", "darwin").dirs).toEqual(["/Network/Servers"]);
    expect(ancestorDirs("/srv/net/project", "linux").dirs).toEqual(["/srv", "/srv/net"]);
  });
});

describe("a workspace on a network share", () => {
  const root = "/net/host/share/project";
  const run = async () => {
    const fake = virtualIo({
      [`${root}/CLAUDE.md`]: "project\n",
      "/net/host/CLAUDE.md": "host level\n",
      "/net/CLAUDE.md": "NET-CANARY\n",
      "/net/.git": { dir: true },
    });
    const sections = await claudeSections({
      root,
      cwd: root,
      dirs: [root],
      environment: { HOME: "/home/u" },
      budget: { remaining: 100000 },
      warnings: [],
      externalBodies: true,
      version: async () => null,
      managedDir: null,
      platform: "linux",
      io: fake.io,
    });
    return { fake, sections };
  };

  it("never looks at a file directly inside /net", async () => {
    const { fake, sections } = await run();
    const inside = fake.calls.filter(
      (call) => path.posix.dirname(call.path) === "/net" && call.path !== "/net/host",
    );
    expect(inside).toEqual([]);
    expect(JSON.stringify(sections)).not.toContain("NET-CANARY");
  });

  it("still reads the instruction files of the hosts and folders below /net", async () => {
    const { fake, sections } = await run();
    expect(fake.calls.some((call) => call.path === "/net/host/CLAUDE.md")).toBe(true);
    expect(sections.map((section) => section.content)).toEqual(["host level\n", "project\n"]);
  });
});
