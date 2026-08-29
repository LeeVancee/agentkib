import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable =
  process.platform === "win32" ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar";
const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;
const source =
  process.platform === "win32"
    ? path.join(desktopRoot, "resources/quota/resources/windows", executable)
    : path.join(desktopRoot, "resources/quota/binaries", `agentkib-quota-sidecar-${target}`);
const destinationDirectory = path.join(desktopRoot, "build/quota");
const destination = path.join(destinationDirectory, executable);

try {
  statSync(source);
} catch {
  process.stdout.write(
    "AgentKib quota sidecar: no prepared host binary, skipping Electron staging.\n",
  );
  process.exit(0);
}

mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
process.stdout.write(`AgentKib quota sidecar: staged ${destination}.\n`);
