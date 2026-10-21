import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Native installer policy tests must run on Windows");
}

// Release helpers may live in a separate sparse checkout. Dependencies and the
// product policy belong to the selected source checkout, where this job runs.
const repository = path.resolve(process.env.AGENTKIB_SOURCE_ROOT || process.cwd());
const desktopRequire = createRequire(path.join(repository, "apps/desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const { getMakeNsisPath } = builderRequire("app-builder-lib/out/toolsets/windows.js");
// Packaging has already resolved this checksum-pinned toolset in this job.
const compiler = await getMakeNsisPath(undefined, undefined);
const result = spawnSync(
  process.execPath,
  ["--test", fileURLToPath(new URL("./windows-installer-policy.test.mjs", import.meta.url))],
  {
    env: {
      ...process.env,
      ...compiler.env,
      AGENTKIB_NSIS_COMPILER: compiler.path,
      AGENTKIB_REQUIRE_NSIS_TESTS: "1",
      AGENTKIB_SOURCE_ROOT: repository,
    },
    stdio: "inherit",
    timeout: 60_000,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
