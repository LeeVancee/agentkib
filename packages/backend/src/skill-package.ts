import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";

const MAX_ENTRIES = 4_096;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;

export interface SkillPackageFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  binary: boolean;
}

export function skillRelativePath(value: string): string {
  if (
    !value ||
    value.length > 4_096 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    (process.platform === "win32" && /^[a-z]:/i.test(value))
  ) {
    throw new Error("Skill path must remain inside its package");
  }
  for (const part of value.split("/")) {
    const stem = part.split(".", 1)[0]?.trimEnd().toUpperCase();
    if (
      /[<>:"|?*]/.test(part) ||
      /[. ]$/.test(part) ||
      [...part].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      [
        "CON",
        "PRN",
        "AUX",
        "NUL",
        ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
      ].includes(stem ?? "")
    )
      throw new Error(`Skill package contains a non-portable path: ${value}`);
  }
  return value;
}

export function privateSkillPath(value: string): boolean {
  return value.split("/").some((part) => {
    const lower = part.toLowerCase();
    return (
      lower.startsWith(".") ||
      ["node_modules", "target", "dist", "build", "__pycache__"].includes(lower) ||
      ["credential", "telemetry", "session", "secret", "token"].some((word) =>
        lower.includes(word),
      ) ||
      lower.endsWith(".env") ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key") ||
      lower.endsWith("state.db")
    );
  });
}

export async function skillPackage(root: string): Promise<{
  files: SkillPackageFile[];
  diagnostics: string[];
  hash: string;
  totalSize: number;
  modifiedAt: string | null;
}> {
  const files: SkillPackageFile[] = [];
  const diagnostics: string[] = [];
  const hash = createHash("sha256");
  const filePaths: Array<{
    relative: string;
    absolute: string;
    executable: boolean;
    size: number;
  }> = [];
  const emptyDirectories: string[] = [];
  const portablePaths = new Set<string>();
  let entries = 0;
  let fileCount = 0;
  let totalSize = 0;
  let modifiedAt: string | null = null;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      if (++entries > MAX_ENTRIES) throw new Error("Skill package contains too many entries");
      const relative = skillRelativePath(prefix ? `${prefix}/${child.name}` : child.name);
      const portable = relative.normalize("NFC").toLowerCase();
      if (portablePaths.has(portable))
        throw new Error(`Skill package contains colliding paths: ${relative}`);
      portablePaths.add(portable);
      const absolute = path.join(directory, child.name);
      const metadata = await fs.lstat(absolute);
      if (
        isReparseOrSymlink(absolute, metadata) ||
        (!metadata.isDirectory() && !metadata.isFile())
      ) {
        diagnostics.push(
          `Unsupported linked or special file cannot be read or copied: ${relative}`,
        );
        files.push({ path: relative, size: 0, sha256: "", executable: false, binary: false });
        continue;
      }
      if (metadata.isDirectory()) {
        files.push({ path: `${relative}/`, size: 0, sha256: "", executable: false, binary: false });
        if ((await fs.readdir(absolute)).length === 0) emptyDirectories.push(relative);
        await visit(absolute, relative);
        continue;
      }
      if (++fileCount > MAX_FILES || metadata.size > MAX_FILE_BYTES)
        throw new Error("Skill package exceeds the file limit");
      const bytes = await fs.readFile(absolute);
      if (bytes.length !== metadata.size || bytes.length > MAX_FILE_BYTES)
        throw new Error("Skill resource changed while reading");
      totalSize += bytes.length;
      if (totalSize > MAX_TOTAL_BYTES)
        throw new Error("Skill package exceeds the total size limit");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      let binary = bytes.includes(0);
      if (!binary) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          binary = true;
        }
      }
      const executable = (metadata.mode & 0o111) !== 0;
      files.push({ path: relative, size: bytes.length, sha256, executable, binary });
      filePaths.push({ relative, absolute, executable, size: bytes.length });
      const mtime = metadata.mtime.toISOString();
      if (!modifiedAt || mtime > modifiedAt) modifiedAt = mtime;
      if (privateSkillPath(relative))
        diagnostics.push(`Private file cannot be read or copied: ${relative}`);
    }
  };
  await visit(root, "");
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  filePaths.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)),
  );
  for (const file of filePaths) {
    const name = Buffer.from(file.relative);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(name.length));
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(file.size));
    hash.update(length);
    hash.update(name);
    hash.update(Buffer.from([file.executable ? 1 : 0]));
    hash.update(size);
    hash.update(await fs.readFile(file.absolute));
  }
  if (emptyDirectories.length) {
    hash.update(Buffer.alloc(8, 0xff));
    hash.update(Buffer.from("agentkib-empty-directories-v1\0"));
    emptyDirectories.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const directory of emptyDirectories) {
      const name = Buffer.from(directory);
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(name.length));
      hash.update(length);
      hash.update(name);
    }
  }
  return { files, diagnostics, hash: hash.digest("hex"), totalSize, modifiedAt };
}

interface Snapshot {
  content: string | null;
  size: number;
  sha256: string;
  executable: boolean;
  binary: boolean;
  truncated: boolean;
}

async function snapshot(root: string | null, relative: string): Promise<Snapshot | null> {
  if (!root) return null;
  let cursor = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]!);
    const metadata = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return null;
    if (isReparseOrSymlink(cursor, metadata))
      throw new Error("Symbolic Skill resources cannot be read");
    if (index < parts.length - 1) {
      if (metadata.isFile()) return null;
      if (!metadata.isDirectory()) throw new Error("Skill resource parent must be a directory");
      continue;
    }
    if (metadata.isDirectory()) return null;
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
      throw new Error("Skill resource is not a readable file");
    const bytes = await fs.readFile(cursor);
    if (bytes.length > MAX_FILE_BYTES) throw new Error("Skill resource exceeds the file limit");
    let content: string | null = null;
    if (!bytes.includes(0)) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        content = null;
      }
    }
    const truncated = bytes.length > MAX_PREVIEW_BYTES;
    if (content !== null && truncated)
      content = Buffer.from(bytes.subarray(0, MAX_PREVIEW_BYTES))
        .toString("utf8")
        .replace(/\uFFFD$/, "");
    return {
      content,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: (metadata.mode & 0o111) !== 0,
      binary: content === null,
      truncated,
    };
  }
  return null;
}

export async function skillPreviewFile(before: string | null, after: string | null, value: string) {
  const relative = skillRelativePath(value);
  if (privateSkillPath(relative)) throw new Error("Skill resource is private or unsafe");
  const prior = await snapshot(before, relative);
  const next = await snapshot(after, relative);
  if (!prior && !next) throw new Error("Skill resource does not exist");
  return {
    path: relative,
    before: prior?.content ?? null,
    after: next?.content ?? null,
    binary: Boolean(prior?.binary || next?.binary),
    truncated: Boolean(prior?.truncated || next?.truncated),
    before_size: prior?.size ?? null,
    after_size: next?.size ?? null,
    before_sha256: prior?.sha256 ?? null,
    after_sha256: next?.sha256 ?? null,
    before_executable: prior?.executable ?? null,
    after_executable: next?.executable ?? null,
  };
}

export async function copySkillPackage(source: string, destination: string): Promise<void> {
  const packageInfo = await skillPackage(source);
  if (packageInfo.diagnostics.length) throw new Error(packageInfo.diagnostics.join("; "));
  await fs.mkdir(destination, { recursive: true });
  for (const entry of packageInfo.files) {
    const relative = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
    const target = path.join(destination, relative);
    if (entry.path.endsWith("/")) {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(source, relative), target);
      await fs.chmod(target, entry.executable ? 0o755 : 0o644);
    }
  }
  const copied = await skillPackage(destination);
  if (copied.hash !== packageInfo.hash) throw new Error("Skill package changed while copying");
}
