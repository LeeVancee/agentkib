import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = path.join(desktopRoot, "build/forge-resources");
const runtimeRoot = path.join(desktopRoot, "build/runtime");
const quotaRoot = path.join(desktopRoot, "build/quota");
const quotaResourcesRoot = path.join(desktopRoot, "resources/quota/resources");
const iconsRoot = path.join(desktopRoot, "resources/icons");
const runtimeExecutable = path.join(
  runtimeRoot,
  process.platform === "win32" ? "agentkib-runtime.exe" : "agentkib-runtime",
);

if (!existsSync(runtimeExecutable)) {
  throw new Error("Electron runtime is not staged. Run pnpm runtime:stage first.");
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(path.join(stageRoot, "bin"), { recursive: true });

copy(runtimeRoot, path.join(stageRoot, "bin"));
copyIfPresent(quotaRoot, path.join(stageRoot, "bin"));
copyIfPresent(
  path.join(quotaResourcesRoot, "CodexBar_CodexBarCore.bundle"),
  path.join(stageRoot, "CodexBar_CodexBarCore.bundle"),
);
copyIfPresent(path.join(quotaResourcesRoot, "linux"), path.join(stageRoot, "bin/linux"));
copyIfPresent(path.join(quotaResourcesRoot, "windows"), path.join(stageRoot, "windows"));

for (const icon of [
  "tray-icon.png",
  "app-icon-white.png",
  "app-icon-black.png",
  "app-icon-white-macos.png",
  "app-icon-black-macos.png",
]) {
  copy(path.join(iconsRoot, icon), path.join(stageRoot, "icons", icon));
}

process.stdout.write(`Electron Forge resources: staged ${stageRoot}.\n`);

function copyIfPresent(source, destination) {
  if (existsSync(source)) copy(source, destination);
}

function copy(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
}
