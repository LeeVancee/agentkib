import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(desktopRoot, "build/forge-app");
const sourcePackage = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const electronPackage = JSON.parse(
  readFileSync(path.join(desktopRoot, "node_modules/electron/package.json"), "utf8"),
);
const updaterPackage = JSON.parse(
  readFileSync(path.join(desktopRoot, "node_modules/electron-updater/package.json"), "utf8"),
);
const forgeConfig = path.relative(appRoot, path.join(desktopRoot, "forge.config.ts"));

rmSync(appRoot, { recursive: true, force: true });
mkdirSync(appRoot, { recursive: true });
copy(path.join(desktopRoot, "dist"), path.join(appRoot, "dist"));
copy(path.join(desktopRoot, "dist-electron"), path.join(appRoot, "dist-electron"));

const packageJson = {
  name: "agentkib",
  private: true,
  version: sourcePackage.version,
  productName: sourcePackage.productName,
  description: sourcePackage.description,
  author: sourcePackage.author,
  homepage: sourcePackage.homepage,
  type: "module",
  main: "dist-electron/main.cjs",
  packageManager: "pnpm@10.8.1",
  config: {
    forge: forgeConfig,
  },
  dependencies: {
    "electron-updater": updaterPackage.version,
  },
  devDependencies: {
    electron: electronPackage.version,
  },
};

writeFileSync(path.join(appRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(path.join(appRoot, ".npmrc"), "node-linker=hoisted\n");
process.stdout.write(`Electron Forge app: staged ${appRoot}.\n`);

function copy(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
}
