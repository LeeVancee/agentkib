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
  const outsideRule = (source: string) =>
    `Instruction source skipped (outside the project): ${source}`;
  const call = (f: ContextFixture) =>
    new McpBuiltins({} as BackendStore, f.context, f.root).call(
      f.project,
      "workspace",
      "claude-code",
      "workspace_get_context",
      { cwd: f.project },
    ) as Promise<Awaited<ReturnType<ContextFixture["resolve"]>>>;

  symlinks("refuses a CLAUDE.md that links outside, and keeps the other sources", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), "OUTSIDE-BODY\n"), "CLAUDE.md");
    f.write(".claude/rules/style.md", "rule\n");
    // A refused CLAUDE.md still counts: Claude Code reads it, so AGENTS.md is not the fallback.
    f.write("AGENTS.md", "agents\n");
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual(["rule\n"]);
    expect(result.warnings).toEqual([outsideRule(f.at("CLAUDE.md"))]);
    expect(result.warnings[0]!.startsWith("Note: ")).toBe(false);
  });

  symlinks("gives the app and the MCP tool the same refusal and no outside contents", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), "OUTSIDE-BODY\n"), "CLAUDE.md");
    f.write(".claude/rules/style.md", "rule\n");
    const viaApp = await f.context.request({
      project: f.project,
      cwd: f.project,
      agent: "claude-code",
    });
    const viaMcp = await call(f);
    for (const result of [viaApp, viaMcp]) {
      expect(JSON.stringify(result)).not.toContain("OUTSIDE-BODY");
      expect(result.warnings).toEqual([outsideRule(f.at("CLAUDE.md"))]);
      expect(result.sections.map((section) => section.content)).toEqual(["rule\n"]);
    }
  });

  symlinks("refuses an AGENTS.md that links outside", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "AGENTS.md"), "OUTSIDE-BODY\n"), "AGENTS.md");
    const result = await f.resolve();
    expect(JSON.stringify(result)).not.toContain("OUTSIDE-BODY");
    expect(result.warnings).toContain(outsideRule(f.at("AGENTS.md")));
    expect(result.sections).toEqual([]);
  });

  symlinks("refuses a rule file that links outside and keeps the next one", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "main\n");
    f.link(f.write(f.outside("shared", "a.md"), "OUTSIDE-BODY\n"), ".claude/rules/a.md");
    f.write(".claude/rules/b.md", "rule b\n");
    const result = await f.resolve();
    expect(result.sections.map((section) => section.content)).toEqual(["main\n", "rule b\n"]);
    expect(result.warnings).toEqual([outsideRule(f.at(".claude", "rules", "a.md"))]);
  });

  symlinks("makes the Doctor report the refusal as a context warning", async () => {
    const f = fixture();
    f.link(f.write(f.outside("shared", "CLAUDE.md"), "OUTSIDE-BODY\n"), "CLAUDE.md");
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
