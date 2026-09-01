import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { applyChangeSet, hashContent, planChangeSet, diagnoseWorkspace } from "../src/index.js";

test("applies changes with hash precondition", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-change-"));
  const file = path.join(root, "a.txt");
  await writeFile(file, "old");
  const set = planChangeSet(root, [
    {
      target: file,
      scope: "project",
      original_hash: hashContent("old"),
      before: "old",
      after: "new",
      risk: "low",
      validator: "text",
    },
  ]);
  const result = await applyChangeSet(set, path.join(root, "backup"));
  expect(result.applied).toEqual([file]);
  expect(await readFile(file, "utf8")).toBe("new");
});
test("doctor returns structured manifest issue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-doctor-"));
  await mkdir(path.join(root, ".agentkib"));
  await writeFile(path.join(root, ".agentkib", "manifest.yaml"), "schema_version: [\n");
  const report = await diagnoseWorkspace(root, "w");
  expect(report.summary.error_count).toBe(1);
  expect(report.issues[0]?.code).toBe("manifest.invalid");
});
test("rolls back files already applied when a later precondition fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-rollback-"));
  const first = path.join(root, "first.txt"),
    second = path.join(root, "second.txt");
  await writeFile(first, "one");
  await writeFile(second, "two");
  const set = planChangeSet(root, [
    {
      target: first,
      scope: "project",
      original_hash: hashContent("one"),
      before: "one",
      after: "changed",
      risk: "low",
      validator: "text",
    },
    {
      target: second,
      scope: "project",
      original_hash: "stale",
      before: "two",
      after: "bad",
      risk: "low",
      validator: "text",
    },
  ]);
  await expect(applyChangeSet(set, path.join(root, "backup"))).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(await readFile(first, "utf8")).toBe("one");
});
