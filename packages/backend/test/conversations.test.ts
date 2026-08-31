import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTranscript, prepareHandoff, sanitizeHandoffContent } from "../src/index.js";
const source = {
  id: "s1",
  workspace_id: "w1",
  agent: "codex" as const,
  archived: false,
  sidechain: false,
  availability: "readable" as const,
};
test("parses damaged transcript lines with warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-conv-"));
  const file = path.join(root, "session.jsonl");
  await writeFile(
    file,
    '{"id":"1","role":"user","content":"hello"}\ninvalid\n{"id":"2","role":"assistant","content":"world"}\n',
  );
  const page = await parseTranscript(file, "codex");
  expect(page.events).toHaveLength(2);
  expect(page.warnings).toHaveLength(1);
});
describe("handoff", () => {
  test("redacts secrets and prepares markdown", () => {
    expect(sanitizeHandoffContent("token=secret123", "/home/me").content).toContain("[REDACTED]");
    const result = prepareHandoff(
      source,
      { session_id: "s1", target_agent: "claude-code", format: "markdown" },
      {
        messages: [
          {
            id: "1",
            kind: "user-message",
            content: "Use token=secret123",
            attachment_count: 0,
            truncated: false,
          },
        ],
        omitted_tool_count: 0,
        warnings: [],
      },
      "/home/me",
    );
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.draft.redaction_count).toBeGreaterThan(0);
  });
  test("returns summary-required at message limit", () => {
    const result = prepareHandoff(
      source,
      { session_id: "s1", target_agent: "claude-code", format: "json" },
      {
        messages: Array.from({ length: 201 }, (_, i) => ({
          id: String(i),
          kind: "user-message" as const,
          content: "x",
          attachment_count: 0,
          truncated: false,
        })),
        omitted_tool_count: 0,
        warnings: [],
      },
    );
    expect(result).toMatchObject({ status: "summary-required", reason: "message-limit" });
  });
});
