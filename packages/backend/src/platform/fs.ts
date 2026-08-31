import { createHash } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ExpectedFile =
  | { kind: "any" }
  | { kind: "missing" }
  | { kind: "sha256"; value: string };
export const expectedAny: ExpectedFile = { kind: "any" };
export const expectedMissing: ExpectedFile = { kind: "missing" };
export const expectedSha256 = (value: string): ExpectedFile => ({ kind: "sha256", value });

export async function atomicWrite(target: string, content: Uint8Array | string): Promise<void> {
  return atomicWriteChecked(target, content, expectedAny);
}
export async function atomicWriteChecked(
  target: string,
  content: Uint8Array | string,
  expected: ExpectedFile,
): Promise<void> {
  await verifyExpected(target, expected);
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const temp = path.join(
    parent,
    `.${path.basename(target)}.agentkib-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temp, content, { mode: 0o600 });
    try {
      const mode = (await fs.stat(target)).mode & 0o777;
      await fs.chmod(temp, mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await fs.open(temp, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicReplace(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
export async function atomicReplace(
  source: string,
  target: string,
  expected: ExpectedFile = expectedAny,
): Promise<void> {
  await verifyExpected(target, expected);
  if (process.platform !== "win32") {
    await fs.rename(source, target);
    return;
  }
  // ReplaceFileW-like behavior: retain a same-directory backup while the
  // destination is replaced, and restore it if the replacement fails.
  const backup = `${target}.agentkib-backup-${process.pid}-${randomUUID()}`;
  let backedUp = false;
  try {
    try {
      await fs.rename(target, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let last: unknown;
    for (const delay of [0, 25, 50, 100, 200]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await fs.rename(source, target);
        last = undefined;
        break;
      } catch (error) {
        last = error;
      }
    }
    if (last) throw last;
  } catch (error) {
    if (backedUp) await fs.rename(backup, target).catch(() => undefined);
    throw error;
  } finally {
    if (backedUp) await fs.rm(backup, { force: true }).catch(() => undefined);
  }
}
export async function movePath(source: string, target: string): Promise<void> {
  try {
    await fs.access(target);
    throw Object.assign(new Error(`move target already exists: ${target}`), { code: "EEXIST" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.rename(source, target);
}
async function verifyExpected(target: string, expected: ExpectedFile): Promise<void> {
  if (expected.kind === "any") return;
  if (expected.kind === "missing") {
    try {
      await fs.access(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw Object.assign(new Error(`file was modified externally: ${target}`), {
      code: "ECONFLICT",
    });
  }
  let data: Buffer;
  try {
    data = await fs.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw Object.assign(new Error(`file was modified externally: ${target}`), {
        code: "ECONFLICT",
      });
    throw error;
  }
  if (createHash("sha256").update(data).digest("hex") !== expected.value)
    throw Object.assign(new Error(`file was modified externally: ${target}`), {
      code: "ECONFLICT",
    });
}
