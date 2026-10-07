import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

// Uses the installed, lockfile-pinned Electron. Build the backend before running.
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [fileURLToPath(new URL("./verify-backend-workers.cjs", import.meta.url))],
  {
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
