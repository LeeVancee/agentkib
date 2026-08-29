import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const outputPath = path.join(desktopRoot, "electron/generated/runtime-protocol.ts");
const generated = spawnSync(
  "cargo",
  ["run", "--quiet", "-p", "agentkib-protocol", "--bin", "generate-typescript"],
  { cwd: repositoryRoot, encoding: "utf8" },
);

if (generated.status !== 0) {
  process.stderr.write(generated.stderr || "Failed to generate runtime protocol bindings.\n");
  process.exit(generated.status ?? 1);
}

let current = "";
try {
  current = readFileSync(outputPath, "utf8");
} catch {
  // The generated file does not exist yet.
}

if (current !== generated.stdout) writeFileSync(outputPath, generated.stdout);
