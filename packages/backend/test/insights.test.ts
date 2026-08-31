import { test, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectGit, identityAliases, normalizeIdentity } from "../src/index.js";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });
test("normalizes and aliases Git identities", () => {
  expect(normalizeIdentity(" User@Example.COM ")).toBe("user@example.com");
  expect(identityAliases(["a@x"])).toContain("a@x");
});
test("collects bounded Git commits and configured identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-insights-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  await writeFile(path.join(root, "a"), "a");
  git(root, "add", ".");
  git(root, "commit", "-qm", "one");
  const snapshot = await collectGit(root, { identity_emails: ["DEV@example.com"] });
  expect(snapshot?.commits).toHaveLength(1);
  expect(snapshot?.identities[0]?.email).toBe("dev@example.com");
});
