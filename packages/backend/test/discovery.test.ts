import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discover } from "../src/index.js";

test("discovers marked project roots, deduplicates canonical paths, and ignores probes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-discovery-"));
  await mkdir(path.join(root, "project", ".git"), { recursive: true });
  await mkdir(path.join(root, "probe"), { recursive: true });
  await writeFile(path.join(root, "probe", ".codexbar-session-id"), "probe");
  await mkdir(path.join(root, "probe", ".git"));
  const result = await discover([
    { path: root, max_depth: 3 },
    { path: path.join(root, "project"), max_depth: 2 },
  ]);
  expect(result.errors).toEqual([]);
  expect(result.candidates.filter((c) => c.path.endsWith("project"))).toHaveLength(1);
  expect(result.candidates.some((c) => c.path.endsWith("probe"))).toBe(false);
});
