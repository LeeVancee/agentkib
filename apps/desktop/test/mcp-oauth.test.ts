import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { McpManager } from "../../../packages/backend/src/mcp";
import type { McpServer } from "../../../packages/backend/src/mcp-config-read";
import { oauthProvider } from "../../../packages/backend/src/mcp-oauth";

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
