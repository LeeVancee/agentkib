import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listWorkspaceSessions } from "../src/index.js";
test("indexes Codex transcript metadata with fresh status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-index-"));
  await mkdir(path.join(root, ".codex"));
  await writeFile(
    path.join(root, ".codex", "session.jsonl"),
    '{"id":"s1","title":"Demo","timestamp":"2026-01-01T00:00:00Z"}\n{"role":"user","content":"hi"}\n',
  );
  const result = await listWorkspaceSessions(root, "codex");
  expect(result.sessions[0]).toMatchObject({ id: "s1", title: "Demo", availability: "readable" });
  expect(result.status.freshness).toBe("fresh");
});
