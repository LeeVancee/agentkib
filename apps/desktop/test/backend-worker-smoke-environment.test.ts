import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as {
  createIsolatedWorkerEnvironment(root: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};
const directories: string[] = [];
const workers: Worker[] = [];
const built = path.resolve("dist-electron/backend-skills.cjs");

async function packageFixture(directory: string, name: string) {
  await fs.mkdir(path.join(directory, name), { recursive: true });
  await fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Synthetic isolation fixture\n---\nFixture text.\n`,
  );
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
      ),
  );
});

describe("backend Worker smoke environment", () => {
  it("preserves Windows runtime lookup regardless of casing and excludes unrelated settings", () => {
    const environment = createIsolatedWorkerEnvironment(path.resolve("isolated-home"), {
      Path: "synthetic-command-path",
      pathext: ".COM;.EXE;.BAT;.CMD",
      SYSTEMROOT: "C:\\Windows",
      windir: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PROGRAMFILES: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--require external-hook.cjs",
      ELECTRON_RUN_AS_NODE: "1",
      OPENCODE_CONFIG_CONTENT: '{"skills":{"paths":["external"]}}',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      ANTHROPIC_API_KEY: "synthetic-secret",
      UNKNOWN_AGENT_HOME: "external",
    });
    expect(environment).toMatchObject({
      PATH: "synthetic-command-path",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LANG: "en_US.UTF-8",
    });
    for (const name of [
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
      "ANTHROPIC_API_KEY",
      "UNKNOWN_AGENT_HOME",
    ])
      expect(environment).not.toHaveProperty(name);
  });

  it("finds isolated packages without reading external Agent homes or configuration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-smoke-isolation-"));
    directories.push(directory);
    const root = path.join(directory, "isolated");
    const external = path.join(directory, "external");
    await fs.mkdir(path.join(directory, ".git"));
    const ancestorSkills = path.join(directory, ".opencode/skills");
    await packageFixture(ancestorSkills, "ancestor-sentinel");
    const externalEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: external,
      USERPROFILE: external,
      AGENTKIB_HOME: path.join(external, "library"),
      CLAUDE_CONFIG_DIR: path.join(external, "claude"),
      CODEX_HOME: path.join(external, "codex"),
      HERMES_HOME: path.join(external, "hermes"),
      OPENCLAW_HOME: external,
      OPENCLAW_PROFILE: "outside",
      OPENCLAW_STATE_DIR: path.join(external, "openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(external, "openclaw.json"),
      OPENCLAW_WORKSPACE_DIR: path.join(external, "workspace"),
      GROK_HOME: path.join(external, "grok"),
      DSH_HOME: path.join(external, "dsh"),
      XDG_CONFIG_HOME: path.join(external, "xdg"),
      OPENCODE_CONFIG: path.join(external, "opencode.json"),
      OPENCODE_CONFIG_DIR: path.join(external, "opencode"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [external] } }),
      SMOKE_EXTERNAL_ROOT: external,
    };
    for (const [index, folder] of [
      "claude/skills",
      "codex/skills",
      "hermes/skills",
      "openclaw/skills",
      "grok/skills",
      "dsh/skills",
      "xdg/opencode/skills",
      "opencode/skills",
      "skills",
    ].entries())
      await packageFixture(path.join(external, folder), `external-sentinel-${index}`);
    await fs.writeFile(
      externalEnvironment.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ skills: { load: { extraDirs: [path.join(external, "skills")] } } }),
    );
    await fs.writeFile(
      externalEnvironment.OPENCODE_CONFIG!,
      JSON.stringify({ skills: { paths: [path.join(external, "skills")] } }),
    );

    const environment = createIsolatedWorkerEnvironment(root, externalEnvironment);
    await fs.mkdir(environment.TMPDIR!, { recursive: true });
    const isolatedRoots = [
      ".claude/skills",
      ".codex/skills",
      ".hermes/skills",
      ".openclaw/skills",
      ".grok/skills",
      ".dsh/skills",
      ".config/opencode/skills",
      "hermes-extra",
      "openclaw-extra",
      "opencode-extra",
    ];
    for (const [index, folder] of isolatedRoots.entries())
      await packageFixture(path.join(root, folder), `isolated-fixture-${index}`);
    // Unknown environment variables must not expand into external skill roots.
    await fs.writeFile(
      path.join(environment.HERMES_HOME!, "config.yaml"),
      `skills:\n  external_dirs:\n    - ${JSON.stringify(path.join(root, "hermes-extra"))}\n    - '\${SMOKE_EXTERNAL_ROOT}'\n`,
    );
    await fs.writeFile(
      environment.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ skills: { load: { extraDirs: [path.join(root, "openclaw-extra")] } } }),
    );
    await fs.writeFile(
      environment.OPENCODE_CONFIG!,
      JSON.stringify({ skills: { paths: [path.join(root, "opencode-extra")] } }),
    );
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    const marker = path.join(root, "external-access");
    const wrapper = path.join(root, "worker.cjs");
    await fs.writeFile(
      wrapper,
      `const fs = require('node:fs');
const path = require('node:path');
const forbidden = ${JSON.stringify([external, ancestorSkills])};
const mark = fs.appendFileSync;
function trace(original) {
  return function(file, ...args) {
    if (typeof file === 'string') {
      for (const root of forbidden) {
        const relative = path.relative(root, file);
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
          mark(${JSON.stringify(marker)}, 'external access\\n');
      }
    }
    return original.call(this, file, ...args);
  };
}
for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'realpath'])
  fs.promises[name] = trace(fs.promises[name]);
for (const name of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync']) {
  const original = fs[name];
  fs[name] = trace(original);
  if (original.native) fs[name].native = trace(original.native);
}
require(${JSON.stringify(built)});
`,
    );
    const worker = new Worker(wrapper, {
      env: environment,
      workerData: { environment, dataDir: environment.AGENTKIB_DATA_DIR },
    });
    workers.push(worker);
    const readInventory = () =>
      new Promise<{ observations: Array<{ name: string; path: string }> }>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (message) => {
          if (message.type === "result") resolve(message.result);
          else reject(new Error(message.message));
        });
        worker.postMessage({
          type: "run",
          id: "isolation",
          deadlineAt: Date.now() + 10_000,
          method: "skills.inventory",
          params: {},
          workspaces: [{ id: "isolated-workspace", path: workspace }],
        });
      });
    const inventory = await readInventory();
    expect([...new Set(inventory.observations.map((item) => item.name))].sort()).toEqual(
      isolatedRoots.map((_, index) => `isolated-fixture-${index}`).sort(),
    );
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // The synthetic parent Git boundary keeps this control away from real data.
    // Removing only the workspace boundary must expose the parent sentinel.
    await fs.rm(path.join(workspace, ".git"), { recursive: true });
    const withoutBoundary = await readInventory();
    expect(withoutBoundary.observations.some((item) => item.name === "ancestor-sentinel")).toBe(
      true,
    );
    await expect(fs.readFile(marker, "utf8")).resolves.toContain("external access");
  }, 15_000);
});
