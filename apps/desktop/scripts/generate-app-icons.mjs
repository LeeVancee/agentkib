import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const assetsDirectory = join(desktopDirectory, "resources/assets");
const iconsDirectory = join(desktopDirectory, "resources/icons");
const tauriCli = join(desktopDirectory, "node_modules/@tauri-apps/cli/tauri.js");
const darkOutput = await mkdtemp(join(tmpdir(), "agentkib-dark-icons-"));
const macosRuntimeOutput = await mkdtemp(join(tmpdir(), "agentkib-macos-runtime-icons-"));
// Dynamically assigned NSApplication icons bypass the visual inset macOS applies
// to the bundled ICNS, so keep the artwork within the standard 80% safe area.
const macosRuntimeInset = 102.4;
const macosRuntimeSize = 819.2;

try {
  generateIcons(join(assetsDirectory, "app-icon-source.png"), iconsDirectory);
  generateIcons(join(assetsDirectory, "app-icon-black.png"), darkOutput);
  await copyFile(
    join(iconsDirectory, "128x128@2x.png"),
    join(iconsDirectory, "app-icon-white.png"),
  );
  await copyFile(join(darkOutput, "128x128@2x.png"), join(iconsDirectory, "app-icon-black.png"));
  await generateMacosRuntimeIcon(join(assetsDirectory, "app-icon-source.png"), "white");
  await generateMacosRuntimeIcon(join(assetsDirectory, "app-icon-black.png"), "black");
} finally {
  await rm(darkOutput, { recursive: true, force: true });
  await rm(macosRuntimeOutput, { recursive: true, force: true });
}

async function generateMacosRuntimeIcon(source, variant) {
  const sourceData = await readFile(source, "base64");
  const svgPath = join(macosRuntimeOutput, `${variant}.svg`);
  const output = join(macosRuntimeOutput, variant);
  await mkdir(output);
  await writeFile(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><image href="data:image/png;base64,${sourceData}" x="${macosRuntimeInset}" y="${macosRuntimeInset}" width="${macosRuntimeSize}" height="${macosRuntimeSize}" preserveAspectRatio="xMidYMid meet"/></svg>`,
  );
  generateIcons(svgPath, output, 256);
  await copyFile(
    join(output, "256x256.png"),
    join(iconsDirectory, `app-icon-${variant}-macos.png`),
  );
}

function generateIcons(source, output, pngSize) {
  const args = [tauriCli, "icon", source, "--output", output];
  if (pngSize) args.push("--png", String(pngSize));
  const result = spawnSync(process.execPath, args, { cwd: desktopDirectory, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Failed to generate app icons from ${source}`);
  }
}
