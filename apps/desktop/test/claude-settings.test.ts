import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeSettings, redactText } from "../../../packages/backend/src/claude-settings";
import { claudeSections } from "../../../packages/backend/src/context-claude";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";
import { virtualIo } from "./fixtures/claude-virtual-io";

// Claude Code settings (https://code.claude.com/docs/en/settings): four files with a fixed
// precedence, shown read-only. Secrets never leave: `env` shows names, credential helpers show
// "configured", commands and rules are redacted, and the MCP tool gets metadata only.

const fixtures: ContextFixture[] = [];
function fixture(...args: Parameters<typeof contextFixture>) {
  const created = contextFixture(...args);
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const json = (value: unknown) => JSON.stringify(value, null, 2);
const user = (f: ContextFixture, value: unknown) => f.user("settings.json", json(value));
const project = (f: ContextFixture, value: unknown) =>
  f.write(".claude/settings.json", json(value));
const local = (f: ContextFixture, value: unknown) =>
  f.write(".claude/settings.local.json", json(value));
const managed = (f: ContextFixture, value: unknown, name = "managed-settings.json") =>
  f.write(path.join(f.managedDir, name), json(value));
const settingsSection = (preview: { sections: { scope: string; content: string }[] }) =>
  preview.sections.find((section) => section.scope === "settings");
const everything = (preview: unknown) => JSON.stringify(preview);

describe("layers and precedence", () => {
  it("shows the file of every layer and takes each value from the highest layer that sets it", async () => {
    const f = fixture();
    user(f, { model: "user-model", outputStyle: "Explanatory", language: "fr" });
    project(f, { model: "project-model", outputStyle: "Learning" });
    local(f, { model: "local-model" });
    managed(f, { language: "managed-language" });
    const section = settingsSection(await f.request())!;
    expect(section.source).toBe("Claude Code settings");
    const text = section.content;
    expect(text).toContain('model = "local-model" (local)');
    expect(text).toContain('outputStyle = "Learning" (project)');
    expect(text).toContain('language = "managed-language" (managed)');
    for (const layer of ["managed", "local", "project", "user"])
      expect(text).toMatch(new RegExp(`- ${layer}: .*settings.*parsed`));
    // Highest precedence first, as the page lists them.
    const order = ["- managed:", "- local:", "- project:", "- user:"].map((label) =>
      text.indexOf(label),
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(text).toContain("--settings, is not visible");
  });

  it("merges lists across layers instead of letting one layer replace another", async () => {
    const f = fixture();
    user(f, { permissions: { allow: ["Bash(npm test)", "Read"], defaultMode: "default" } });
    project(f, { permissions: { allow: ["Read", "Edit"], deny: ["Bash(rm:*)"] } });
    const text = settingsSection(await f.request())!.content;
    expect(text).toContain("permissions.allow: 3 entries (project, user)");
    for (const rule of ["Bash(npm test)", "Read", "Edit"]) expect(text).toContain(`  - ${rule}`);
    expect(text).toContain("permissions.deny: 1 entry (project)");
    expect(text).toContain('permissions.defaultMode = "default" (user)');
  });

  it("ignores auto and bypassPermissions as a default mode from project and local settings", async () => {
    const f = fixture();
    user(f, { permissions: { defaultMode: "acceptEdits" } });
    project(f, { permissions: { defaultMode: "bypassPermissions" } });
    local(f, { permissions: { defaultMode: "auto" } });
    expect(settingsSection(await f.request())!.content).toContain(
      'permissions.defaultMode = "acceptEdits" (user)',
    );
    managed(f, { permissions: { defaultMode: "auto" } });
    expect(settingsSection(await f.request())!.content).toContain(
      'permissions.defaultMode = "auto" (managed)',
    );
  });

  it("merges managed-settings.json with its drop-ins in alphabetical order, later files winning", async () => {
    const f = fixture();
    managed(f, { model: "base", permissions: { deny: ["A"] }, theme: "dark" });
    managed(f, { model: "second", permissions: { deny: ["C"] } }, "managed-settings.d/20-b.json");
    managed(f, { model: "first", permissions: { deny: ["B"] } }, "managed-settings.d/10-a.json");
    managed(f, { model: "hidden" }, "managed-settings.d/.30-hidden.json");
    managed(f, { model: "wrong-extension" }, "managed-settings.d/40-c.txt");
    const text = settingsSection(await f.request())!.content;
    expect(text).toContain('model = "second" (managed)');
    expect(text).toContain("permissions.deny: 3 entries (managed)");
    expect(text).toContain('theme = "dark" (managed)');
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("wrong-extension");
  });

  it("reads the local file from the repository root and the project file from the working directory", async () => {
    const f = fixture();
    mkdirSync(f.at(".git"), { recursive: true });
    f.write("packages/app/CLAUDE.md", "app\n");
    local(f, { model: "root-local", language: "root" });
    f.write("packages/app/.claude/settings.local.json", json({ model: "old-local", theme: "old" }));
    f.write("packages/app/.claude/settings.json", json({ outputStyle: "app-project" }));
    project(f, { outputStyle: "root-project" });
    const text = settingsSection(await f.request(f.at("packages", "app")))!.content;
    // The repository root's local file wins over the older copy in the starting directory.
    expect(text).toContain('model = "root-local" (local)');
    expect(text).toContain('theme = "old" (local)');
    expect(text).toContain('outputStyle = "app-project" (project)');
    expect(text).not.toContain("root-project");
  });

  it("explains what it cannot see", async () => {
    const f = fixture();
    user(f, { model: "m" });
    const preview = await f.request();
    expect(preview.warnings.join("\n")).toContain("Settings given on the command line");
  });
});

describe("files that cannot be used", () => {
  it("reports a syntax error by position only and never echoes the text around it", async () => {
    const f = fixture();
    f.write(".claude/settings.json", '{\n  "env": { "TOKEN": "PARSE-CANARY" },\n}\n');
    f.write("CLAUDE.md", "x\n");
    const preview = await f.request();
    expect(settingsSection(preview)!.content).toMatch(
      /- project: .* - cannot be parsed \(line \d+, column \d+\)/,
    );
    expect(preview.warnings.join("\n")).toMatch(
      /Settings file cannot be used \(line \d+, column \d+\)/,
    );
    expect(everything(preview)).not.toContain("PARSE-CANARY");
    expect((await f.mcp()) && everything(await f.mcp())).not.toContain("PARSE-CANARY");
  });

  it("skips a file whose top level is not an object, and one that is too large", async () => {
    const f = fixture();
    f.user("settings.json", "[1, 2]");
    f.write(".claude/settings.json", `{"padding": "${"x".repeat(300 * 1024)}"}`);
    const text = settingsSection(await f.request())!.content;
    expect(text).toMatch(/- user: .* - cannot be used \(the top level is not an object\)/);
    expect(text).toMatch(/- project: .* - skipped \(larger than 256 KiB\)/);
  });

  it("does not read a settings file that is a link to a credential store", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const secret = f.write(f.outside(".aws", "settings.json"), json({ model: "LINK-CANARY" }));
    f.link(secret, ".claude/settings.json");
    const preview = await f.request();
    expect(everything(preview)).not.toContain("LINK-CANARY");
    expect(settingsSection(preview)!.content).toMatch(/- project: .* - skipped \(sensitive path\)/);
  });
});

describe("nothing changes without settings files", () => {
  it("adds no section and no note", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n");
    const preview = await f.request();
    expect(settingsSection(preview)).toBeUndefined();
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.warnings).toEqual([]);
  });
});

describe("secrets", () => {
  const CANARY = {
    env: "ENV-VALUE-CANARY-9f3a",
    hook: "HOOK-TOKEN-CANARY-7b2c",
    status: "STATUS-SECRET-CANARY-4d1e",
    helper: "HELPER-CANARY-1a8f",
    rule: "RULE-BEARER-CANARY-6c5d",
    plugin: "PLUGIN-OPTION-CANARY-2e9b",
    market: "MARKET-TOKEN-CANARY-3f7a",
    header: "HEADER-CANARY-8d4c",
    other: "OTHER-VALUE-CANARY-5a6b",
    url: "URL-USERINFO-CANARY-0c9d",
    query: "QUERY-CANARY-b1e2",
    flag: "FLAG-CANARY-c3d4",
    assign: "ASSIGN-CANARY-d5e6",
  } as const;
  const seed = (f: ContextFixture) => {
    const body = {
      model: "claude-test",
      env: {
        ANTHROPIC_AUTH_TOKEN: CANARY.env,
        HTTPS_PROXY: `https://user:${CANARY.url}@proxy.example`,
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `curl -H "Authorization: Bearer ${CANARY.hook}" https://x.example/y`,
              },
              {
                type: "command",
                command: `deploy --token ${CANARY.flag} && API_KEY=${CANARY.assign} run`,
              },
              {
                type: "http",
                url: `https://hooks.example/p?access_token=${CANARY.query}`,
                headers: { Authorization: CANARY.header },
              },
            ],
          },
        ],
      },
      statusLine: { type: "command", command: `./status.sh --secret ${CANARY.status}` },
      apiKeyHelper: `/bin/sh -c 'echo ${CANARY.helper}'`,
      awsAuthRefresh: `aws sso login --token ${CANARY.helper}`,
      permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${CANARY.rule}")`] },
      pluginConfigs: { "tool@market": { options: { apiToken: CANARY.plugin } } },
      extraKnownMarketplaces: {
        shop: { source: { source: "url", url: `https://m.example/?token=${CANARY.market}` } },
      },
      managedMcpServers: {
        svc: {
          type: "http",
          url: "https://svc.example",
          headers: { Authorization: CANARY.header },
        },
      },
      somethingNew: { value: CANARY.other },
      sandbox: { credentials: { envVars: [CANARY.other] } },
    };
    user(f, body);
    project(f, body);
    local(f, body);
    managed(f, body);
  };

  it("never lets a value out of the app view, and keeps the key names", async () => {
    const f = fixture();
    seed(f);
    const preview = await f.request();
    const output = everything(preview);
    for (const canary of Object.values(CANARY)) expect(output).not.toContain(canary);
    const text = settingsSection(preview)!.content;
    expect(text).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(text).toContain("values hidden");
    expect(text).toContain("apiKeyHelper: configured, value hidden");
    expect(text).toContain("awsAuthRefresh: configured, value hidden");
    expect(text).toContain("statusLine: command");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("somethingNew");
  });

  it("never lets a value out over MCP, which gets no commands, rules, env names or paths", async () => {
    const f = fixture();
    seed(f);
    for (const agent of ["claude-code", "codex"]) {
      const preview = await f.mcp(f.project, agent);
      const output = everything(preview);
      for (const canary of Object.values(CANARY)) expect(output).not.toContain(canary);
      for (const hidden of ["Authorization", "status.sh", "ANTHROPIC_AUTH_TOKEN", "curl"])
        expect(output).not.toContain(hidden);
      for (const place of [f.home, f.managedDir]) expect(output).not.toContain(place);
    }
  });

  it("redacts commands, flags, assignments, headers, URLs and opaque blobs", () => {
    const samples = [
      "curl -H 'Authorization: Bearer abc123SECRETabc123' https://h",
      "run --api-key=SECRETVALUE1 --token SECRETVALUE2 --password 'two words'",
      "export MY_SERVICE_KEY=SECRETVALUE3 && x",
      "git clone https://user:SECRETVALUE4@host/repo",
      "fetch https://h/p?access_token=SECRETVALUE5&x=1",
      "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "echo QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0Fsb25nVG9rZW4xMjM0NTY3ODkw",
    ];
    for (const sample of samples) {
      const out = redactText(sample);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toMatch(/SECRETVALUE\d|abc123SECRET|ghp_abcdef|QWxhZGRpbjpvcGVu|two words/);
    }
    expect(redactText("npm run build -- --watch")).toBe("npm run build -- --watch");
    expect(redactText("x".repeat(500)).length).toBeLessThanOrEqual(201);
  });
});

describe("over MCP", () => {
  it("returns the project file's plain values and counts, and only metadata for every other file", async () => {
    const f = fixture();
    user(f, { model: "user-secret-choice", theme: "dark" });
    managed(f, { language: "managed-choice" });
    local(f, { effortLevel: "local-choice" });
    project(f, {
      model: "project-model",
      permissions: { defaultMode: "plan", allow: ["Read", "Bash(x)"] },
      env: { A: "1" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "./stop.sh" }] }] },
      statusLine: { type: "command", command: "./line.sh" },
    });
    const preview = await f.mcp();
    const section = settingsSection(preview)!;
    expect(section.source).toBe("Claude Code settings (project)");
    expect(section.content).toContain('model = "project-model" (project)');
    expect(section.content).toContain('permissions.defaultMode = "plan" (project)');
    expect(section.content).toContain("permissions.allow: 2 entries (project)");
    expect(section.content).toContain("env: 1 name, values hidden");
    expect(section.content).toContain("hooks: 1 hook for 1 event, commands hidden");
    expect(section.content).toContain("statusLine: configured");
    for (const hidden of ["./stop.sh", "./line.sh", "Bash(x)", "A, "])
      expect(section.content).not.toContain(hidden);
    const output = everything(preview);
    for (const hidden of ["user-secret-choice", "managed-choice", "local-choice"])
      expect(output).not.toContain(hidden);
    const notes = preview.warnings.filter((warning) =>
      warning.startsWith("Note: Claude Code settings"),
    );
    expect(notes.map((note) => note.replace(/\(.*?\)/, "(...)")).sort()).toEqual(
      [
        "Note: Claude Code settings, local layer: parsed, 1 key (...). The values are not included in this result.",
        "Note: Claude Code settings, managed layer: parsed, 1 key (...). The values are not included in this result.",
        "Note: Claude Code settings, user layer: parsed, 2 keys (...). The values are not included in this result.",
      ].sort(),
    );
    expect(notes.join("\n")).toContain("(effortLevel)");
  });

  it("gives metadata only when the project file is a link that leads out of the workspace", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    f.link(
      f.write(f.outside("shared", "settings.json"), json({ model: "OUTSIDE-CANARY" })),
      ".claude/settings.json",
    );
    const preview = await f.mcp();
    expect(settingsSection(preview)).toBeUndefined();
    expect(everything(preview)).not.toContain("OUTSIDE-CANARY");
    expect(preview.warnings.join("\n")).toContain(
      "Claude Code settings, project layer: parsed, 1 key (model)",
    );
  });
});

describe("for the Doctor", () => {
  it("reads nothing, so a settings file can never become a finding", async () => {
    const f = fixture();
    user(f, { model: "m" });
    project(f, { model: "m" });
    local(f, { model: "m" });
    managed(f, { model: "m" });
    f.write("CLAUDE.md", "project\n");
    const preview = await f.resolve(f.project, { includeOutsideSources: false });
    expect(settingsSection(preview)).toBeUndefined();
    expect(everything(preview)).not.toContain("Claude Code settings");
  });

  it("does not even look at a settings path when nothing may be read", async () => {
    const root = "/w/project";
    const files = {
      [`${root}/CLAUDE.md`]: "x\n",
      [`${root}/.claude/settings.json`]: json({ model: "m" }),
      [`${root}/.claude/settings.local.json`]: json({ model: "m" }),
      "/h/.claude/settings.json": json({ model: "m" }),
      "/m/managed-settings.json": json({ model: "m" }),
    };
    const fake = virtualIo(files);
    const settings = readClaudeSettings({
      root,
      cwd: root,
      environment: { HOME: "/h" },
      mode: "none",
      managedDir: "/m",
      platform: "linux",
      io: fake.io,
    });
    expect(settings.anyFile).toBe(false);
    expect(fake.calls).toEqual([]);
    const sections = await claudeSections({
      root,
      cwd: root,
      dirs: [root],
      environment: { HOME: "/h" },
      budget: { remaining: 100000 },
      warnings: [],
      externalBodies: false,
      version: async () => null,
      outside: "none",
      managedDir: "/m",
      platform: "linux",
      io: fake.io,
    });
    expect(sections.map((section) => section.scope)).toEqual([""]);
    expect(fake.calls.filter((call) => call.path.includes("settings"))).toEqual([]);
  });
});

describe("the reader", () => {
  it("shows the user layer from the configured folder", async () => {
    const f = fixture();
    const config = f.outside("elsewhere");
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, "settings.json"), json({ model: "from-config-dir" }));
    f.environment.CLAUDE_CONFIG_DIR = config;
    const text = settingsSection(await f.request())!.content;
    expect(text).toContain('model = "from-config-dir" (user)');
  });
});
