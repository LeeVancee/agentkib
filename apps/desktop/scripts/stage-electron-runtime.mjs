import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const executable = process.platform === "win32" ? "agentkib-runtime.exe" : "agentkib-runtime";
const source = path.join(repositoryRoot, "target/release", executable);
const destinationDirectory = path.join(desktopRoot, "build/runtime");
const destination = path.join(destinationDirectory, executable);

mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);

const quotaDirectory = path.join(desktopRoot, "build/quota");
const quotaExecutable =
  process.platform === "win32" ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar";
mkdirSync(quotaDirectory, { recursive: true });
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const target = process.platform === "darwin" ? `${arch}-apple-darwin` : `${arch}-unknown-linux-gnu`;
const quotaSource =
  process.platform === "win32"
    ? path.join(desktopRoot, "resources/quota/resources/windows", quotaExecutable)
    : path.join(desktopRoot, "resources/quota/binaries", `agentkib-quota-sidecar-${target}`);

try {
  statSync(quotaSource);
} catch {
  process.stdout.write(
    "AgentKib quota sidecar: no prepared host binary, skipping Electron staging.\n",
  );
  process.exit(0);
}
const quotaDestination = path.join(quotaDirectory, quotaExecutable);
copyFileSync(quotaSource, quotaDestination);
if (process.platform !== "win32") chmodSync(quotaDestination, 0o755);
