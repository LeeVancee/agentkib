import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultManifest, history, workspaceSummary } from "../src/index.js";
import { execFileSync } from "node:child_process";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });
describe("adapters and git public interface", () => {
  test("builds a safe default manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentkib-adapter-"));
    await writeFile(path.join(root, "AGENTS.md"), "shared");
    await mkdir(path.join(root, ".agents/skills/demo"), { recursive: true });
    await writeFile(path.join(root, ".agents/skills/demo/SKILL.md"), "skill");
    const manifest = await defaultManifest(root);
    expect(manifest.schema_version).toBe(2);
    expect(manifest.skills[0]?.name).toBe("demo");
  });
  test("summarizes repository and reads bounded history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentkib-git-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    await writeFile(path.join(root, "a.txt"), "a");
    git(root, "add", ".");
    git(root, "commit", "-qm", "initial");
    const summary = await workspaceSummary(root);
    expect(summary?.head_oid).toHaveLength(40);
    expect((await history(root, { limit: 1 }))?.commits[0]?.subject).toBe("initial");
  });
});
