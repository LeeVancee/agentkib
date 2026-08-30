import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import type { ForgeConfig } from "@electron-forge/shared-types";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const stagedResourcesRoot = path.join(desktopRoot, "build/forge-resources");
const stagedResourceNames = [
  "bin",
  "icons",
  "windows",
  "CodexBar_CodexBarCore.bundle",
];
const extraResource = stagedResourceNames
  .map((name) => path.join(stagedResourcesRoot, name))
  .filter((resourcePath) => existsSync(resourcePath));

if (!existsSync(path.join(stagedResourcesRoot, "bin"))) {
  throw new Error("Electron Forge resources are not staged. Run pnpm forge:prepare first.");
}

const appleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY;
const appleApiKey = process.env.APPLE_API_KEY_PATH;
const appleApiKeyId = process.env.APPLE_API_KEY_ID;
const appleApiIssuer = process.env.APPLE_API_ISSUER;
const shouldNotarize = Boolean(appleApiKey && appleApiKeyId && appleApiIssuer);

if (shouldNotarize && !appleSigningIdentity) {
  throw new Error("APPLE_SIGNING_IDENTITY is required when Forge notarization is enabled.");
}

const config: ForgeConfig = {
  outDir: path.join(desktopRoot, "release-forge"),
  hooks: {
    readPackageJson: async (_forgeConfig, packageJson) => ({
      ...packageJson,
      dependencies: {
        "electron-updater": packageJson.dependencies["electron-updater"],
      },
      devDependencies: {
        electron: packageJson.devDependencies.electron,
      },
    }),
  },
  packagerConfig: {
    name: "AgentKib",
    executableName: "AgentKib",
    appBundleId: "ai.agentkib",
    appCategoryType: "public.app-category.developer-tools",
    icon: path.join(desktopRoot, "resources/icons/icon"),
    asar: true,
    extraResource,
    extendInfo: {
      LSMinimumSystemVersion: "13.3.0",
    },
    ignore: [
      /^\/build(?:\/|$)/,
      /^\/electron(?:\/|$)/,
      /^\/release-electron(?:\/|$)/,
      /^\/release-forge(?:\/|$)/,
      /^\/resources(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/src-tauri(?:\/|$)/,
      /^\/(?:components\.json|electron-builder\.yml|forge\.config\.ts|index\.html)$/,
      /^\/tsconfig(?:\..+)?\.json$/,
      /^\/vite(?:\..+)?\.config\.ts$/,
    ],
    osxSign: {
      identity: appleSigningIdentity ?? "-",
      identityValidation: Boolean(appleSigningIdentity),
      optionsForFile: () => ({ hardenedRuntime: true }),
    },
    ...(shouldNotarize
      ? {
          osxNotarize: {
            appleApiKey,
            appleApiKeyId,
            appleApiIssuer,
          },
        }
      : {}),
  },
  makers: [
    new MakerDMG({
      icon: path.join(desktopRoot, "resources/icons/icon.icns"),
      format: "ULFO",
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerSquirrel({
      name: "AgentKib",
      setupIcon: path.join(desktopRoot, "resources/icons/icon.ico"),
      authors: "AgentKib contributors",
      description:
        "Desktop app for discovering, diagnosing, and synchronizing coding agent configuration.",
    }),
    new MakerDeb({
      options: {
        name: "agentkib",
        productName: "AgentKib",
        genericName: "Coding agent configuration manager",
        description: "Discover, diagnose, and synchronize coding agent configuration.",
        categories: ["Development"],
        section: "devel",
        priority: "optional",
        maintainer: "AgentKib contributors",
        homepage: "https://github.com/starroyhq/agentkib",
        icon: path.join(desktopRoot, "resources/icons/icon.png"),
      },
    }),
    new MakerRpm({
      options: {
        name: "agentkib",
        productName: "AgentKib",
        genericName: "Coding agent configuration manager",
        description: "Discover, diagnose, and synchronize coding agent configuration.",
        categories: ["Development"],
        license: "MIT",
        homepage: "https://github.com/starroyhq/agentkib",
        icon: path.join(desktopRoot, "resources/icons/icon.png"),
      },
    }),
  ],
};

export default config;
