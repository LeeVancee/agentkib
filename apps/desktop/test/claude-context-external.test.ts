import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Doctor } from "../../../packages/backend/src/doctor";
import { McpBuiltins } from "../../../packages/backend/src/mcp-builtin";
import type { BackendStore } from "../../../packages/backend/src/store";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

// Imports of files outside the project are allowed by Claude Code after the user approves them.
// The preview has no such approval step, so it reads them with a filter, redacts what it reads,
// and the MCP tool does not return their contents at all.
const fixtures: ContextFixture[] = [];
function fixture() {
  const created = contextFixture();
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const symlinks = process.platform === "win32" ? it.skip : it;
const ASK_FIRST =
  "Claude Code asks for approval before loading external imports, so this content may not be in effect.";
const AGENTS_APPROVED =
  "Claude Code loads external imports from AGENTS.md only if you already approved external imports for this project, and does not ask again, so this content may not be in effect.";
const OMITTED = "Its content is not included in this result.";
const note = (written: string, source: string, tail = ASK_FIRST) =>
  `Note: External import (outside the working directory): ${written} (source: ${source}). ${tail}`;
const sensitiveSkip = (resolved: string, source: string) =>
  `Instruction import skipped (sensitive path): ${resolved} (source: ${source})`;

describe("imports outside the project", () => {
  it("reads a file reached with ../ and notes that Claude Code asks for approval", async () => {
    const f = fixture();
    f.write(f.outside("shared", "team.md"), "team rules\n");
    f.write("CLAUDE.md", "before\n@../shared/team.md\nafter\n");
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual([
      "before\nteam rules\n\nafter\n",
    ]);
    expect(result.warnings).toEqual([note("../shared/team.md", f.at("CLAUDE.md"))]);
  });

  it("reads a file reached with an absolute path", async () => {
    const f = fixture();
    const target = f.write(f.outside("shared", "abs.md"), "absolute rules\n");
    f.write("CLAUDE.md", `@${target}\n`);
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual(["absolute rules\n\n"]);
    expect(result.warnings).toEqual([note(target, f.at("CLAUDE.md"))]);
  });

  it("reports a missing external file like any other missing import", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "@~/nope.md\nsee @~/nope-either.md\n");
    const result = await f.resolve();
    expect(result.sections).toHaveLength(1);
    expect(result.warnings).toEqual([
      `Imported file is missing: ${f.inHome("nope.md")} (source: ${f.at("CLAUDE.md")})`,
    ]);
  });

  it("describes an AGENTS.md import as loaded only when external imports were approved earlier", async () => {
    const f = fixture();
    f.write("docs/a.md", "alpha\n");
    f.write(f.outside("shared", "team.md"), "team rules\n");
    f.write("AGENTS.md", "shared\n@docs/a.md\n@../shared/team.md\n");
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual([
      "shared\nalpha\n\nteam rules\n\n",
    ]);
    expect(result.warnings).toContain(
      note("../shared/team.md", f.at("AGENTS.md"), AGENTS_APPROVED),
    );
    expect(result.warnings.some((warning) => warning.includes(ASK_FIRST))).toBe(false);
  });

  it("does not report the note as a Doctor issue", async () => {
    const f = fixture();
    f.write(f.outside("shared", "team.md"), "team rules\n");
    f.write("CLAUDE.md", "@../shared/team.md\n");
    f.write(
      ".agentkib/manifest.yaml",
      "schema_version: 2\nworkspace:\n  id: fixture\n  name: Fixture\n",
    );
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(report.issues.filter((issue) => issue.agent === "claude-code")).toEqual([]);
  });
});

describe("which external files are never read", () => {
  const home = (...parts: string[]) => ["~", ...parts].join("/");
  it.each([
    ["a .ssh directory", home(".ssh", "config")],
    ["a .aws directory", home(".aws", "config")],
    ["a .gnupg directory", home(".gnupg", "pubring.kbx")],
    ["a .kube directory", home(".kube", "config")],
    ["a .docker directory", home(".docker", "config.json")],
    ["a .azure directory", home(".azure", "profile.json")],
    ["the GitHub CLI directory", home(".config", "gh", "hosts.yml")],
    ["the gcloud directory", home(".config", "gcloud", "settings.json")],
    ["~/.claude.json", home(".claude.json")],
    ["~/.npmrc", home(".npmrc")],
    ["~/.netrc", home(".netrc")],
    ["~/.pypirc", home(".pypirc")],
    ["an .env file", home("project", ".env")],
    ["a file with credential in its name", home("credentials")],
    ["a file with token in its name", home("notes", "my-token.txt")],
    ["a file with secret in its name", home("notes", "secrets.md")],
    ["a .pem file", home("certs", "server.pem")],
    ["a .key file", home("certs", "server.key")],
    ["a directory written in capitals", home(".SSH", "config")],
    ["a file name written in capitals", home(".NPMRC")],
    ["a file name in mixed case", home(".Claude.json")],
  ])("skips an import of %s", async (_name, written) => {
    const f = fixture();
    const target = f.write(path.join(f.home, ...written.split("/").slice(1)), "TOP-SECRET-BODY\n");
    f.write("CLAUDE.md", `before\n@${written}\nafter\n`);
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual([
      `before\n@${written}\nafter\n`,
    ]);
    expect(result.warnings).toEqual([sensitiveSkip(target, f.at("CLAUDE.md"))]);
  });

  it("skips a sensitive file mentioned inline too", async () => {
    const f = fixture();
    f.write(f.inHome(".npmrc"), "TOP-SECRET-BODY\n");
    f.write("CLAUDE.md", "config in @~/.npmrc is private\n");
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET-BODY");
    expect(result.warnings).toEqual([sensitiveSkip(f.inHome(".npmrc"), f.at("CLAUDE.md"))]);
  });

  symlinks("skips an import inside the project that links to a credentials file", async () => {
    const f = fixture();
    const target = f.write(f.inHome(".aws", "credentials"), "TOP-SECRET-BODY\n");
    const link = f.link(target, "docs/x.md");
    f.write("CLAUDE.md", "before\n@docs/x.md\nafter\n");
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual([
      "before\n@docs/x.md\nafter\n",
    ]);
    expect(result.warnings).toEqual([sensitiveSkip(link, f.at("CLAUDE.md"))]);
  });

  symlinks("skips a link to a sensitive file whose own name is harmless", async () => {
    const f = fixture();
    const target = f.write(f.inHome(".ssh", "id_ed25519"), "TOP-SECRET-BODY\n");
    f.link(target, "docs/guide.md");
    f.write("CLAUDE.md", "@docs/guide.md\n");
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET-BODY");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Instruction import skipped (sensitive path)");
  });
});

describe("the two boundaries", () => {
  it("does not filter or redact a file that is inside the project but outside the working directory", async () => {
    const f = fixture();
    f.write("docs/token-guide.md", "password=hunter2\nrotate it often\n");
    f.write("AGENTS.md", "shared rules\n");
    f.write("CLAUDE.md", "@docs/token-guide.md\n@AGENTS.md\n");
    f.mkdir("packages/app");
    const result = await f.resolve(f.at("packages", "app"));
    expect(result.sections.map((section) => section.content)).toEqual([
      "password=hunter2\nrotate it often\n\nshared rules\n\n",
    ]);
    // Only a note: these files are outside the working directory, not outside the project.
    expect(result.warnings).toEqual([
      note("docs/token-guide.md", f.at("CLAUDE.md")),
      note("AGENTS.md", f.at("CLAUDE.md")),
    ]);
  });

  it("still skips a file with the same name when it is outside the project", async () => {
    const f = fixture();
    const target = f.write(f.outside("shared", "token-guide.md"), "password=hunter2\n");
    f.write("CLAUDE.md", "@../shared/token-guide.md\n");
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.warnings).toEqual([sensitiveSkip(target, f.at("CLAUDE.md"))]);
  });

  it("does not note an import inside the working directory", async () => {
    const f = fixture();
    f.write("packages/app/CLAUDE.md", "@notes.md\n");
    f.write("packages/app/notes.md", "local\n");
    const result = await f.resolve(f.at("packages", "app"));
    expect(result.warnings).toEqual([]);
  });
});

describe("what is read from outside the project is redacted", () => {
  const external = [
    "Deploy notes",
    "password=hunter2-should-vanish",
    "Authorization: Bearer abcdef1234567890",
    "token: sk-abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    "-----END RSA PRIVATE KEY-----",
    "after the key",
    "",
  ].join("\n");
  const leaked = [
    "hunter2",
    "abcdef1234567890",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "MIIBOgIBAAJBAKj34",
  ];

  it("removes secrets and private keys from an external file", async () => {
    const f = fixture();
    f.write(f.outside("shared", "ops.md"), external);
    f.write("CLAUDE.md", "@../shared/ops.md\n");
    const result = await f.resolve();
    const content = result.sections[0]!.content;
    expect(content).toContain("Deploy notes\n");
    expect(content).toContain("after the key\n");
    expect(content).toContain("[REDACTED PRIVATE KEY]");
    for (const secret of leaked) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("treats a file reached through an external file as external, even inside the project", async () => {
    const f = fixture();
    f.write("docs/inner.md", "password=inner-secret\n");
    f.write(f.outside("shared", "hub.md"), `@${f.at("docs", "inner.md")}\n`);
    f.write("CLAUDE.md", "@../shared/hub.md\n@docs/inner.md\n");
    const result = await f.resolve();
    const content = result.sections[0]!.content;
    // Through the external hub it is redacted; imported directly it is read as before.
    expect(content.match(/inner-secret/g)).toHaveLength(1);
    expect(content).toContain("password=[REDACTED]");
  });

  it("applies the filter to imports of an external file", async () => {
    const f = fixture();
    f.write(f.inHome(".npmrc"), "TOP-SECRET-BODY\n");
    f.write(f.outside("shared", "hub.md"), "hub\n@~/.npmrc\n");
    f.write("CLAUDE.md", "@../shared/hub.md\n");
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET-BODY");
    expect(result.warnings).toContain(
      sensitiveSkip(f.inHome(".npmrc"), f.outside("shared", "hub.md")),
    );
  });

  symlinks("redacts an innocuous-looking link that leads outside the project", async () => {
    const f = fixture();
    const target = f.write(f.outside("shared", "ops.md"), external);
    f.link(target, "docs/ops.md");
    f.write("CLAUDE.md", "@docs/ops.md\n");
    const result = await f.resolve();
    for (const secret of leaked) expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.sections[0]!.content).toContain("Deploy notes\n");
  });
});

describe("the MCP tool", () => {
  const call = (f: ContextFixture, cwd = f.project) =>
    new McpBuiltins({} as BackendStore, f.context, f.root).call(
      f.project,
      "workspace",
      "claude-code",
      "workspace_get_context",
      { cwd },
    ) as Promise<Awaited<ReturnType<ContextFixture["resolve"]>>>;
  const request = (f: ContextFixture) =>
    f.context.request({ project: f.project, cwd: f.project, agent: "claude-code" });

  function seed(f: ContextFixture) {
    f.write(f.outside("shared", "team.md"), "EXTERNAL-BODY\n");
    f.write("docs/a.md", "inside body\n");
    f.write("CLAUDE.md", "@../shared/team.md\n@docs/a.md\n");
  }

  it("does not return the contents of an external import", async () => {
    const f = fixture();
    seed(f);
    const result = await call(f);
    expect(JSON.stringify(result)).not.toContain("EXTERNAL-BODY");
    expect(result.sections[0]!.content).toBe("@../shared/team.md\ninside body\n\n");
    expect(result.warnings).toEqual([note("../shared/team.md", f.at("CLAUDE.md"), OMITTED)]);
  });

  it("does not expand the imports of an external file either", async () => {
    const f = fixture();
    f.write(f.outside("shared", "hub.md"), "EXTERNAL-BODY\n@nested.md\n");
    f.write(f.outside("shared", "nested.md"), "NESTED-BODY\n");
    f.write("CLAUDE.md", "@../shared/hub.md\n");
    const result = await call(f);
    expect(JSON.stringify(result)).not.toContain("NESTED-BODY");
    expect(JSON.stringify(result)).not.toContain("EXTERNAL-BODY");
    // The file itself stays, with the import left as written and one note about it.
    expect(result.sections.map((section) => section.content)).toEqual(["@../shared/hub.md\n"]);
    expect(result.warnings).toEqual([note("../shared/hub.md", f.at("CLAUDE.md"), OMITTED)]);
  });

  it("returns the same external contents to the app", async () => {
    const f = fixture();
    seed(f);
    const result = await request(f);
    expect(result.sections[0]!.content).toBe("EXTERNAL-BODY\n\ninside body\n\n");
  });

  symlinks("treats a link that leaves the project as external", async () => {
    const f = fixture();
    const target = f.write(f.outside("shared", "linked.md"), "EXTERNAL-BODY\n");
    f.link(target, "docs/linked.md");
    f.write("CLAUDE.md", "@docs/linked.md\n");
    const result = await call(f);
    expect(JSON.stringify(result)).not.toContain("EXTERNAL-BODY");
    expect(result.warnings).toEqual([note("docs/linked.md", f.at("CLAUDE.md"), OMITTED)]);
  });

  it("still names a sensitive external file as skipped", async () => {
    const f = fixture();
    f.write(f.inHome(".npmrc"), "TOP-SECRET-BODY\n");
    f.write("CLAUDE.md", "@~/.npmrc\n");
    const result = await call(f);
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET-BODY");
    expect(result.warnings).toEqual([sensitiveSkip(f.inHome(".npmrc"), f.at("CLAUDE.md"))]);
  });
});

describe("top-level sources that lead outside the project", () => {
  // A CLAUDE.md, AGENTS.md or rule file that is a link to a file elsewhere (dotfiles, a shared
  // folder), or that sits in a `.claude` folder which is such a link. The app reads it as an
  // outside source (filtered, redacted, noted), the MCP tool only counts it, and the Doctor
  // refuses it without opening it, as it always did.
  const outsideRule = (source: string) =>
    `Instruction source skipped (outside the project): ${source}`;
  const SETTINGS_NOT_READ =
    "Note: Settings given on the command line (--settings, --setting-sources), policy delivered by MDM, a configuration profile or the Windows registry, and server-managed settings are not visible to AgentKib, and rules in parent directories are not read, so this list can differ from what Claude Code loads.";
  const linkedSource = (source: string, link = source) =>
    `Note: External instruction source (outside the working directory): ${source} (link: ${link}). Claude Code may ask for approval before loading it, so this content may not be in effect.`;
  const linkedRule = (source: string, link = source) =>
    `Note: External rule file (outside the working directory): ${source} (link: ${link}). Claude Code asks for approval before loading it and then loads it only when it has no paths field, so this content may not be in effect.`;
  const OUTSIDE_BODY = "OUTSIDE-BODY\n";
  const problems = (result: { warnings: string[] }) =>
    result.warnings.filter((warning) => !warning.startsWith("Note: "));

  symlinks("reads a CLAUDE.md that links outside and keeps the other sources", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), OUTSIDE_BODY), "CLAUDE.md");
    f.write(".claude/rules/style.md", "rule\n");
    // The linked file still counts as a CLAUDE.md, so AGENTS.md is not the fallback.
    f.write("AGENTS.md", "agents\n");
    const result = await f.resolve();
    expect(result.sections.map((section) => [section.scope, section.content])).toEqual([
      ["", OUTSIDE_BODY],
      [".claude/rules", "rule\n"],
    ]);
    expect(result.warnings).toEqual([linkedSource(f.at("CLAUDE.md")), SETTINGS_NOT_READ]);
    expect(result.warnings[0]!.startsWith("Note: ")).toBe(true);
  });

  symlinks("redacts what it reads through such a link", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), "keep\npassword=hunter2\n"), "CLAUDE.md");
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.sections[0]!.content).toBe("keep\npassword=[REDACTED]\n");
  });

  symlinks("refuses a link whose real path is sensitive, and the file still counts", async () => {
    const f = fixture();
    f.link(f.write(f.inHome(".ssh", "notes.md"), "SECRET-BODY\n"), "CLAUDE.md");
    f.write("AGENTS.md", "agents\n");
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("SECRET-BODY");
    expect(result.sections).toEqual([]);
    expect(result.warnings).toContain(
      `Note: Instruction source skipped (sensitive path): ${f.at("CLAUDE.md")}`,
    );
    // Claude Code reads that CLAUDE.md, so AGENTS.md is not read in its place.
    expect(result.warnings.some((warning) => warning.includes("AGENTS.md may not"))).toBe(false);
  });

  symlinks("gives the MCP tool a count and neither the contents nor the location", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), OUTSIDE_BODY), "CLAUDE.md");
    f.write(".claude/rules/style.md", "rule\n");
    const viaMcp = await f.mcp();
    expect(JSON.stringify(viaMcp)).not.toContain("OUTSIDE-BODY");
    expect(JSON.stringify(viaMcp)).not.toContain(f.outside("shared"));
    expect(viaMcp.sections.map((section) => section.content)).toEqual(["rule\n"]);
    expect(viaMcp.warnings).toEqual([
      "Note: External instruction sources exist (1 file, 13 bytes); its content is not included in this result.",
      SETTINGS_NOT_READ,
    ]);
    // The app gets the same files with their contents.
    const viaApp = await f.request();
    expect(viaApp.sections.map((section) => section.content)).toEqual([OUTSIDE_BODY, "rule\n"]);
  });

  symlinks("makes the Doctor refuse the link without opening it", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), OUTSIDE_BODY), "CLAUDE.md");
    f.write(".claude/rules/style.md", "rule\n");
    const result = await f.resolve(f.project, { includeOutsideSources: false });
    expect(JSON.stringify(result)).not.toContain("OUTSIDE-BODY");
    expect(result.sections.map((section) => section.content)).toEqual(["rule\n"]);
    // The refusal is a warning, not a note; the Doctor ignores the notes next to it.
    expect(problems(result)).toEqual([outsideRule(f.at("CLAUDE.md"))]);
  });

  symlinks("reads an AGENTS.md that links outside when it is the fallback", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "AGENTS.md"), OUTSIDE_BODY), "AGENTS.md");
    const full = await f.resolve();
    expect(full.sections.map((section) => section.content)).toEqual([OUTSIDE_BODY]);
    expect(full.warnings).toContain(linkedSource(f.at("AGENTS.md")));
    const none = await f.resolve(f.project, { includeOutsideSources: false });
    expect(JSON.stringify(none)).not.toContain("OUTSIDE-BODY");
    expect(none.warnings).toContain(outsideRule(f.at("AGENTS.md")));
  });

  symlinks("treats a rule file that links outside like any outside rule", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "main\n");
    const link = f.link(f.write(f.outside("shared", "a.md"), OUTSIDE_BODY), ".claude/rules/a.md");
    f.write(".claude/rules/b.md", "rule b\n");
    const full = await f.resolve();
    expect(full.sections.map((section) => section.content)).toEqual([
      "main\n",
      OUTSIDE_BODY,
      "rule b\n",
    ]);
    expect(full.warnings).toContain(linkedRule(link));
    const none = await f.resolve(f.project, { includeOutsideSources: false });
    expect(none.sections.map((section) => section.content)).toEqual(["main\n", "rule b\n"]);
    expect(problems(none)).toEqual([outsideRule(link)]);
  });

  symlinks("lists no rule that links outside when it only loads on matching files", async () => {
    // Claude Code loads an approved rule link only without a `paths` field, so it never loads.
    const f = fixture();
    f.write("CLAUDE.md", "main\n");
    f.link(
      f.write(f.outside("shared", "scoped.md"), "---\npaths: src/**\n---\nOUTSIDE-BODY\n"),
      ".claude/rules/scoped.md",
    );
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("OUTSIDE-BODY");
    expect(result.sections.map((section) => section.scope)).toEqual([""]);
  });

  symlinks("treats a .claude folder that links outside as outside content", async () => {
    const f = fixture();
    f.write(f.outside("dotfiles", "claude", "CLAUDE.md"), "DOTFILES-BODY\n");
    f.write(f.outside("dotfiles", "claude", "rules", "x.md"), "RULE-BODY\n");
    f.link(f.outside("dotfiles", "claude"), ".claude");
    f.write("CLAUDE.md", "main\n");
    const full = await f.resolve();
    expect(full.sections.map((section) => [section.scope, section.content])).toEqual([
      ["", "main\n"],
      [".claude", "DOTFILES-BODY\n"],
      [".claude/rules", "RULE-BODY\n"],
    ]);
    const viaMcp = await f.mcp();
    expect(JSON.stringify(viaMcp)).not.toContain("DOTFILES-BODY");
    expect(JSON.stringify(viaMcp)).not.toContain("RULE-BODY");
    expect(JSON.stringify(viaMcp)).not.toContain(f.outside("dotfiles"));
    expect(viaMcp.warnings).toContain(
      "Note: External instruction sources exist (2 files, 24 bytes); its content is not included in this result.",
    );
    const none = await f.resolve(f.project, { includeOutsideSources: false });
    expect(JSON.stringify(none)).not.toContain("DOTFILES-BODY");
    expect(JSON.stringify(none)).not.toContain("RULE-BODY");
    expect(none.sections.map((section) => section.content)).toEqual(["main\n"]);
  });

  symlinks("refuses a parent's .claude folder that is a link to a credentials folder", async () => {
    // The check is on the real path, so the harmless name .claude does not hide .ssh.
    const f = fixture();
    f.write(f.inHome(".ssh", "CLAUDE.md"), "SSH-BODY\n");
    f.link(f.inHome(".ssh"), f.outside(".claude"));
    f.write("CLAUDE.md", "project\n");
    const full = await f.resolve();
    expect(JSON.stringify(full)).not.toContain("SSH-BODY");
    expect(full.warnings).toContain(
      `Note: Instruction source skipped (sensitive path): ${f.outside(".claude", "CLAUDE.md")}`,
    );
    const viaMcp = await f.mcp();
    expect(JSON.stringify(viaMcp)).not.toContain("SSH-BODY");
    expect(JSON.stringify(viaMcp)).not.toContain(".ssh");
    expect(viaMcp.warnings).toContain(
      "Note: Parent-directory instruction files exist (0 files, 0 bytes, 1 skipped); its content is not included in this result.",
    );
  });

  symlinks("refuses the user's own CLAUDE.md when it links to a credentials file", async () => {
    const f = fixture();
    const secret = f.write(f.inHome(".aws", "notes.md"), "AWS-BODY\n");
    f.link(secret, f.inHome(".claude", "CLAUDE.md"));
    const full = await f.resolve();
    expect(JSON.stringify(full)).not.toContain("AWS-BODY");
    expect(full.warnings).toContain(
      `Note: Instruction source skipped (sensitive path): ${f.inHome(".claude", "CLAUDE.md")}`,
    );
  });

  symlinks("treats a .claude folder that links inside the project as project content", async () => {
    const f = fixture();
    f.write("config/claude/CLAUDE.md", "INNER-BODY\n");
    f.link(f.at("config", "claude"), ".claude");
    const result = await f.resolve();
    expect(result.sections.map((section) => [section.scope, section.content])).toEqual([
      [".claude", "INNER-BODY\n"],
    ]);
    // It is a project file: no note about leaving the working directory.
    expect(result.warnings).toEqual([]);
  });

  symlinks("makes the Doctor report the refusal as a context warning", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), OUTSIDE_BODY), "CLAUDE.md");
    f.write(
      ".agentkib/manifest.yaml",
      "schema_version: 2\nworkspace:\n  id: fixture\n  name: Fixture\ninstructions:\n  shared: |\n    Use tabs.\n",
    );
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    const issues = report.issues.filter((issue) => issue.agent === "claude-code");
    expect(
      issues.filter((issue) => issue.code === "context.warning").map((i) => i.evidence[0]!.detail),
    ).toEqual([outsideRule(f.at("CLAUDE.md"))]);
    // With no source left, the existing missing-instructions finding appears next to it.
    expect(issues.map((issue) => issue.code)).toContain("instruction.missing");
  });
});
