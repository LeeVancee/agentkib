import { describe, expect, it } from "vitest";
import {
  mcpConnectionApply,
  mcpConnectionBatch,
  mcpImportApply,
  mcpImportPreview,
  mcpMigrationPreview,
  mcpPolicySave,
  mcpSave,
  mcpScope,
} from "./mcp-management-validation";

describe("desktop MCP management IPC input boundaries", () => {
  it("does not allow callers to choose native input files or bypass preview tokens", () => {
    expect(() => mcpImportPreview({ sourcePath: "/private/config", project: "/project" })).toThrow(
      "Unsupported",
    );
    expect(() =>
      mcpConnectionBatch({ workspaceId: "w", targetAgents: ["codex"], url: "http://evil" }),
    ).toThrow("Unsupported");
    expect(() => mcpConnectionApply({ token: "t", approveHome: true, changes: [] })).toThrow(
      "Unsupported",
    );
    expect(() =>
      mcpMigrationPreview({
        project: "p",
        revision: "r",
        candidateIds: ["c"],
        source_path: "/etc/config",
      }),
    ).toThrow("Unsupported");
  });
  it("accepts explicit selection and enforces boolean Agent home approval", () => {
    expect(
      mcpConnectionBatch({
        workspaceId: "w",
        targetAgents: ["codex", "hermes"],
        rebindAgents: ["hermes"],
      }),
    ).toEqual({ workspaceId: "w", targetAgents: ["codex", "hermes"], rebindAgents: ["hermes"] });
    expect(() => mcpConnectionApply({ token: "t", approveHome: "true" })).toThrow();
    expect(() => mcpConnectionBatch({ workspaceId: "w", targetAgents: ["unknown"] })).toThrow(
      "Unsupported agent",
    );
  });
  it("requires explicit secret operations and rejects values on keep/delete", () => {
    const request = {
      revision: "r",
      server: { id: "one" },
      secretOperations: {
        env: { TOKEN: { action: "replace", value: "new" } },
        headers: { Authorization: { action: "delete" } },
      },
    };
    expect(mcpSave(request)).toMatchObject(request);
    expect(() =>
      mcpSave({
        ...request,
        secretOperations: { env: { TOKEN: { action: "keep", value: "old" } } },
      }),
    ).toThrow("Unexpected secret value");
    expect(() => mcpSave({ ...request, secretOperations: { password: "raw" } })).toThrow(
      "Unsupported",
    );
  });
  it("keeps policy inherit, all and selected-empty distinct", () => {
    const rules = [
      { agent: "codex", server_id: null, mode: "selected", tools: [] },
      { agent: "hermes", server_id: "one", mode: "inherit", tools: [] },
    ];
    expect(mcpPolicySave({ revision: "r", rules })).toEqual({
      project: undefined,
      revision: "r",
      rules,
    });
    expect(() => mcpPolicySave({ revision: "r", rules: [{ ...rules[0], mode: "allow" }] })).toThrow(
      "Invalid policy mode",
    );
  });
  it("bounds import batches and permits exactly one source kind", () => {
    expect(() => mcpImportPreview({ text: "{}", candidateIds: ["c"] })).toThrow(
      "one import source",
    );
    expect(() => mcpImportPreview({ text: "x".repeat(1024 * 1024 + 1) })).toThrow("Invalid");
    expect(() =>
      mcpImportApply({
        token: "t",
        revision: "r",
        selections: [{ key: "x", action: "overwrite" }],
      }),
    ).toThrow("Invalid import action");
    expect(() => mcpScope({ project: "/project", owner: true })).toThrow("Unsupported");
  });
});
