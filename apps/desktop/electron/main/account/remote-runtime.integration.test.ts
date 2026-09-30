// @vitest-environment node
import { expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopRuntimeHost } from "../runtime-host";
import { WebAccessService } from "../web/service";
import { DesktopAccountService, ACCOUNT_API, ACCOUNT_ORIGIN } from "./service";

// Opt-in local integration: real account HTTP handlers, WebAccessService and packaged Rust.
// The account store is disposable memory; PG durability has a separate backend integration test.
// A fixed Codex transcript is read by the real runtime. No model turn, public relay or native user data is used.
// Storage encryption is an injected test adapter; OS keychain verification belongs to the Electron smoke.
const runtimePath = process.env.AGENTKIB_ACCOUNT_TEST_RUNTIME;
const backendRoot = process.env.AGENTKIB_ACCOUNT_TEST_BACKEND;
it.skipIf(!runtimePath || !backendRoot)(
  "account-selected device requires a real eight-digit grant before packaged runtime history is readable",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "agentkib-account-runtime-"));
    const localHome = join(scratch, "home");
    const codexHome = join(scratch, "codex");
    const runtimeData = join(scratch, "runtime");
    const workspace = join(scratch, "workspace");
    const webData = join(scratch, "web");
    for (const directory of [localHome, codexHome, runtimeData, workspace, webData])
      await mkdir(directory);
    const port = async () => {
      const listener = createServer();
      await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
      const value = (listener.address() as { port: number }).port;
      await new Promise<void>((done) => listener.close(() => done()));
      return value;
    };
    await writeFile(
      join(runtimeData, "preferences.json"),
      JSON.stringify({
        mcp_network: { port: await port(), lan_enabled: false, lan_risk_accepted: false },
        local_auto_refresh: false,
        quota_auto_refresh: false,
      }),
    );
    const session = randomUUID();
    const transcript = join(codexHome, "safe-session.jsonl");
    const marker = `AK-LOCAL-READ-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    await writeFile(
      transcript,
      [
        {
          timestamp,
          type: "session_meta",
          payload: {
            id: session,
            cwd: workspace,
            source: "cli",
            timestamp,
            cli_version: "0.155.1",
            originator: "codex-cli",
          },
        },
        {
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Local account remote-access acceptance fixture" },
            ],
          },
        },
        {
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: marker }],
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(codexHome, "state_1.sqlite"));
    database.exec(
      "CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, git_branch TEXT, archived INTEGER, source TEXT)",
    );
    database
      .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, 'main', 0, 'cli')")
      .run(session, transcript, workspace, "Account local acceptance", Date.now(), Date.now());
    database.close();
    const runtime = new DesktopRuntimeHost({
      executablePath: resolve(runtimePath!),
      clientVersion: "0.13.0",
      maxRestarts: 0,
      environment: {
        ...process.env,
        HOME: localHome,
        USERPROFILE: localHome,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(localHome, ".claude"),
        AGENTKIB_BENCHMARK_DATA_DIR: runtimeData,
        AGENTKIB_APP_FLAVOR: "ai.agentkib.acceptance",
      },
    });
    let remote: WebAccessService | undefined;
    let account: DesktopAccountService | undefined;
    let accountServer: ReturnType<typeof createServer> | undefined;
    try {
      await runtime.start();
      const target = await runtime.request<{ id: string }>("workspace.add", { path: workspace });
      const discovered = await runtime.request<Array<{ id: string }>>("workspace.refreshSessions", {
        workspaceId: target.id,
        force: true,
      });
      expect(discovered).toHaveLength(1);
      const sessionId = discovered[0].id;
      const webPort = await port();
      const webOrigin = `http://127.0.0.1:${webPort}`;
      remote = new WebAccessService({
        dataDir: webData,
        staticDir: scratch,
        runtimeRequest: (params) => runtime.request("web.request", params),
        workspaceRequest: () => runtime.request("workspaces.list", {}),
        verifiedCodex: true,
      });
      await remote.initialize();
      await remote.request({
        operation: "configure",
        enabled: true,
        port: webPort,
        externalOrigin: "",
        experimentalEnabled: false,
        allowedWorkspaceIds: [],
      });

      const loadBackend = (relative: string) =>
        import(/* @vite-ignore */ pathToFileURL(join(backendRoot!, relative)).href);
      const { RelayBroker } = await loadBackend("services/relay/src/broker.mjs");
      const { Accounts } = await loadBackend("services/relay/src/accounts.mjs");
      const { createHandlers } = await loadBackend("services/relay/src/server.mjs");
      const { memoryStore } = await loadBackend("services/relay/test/helpers.mjs");
      const config = {
        controlDomain: "control.remote.agentkib.com",
        previewDomain: "preview.remote.agentkib.com",
        tunnelHost: "tunnel.remote.agentkib.com",
        accountOrigin: ACCOUNT_ORIGIN,
        accountEnabled: true,
        dataKey: randomBytes(32).toString("hex"),
      };
      const broker = await RelayBroker.open(config, {
        store: memoryStore(),
        issueCertificate: async () => {
          throw new Error("Public certificate issuance excluded from local test");
        },
      });
      accountServer = createServer(
        createHandlers(broker, config, new Map(), { trustProxyHeader: false }).api,
      );
      await new Promise<void>((done) => accountServer!.listen(0, "127.0.0.1", done));
      const accountBase = `http://127.0.0.1:${(accountServer.address() as { port: number }).port}`;
      const accounts = new Accounts(broker, config);
      const { signupCode } = await accounts.signupCode();
      let accountCookie = "";
      async function accountHttp(path: string, body?: object) {
        const response = await fetch(accountBase + path, {
          method: body ? "POST" : "GET",
          headers: {
            origin: ACCOUNT_ORIGIN,
            "x-agentkib-request": "1",
            "content-type": "application/json",
            cookie: accountCookie,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.headers.has("set-cookie"))
          accountCookie = response.headers.get("set-cookie")!.split(";")[0];
        expect(response.status).toBeLessThan(300);
        return response.json();
      }
      await accountHttp("/v1/auth/signup", {
        signupCode,
        username: "runtime-check",
        password: "Acceptance fixture password!2026",
      });
      const { invitation } = await broker.invite();
      const credential = randomBytes(32).toString("base64url");
      const device = await broker.register(invitation, "127.0.0.1", {
        registrationId: randomBytes(24).toString("base64url"),
        credential,
      });
      const identityDirectory = join(
        webData,
        "relay",
        createHash("sha256").update(ACCOUNT_API).digest("hex").slice(0, 24),
      );
      await mkdir(identityDirectory, { recursive: true });
      await writeFile(
        join(identityDirectory, "registration.json"),
        JSON.stringify({ ...device, credential, brokerUrl: ACCOUNT_API }),
        { mode: 0o600 },
      );
      let loginUrl = "";
      const secret = randomBytes(32);
      const transform = (value: Buffer) =>
        Buffer.from(value.map((byte, index) => byte ^ secret[index % secret.length]));
      account = new DesktopAccountService({
        directory: join(scratch, "account"),
        storage: {
          available: () => true,
          encrypt: (value) => transform(Buffer.from(value)),
          decrypt: (value) => transform(value).toString(),
        },
        openExternal: async (value) => {
          loginUrl = value;
        },
        identity: () => remote!.accountIdentity(),
        prepareIdentityClaim: (id) => remote!.prepareAccountClaim(id),
        bindIdentity: (id) => remote!.bindAccountIdentity(id),
        pauseRemote: () => remote!.request({ operation: "relay-stop" }),
        fetch: (url, options) => fetch(accountBase + new URL(url.toString()).pathname, options),
      });
      await account.initialize();
      await account.request({ operation: "login" });
      const params = new URLSearchParams(new URL(loginUrl).hash.split("?")[1]);
      const authorization = await accountHttp("/v1/auth/desktop/authorize", {
        redirectUri: params.get("redirectUri"),
        state: params.get("state"),
        codeChallenge: params.get("codeChallenge"),
      });
      expect((await fetch(authorization.redirectUri)).status).toBe(200);
      expect((await account.request({ operation: "status" })).phase).toBe("signed-in");
      expect((await account.request({ operation: "claim" })).device?.ownership).toBe("owned");
      const selected = (await accountHttp("/v1/account/devices")).devices[0];
      expect(selected.deviceId).toBe(device.deviceId);
      expect(selected.controlHost).toBe(device.controlHost);
      // Explicit test-only address mapping. This does not verify DNS, public TLS or FRP.
      expect((await remote.accountIdentity())?.deviceId).toBe(selected.deviceId);
      const initial = await fetch(`${webOrigin}/api/web/v1/access`);
      const access = await initial.json();
      const browserCookie = initial.headers.get("set-cookie")!.split(";")[0];
      async function browser(path: string, body?: object) {
        return fetch(`${webOrigin}/api/web/v1/${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            cookie: browserCookie,
            origin: webOrigin,
            "x-csrf-token": access.csrfToken,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      }
      expect((await browser("catalog")).status).toBe(401);
      const accountToken = await account.accessToken();
      expect(
        (
          await fetch(`${webOrigin}/api/web/v1/catalog`, {
            headers: { authorization: `Bearer ${accountToken}` },
          })
        ).status,
      ).not.toBe(200);
      const code = (await remote.request({ operation: "generate-code" })).code!.value;
      expect(code).toMatch(/^\d{8}$/);
      const paired = await browser("pair", { code, name: "Isolated runtime browser" });
      expect(paired.status).toBe(200);
      const pairedDevice = (await paired.json()).device;
      expect(pairedDevice.accessMode).toBe("full");
      const catalogResponse = await browser("catalog");
      expect(catalogResponse.status).toBe(200);
      expect(
        (await catalogResponse.json()).sessions.map((value: { id: string }) => value.id),
      ).toContain(sessionId);
      const eventsResponse = await browser(`events?sessionId=${sessionId}`);
      expect(eventsResponse.status).toBe(200);
      expect(JSON.stringify(await eventsResponse.json())).toContain(marker);
      expect((await account.request({ operation: "logout" })).phase).toBe("signed-out");
      const persisted = JSON.parse(await readFile(join(webData, "web-access.json"), "utf8"));
      expect(persisted.credentials).toHaveLength(1);
      expect(persisted.config.relay?.enabled).not.toBe(true);
      expect((await remote.accountIdentity())?.accountId).toBe(selected.accountId);
      expect(await runtime.request("workspaces.list", {})).toHaveLength(1);
      await remote.request({ operation: "revoke", id: pairedDevice.id });
      expect((await browser(`events?sessionId=${sessionId}`)).status).not.toBe(200);
    } finally {
      account?.shutdown();
      await remote?.shutdown();
      await runtime.stop();
      if (accountServer) {
        accountServer.closeAllConnections();
        await new Promise<void>((done) => accountServer!.close(() => done()));
      }
      await rm(scratch, { recursive: true, force: true });
    }
  },
  60_000,
);
