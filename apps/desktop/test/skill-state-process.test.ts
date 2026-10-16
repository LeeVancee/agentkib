import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { withSkillLocks } from "../../../packages/backend/src/skill-state";

const folders: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill();
      await closed;
    }),
  );
  await Promise.all(
    folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});

// Load the actual source with the existing Vite SSR transformer. No repository
// build, private Agent configuration or duplicate lock implementation is involved.
const childCode = `
import { createServer } from 'vite';
const server = await createServer({ configFile: false, logLevel: 'silent', cacheDir: process.env.HOME + '/vite-cache',
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { withSkillLocks } = await server.ssrLoadModule(process.env.SKILL_STATE_MODULE);
  await withSkillLocks([process.env.SKILL_LOCK_ROOT], async () => {
    process.stdout.write('locked\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
  });
  process.stdout.write('released\\n');
} catch (error) {
  if (!String(error).includes('session-managed-by-another-runtime')) throw error;
  process.stdout.write('contended\\n');
} finally { await server.close(); }
`;
function worker(root: string, home: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SKILL_LOCK_ROOT: root,
      SKILL_STATE_MODULE: path.resolve("../../packages/backend/src/skill-state.ts"),
    },
    stdio: "pipe",
  });
  children.push(child);
  let errors = "";
  child.stderr.on("data", (bytes) => {
    errors += String(bytes);
  });
  const firstLine = new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (line) => {
      lines.close();
      resolve(line);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(errors || `Child exited ${code}`));
    });
  });
  const closed = new Promise<void>((resolve, reject) =>
    child.once("close", (code, signal) => {
      if (code === 0 || signal) resolve();
      else reject(new Error(errors || `Child exited ${code}`));
    }),
  );
  return { child, firstLine, closed };
}

describe("Skill locks across runtimes", { timeout: 20_000 }, () => {
  it("shares the physical lock across processes and releases it after process termination", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-lock-process-")));
    folders.push(root);
    const library = path.join(root, "library");
    await fs.mkdir(library);
    const alias = path.join(root, "library-alias");
    await fs.symlink(library, alias, process.platform === "win32" ? "junction" : "dir");
    await withSkillLocks([library], async () => {
      const competing = worker(alias, root);
      expect(await competing.firstLine).toBe("contended");
      await competing.closed;
    });
    const owner = worker(alias, root);
    expect(await owner.firstLine).toBe("locked");
    await expect(withSkillLocks([library], async () => undefined)).rejects.toThrow();
    owner.child.kill();
    await owner.closed;
    expect(await withSkillLocks([library], async () => "reacquired")).toBe("reacquired");
  });
});
