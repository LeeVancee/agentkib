import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
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
