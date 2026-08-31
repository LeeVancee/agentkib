import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/backend-worker.cjs",
];

for (const relative of required) {
  const target = path.join(desktopRoot, relative);
  await access(target);
  const metadata = await stat(target);
  if (!metadata.isFile() || metadata.size === 0)
    throw new Error(`Invalid package artifact: ${relative}`);
}

process.stdout.write(
  `TypeScript Electron package verified for ${process.platform}/${process.arch}: ${required.length} artifacts.\n`,
);
