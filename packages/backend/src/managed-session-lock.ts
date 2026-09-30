import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { nativeBindings } from "./native-files";
import { restrictRemotePath } from "./remote-tls";

let lockApi:
  | {
      lock: (fd: number, operation: number) => number;
    }
  | undefined;

function flockApi() {
  if (lockApi) return lockApi;
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("platform-unsupported");
  const library = nativeBindings().load(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  );
  lockApi = { lock: library.func("int flock(int fd, int operation)") };
  return lockApi;
}

/** Acquire the same advisory lease used by the Rust managed-session runtime. */
export function acquireManagedSessionLease(dataDir: string, sessionId: string): () => void {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) throw new Error("invalid-session");
  if (process.platform !== "darwin") throw new Error("platform-unsupported");
  const directory = path.join(dataDir, "codex-managed");
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw new Error("invalid-managed-ledger");
  restrictRemotePath(directory, true);

  const lockPath = path.join(directory, `managed-${sessionId}.lock`);
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile()) throw new Error("invalid-managed-ledger-lock");
    restrictRemotePath(lockPath);
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
