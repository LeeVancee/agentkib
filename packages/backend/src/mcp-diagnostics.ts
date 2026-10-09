import type { McpDiagnosticMessage } from "@agentkib/runtime-protocol";

/** Keys and parameters must be chosen by the backend, never from parser/private error text. */
export function mcpDiagnostic(
  code: string,
  params?: McpDiagnosticMessage["params"],
): McpDiagnosticMessage {
  return { key: `mcp.manage.diagnostic.${code}`, ...(params ? { params } : {}) };
}

export class McpDiagnosticError extends Error {
  readonly diagnostic: McpDiagnosticMessage;
  constructor(message: string, code: string, params?: McpDiagnosticMessage["params"]) {
    super(message);
    this.diagnostic = mcpDiagnostic(code, params);
  }
}

export function mcpErrorDiagnostic(
  error: unknown,
  fallback = "invalid_entry",
): McpDiagnosticMessage {
  return error instanceof McpDiagnosticError ? error.diagnostic : mcpDiagnostic(fallback);
}
