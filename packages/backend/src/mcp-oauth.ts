import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServer } from "./mcp-config-read";
import { mcpToolCacheKey, type McpManager } from "./mcp";
import { canonicalize } from "./paths";

type StoredOAuthCredentials = {
  client_id?: string;
  client_information?: OAuthClientInformationMixed;
  token_response?: OAuthTokens;
  granted_scopes?: string[];
  token_received_at?: number;
  issuer?: string;
  discovery_state?: OAuthDiscoveryState;
};
type HttpMcpServer = Extract<McpServer, { transport: "streamable-http" }>;
type PersistCredentials = (write: () => void, invalidatesAuthorization: boolean) => void;

type Pending = {
  server: HttpMcpServer;
  provider: StoredOAuthProvider;
  state: string;
  completing: boolean;
  assertCurrent: () => void;
};

export class McpOAuth {
  #pending = new Map<string, Pending>();

  constructor(
    readonly manager: McpManager,
    readonly port: () => number,
  ) {}

  async start(serverId: string, project?: string): Promise<{ authorization_url: string }> {
    const scope = project ? canonicalize(project) : null,
      selectedProject = scope ?? undefined,
      key = JSON.stringify([scope, serverId]),
      server = this.manager.getPrivate(serverId, selectedProject);
    if (!server) throw new Error("Unknown MCP server");
    if (server.transport !== "streamable-http" || !("url" in server))
      throw new Error("OAuth is supported only for Streamable HTTP MCP servers");
    const serverUrl = server.url;
    this.manager.ensureOAuthStore(server, selectedProject);
    let fingerprint = mcpToolCacheKey(server, scope, this.manager.environment);
    let pending: Pending;
    const assertCurrent = () => {
      if (this.#pending.get(key) !== pending)
        throw new Error("OAuth authorization attempt was cancelled or replaced");
      const current = this.manager.getPrivate(serverId, selectedProject);
      if (!current || mcpToolCacheKey(current, scope, this.manager.environment) !== fingerprint)
        throw new Error("MCP OAuth configuration changed; start authorization again");
    };
    const provider = new StoredOAuthProvider(
      server,
      this.manager,
      selectedProject,
      this.port(),
      (write) => {
        assertCurrent();
        write();
        const current = this.manager.getPrivate(serverId, selectedProject);
        if (!current) throw new Error("MCP OAuth server was removed");
        fingerprint = mcpToolCacheKey(current, scope, this.manager.environment);
      },
    );
    const state = randomBytes(32).toString("base64url");
    provider.stateValue = state;
    provider.authorizationUrl = undefined;
    // Install the attempt before discovery starts so cancellation or a newer
    // login also invalidates metadata/registration writes that finish late.
    pending = { server, provider, state, completing: false, assertCurrent };
    this.#pending.set(key, pending);
    try {
      const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
      assertCurrent();
      const result = await auth(provider, { serverUrl });
      assertCurrent();
      const authorizationUrl = provider.getAuthorizationUrl();
      if (result !== "REDIRECT" || !authorizationUrl)
        throw new Error("MCP server did not begin an interactive OAuth flow");
      return { authorization_url: authorizationUrl.toString() };
    } catch (error) {
      if (this.#pending.get(key) === pending) this.#pending.delete(key);
      throw error;
    }
  }

  async complete(serverId: string, code: string, state: string, issuer?: string): Promise<void> {
    const candidates = [...this.#pending].filter(([, pending]) => pending.server.id === serverId),
      match = candidates.find(([, pending]) => safeEqual(state, pending.state));
    if (!match)
      throw new Error(
        candidates.length
          ? "OAuth state did not match"
          : "No pending OAuth authorization for this MCP server",
      );
    const [key, pending] = match;
    if (pending.completing) throw new Error("OAuth authorization is already being completed");
    const expectedIssuer = pending.provider.discovery?.authorizationServerMetadata?.issuer;
    if (issuer && expectedIssuer && issuer !== expectedIssuer)
      throw new Error("OAuth issuer did not match the discovered authorization server");
    pending.completing = true;
    try {
      const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
      pending.assertCurrent();
      await auth(pending.provider, { serverUrl: pending.server.url, authorizationCode: code });
      pending.assertCurrent();
      if (!pending.provider.hasTokens) throw new Error("OAuth provider did not return credentials");
    } finally {
      if (this.#pending.get(key) === pending) this.#pending.delete(key);
    }
  }

  cancel(serverId: string): void {
    for (const [key, pending] of this.#pending)
      if (pending.server.id === serverId) this.#pending.delete(key);
  }
}

export function oauthProvider(
  server: HttpMcpServer,
  manager: McpManager,
  project: string | undefined,
  port: number,
  persistCredentials?: PersistCredentials,
) {
  return new StoredOAuthProvider(server, manager, project, port, persistCredentials);
}

class StoredOAuthProvider implements OAuthClientProvider {
  readonly #redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  authorizationUrl?: URL;
  stateValue?: string;
  discovery?: OAuthDiscoveryState;
  hasTokens = false;

  constructor(
    readonly server: HttpMcpServer,
    readonly manager: McpManager,
    readonly project: string | undefined,
    port: number,
    readonly persistCredentials?: PersistCredentials,
  ) {
    this.#redirectUrl = `http://127.0.0.1:${port}/oauth/callback/${encodeURIComponent(server.id)}`;
    this.clientMetadata = {
      redirect_uris: [this.#redirectUrl],
      client_name: "AgentKib",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    this.discovery = readCredentials(server)?.discovery_state;
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  state(): string {
    return this.stateValue ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const value = readCredentials(this.server)?.client_information;
    // Legacy credentials were not bound to their authorization server. Require a new login
    // rather than trusting an issuer advertised by the current server or cached discovery.
    return hasIssuer(value) ? value : undefined;
  }

  saveClientInformation(value: OAuthClientInformationMixed): void {
    this.#update((stored) => ({
      ...stored,
      client_id: value.client_id,
      client_information: value,
    }));
  }

  tokens(): OAuthTokens | undefined {
    const value = readCredentials(this.server)?.token_response;
    return hasIssuer(value) ? value : undefined;
  }

  saveTokens(value: OAuthTokens): void {
    const scopes = value.scope?.split(/\s+/).filter(Boolean) ?? [];
    this.#update((stored) => ({
      ...stored,
      token_response: value,
      granted_scopes: scopes,
      token_received_at: Math.floor(Date.now() / 1000),
      issuer: value.issuer,
    }));
    this.hasTokens = true;
  }

  saveCodeVerifier(value: string): void {
    this.#verifier = value;
  }

  codeVerifier(): string {
    if (!this.#verifier) throw new Error("No OAuth PKCE verifier is pending");
    return this.#verifier;
  }

  redirectToAuthorization(value: URL): void {
    this.authorizationUrl = value;
  }

  getAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl;
  }

  saveDiscoveryState(value: OAuthDiscoveryState): void {
    this.#update((stored) => ({ ...stored, discovery_state: value }));
    this.discovery = value;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      this.#persist(() => {
        this.manager.clearOAuthCredentials(this.server.id, this.project);
        this.server.oauth_credentials = undefined;
      }, true);
    } else
      this.#update(
        (stored) => {
          const next = { ...stored };
          if (scope === "client") {
            delete next.client_id;
            delete next.client_information;
          }
          if (scope === "tokens") {
            delete next.token_response;
            delete next.granted_scopes;
            delete next.token_received_at;
          }
          if (scope === "discovery") delete next.discovery_state;
          return next;
        },
        scope === "client" || scope === "tokens",
      );
    if (scope === "verifier" || scope === "all") this.#verifier = undefined;
    if (scope === "discovery" || scope === "all") this.discovery = undefined;
    if (scope === "tokens" || scope === "all") this.hasTokens = false;
  }

  #verifier?: string;

  #persist(write: () => void, invalidatesAuthorization = false): void {
    if (this.persistCredentials) this.persistCredentials(write, invalidatesAuthorization);
    else write();
  }

  #update(
    transform: (value: StoredOAuthCredentials) => StoredOAuthCredentials,
    invalidatesAuthorization = false,
  ): void {
    const current = readCredentials(this.server) ?? {};
    const updated = transform(current);
    this.#persist(() => {
      this.manager.saveOAuthCredentials(this.server.id, updated, this.project);
      this.server.oauth_credentials = updated;
    }, invalidatesAuthorization);
  }
}

function readCredentials(server: McpServer): StoredOAuthCredentials | undefined {
  const value = server.oauth_credentials;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StoredOAuthCredentials)
    : undefined;
}

function hasIssuer(value: { issuer?: unknown } | undefined): boolean {
  return typeof value?.issuer === "string" && value.issuer.trim().length > 0;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
