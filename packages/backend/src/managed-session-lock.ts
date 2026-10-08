import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { isReparseOrSymlink, nativeBindings } from "./native-files";
import { restrictRemotePath } from "./remote-tls";

let lockApi:
  | {
      lock: (fd: number, operation: number) => number;
    }
  | undefined;
let windowsLockApi:
  | {
      open: (
        file: string,
        access: number,
        share: number,
        security: null,
        disposition: number,
        flags: number,
        template: number,
      ) => number | bigint;
      query: (handle: number | bigint, information: Buffer) => number;
      close: (handle: number | bigint) => number;
      lock: (
        handle: number | bigint,
        flags: number,
        reserved: number,
        bytesLow: number,
        bytesHigh: number,
        overlapped: Buffer,
      ) => number;
      unlock: (
        handle: number | bigint,
        reserved: number,
        bytesLow: number,
        bytesHigh: number,
        overlapped: Buffer,
      ) => number;
      error: () => number;
    }
  | undefined;

function flockApi() {
  if (lockApi) return lockApi;
  const library = nativeBindings().load(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  );
  lockApi = { lock: library.func("int flock(int fd, int operation)") };
  return lockApi;
}

function win32Api() {
  if (windowsLockApi) return windowsLockApi;
  const bindings = nativeBindings();
  const kernel = bindings.load("kernel32.dll");
  windowsLockApi = {
    open: kernel.func("__stdcall", "CreateFileW", "intptr_t", [
      "str16",
      "uint32_t",
      "uint32_t",
      "void *",
      "uint32_t",
      "uint32_t",
      "intptr_t",
    ]),
    query: kernel.func("__stdcall", "GetFileInformationByHandle", "int", ["intptr_t", "void *"]),
    close: kernel.func("__stdcall", "CloseHandle", "int", ["intptr_t"]),
    lock: kernel.func("__stdcall", "LockFileEx", "int", [
      "intptr_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "void *",
    ]),
    unlock: kernel.func("__stdcall", "UnlockFileEx", "int", [
      "intptr_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "void *",
    ]),
    error: kernel.func("__stdcall", "GetLastError", "uint32_t", []),
  };
  return windowsLockApi;
}

function acquireWindowsLock(lockPath: string, fd: number): () => void {
  const api = win32Api();
  // Node/Electron may use a private CRT descriptor table. Passing its fd to
  // ucrtbase._get_osfhandle can terminate the process via invalid-parameter handling.
  // Open a native handle and prove it still identifies the checked Node file.
  const handle = api.open(lockPath, 0xc0000000, 7, null, 3, 0x00200000, 0);
  if (handle === -1 || handle === -1n)
    throw new Error(`Cannot open managed session lock (${api.error()})`);
  // OVERLAPPED is two pointer-sized fields followed by the 8-byte offset union
  // and event handle; supported Windows targets are x64 and ARM64.
  const overlapped = Buffer.alloc(32);
  try {
    const information = Buffer.alloc(52);
    if (!api.query(handle, information))
      throw new Error(`Cannot inspect managed session lock (${api.error()})`);
    const expected = fstatSync(fd, { bigint: true });
    const volume = BigInt(information.readUInt32LE(28));
    const fileId =
      (BigInt(information.readUInt32LE(44)) << 32n) | BigInt(information.readUInt32LE(48));
    if (
      (information.readUInt32LE(0) & (0x10 | 0x400)) !== 0 ||
      volume !== expected.dev ||
      fileId !== expected.ino
    )
      throw new Error("invalid-managed-lock-file");
    if (!api.lock(handle, 0x3, 0, 0xffffffff, 0xffffffff, overlapped)) {
      const code = api.error();
      if (code === 33) throw new Error("session-managed-by-another-runtime");
      throw new Error(`Cannot acquire managed session lock (${code})`);
    }
  } catch (error) {
    api.close(handle);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (!api.unlock(handle, 0, 0xffffffff, 0xffffffff, overlapped))
        throw new Error(`Cannot release managed session lock (${api.error()})`);
    } finally {
      api.close(handle);
    }
  };
}

/** Acquire a cross-process advisory lock on the whole file at a shared lock path. */
export function acquirePortableFileLease(lockPath: string): () => void {
  if (!["darwin", "linux", "win32"].includes(process.platform))
    throw new Error("platform-unsupported");
  const directory = path.dirname(lockPath);
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw new Error("invalid-managed-lock-directory");
  restrictRemotePath(directory, true);

  const fd = openSync(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile() || isReparseOrSymlink(lockPath, lstatSync(lockPath)))
      throw new Error("invalid-managed-lock-file");
    restrictRemotePath(lockPath);
    if (process.platform === "win32") {
      const releaseLock = acquireWindowsLock(lockPath, fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          releaseLock();
        } finally {
          closeSync(fd);
        }
      };
    }
    if (flockApi().lock(fd, 2 | 4) !== 0) throw new Error("session-managed-by-another-runtime");
  } catch (error) {
    closeSync(fd);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      flockApi().lock(fd, 8);
    } finally {
      closeSync(fd);
    }
  };
}

/** Acquire the advisory lease shared by local managed-session owners. */
export function acquireManagedSessionLease(dataDir: string, sessionId: string): () => void {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) throw new Error("invalid-session");
  return acquirePortableFileLease(path.join(dataDir, "codex-managed", `managed-${sessionId}.lock`));
}
