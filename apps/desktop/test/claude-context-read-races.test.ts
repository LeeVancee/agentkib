import {
  existsSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultIo } from "../../../packages/backend/src/context-claude-sources";
import { Doctor } from "../../../packages/backend/src/doctor";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync) };
});

const native = await vi.importActual<typeof import("node:fs")>("node:fs");
const fixtures: ContextFixture[] = [];
const links = process.platform === "win32" ? it.skip : it;
function fixture(...args: Parameters<typeof contextFixture>) {
  const value = contextFixture(...args);
  fixtures.push(value);
  return value;
}
beforeEach(() => {
  vi.mocked(openSync).mockImplementation(native.openSync);
  vi.mocked(readSync).mockImplementation(native.readSync);
});
afterEach(() => {
  vi.mocked(openSync).mockReset();
  vi.mocked(readSync).mockReset();
  for (const f of fixtures.splice(0)) f.dispose();
});

describe("instruction reads keep the identity checked before opening", () => {
  it("keeps ordinary case-insensitive Claude filenames readable", async ({ skip }) => {
    const f = fixture();
    f.write("claude.md", "local instructions\n");
    if (!existsSync(f.at("CLAUDE.md"))) skip();
    expect(
      (await f.resolve(f.project, { includeOutsideSources: false })).sections.map(
        (section) => section.content,
      ),
    ).toEqual(["local instructions\n"]);
  });
  describe.each(["opencode", "deepseek-harness"] as const)("%s", (agent) => {
    links.each(["file", "parent", "temporary-parent"] as const)(
      "does not expose personal MCP content after replacing the %s at open",
      async (replacement) => {
        const f = fixture();
        const personal = f.user("AGENTS.md", "PRIVATE-RACE-CANARY\n");
        const home = agent === "opencode" ? f.inHome(".config", "opencode") : f.inHome(".dsh");
        const candidate = f.write(path.join(home, "AGENTS.md"), "own\n");
        f.write("AGENTS.md", "project\n");
        let changed = false;
        vi.mocked(openSync).mockImplementation((file, flags, mode) => {
          if (String(file) !== candidate || changed) return native.openSync(file, flags, mode);
          changed = true;
          if (replacement === "file") {
            rmSync(candidate);
            symlinkSync(personal, candidate);
            return native.openSync(file, flags, mode);
          }
          const folder = path.dirname(candidate);
          renameSync(folder, `${folder}-saved`);
          symlinkSync(path.dirname(personal), folder);
          try {
            return native.openSync(file, flags, mode);
          } finally {
            if (replacement === "temporary-parent") {
              rmSync(folder);
              renameSync(`${folder}-saved`, folder);
            }
          }
        });
        const result = await f.mcp(f.project, agent);
        expect(changed).toBe(true);
        expect(JSON.stringify(result)).not.toContain("PRIVATE-RACE-CANARY");
        expect(result.sections.map((section) => section.content)).toEqual(["project\n"]);
      },
    );
  });

  links.each(["file", "parent"] as const)(
    "does not let a %s swapped before Claude IO satisfy the Doctor",
    async (replacement) => {
      let candidate = "";
      let outside = "";
      let changed = false;
      const f = fixture({
        io: {
          ...defaultIo,
          readFile(file, limit) {
            if (file === candidate && !changed) {
              changed = true;
              const location = replacement === "file" ? candidate : path.dirname(candidate);
              renameSync(location, `${location}-saved`);
              symlinkSync(replacement === "file" ? outside : path.dirname(outside), location);
            }
            return defaultIo.readFile(file, limit);
          },
        },
      });
      f.write(
        ".agentkib/manifest.yaml",
        "schema_version: 2\nworkspace:\n  id: fixture\n  name: Fixture\ninstructions:\n  shared: |\n    Use tabs for indentation.\n",
      );
      f.write("CLAUDE.md", "Project rules\n@docs/inside.md\n");
      candidate = f.write("docs/inside.md", "local instructions\n");
      outside = f.write(f.outside("external", "inside.md"), "Use tabs for indentation.\n");
      const report = await new Doctor(f.context, () => f.project).report("fixture");
      expect(changed).toBe(true);
      expect(
        report.issues.filter((issue) => issue.agent === "claude-code").map((issue) => issue.code),
      ).toContain("instruction.expected-content-missing");
    },
  );

  it("discards a context file changed while its descriptor is being read", async () => {
    const f = fixture();
    const candidate = f.write("AGENTS.md", "own instructions\n");
    let descriptor: number | null = null;
    let changed = false;
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      const fd = native.openSync(file, flags, mode);
      if (String(file) === candidate) descriptor = fd;
      return fd;
    });
    vi.mocked(readSync).mockImplementation(((fd, ...args) => {
      if (fd === descriptor && !changed) {
        changed = true;
        writeFileSync(candidate, "CHANGED-RACE-CANARY\n");
      }
      return Reflect.apply(native.readSync, undefined, [fd, ...args]);
    }) as typeof readSync);
    const result = await f.mcp(f.project, "opencode");
    expect(changed).toBe(true);
    expect(result.sections).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("CHANGED-RACE-CANARY");
  });
});

describe("configuration reads keep the same personal-source boundary", () => {
  links.each([
    "opencode-global",
    "opencode-project",
    "grok",
    "antigravity-manifest",
    "antigravity-overrides",
    "deepseek-profile",
  ] as const)(
    "does not read personal configuration through a swapped %s directory",
    async (kind) => {
      const f = fixture();
      f.write("AGENTS.md", "project\n");
      let agent = "opencode";
      let candidate: string;
      let personal: string;
      if (kind.startsWith("opencode")) {
        candidate = f.write(
          kind === "opencode-global"
            ? f.inHome(".config", "opencode", "opencode.json")
            : f.at(".opencode", "opencode.json"),
          JSON.stringify({ instructions: [] }),
        );
        personal = f.user(
          "opencode.json",
          JSON.stringify({ instructions: ["/PRIVATE-CONFIG-CANARY"] }),
        );
      } else if (kind === "grok") {
        agent = "grok-build";
        candidate = f.write(f.inHome(".grok", "config.toml"), "[compat.claude]\nagents=true\n");
        personal = f.user(
          "config.toml",
          "# PRIVATE-CONFIG-CANARY\n[compat.claude]\nagents=false\n",
        );
      } else if (kind === "antigravity-manifest") {
        agent = "antigravity";
        candidate = f.write(
          f.inHome(".gemini", "config", "plugins", "safe", "plugin.json"),
          JSON.stringify({ name: "safe" }),
        );
        personal = f.user(
          "plugin.json",
          JSON.stringify({ name: "private", description: "PRIVATE-CONFIG-CANARY" }),
        );
      } else if (kind === "antigravity-overrides") {
        agent = "antigravity";
        f.write(
          f.inHome(".gemini", "antigravity-cli", "plugins", "staged", "plugin.json"),
          JSON.stringify({ name: "staged" }),
        );
        candidate = f.write(
          f.inHome(".gemini", "config", "config.json"),
          JSON.stringify({ plugins: {} }),
        );
        personal = f.user(
          "config.json",
          JSON.stringify({ plugins: { "PRIVATE-CONFIG-CANARY": { enabled: true } } }),
        );
      } else {
        agent = "deepseek-harness";
        candidate = f.write(
          f.inHome(".dsh", "profiles", "active", "cordis.patch.yml"),
          "unrelated: value\n",
        );
        personal = f.user("cordis.patch.yml", "agent-instructions: PRIVATE-CONFIG-CANARY\n");
      }
      let changed = false;
      let descriptor: number | null = null;
      let contents = "";
      vi.mocked(openSync).mockImplementation((file, flags, mode) => {
        if (String(file) !== candidate || changed) return native.openSync(file, flags, mode);
        changed = true;
        const folder = path.dirname(candidate);
        renameSync(folder, `${folder}-saved`);
        symlinkSync(path.dirname(personal), folder);
        try {
          return (descriptor = native.openSync(file, flags, mode));
        } finally {
          rmSync(folder);
          renameSync(`${folder}-saved`, folder);
        }
      });
      vi.mocked(readSync).mockImplementation(((fd: number, ...args: unknown[]) => {
        const size = Reflect.apply(native.readSync, undefined, [fd, ...args]) as number;
        if (fd === descriptor && Buffer.isBuffer(args[0])) {
          const offset = typeof args[1] === "number" ? args[1] : 0;
          contents += args[0].subarray(offset, offset + size).toString("utf8");
        }
        return size;
      }) as typeof readSync);
      const result = await f.mcp(f.project, agent);
      expect(changed).toBe(true);
      expect(contents).not.toContain("PRIVATE-CONFIG-CANARY");
      expect(JSON.stringify(result)).not.toContain("PRIVATE-CONFIG-CANARY");
    },
  );
});
