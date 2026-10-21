// QA-only launcher. It never imports a personal profile, credential or session.
// Run prepare, then seed after the production desktop build, then start.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, symlink, access, readdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const desktop = path.join(repository, "apps/desktop");
const command = process.argv[2];
const options = {};
for (let index = 3; index < process.argv.length; index += 2) {
  assert.ok(["--root", "--cdp-port"].includes(process.argv[index]));
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
const root = path
  .resolve(options.root ?? "/tmp/agentkib-v15-a-sandbox")
  .replace(/^\/tmp\//, "/private/tmp/");
assert.ok(
  /^\/(?:private\/)?tmp\/agentkib-v15-a-[^/]+$/.test(root),
  "Use a dedicated temporary QA root",
);
const paths = {
  home: path.join(root, "home"),
  codex: path.join(root, "codex"),
  claude: path.join(root, "claude"),
  data: path.join(root, "runtime-data"),
  profile: path.join(root, "electron-profile"),
  app: path.join(root, "desktop"),
  library: path.join(root, "library"),
};
const workspace = path.join(paths.home, "projects/northstar-api");
const configFile = path.join(root, "fixture-private.json");
const requireDesktop = createRequire(path.join(desktop, "package.json"));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function put(file, contents) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, typeof contents === "string" ? contents : json(contents), { mode: 0o600 });
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function environment(config) {
  // Do not inherit account/provider variables or real Agent configuration roots.
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    TMPDIR: root,
    LANG: "zh_CN.UTF-8",
    XDG_CONFIG_HOME: path.join(paths.home, ".config"),
    XDG_DATA_HOME: path.join(paths.home, ".local/share"),
    CODEX_HOME: paths.codex,
    CLAUDE_CONFIG_DIR: paths.claude,
    AGENTKIB_HOME: paths.library,
    AGENTKIB_BENCHMARK_DATA_DIR: paths.data,
    AGENTKIB_BENCHMARK_USER_DATA: paths.profile,
    AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
    AGENTKIB_DEV: "1",
    AGENTKIB_LOCALE: "zh-CN",
    AGENTKIB_SYSTEM_THEME: "light",
    AGENTKIB_V15_A_FIXTURE: configFile,
    ...(config ? { AGENTKIB_V15_A_CDP_PORT: String(config.cdpPort) } : {}),
  };
}

if (command === "prepare") {
  await mkdir(root, { mode: 0o700, recursive: true });
  try {
    const existing = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(existing.owner, "agentkib-v15-a-sandbox");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assert.deepEqual(
      await readdir(root),
      [],
      "Refusing to initialize an existing unowned directory",
    );
  }
  await Promise.all(
    Object.values(paths).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
  const config = {
    owner: "agentkib-v15-a-sandbox",
    repository,
    root,
    paths,
    workspace,
    webPort: await freePort(),
    mcpPort: await freePort(),
    cdpPort: Number(options["cdp-port"] ?? 19333),
  };
  await put(configFile, config);
  await put(path.join(paths.data, "preferences.json"), {
    locale_preference: "zh-CN",
    theme_preference: "light",
    accent_theme_preference: "vtron",
    close_behavior: "quit",
    session_index_enabled: true,
    local_auto_refresh_enabled: false,
    quota_auto_refresh_enabled: false,
    quota_auto_refresh_prompt_seen: true,
    mcp_network: { port: config.mcpPort, lan_enabled: false, lan_risk_accepted: false },
    onboarding: {
      acknowledged_version: 1,
      workspace_id: null,
      doctor_completed: true,
      repairable_count: 0,
      repair_applied: false,
    },
  });
  await put(path.join(paths.profile, "web/web-access.json"), {
    config: {
      enabled: true,
      port: config.webPort,
      externalOrigin: "",
      experimentalEnabled: false,
      relay: { enabled: false, brokerUrl: "https://example.invalid" },
    },
    credentials: [],
    remotePairingInitialized: false,
  });
  await put(
    path.join(workspace, "AGENTS.md"),
    "# Northstar API\nUse small changes and deterministic tests.\n",
  );
  await put(
    path.join(workspace, "CLAUDE.md"),
    "# Northstar API\nRead AGENTS.md before implementation.\n",
  );
  await put(path.join(workspace, "package.json"), { name: "northstar-api", private: true });
  await put(path.join(workspace, ".mcp.json"), {
    mcpServers: { "example-tools": { command: "/usr/bin/true", args: [] } },
  });
  await put(path.join(workspace, ".agentkib/mcp.json"), {
    schema_version: 1,
    servers: [
      {
        id: "example-tools",
        name: "Example tools",
        transport: "stdio",
        command: "/usr/bin/true",
        args: [],
        enabled: false,
        targets: ["claude-code", "codex"],
      },
    ],
  });
  for (const [name, description, directory] of [
    [
      "design-review",
      "Review typography, color and accessibility.",
      path.join(workspace, ".agents/skills/design-review"),
    ],
    [
      "api-tests",
      "Run deterministic API regression tests.",
      path.join(paths.claude, "skills/api-tests"),
    ],
  ])
    await put(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nSynthetic QA fixture only.\n`,
    );
  const project = path.join(paths.claude, "projects", workspace.replaceAll("/", "-"));
  const sessions = [
    { id: "11111111-1111-4111-8111-111111111111", title: "检查侧栏筛选状态", readable: true },
    { id: "22222222-2222-4222-8222-222222222222", title: "整理接口回归用例", readable: true },
    { id: "33333333-3333-4333-8333-333333333333", title: "旧会话目录记录", readable: false },
  ];
  for (const session of sessions.filter((item) => item.readable)) {
    const lines = [
      {
        type: "user",
        uuid: `${session.id}-u`,
        sessionId: session.id,
        cwd: workspace,
        timestamp: "2026-10-21T01:00:00Z",
        message: { role: "user", content: session.title },
      },
      {
        type: "assistant",
        uuid: `${session.id}-a`,
        parentUuid: `${session.id}-u`,
        sessionId: session.id,
        cwd: workspace,
        timestamp: "2026-10-21T01:01:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "这是合成历史内容，可用于检查会话目录、链接和状态徽标。" },
          ],
        },
      },
    ];
    await put(
      path.join(project, `${session.id}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
  }
  await put(path.join(project, "sessions-index.json"), {
    version: 1,
    entries: sessions.map((session) => ({
      sessionId: session.id,
      fullPath: path.join(project, `${session.id}.jsonl`),
      projectPath: workspace,
      summary: session.title,
      created: "2026-10-21T01:00:00Z",
      modified: "2026-10-21T01:01:00Z",
      messageCount: session.readable ? 2 : 0,
    })),
  });
  await put(path.join(paths.app, "package.json"), {
    name: "agentkib-v15-a-sandbox",
    version: "0.20.2",
    main: "bootstrap.cjs",
  });
  await put(
    path.join(paths.app, "bootstrap.cjs"),
    `require(${JSON.stringify(path.join(repository, "qa/probes/v15-a-bootstrap.cjs"))});\n`,
  );
  for (const [target, link] of [
    [path.join(desktop, "dist"), path.join(paths.app, "dist")],
    [path.join(desktop, "build"), path.join(paths.app, "build")],
    [path.join(repository, "apps/web/dist"), path.join(root, "web/dist")],
  ]) {
    await mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
    try {
      await symlink(target, link, "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const realHome = os.homedir();
  // This checkout can itself live below .codex/worktrees. Guard Codex's
  // personal data explicitly without denying the source/build being tested.
  const denied = [
    ".claude",
    ".codex/sessions",
    ".codex/archived_sessions",
    ".cursor",
    ".agents",
    ".agentkib",
    ".agentkib-dev",
    ".config/opencode",
    ".openclaw",
    ".hermes",
    ".grok",
    ".gemini",
    ".dsh",
  ].map((directory) => path.join(realHome, directory));
  denied.push("/Library/Application Support/ClaudeCode");
  const fileGuards = denied
    .map((directory) => `(deny file-read* (subpath ${JSON.stringify(directory)}))`)
    .join("");
  const personalFiles = [
    ".claude.json",
    ".codex/auth.json",
    ".codex/config.toml",
    ".codex/history.jsonl",
    ".codex/session_index.jsonl",
  ]
    .map((file) => `(deny file-read* (literal ${JSON.stringify(path.join(realHome, file))}))`)
    .join("");
  await put(
    path.join(root, "network.sb"),
    `(version 1)(allow default)(deny network*)(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(allow network* (local unix-socket))(allow network* (remote unix-socket))${fileGuards}${personalFiles}\n`,
  );
  await put(path.join(root, "inventory.json"), {
    fixture: "v15-a",
    syntheticOnly: true,
    accounts: "signed-out",
    modelRequests: 0,
    network:
      "OS sandbox blocks non-loopback; Electron additionally denies external navigation and requests",
    browserSandbox:
      "QA process only uses --no-sandbox because Chromium cannot nest its Seatbelt profile inside sandbox-exec. The outer OS network/data guards and production permission/IPC checks remain; this does not verify Chromium's renderer sandbox.",
    statusMocks:
      "Account status and computer-sharing status use synthetic payloads; web status hides real interface metadata. Login, pairing, account authorization and Chromium renderer isolation are not accepted by this visual fixture.",
    lifecycleEvidence:
      "Electron runs in its own process group with private stderr/lifecycle logs and identity-checked stop. Logs are private execution evidence and must be sanitized before adding any excerpt to QA.",
    workspace: "~/projects/northstar-api",
    skills: ["design-review", "api-tests"],
    sessions: sessions.map(({ id, title, readable }) => ({ id, title, readable })),
    remoteDisplay: { computer: "Example Computer", address: "192.0.2.10" },
    captures: [
      "desktop-library",
      "desktop-mcp",
      "desktop-remote",
      "desktop-sessions",
      "desktop-color-controls",
      "web-sessions",
      "web-connect",
    ],
  });
  console.log(
    json({
      prepared: true,
      root,
      next: "Build production sources, then seed and start using this same --root",
      cdpPort: config.cdpPort,
    }),
  );
} else {
  assert.ok(["seed", "start", "stop"].includes(command), "Use prepare, seed, start or stop");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.owner, "agentkib-v15-a-sandbox");
  assert.equal(config.repository, repository);
  const identity = (pid) => {
    try {
      return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,command="], {
        encoding: "utf8",
      }).trim();
    } catch (error) {
      if (error.status === 1) return "";
      throw error;
    }
  };
  if (command === "stop") {
    const owned = JSON.parse(await readFile(path.join(root, "owned-process.json"), "utf8"));
    const current = identity(owned.pid);
    if (current) {
      if (current !== owned.identity)
        throw new Error("Owned process identity changed; refusing to signal it");
      process.kill(owned.detached ? -owned.pid : owned.pid, "SIGTERM");
      for (let index = 0; index < 200 && identity(owned.pid) === owned.identity; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (identity(owned.pid) === owned.identity)
        throw new Error("Owned Electron process has not exited");
    }
    console.log(json({ stopped: true }));
    process.exit(0);
  }
  const electron = requireDesktop("electron");
  if (command === "seed") {
    await access(path.join(desktop, "dist-electron/backend.cjs"));
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        path.join(root, "network.sb"),
        electron,
        path.join(desktop, "dist-electron/backend.cjs"),
      ],
      {
        cwd: workspace,
        env: { ...environment(config), ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const pending = new Map();
    let sequence = 0;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line);
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      frame.error ? waiter.reject(new Error(frame.error.message)) : waiter.resolve(frame.result);
    });
    let diagnostic = "";
    child.stderr.on("data", (value) => {
      diagnostic = (diagnostic + String(value)).slice(-2000);
    });
    child.on("exit", () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Seed backend exited: ${diagnostic}`));
      }
      pending.clear();
    });
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Seed ${method} timeout`));
          }, 30_000),
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    try {
      await rpc("backend.initialize", { dataDir: paths.data });
      const context = await rpc("backend.nativeContext");
      const plan = await rpc("backend.planWorkspace", {
        operation: "add",
        path: workspace,
        context,
      });
      const inspections = await rpc("backend.inspectWorkspaces", {
        workspaces: [{ id: plan.id, path: plan.path }],
      });
      const added = await rpc("workspace.add", {
        path: workspace,
        _plan: plan,
        _inspection: inspections[0].inspection,
      });
      await rpc("workspace.refreshSessions", { workspaceId: added.id, force: true });
      const sessions = await rpc("workspace.sessions", { workspaceId: added.id });
      assert.ok(sessions.length >= 2, "Synthetic readable sessions were not indexed");
      const inventory = await rpc("skills.inventory");
      const observations = inventory.observations ?? [];
      assert.ok(observations.length >= 2, "Synthetic native skills were not discovered");
      if (observations.length) {
        const preview = await rpc("skills.prepareImports", {
          observation_ids: observations.slice(0, 2).map((item) => item.id),
        });
        await rpc("skills.applyImports", { token: preview.token, confirmed: true });
      }
      await put(path.join(root, "seed-result.json"), {
        workspaceId: added.id,
        sessionCount: sessions.length,
        observedSkills: observations.length,
      });
      console.log(
        json({
          seeded: true,
          workspaceId: added.id,
          sessionCount: sessions.length,
          observedSkills: observations.length,
        }),
      );
      await rpc("agentkib.shutdown");
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  } else {
    try {
      const previous = JSON.parse(await readFile(path.join(root, "owned-process.json"), "utf8"));
      if (identity(previous.pid) === previous.identity)
        throw new Error("This owned sandbox is already running");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const file of ["dist-electron/main.cjs", "dist-electron/preload.cjs", "dist/index.html"])
      await access(path.join(desktop, file));
    const cdpPort = Number(options["cdp-port"] ?? config.cdpPort);
    assert.ok(Number.isInteger(cdpPort) && cdpPort > 1024 && cdpPort < 65536);
    const log = await open(path.join(root, "electron.stderr.log"), "a", 0o600);
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        path.join(root, "network.sb"),
        electron,
        "--use-mock-keychain",
        "--no-sandbox",
        `--remote-debugging-port=${cdpPort}`,
        paths.app,
      ],
      {
        cwd: workspace,
        env: environment({ ...config, cdpPort }),
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await log.close();
    child.unref();
    let ownedIdentity = "";
    for (let index = 0; index < 200; index += 1) {
      ownedIdentity = identity(child.pid);
      if (ownedIdentity && !ownedIdentity.includes("/usr/bin/sandbox-exec")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      ownedIdentity && !ownedIdentity.includes("/usr/bin/sandbox-exec"),
      "Sandbox launcher did not execute Electron",
    );
    await put(path.join(root, "owned-process.json"), {
      pid: child.pid,
      identity: ownedIdentity,
      detached: true,
    });
    console.log(
      json({
        started: true,
        pid: child.pid,
        cdp: `http://127.0.0.1:${cdpPort}`,
        web: `http://127.0.0.1:${config.webPort}`,
        root,
      }),
    );
  }
}
