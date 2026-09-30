import path from "node:path";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type RuntimeRpcError,
} from "@agentkib/runtime-protocol";
import { BackendStore } from "./store";
import {
  preferenceSnapshot,
  writePreference,
  writePreferences,
  readPreferences,
  readOnboarding,
  parseQuotaPreferences,
  normalizeQuotaPreferences,
} from "./preferences";
import {
  refreshReceipt,
  type NativeContext,
  type WorkspacePlan,
  type WorkspaceInspection,
  type DiscoverySnapshot,
  type DiscoveryPlan,
  type InspectedWorkspace,
} from "./workspaces";

import {
  BACKEND_INITIALIZE,
  BACKEND_PREFERENCES,
  BACKEND_PLAN_WORKSPACE,
  BACKEND_PLAN_DISCOVERY,
} from "./migration";

class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class TypeScriptBackend {
  #store?: BackendStore;
  #dataDir?: string;

  constructor(readonly environment: NodeJS.ProcessEnv = process.env) {}

  close(): void {
    this.#store?.close();
    this.#store = undefined;
    this.#dataDir = undefined;
  }

  handle(value: unknown): {
    jsonrpc: "2.0";
    id: unknown;
    result?: unknown;
    error?: RuntimeRpcError;
  } {
    const id = typeof value === "object" && value !== null && "id" in value ? value.id : null;
    try {
      if (
        typeof value !== "object" ||
        value === null ||
        !("jsonrpc" in value) ||
        value.jsonrpc !== "2.0" ||
        !("method" in value) ||
        typeof value.method !== "string"
      ) {
        throw new RpcFault(-32600, "Invalid JSON-RPC request");
      }
      const params = object("params" in value ? value.params : {});
      return { jsonrpc: "2.0", id, result: this.#request(value.method, params) };
    } catch (error) {
      const fault =
        error instanceof RpcFault
          ? error
          : new RpcFault(-32000, "AgentKib command failed", {
              detail: error instanceof Error ? error.message : "Backend operation failed",
            });
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: fault.code,
          message: fault.message,
          ...(fault.data === undefined ? {} : { data: fault.data }),
        },
      };
    }
  }

  #request(method: string, params: Record<string, unknown>): unknown {
    if (method === RUNTIME_METHODS.handshake) {
      const client = object(params.client);
      if (
        !Number.isInteger(params.protocolVersion) ||
        typeof client.name !== "string" ||
        typeof client.version !== "string"
      )
        throw new RpcFault(-32602, "Invalid handshake parameters");
      if (params.protocolVersion !== PROTOCOL_VERSION)
        throw new RpcFault(-32001, "Incompatible protocol version", {
          expected: PROTOCOL_VERSION,
          received: params.protocolVersion,
          client,
        });
      return {
        protocolVersion: PROTOCOL_VERSION,
        runtime: {
          name: "agentkib-typescript",
          version: this.environment.AGENTKIB_APP_VERSION ?? "0.13.0",
        },
        pid: process.pid,
        capabilities: [
          "shared-schema-15",
          "preferences",
          "cached-workspace-reads",
          "workspace-writes",
          "discovery-persistence",
        ],
      };
    }
    if (method === RUNTIME_METHODS.shutdown) {
      this.close();
      return null;
    }
    if (method === BACKEND_INITIALIZE) {
      if (typeof params.dataDir !== "string" || !path.isAbsolute(params.dataDir))
        invalid("Backend data directory must be absolute");
      const dataDir = params.dataDir as string;
      const store = new BackendStore(path.join(dataDir, "agentkib.db"));
      this.close();
      this.#store = store;
      this.#dataDir = dataDir;
      return null;
    }
    if (!this.#store || !this.#dataDir)
      throw new RpcFault(-32000, "AgentKib command failed", {
        detail: "TypeScript backend has not been initialized",
      });
    switch (method) {
      case BACKEND_PLAN_WORKSPACE: {
        if (params.operation !== "add" && params.operation !== "refresh")
          invalid("Invalid workspace operation");
        const value = string(params, params.operation === "add" ? "path" : "id");
        const context = object(params.context) as unknown as NativeContext;
        return this.#store.workspaces.prepareWorkspace(params.operation, value, context);
      }
      case BACKEND_PLAN_DISCOVERY:
        return this.#store.workspaces.prepareDiscovery(
          object(params.snapshot) as unknown as DiscoverySnapshot,
          object(params.context) as unknown as NativeContext,
        );
      case RUNTIME_METHODS.addWorkspace:
      case RUNTIME_METHODS.refreshWorkspace: {
        string(params, method === RUNTIME_METHODS.addWorkspace ? "path" : "id");
        const plan = object(params._plan) as unknown as WorkspacePlan;
        const inspection = object(params._inspection) as unknown as WorkspaceInspection;
        const id =
          method === RUNTIME_METHODS.addWorkspace
            ? this.#store.workspaces.addWorkspace(plan, inspection)
            : this.#store.workspaces.refreshWorkspace(plan, inspection);
        return this.#store.getWorkspace(id);
      }
      case RUNTIME_METHODS.excludeWorkspace:
        this.#store.workspaces.excludeWorkspace(string(params, "id"));
        return null;
      case RUNTIME_METHODS.restoreExcludedWorkspace:
        this.#store.workspaces.restoreExcludedWorkspace(string(params, "path"));
        return null;
      case RUNTIME_METHODS.addScanRoot: {
        const value = string(params, "path");
        const depth = unsigned(params.maxDepth, "maxDepth");
        return this.#store.workspaces.addScanRoot(value, depth);
      }
      case RUNTIME_METHODS.removeScanRoot:
        this.#store.workspaces.removeScanRoot(string(params, "id"));
        return null;
      case RUNTIME_METHODS.refreshDiscovery: {
        const plan = object(params._plan) as unknown as DiscoveryPlan;
        const snapshot = object(params._snapshot) as unknown as DiscoverySnapshot;
        if (!Array.isArray(params._inspections)) invalid("Missing workspace inspections");
        const queued = string(params, "_queuedAt");
        const started = string(params, "_startedAt");
        this.#store.workspaces.syncDiscovery(
          plan,
          snapshot,
          params._inspections as InspectedWorkspace[],
          started,
        );
        return refreshReceipt(queued, started);
      }
      case RUNTIME_METHODS.discoveryReport:
        return this.#store.workspaces.discoveryReport();
      case RUNTIME_METHODS.quotaPreferences:
        return (
          parseQuotaPreferences(readPreferences(this.#dataDir).quota_popover) ?? {
            hidden_providers: [],
            hidden_windows: [],
          }
        );
      case RUNTIME_METHODS.setQuotaPreferences: {
        const preferences = parseQuotaPreferences(params.preferences);
        if (!preferences) invalid("Invalid quota preferences");
        const normalized = normalizeQuotaPreferences(preferences);
        writePreference(this.#dataDir, "quota_popover", normalized);
        return normalized;
      }
      case RUNTIME_METHODS.setSessionIndexEnabled:
      case RUNTIME_METHODS.setLocalAutoRefresh:
      case RUNTIME_METHODS.setQuotaPromptSeen:
      case RUNTIME_METHODS.setQuotaAutoRefresh: {
        const keys: Record<string, string> = {
          [RUNTIME_METHODS.setSessionIndexEnabled]: "session_index_enabled",
          [RUNTIME_METHODS.setLocalAutoRefresh]: "local_auto_refresh_enabled",
          [RUNTIME_METHODS.setQuotaPromptSeen]: "quota_auto_refresh_prompt_seen",
          [RUNTIME_METHODS.setQuotaAutoRefresh]: "quota_auto_refresh_enabled",
        };
        const aliases = ["value", "enabled", "seen"].filter((key) => key in params);
        if (aliases.length !== 1 || typeof params[aliases[0]!] !== "boolean")
          invalid("Expected exactly one boolean value");
        writePreferences(this.#dataDir, {
          [keys[method]!]: params[aliases[0]!],
          ...(method === RUNTIME_METHODS.setQuotaAutoRefresh
            ? { quota_auto_refresh_prompt_seen: true }
            : {}),
        });
        return this.#preferences();
      }
      case RUNTIME_METHODS.updateOnboarding: {
        const event = object(params.event);
        const preferences = readOnboarding(readPreferences(this.#dataDir).onboarding);
        switch (event.event) {
          case "doctor-completed": {
            const id = string(event, "workspace_id");
            const count = unsigned(event.repairable_count, "repairable_count");
            if (preferences.workspace_id !== id) preferences.repair_applied = false;
            preferences.workspace_id = id;
            preferences.doctor_completed = true;
            preferences.repairable_count = count;
            if (count === 0) preferences.acknowledged_version = 1;
            break;
          }
          case "repair-applied":
            preferences.workspace_id = string(event, "workspace_id");
            preferences.repair_applied = true;
            break;
          case "dismissed":
            preferences.acknowledged_version = 1;
            break;
          case "restarted":
            Object.assign(preferences, readOnboarding(null));
            break;
          default:
            invalid("Invalid onboarding event");
        }
        const { workspace_id, ...rest } = preferences;
        writePreference(this.#dataDir, "onboarding", {
          ...rest,
          ...(workspace_id === null ? {} : { workspace_id }),
        });
        return this.#preferences();
      }
      case RUNTIME_METHODS.listWorkspaces:
        return this.#store.listWorkspaces();
      case RUNTIME_METHODS.listScanRoots:
        return this.#store.listScanRoots();
      case RUNTIME_METHODS.listExcludedWorkspaces:
        return this.#store.listExcludedWorkspaces();
      case RUNTIME_METHODS.listActivity: {
        const limit = params.limit === undefined ? 200 : params.limit;
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
          invalid("Activity limit must be a nonnegative integer");
        return this.#store.listActivity(limit as number);
      }
      case BACKEND_PREFERENCES:
        return this.#preferences();
      case RUNTIME_METHODS.setCloseBehavior: {
        const value = params.value ?? null;
        if (value !== null && value !== "minimize-to-tray" && value !== "quit")
          invalid("Invalid close behavior");
        writePreference(this.#dataDir, "close_behavior", value);
        return this.#preferences();
      }
      case RUNTIME_METHODS.setLocale: {
        if (typeof params.preference !== "string") invalid("Locale preference must be a string");
        if (!["system", "en-US", "zh-CN", "zh-TW", "ja-JP"].includes(params.preference))
          throw new Error(`Unsupported locale preference: ${params.preference}`);
        return this.#setChoice(params, "locale_preference", [
          "system",
          "en-US",
          "zh-CN",
          "zh-TW",
          "ja-JP",
        ]);
      }
      case RUNTIME_METHODS.setThemePreference:
        return this.#setChoice(params, "theme_preference", ["system", "light", "dark"]);
      case RUNTIME_METHODS.setAccentThemePreference:
        return this.#setChoice(params, "accent_theme_preference", [
          "minimal-neutral",
          "vtron",
          "claude",
          "sakura",
          "ocean-breeze",
        ]);
      case RUNTIME_METHODS.setAppIconPreference:
        return this.#setChoice(params, "app_icon_preference", ["white", "black"]);
      case RUNTIME_METHODS.setSidebarWidthPreference: {
        const value = params.preference;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535)
          invalid("Sidebar width preference must be an unsigned 16-bit integer");
        if (value < 250 || value > 400)
          throw new Error("Sidebar width preference must be an integer between 250 and 400");
        writePreference(this.#dataDir, "sidebar_width_preference", value);
        return this.#preferences();
      }
      default:
        throw new RpcFault(-32601, "Method not found");
    }
  }

  #setChoice(params: Record<string, unknown>, key: string, values: string[]): unknown {
    if (typeof params.preference !== "string" || !values.includes(params.preference))
      invalid(`Invalid ${key}`);
    writePreference(this.#dataDir!, key, params.preference);
    return this.#preferences();
  }

  #preferences() {
    return preferenceSnapshot(this.#dataDir!, this.environment);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("Parameters must be an object");
  return value as Record<string, unknown>;
}

function invalid(detail: string): never {
  throw new RpcFault(-32602, "Invalid method parameters", { detail });
}

function string(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") invalid(`${key} must be a string`);
  return value;
}
function unsigned(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(`${key} must be a nonnegative integer`);
  return value;
}
