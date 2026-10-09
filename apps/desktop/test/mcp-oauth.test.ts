import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "../../../packages/backend/src/mcp";
import type { McpServer } from "../../../packages/backend/src/mcp-config-read";
import { McpOAuth, oauthProvider } from "../../../packages/backend/src/mcp-oauth";
import { Commands } from "../../../packages/backend/src/commands";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { auth } = requireBackend("@modelcontextprotocol/sdk/client/auth.js");

const serverUrl = "https://mcp.example.com/mcp";
const trustedIssuer = "https://auth.example.com";
const otherIssuer = "https://other.example.com";

function discovery(issuer: string, metadataIssuer = issuer) {
  return {
    authorizationServerUrl: issuer,
    resourceMetadata: { resource: serverUrl, authorization_servers: [issuer] },
    authorizationServerMetadata: {
      issuer: metadataIssuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    },
  };
}

function fixture(credentials?: unknown) {
  let persisted = credentials;
  const manager = {
    saveOAuthCredentials: vi.fn((_id: string, value: unknown) => {
      // Exercise the same JSON round trip as mcp.local.json without touching user files.
      persisted = JSON.parse(JSON.stringify(value));
    }),
    clearOAuthCredentials: vi.fn(() => {
      persisted = undefined;
    }),
  };
  const createProvider = () => {
    const server: Extract<McpServer, { transport: "streamable-http" }> = {
      id: "oauth-fixture",
      name: "OAuth fixture",
      transport: "streamable-http",
      url: serverUrl,
      enabled: true,
      env: {},
      headers: {},
      targets: [],
      allow_tools: [],
      lan_allow_tools: [],
      supports_parallel_tool_calls: false,
      oauth_credentials: structuredClone(persisted),
    };
    return oauthProvider(server, manager as McpManager, undefined, 12345);
  };
  return { provider: createProvider(), reload: createProvider, manager, stored: () => persisted };
}

const client = { client_id: "original-client", client_secret: "original-secret" };
const tokens = {
  access_token: "original-access",
  refresh_token: "original-refresh",
  token_type: "Bearer",
};

function interactiveFixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-interactive-oauth-"))),
    home = path.join(root, "home"),
    project = path.join(root, "project"),
    project2 = path.join(root, "project2"),
    data = path.join(root, "data"),
    environment = { HOME: home, USERPROFILE: home };
  for (const directory of [home, project, project2]) mkdirSync(directory);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanups.push(() => store.close());
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const server: McpServer = {
      id: "oauth",
      name: "OAuth",
      transport: "streamable-http",
      url: serverUrl,
      enabled: true,
      env: {},
      headers: {},
      targets: [],
      allow_tools: [],
      lan_allow_tools: [],
      supports_parallel_tool_calls: false,
    },
    credentials = {
      client_information: { ...client, issuer: trustedIssuer },
      discovery_state: discovery(trustedIssuer),
    },
    oauth = new McpOAuth(manager, () => 47653),
    events: string[] = [],
    gates = new Map<string, Promise<void>>();
  for (const [id, directory] of [
    ["one", project],
    ["two", project2],
  ] as const)
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      id,
      directory,
      id,
      id,
      "healthy",
      new Date().toISOString(),
    );
  for (const scope of [undefined, project, project2]) {
    manager.save(server, scope);
    manager.ensureOAuthStore(server, scope);
    manager.saveOAuthCredentials(server.id, credentials, scope);
  }
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === `${trustedIssuer}/token`) {
      const params = new URLSearchParams(await request.text()),
        code = params.get("code");
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code_verifier")).toBeTruthy();
      events.push(`token:${code}`);
      await gates.get("token");
      return Response.json({ access_token: `access-${code}`, token_type: "Bearer" });
    }
    if (request.url.startsWith("https://mcp.example.com/.well-known/oauth-protected-resource")) {
      events.push("discovery");
      await gates.get("discovery");
      return Response.json(discovery(trustedIssuer).resourceMetadata);
    }
    if (request.url === `${trustedIssuer}/.well-known/oauth-authorization-server`) {
      events.push("metadata");
      return Response.json(discovery(trustedIssuer).authorizationServerMetadata);
    }
    if (request.url === `${trustedIssuer}/register`) {
      events.push("register");
      const metadata = await request.json();
      return Response.json({ ...metadata, client_id: "registered-client" });
    }
    throw new Error(`Unexpected OAuth fixture request: ${request.url}`);
  });
  return {
    manager,
    oauth,
    project,
    project2,
    events,
    start: async (scope: string | undefined = project) =>
      new URL((await oauth.start("oauth", scope)).authorization_url).searchParams.get("state")!,
    globalStart: async () =>
      new URL((await oauth.start("oauth")).authorization_url).searchParams.get("state")!,
    contents: (scope: string | undefined = project) =>
      readFileSync(path.join(scope ?? home, ".agentkib/mcp.local.json"), "utf8"),
    credentials: (scope: string | undefined = project) =>
      manager.getPrivate("oauth", scope)?.oauth_credentials,
    reset: () => manager.saveOAuthCredentials("oauth", {}, project),
    hold(event: string) {
      let release!: () => void;
      gates.set(
        event,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        gates.delete(event);
        release();
      };
    },
    waitFor(event: string) {
      return vi.waitFor(() => expect(events).toContain(event), { timeout: 3000, interval: 5 });
    },
    change(kind: "url" | "credentials" | "clear" | "remove") {
      if (kind === "url") manager.save({ ...server, url: `${serverUrl}/changed` }, project);
      if (kind === "credentials")
        manager.saveOAuthCredentials(
          "oauth",
          {
            ...credentials,
            client_information: { ...client, client_id: "another-account", issuer: trustedIssuer },
          },
          project,
        );
      if (kind === "clear") manager.clearOAuthCredentials("oauth", project);
      if (kind === "remove") store.sql.run("DELETE FROM workspaces WHERE id='one'");
    },
  };
}

describe("interactive OAuth attempt ownership", () => {
  it("completes independent same-ID authorizations in two workspaces and global scope", async () => {
    const f = interactiveFixture(),
      first = await f.start(),
      second = await f.start(f.project2),
      global = await f.globalStart();
    await f.oauth.complete("oauth", "two", second);
    await f.oauth.complete("oauth", "one", first);
    await f.oauth.complete("oauth", "global", global);
    expect(f.credentials()).toMatchObject({
      token_response: { access_token: "access-one", issuer: trustedIssuer },
    });
    expect(f.credentials(f.project2)).toMatchObject({
      token_response: { access_token: "access-two" },
    });
    expect(f.manager.getPrivate("oauth")?.oauth_credentials).toMatchObject({
      token_response: { access_token: "access-global" },
    });
  });

  it.each(["url", "credentials", "clear", "remove"] as const)(
    "rejects %s changes before exchanging the authorization code",
    async (kind) => {
      const f = interactiveFixture(),
        state = await f.start();
      f.change(kind);
      const before = f.contents();
      await expect(f.oauth.complete("oauth", "old", state)).rejects.toThrow();
      expect(f.events).toEqual([]);
      expect(f.contents()).toBe(before);
    },
  );

  it.each(["url", "credentials", "clear", "remove"] as const)(
    "does not persist a delayed token exchange after %s changes",
    async (kind) => {
      const f = interactiveFixture(),
        state = await f.start(),
        release = f.hold("token"),
        completion = f.oauth.complete("oauth", "old", state),
        rejected = expect(completion).rejects.toThrow();
      await f.waitFor("token:old");
      f.change(kind);
      const before = f.contents();
      release();
      await rejected;
      expect(f.contents()).toBe(before);
    },
  );

  it("cancels an in-progress token exchange without restoring credentials", async () => {
    const f = interactiveFixture(),
      state = await f.start(),
      before = f.contents(),
      release = f.hold("token"),
      completion = f.oauth.complete("oauth", "old", state),
      rejected = expect(completion).rejects.toThrow("cancelled");
    await f.waitFor("token:old");
    f.oauth.cancel("oauth");
    release();
    await rejected;
    expect(f.contents()).toBe(before);
  });

  it("a new login replaces only its scope and rejects the old token exchange", async () => {
    const f = interactiveFixture(),
      old = await f.start(),
      other = await f.start(f.project2),
      release = f.hold("token"),
      completion = f.oauth.complete("oauth", "old", old),
      rejected = expect(completion).rejects.toThrow("replaced");
    await f.waitFor("token:old");
    const next = await f.start(),
      before = f.contents();
    release();
    await rejected;
    expect(f.contents()).toBe(before);
    await f.oauth.complete("oauth", "new", next);
    await f.oauth.complete("oauth", "other", other);
    expect(f.credentials()).toMatchObject({ token_response: { access_token: "access-new" } });
    expect(f.credentials(f.project2)).toMatchObject({
      token_response: { access_token: "access-other" },
    });
  });

  it.each(["cancel", "replace"])("rejects late discovery after %s during start", async (action) => {
    const f = interactiveFixture();
    f.reset();
    const before = f.contents(),
      release = f.hold("discovery"),
      first = f.start(),
      rejected = expect(first).rejects.toThrow(/cancelled|replaced/);
    await f.waitFor("discovery");
    if (action === "cancel") f.oauth.cancel("oauth");
    release();
    const next = action === "replace" ? f.start() : undefined;
    await rejected;
    if (next) {
      const state = await next;
      await f.oauth.complete("oauth", "new", state);
      expect(f.credentials()).toMatchObject({ token_response: { access_token: "access-new" } });
    } else {
      expect(f.contents()).toBe(before);
      expect(f.events).not.toContain("register");
    }
  });

  it("keeps the matching attempt after invalid state/issuer and prevents duplicate exchange", async () => {
    const f = interactiveFixture(),
      state = await f.start();
    await expect(f.oauth.complete("oauth", "old", "wrong-state")).rejects.toThrow("state");
    await expect(f.oauth.complete("oauth", "old", state, otherIssuer)).rejects.toThrow("issuer");
    expect(f.events).toEqual([]);
    const release = f.hold("token"),
      completion = f.oauth.complete("oauth", "one", state);
    await f.waitFor("token:one");
    await expect(f.oauth.complete("oauth", "duplicate", state)).rejects.toThrow("already");
    release();
    await completion;
    expect(f.events).toEqual(["token:one"]);
    await expect(f.oauth.complete("oauth", "replayed", state)).rejects.toThrow("No pending");
  });
});

describe("MCP OAuth credential issuer binding", () => {
  it.each([undefined, null, "", "  ", 123])(
    "does not expose credentials with an absent or invalid issuer (%s)",
    (issuer) => {
      const { provider } = fixture({
        client_id: client.client_id,
        client_information: { ...client, issuer },
        token_response: { ...tokens, issuer },
        issuer: trustedIssuer,
        discovery_state: discovery(trustedIssuer),
      });

      expect(provider.clientInformation()).toBeUndefined();
      expect(provider.tokens()).toBeUndefined();
    },
  );

  it("does not recover a legacy client id using the outer issuer", () => {
    const { provider } = fixture({ client_id: client.client_id, issuer: trustedIssuer });
    expect(provider.clientInformation()).toBeUndefined();
  });

  it("replaces legacy credentials through a complete interactive sign-in", async () => {
    const { provider, reload } = fixture({
      client_id: client.client_id,
      client_information: client,
      token_response: tokens,
      issuer: trustedIssuer,
      discovery_state: discovery(trustedIssuer),
    });
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.text();
      for (const secret of Object.values({ ...client, ...tokens }))
        expect(body).not.toContain(secret);
      if (request.url === `${trustedIssuer}/register`)
        return Response.json({
          ...provider.clientMetadata,
          client_id: "new-client",
        });
      expect(request.url).toBe(`${trustedIssuer}/token`);
      const params = new URLSearchParams(body);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("new-authorization-code");
      expect(params.get("client_id")).toBe("new-client");
      expect(params.has("client_secret")).toBe(false);
      expect(params.get("code_verifier")).toBe(provider.codeVerifier());
      return Response.json({ access_token: "new-access", token_type: "Bearer" });
    });

    expect(await auth(provider, { serverUrl, fetchFn })).toBe("REDIRECT");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.codeVerifier()).not.toBe("");
    expect(
      await auth(provider, { serverUrl, authorizationCode: "new-authorization-code", fetchFn }),
    ).toBe("AUTHORIZED");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(provider.hasTokens).toBe(true);
    expect(reload().clientInformation()).toMatchObject({
      client_id: "new-client",
      issuer: trustedIssuer,
    });
    expect(reload().tokens()).toEqual({
      access_token: "new-access",
      token_type: "Bearer",
      issuer: trustedIssuer,
    });
  });

  it("persists the SDK issuer through refresh and reload instead of trusting metadata", async () => {
    const { provider, reload, stored } = fixture({
      client_information: { ...client, issuer: trustedIssuer },
      token_response: { ...tokens, issuer: trustedIssuer },
      discovery_state: discovery(trustedIssuer, otherIssuer),
    });
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${trustedIssuer}/token`);
      const body = new URLSearchParams(await request.text());
      expect(body.get("refresh_token")).toBe(tokens.refresh_token);
      expect(body.get("client_secret")).toBe(client.client_secret);
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        token_type: "Bearer",
        scope: "read write",
        issuer: otherIssuer,
      });
    });

    expect(await auth(provider, { serverUrl, fetchFn })).toBe("AUTHORIZED");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(provider.hasTokens).toBe(true);
    expect(reload().tokens()).toEqual({
      access_token: "refreshed-access",
      refresh_token: "refreshed-refresh",
      token_type: "Bearer",
      scope: "read write",
      issuer: trustedIssuer,
    });
    expect(stored()).toMatchObject({ issuer: trustedIssuer, granted_scopes: ["read", "write"] });
  });

  it.each([undefined, trustedIssuer])(
    "does not send existing secrets to a different authorization server (issuer: %s)",
    async (issuer) => {
      const { provider, reload } = fixture({
        client_id: client.client_id,
        client_information: { ...client, issuer },
        token_response: { ...tokens, issuer },
        issuer: trustedIssuer,
        // A new server may even claim the old issuer in its metadata.
        discovery_state: discovery(otherIssuer, trustedIssuer),
      });
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe(`${otherIssuer}/register`);
        expect(request.headers.has("Authorization")).toBe(false);
        const body = await request.text();
        for (const secret of Object.values({ ...client, ...tokens }))
          expect(body).not.toContain(secret);
        return Response.json({ ...provider.clientMetadata, client_id: "new-client" });
      });

      expect(await auth(provider, { serverUrl, fetchFn })).toBe("REDIRECT");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(provider.getAuthorizationUrl()?.origin).toBe(otherIssuer);
      expect(provider.getAuthorizationUrl()?.searchParams.get("client_id")).toBe("new-client");
      expect(reload().clientInformation()).toMatchObject({
        client_id: "new-client",
        issuer: otherIssuer,
      });
    },
  );

  it("clears invalidated credentials and discovery in memory and persistent storage", () => {
    const { provider, reload, manager } = fixture();
    provider.saveClientInformation({ ...client, issuer: trustedIssuer });
    provider.saveTokens({ ...tokens, issuer: trustedIssuer });
    provider.saveDiscoveryState(discovery(trustedIssuer));
    provider.saveCodeVerifier("verifier");

    provider.invalidateCredentials("all");

    expect(manager.clearOAuthCredentials).toHaveBeenCalledWith("oauth-fixture", undefined);
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.tokens()).toBeUndefined();
    expect(provider.discoveryState()).toBeUndefined();
    expect(provider.hasTokens).toBe(false);
    expect(() => provider.codeVerifier()).toThrow("No OAuth PKCE verifier is pending");
    expect(reload().clientInformation()).toBeUndefined();
    expect(reload().tokens()).toBeUndefined();
    expect(reload().discoveryState()).toBeUndefined();
  });

  it("rediscovers and registers a new client after the SDK invalidates a rejected client", async () => {
    const { provider, manager, reload } = fixture({
      client_information: { ...client, issuer: trustedIssuer },
      token_response: { ...tokens, issuer: trustedIssuer },
      discovery_state: discovery(trustedIssuer),
    });
    const nextDiscovery = discovery(otherIssuer);
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.url);
      if (requests.length === 1) {
        expect(request.url).toBe(`${trustedIssuer}/token`);
        return Response.json({ error: "invalid_client" }, { status: 400 });
      }

      expect(request.headers.has("Authorization")).toBe(false);
      const body = await request.text();
      for (const secret of Object.values({ ...client, ...tokens }))
        expect(body).not.toContain(secret);
      if (request.url.startsWith("https://mcp.example.com/.well-known/oauth-protected-resource"))
        return Response.json(nextDiscovery.resourceMetadata);
      if (request.url === `${otherIssuer}/.well-known/oauth-authorization-server`)
        return Response.json(nextDiscovery.authorizationServerMetadata);
      if (request.url === `${otherIssuer}/register`)
        return Response.json({ ...provider.clientMetadata, client_id: "replacement-client" });
      throw new Error(`Unexpected OAuth request: ${request.url}`);
    });

    expect(await auth(provider, { serverUrl, fetchFn })).toBe("REDIRECT");
    expect(manager.clearOAuthCredentials).toHaveBeenCalledTimes(1);
    expect(requests).toContain(`${otherIssuer}/register`);
    expect(provider.getAuthorizationUrl()?.origin).toBe(otherIssuer);
    expect(provider.tokens()).toBeUndefined();
    expect(reload().tokens()).toBeUndefined();
    expect(reload().clientInformation()).toMatchObject({
      client_id: "replacement-client",
      issuer: otherIssuer,
    });
  });

  it("invalidates only the requested credential scope", () => {
    const { provider, reload } = fixture();
    const savedClient = { ...client, issuer: trustedIssuer };
    const savedTokens = { ...tokens, issuer: trustedIssuer };
    provider.saveClientInformation(savedClient);
    provider.saveTokens(savedTokens);
    provider.saveDiscoveryState(discovery(trustedIssuer));
    provider.saveCodeVerifier("verifier");

    provider.invalidateCredentials("discovery");
    expect(provider.discoveryState()).toBeUndefined();
    expect(reload().discoveryState()).toBeUndefined();
    expect(provider.tokens()).toEqual(savedTokens);
    expect(provider.clientInformation()).toEqual(savedClient);

    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(reload().tokens()).toBeUndefined();
    expect(provider.hasTokens).toBe(false);
    expect(provider.clientInformation()).toEqual(savedClient);
    expect(provider.codeVerifier()).toBe("verifier");

    provider.invalidateCredentials("client");
    expect(provider.clientInformation()).toBeUndefined();
    expect(reload().clientInformation()).toBeUndefined();
    expect(provider.codeVerifier()).toBe("verifier");

    provider.invalidateCredentials("verifier");
    expect(() => provider.codeVerifier()).toThrow("No OAuth PKCE verifier is pending");
  });
});
