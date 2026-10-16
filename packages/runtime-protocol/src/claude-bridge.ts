/** Private local transport. These credentials never cross Renderer or Web RPC. */
export const CLAUDE_BRIDGE_PROTOCOL = 1 as const;
export const CLAUDE_BRIDGE_PLUGIN_VERSION = "0.1.0" as const;
export const CLAUDE_BRIDGE_CLI_VERSION = "2.1.301" as const;
export const CLAUDE_BRIDGE_PATHS = {
  pair: "/v1/pair",
  reconnect: "/v1/reconnect",
  events: "/v1/events",
  commands: "/v1/commands",
  results: "/v1/results",
} as const;

export interface ClaudeBridgeTicket {
  protocol: 1;
  socketPath: string;
  ticket: string;
}

export interface ClaudeBridgeIdentity {
  protocol: 1;
  nativeId: string;
  cwd: string;
  cliVersion: "2.1.301";
  instanceId: string;
  pluginVersion: "0.1.0";
}

export interface ClaudeBridgePairRequest extends ClaudeBridgeIdentity {
  ticket: string;
}

export interface ClaudeBridgeConnection {
  protocol: 1;
  bindingId: string;
  token: string;
  leaseId: string;
  credentialPath: string;
}

/** Backend writes this file with mode 0600; the plugin only reads it using $.fs. */
export interface ClaudeBridgeCredential {
  protocol: 1;
  socketPath: string;
  bindingId: string;
  token: string;
  nativeId: string;
  cwd: string;
  cliVersion: "2.1.301";
  pluginVersion: "0.1.0";
}

export interface ClaudeBridgeReconnectRequest extends ClaudeBridgeIdentity {
  bindingId: string;
}

/** Every authenticated request also carries Authorization: Bearer <token>. */
export interface ClaudeBridgeLease {
  bindingId: string;
  leaseId: string;
  nativeId: string;
  cwd: string;
  instanceId: string;
}

export interface ClaudeBridgeCapabilities {
  read: boolean;
  send: boolean;
  stop: boolean;
  approve: false;
  answer: false;
}

export interface ClaudeBridgeMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ClaudeBridgeTool {
  id: string;
  name: string;
  input: string;
  output?: string;
  status: "running" | "completed" | "failed";
}

export interface ClaudeBridgeUsage {
  tokens: number | null;
  window: number | null;
  percent: number | null;
  observedAt: number;
}

export interface ClaudeBridgeSnapshot extends ClaudeBridgeIdentity {
  revision: number;
  currentTurnId: string | null;
  status: "idle" | "running" | "waiting" | "disconnected";
  waiting: "permission" | "question" | "unknown" | null;
  messages: ClaudeBridgeMessage[];
  toolItems: ClaudeBridgeTool[];
  streamText: string;
  usage: ClaudeBridgeUsage | null;
  capabilities: ClaudeBridgeCapabilities;
}

export type ClaudeBridgeEvent =
  | { type: "gap"; revision: number }
  | { type: "snapshot"; snapshot: ClaudeBridgeSnapshot }
  | { type: "turn-start"; turnId: string; revision: number }
  | { type: "text"; turnId: string; text: string; revision: number }
  | {
      type: "turn-complete";
      turnId: string;
      text: string;
      aborted: boolean;
      revision: number;
    }
  | { type: "tool-start" | "tool-complete"; tool: ClaudeBridgeTool; revision: number }
  | { type: "invalidated"; reason: string; revision: number };

export interface ClaudeBridgeSequencedEvent {
  seq: number;
  event: ClaudeBridgeEvent;
}

export interface ClaudeBridgeEventsRequest extends ClaudeBridgeLease {
  events: ClaudeBridgeSequencedEvent[];
}

export interface ClaudeBridgeEventsResponse {
  ackSeq: number;
}

export type ClaudeBridgeCommand =
  | {
      commandId: string;
      kind: "send";
      requestId: string;
      text: string;
      expectedRevision: number;
    }
  | {
      commandId: string;
      kind: "stop";
      turnId: string;
      expectedRevision: number;
    };

export interface ClaudeBridgeCommandsRequest extends ClaudeBridgeLease {
  afterCommandId: string | null;
  waitMs: number;
}

export interface ClaudeBridgeCommandsResponse {
  commands: ClaudeBridgeCommand[];
}

export interface ClaudeBridgeResultRequest extends ClaudeBridgeLease {
  commandId: string;
  status: "accepted" | "rejected" | "unknown";
  reason?: string;
  revision: number;
  turnId?: string;
}
