import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

if (process.platform !== "darwin") {
  process.stdout.write("Electron Forge makers: no host-specific preparation required.\n");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const makerEntry = require.resolve("@electron-forge/maker-dmg");
const installerEntry = require.resolve("electron-installer-dmg", {
  paths: [path.dirname(makerEntry)],
});
const appDmgEntry = require.resolve("appdmg", {
  paths: [path.dirname(installerEntry)],
});
const dsStoreEntry = require.resolve("ds-store", {
  paths: [path.dirname(appDmgEntry)],
});
const macosAliasEntry = require.resolve("macos-alias", {
  paths: [path.dirname(dsStoreEntry)],
});
const fsXattrEntry = require.resolve("fs-xattr", {
  paths: [path.dirname(appDmgEntry)],
});
const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");

const built = [
  prepareNativeAddon("macos-alias", macosAliasEntry),
  prepareNativeAddon("fs-xattr", fsXattrEntry),
].filter(Boolean);

process.stdout.write(
  built.length > 0
    ? `Electron Forge makers: built ${built.join(", ")}.\n`
    : "Electron Forge makers: macOS DMG addons are ready.\n",
);

function prepareNativeAddon(name, entry) {
  try {
    require(entry);
    return undefined;
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_DLOPEN_FAILED") throw error;
  }

  const result = spawnSync(process.execPath, [nodeGyp, "rebuild"], {
    cwd: path.dirname(entry),
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Failed to build ${name} (exit ${result.status ?? "unknown"}).`);
  }

  require(entry);
  return name;
}
