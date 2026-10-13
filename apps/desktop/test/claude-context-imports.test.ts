import { chmodSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

// @import rules of CLAUDE.md, as documented at https://code.claude.com/docs/en/memory:
// relative paths resolve against the file that contains the import, imports nest up to four
// hops, `~/` and absolute paths are allowed, and code spans and code blocks are skipped.
const fixtures: ContextFixture[] = [];
function fixture() {
  const created = contextFixture();
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
/** Resolve the project's single top-level CLAUDE.md and return what the preview shows. */
async function preview(f: ContextFixture) {
  const result = await f.resolve();
  return { content: result.sections.map((section) => section.content), warnings: result.warnings };
}
const missing = (f: ContextFixture, file: string, source = "CLAUDE.md") =>
  `Imported file is missing: ${f.at(file)} (source: ${f.at(source)})`;

describe("where an import is resolved", () => {
  it("resolves a relative path against the file that contains the import", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "root\n@docs/a.md\nend\n");
    f.write("docs/a.md", "a top\n@b.md\n");
    f.write("docs/b.md", "b in docs\n");
    f.write("b.md", "b at the root\n");
    const result = await preview(f);
    expect(result.content).toEqual(["root\na top\nb in docs\n\n\nend\n"]);
    expect(result.warnings).toEqual([]);
  });

  it("accepts an absolute path", async () => {
    const f = fixture();
    f.write("docs/a.md", "alpha\n");
    f.write("CLAUDE.md", `@${f.at("docs", "a.md")}\n`);
    expect((await preview(f)).content).toEqual(["alpha\n\n"]);
  });

  it("expands ~/ to the home directory instead of reporting the file as missing", async () => {
    const f = fixture();
    f.write(f.inHome("notes", "personal.md"), "personal notes\n");
    f.write("CLAUDE.md", "@~/notes/personal.md\n");
    const result = await preview(f);
    expect(result.content).toEqual(["personal notes\n\n"]);
    // Outside the working directory, so Claude Code would ask for approval first.
    expect(result.warnings).toEqual([
      `Note: External import (outside the working directory): ~/notes/personal.md (source: ${f.at("CLAUDE.md")}). Claude Code asks for approval before loading external imports, so this content may not be in effect.`,
    ]);
  });

  it("resolves an inline ~/ mention when the file exists", async () => {
    const f = fixture();
    f.write(f.inHome("snippet.md"), "snippet\n");
    f.write("CLAUDE.md", "also see @~/snippet.md here\n");
    expect((await preview(f)).content).toEqual(["also see @~/snippet.md here\nsnippet\n"]);
  });
});

describe("how deep imports nest", () => {
  const chain = (f: ContextFixture, hops: number) => {
    f.write("CLAUDE.md", "top\n@h1.md\nbottom\n");
    for (let hop = 1; hop <= hops; hop++)
      f.write(`h${hop}.md`, hop < hops ? `h${hop}\n@h${hop + 1}.md\n` : `h${hop}\n`);
  };

  it("follows four hops", async () => {
    const f = fixture();
    chain(f, 4);
    const result = await preview(f);
    expect(result.content[0]).toContain("h4\n");
    expect(result.warnings).toEqual([]);
  });

  it("skips the fifth hop, keeps the file, and says so", async () => {
    const f = fixture();
    chain(f, 5);
    const result = await preview(f);
    expect(result.content).toEqual(["top\nh1\nh2\nh3\nh4\n@h5.md\n\n\n\n\nbottom\n"]);
    expect(result.content[0]).not.toContain("h5\n");
    expect(result.warnings).toEqual([
      `Instruction import skipped (deeper than 4 hops): ${f.at("h5.md")} (source: ${f.at("h4.md")})`,
    ]);
  });
});

describe("circular imports", () => {
  it("skips the import that closes the cycle but keeps every file", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "top\n@a.md\nbottom\n");
    f.write("a.md", "a\n@b.md\n");
    f.write("b.md", "b\n@a.md\n");
    const result = await preview(f);
    expect(result.content).toEqual(["top\na\nb\n@a.md\n\n\nbottom\n"]);
    expect(result.warnings).toEqual([
      `Instruction import skipped (circular reference): ${f.at("a.md")} (source: ${f.at("b.md")})`,
    ]);
  });

  it("keeps a CLAUDE.md that imports itself", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "x\n@CLAUDE.md\ny\n");
    const result = await preview(f);
    expect(result.content).toEqual(["x\n@CLAUDE.md\ny\n"]);
    expect(result.warnings).toEqual([
      `Instruction import skipped (circular reference): ${f.at("CLAUDE.md")} (source: ${f.at("CLAUDE.md")})`,
    ]);
  });

  it("still allows the same file to be imported from two places", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "@a.md\n@b.md\n");
    f.write("a.md", "@shared.md\n");
    f.write("b.md", "@shared.md\n");
    f.write("shared.md", "shared\n");
    const result = await preview(f);
    expect(result.content).toEqual(["shared\n\n\nshared\n\n\n"]);
    expect(result.warnings).toEqual([]);
  });
});

describe("imports on a line with other text", () => {
  it("keeps the line and inserts the file after it when the file exists", async () => {
    const f = fixture();
    f.write("docs/a.md", "alpha\n");
    f.write("CLAUDE.md", "Read @docs/a.md first\nnext\n");
    expect((await preview(f)).content).toEqual(["Read @docs/a.md first\nalpha\nnext\n"]);
  });

  it("silently ignores an inline mention whose file does not exist", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "Read @docs/none.md first\n");
    const result = await preview(f);
    expect(result.content).toEqual(["Read @docs/none.md first\n"]);
    expect(result.warnings).toEqual([]);
  });

  it("inserts every existing file from a line with several mentions, in order", async () => {
    const f = fixture();
    f.write("one.md", "one\n");
    f.write("two.md", "two\n");
    f.write("CLAUDE.md", "Compare @one.md and @gone.md and @two.md now\n");
    const result = await preview(f);
    expect(result.content).toEqual(["Compare @one.md and @gone.md and @two.md now\none\ntwo\n"]);
    expect(result.warnings).toEqual([]);
  });

  it("does not treat email addresses or scoped package names as imports", async () => {
    const f = fixture();
    const line = "Mail user@example.com, install (@types/node) or ask @maintainers today\n";
    f.write("CLAUDE.md", line);
    const result = await preview(f);
    expect(result.content).toEqual([line]);
    expect(result.warnings).toEqual([]);
  });

  it("still warns about a line that is only an import that does not exist", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "@types/node\nafter\n");
    const result = await preview(f);
    expect(result.content).toEqual(["@types/node\nafter\n"]);
    expect(result.warnings).toEqual([missing(f, "types/node")]);
  });

  it("treats an indented import as standalone", async () => {
    const f = fixture();
    f.write("docs/a.md", "alpha\n");
    f.write("CLAUDE.md", "   @docs/a.md   \n");
    expect((await preview(f)).content).toEqual(["alpha\n\n"]);
  });

  it("keeps a line that has a code span and an import as inline text", async () => {
    const f = fixture();
    f.write("docs/a.md", "alpha\n");
    f.write("CLAUDE.md", "`code` @docs/a.md\n");
    expect((await preview(f)).content).toEqual(["`code` @docs/a.md\nalpha\n"]);
  });

  it("does not strip fragments or trailing punctuation from the path", async () => {
    // Not documented upstream, so the path is taken exactly as written.
    const f = fixture();
    f.write("docs/a.md", "alpha\n");
    f.write("CLAUDE.md", "see @docs/a.md#intro and @docs/a.md.\n");
    const result = await preview(f);
    expect(result.content).toEqual(["see @docs/a.md#intro and @docs/a.md.\n"]);
    expect(result.warnings).toEqual([]);
  });
});

describe("code is not scanned for imports", () => {
  const alpha = (f: ContextFixture) => f.write("docs/a.md", "alpha\n");

  it.each([
    ["backtick fence", "```\n@docs/a.md\n```\n"],
    ["tilde fence with an info string", "~~~md\n@docs/a.md\n~~~\n"],
    ["fence indented by up to three spaces", "   ```\n@docs/a.md\n   ```\n"],
    ["longer fence that a shorter one cannot close", "````\n```\n@docs/a.md\n```\n````\n"],
    ["fence that another character cannot close", "```\n~~~\n@docs/a.md\n```\n"],
    ["fence that is never closed", "```\n@docs/a.md\nstill code\n"],
  ])("skips an import inside a %s", async (_name, block) => {
    const f = fixture();
    alpha(f);
    f.write("CLAUDE.md", block);
    const result = await preview(f);
    expect(result.content).toEqual([block]);
    expect(result.warnings).toEqual([]);
  });

  it("resumes importing after the fence closes", async () => {
    const f = fixture();
    alpha(f);
    f.write("CLAUDE.md", "```\n@docs/a.md\n```\n@docs/a.md\n");
    expect((await preview(f)).content).toEqual(["```\n@docs/a.md\n```\nalpha\n\n"]);
  });

  it("does not report a missing file for an import inside a fence", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "```\n@docs/none.md\n```\n");
    expect((await preview(f)).warnings).toEqual([]);
  });

  it.each([
    ["inline code", "Use `@docs/a.md` to include it\n"],
    ["double-backtick code", "Use ``@docs/a.md`` to include it\n"],
    ["a line that is only a code span", "`@docs/a.md`\n"],
  ])("skips an import inside %s", async (_name, line) => {
    const f = fixture();
    alpha(f);
    f.write("CLAUDE.md", line);
    const result = await preview(f);
    expect(result.content).toEqual([line]);
    expect(result.warnings).toEqual([]);
  });

  it("does not take a lone backtick for a code span", async () => {
    const f = fixture();
    alpha(f);
    f.write("CLAUDE.md", "a ` lone tick @docs/a.md here\n");
    expect((await preview(f)).content).toEqual(["a ` lone tick @docs/a.md here\nalpha\n"]);
  });
});

describe("paths with spaces and quotes", () => {
  it("imports a path whose spaces are escaped with a backslash", async () => {
    const f = fixture();
    f.write("docs/my notes.md", "spaced\n");
    f.write("CLAUDE.md", "@docs/my\\ notes.md\n");
    expect((await preview(f)).content).toEqual(["spaced\n\n"]);
  });

  it("imports an escaped path that is mentioned inline", async () => {
    const f = fixture();
    f.write("docs/my notes.md", "spaced\n");
    f.write("CLAUDE.md", "see @docs/my\\ notes.md ok\n");
    expect((await preview(f)).content).toEqual(["see @docs/my\\ notes.md ok\nspaced\n"]);
  });

  it.each([
    ["double quotes", '@"docs/my notes.md"\n'],
    ["double quotes around a plain path", '@"docs/a.md"\n'],
    ["single quotes", "@'docs/a.md'\n"],
  ])("does not import a path in %s", async (_name, line) => {
    const f = fixture();
    f.write("docs/my notes.md", "spaced\n");
    f.write("docs/a.md", "alpha\n");
    f.write("CLAUDE.md", line);
    const result = await preview(f);
    expect(result.content).toEqual([line]);
    expect(result.warnings).toEqual([]);
  });

  it("does not join an unescaped space into the path", async () => {
    const f = fixture();
    f.write("docs/my notes.md", "spaced\n");
    f.write("CLAUDE.md", "@docs/my notes.md\n");
    const result = await preview(f);
    expect(result.content).toEqual(["@docs/my notes.md\n"]);
    expect(result.warnings).toEqual([]);
  });

  it("ignores an @ with nothing after it", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "@\n@ \nping @ me\n");
    const result = await preview(f);
    expect(result.content).toEqual(["@\n@ \nping @ me\n"]);
    expect(result.warnings).toEqual([]);
  });
});

describe("imports that cannot be used", () => {
  it("keeps the parent when the imported file is not valid UTF-8", async () => {
    const f = fixture();
    f.write("docs/bad.md", Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    f.write("CLAUDE.md", "x\n@docs/bad.md\ny\n");
    const result = await preview(f);
    expect(result.content).toEqual(["x\n@docs/bad.md\ny\n"]);
    expect(result.warnings).toEqual([
      `Instruction import could not be read: ${f.at("docs", "bad.md")} (source: ${f.at("CLAUDE.md")})`,
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the parent when the imported file has no read permission",
    async () => {
      const f = fixture();
      const locked = f.write("docs/locked.md", "secret\n");
      chmodSync(locked, 0o000);
      f.write("CLAUDE.md", "x\n@docs/locked.md\ny\n");
      const result = await preview(f);
      expect(result.content).toEqual(["x\n@docs/locked.md\ny\n"]);
      expect(result.warnings).toEqual([
        `Instruction import could not be read: ${locked} (source: ${f.at("CLAUDE.md")})`,
      ]);
    },
  );

  it("stops resolving after 256 imports and keeps the rest of the file", async () => {
    const f = fixture();
    f.write("docs/a.md", "alpha\n");
    f.write("CLAUDE.md", "@docs/a.md\n".repeat(300));
    const result = await preview(f);
    expect(result.content[0]!.match(/^alpha$/gm)).toHaveLength(256);
    expect(result.content[0]!.match(/^@docs\/a\.md$/gm)).toHaveLength(44);
    expect(result.warnings).toEqual([
      `Instruction import limit reached (256); remaining imports were not resolved (source: ${f.at("CLAUDE.md")})`,
    ]);
  });

  it("keeps every other source when one top-level source cannot be read", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "main\n");
    f.mkdir(".claude/rules/folder.md");
    f.write(".claude/rules/ok.md", "rule\n");
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual(["main\n", "rule\n"]);
    expect(result.warnings).toEqual([`Could not read ${f.at(".claude", "rules", "folder.md")}`]);
  });
});
