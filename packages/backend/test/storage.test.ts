import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanStorage } from "../src/index.js";

test("scans storage recursively with totals and skips symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-storage-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.txt"), "hello");
  await symlink(path.join(root, "src"), path.join(root, "link"));
  const result = await scanStorage({ id: "w", name: "W", path: root });
  expect(result.quality).toBe("complete");
  expect(result.logical_bytes).toBe(5);
  expect(result.root?.children.some((child) => child.name === "link")).toBe(false);
});
test("supports cancellation and reports partial quality", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-storage-cancel-"));
  const controller = new AbortController();
  controller.abort();
  const result = await scanStorage({ id: "w", name: "W", path: root }, [], controller.signal);
  expect(result.quality).toBe("partial");
  expect(result.error_key).toBe("storage.scanStopped");
});
