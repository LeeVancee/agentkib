import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isVerifiedLegacyReleaseRetry(environment, sourceVersion, sourceSha) {
  const tag = environment.AGENTKIB_VALIDATED_RELEASE_TAG;
  if (
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.SHOULD_PUBLISH !== "true" ||
    environment.AGENTKIB_REQUESTED_RELEASE_TAG !== tag ||
    environment.APP_VERSION !== sourceVersion ||
    tag !== `v${sourceVersion}` ||
    !/^[a-f0-9]{40}$/.test(environment.AGENTKIB_VALIDATED_RELEASE_SHA || "") ||
    environment.AGENTKIB_VALIDATED_RELEASE_SHA !== sourceSha
  ) {
    return false;
  }

  // Only immutable stable releases predating the product hook get this exception.
  // Missing hooks in branch builds, newer versions or ambiguous tags must fail.
  const version = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  return (
    version !== null &&
    version[1] === "0" &&
    (BigInt(version[2]) < 20n || (version[2] === "20" && BigInt(version[3]) <= 1n))
  );
}

async function runNativePolicyTests() {
  // Release helpers may live in a separate sparse checkout. Dependencies and the
  // product policy belong to the selected source checkout, where this job runs.
  const repository = path.resolve(process.env.AGENTKIB_SOURCE_ROOT || process.cwd());
  const packagePath = path.join(repository, "apps/desktop/package.json");
  const includePath = path.join(repository, "apps/desktop/scripts/windows-installer.nsh");
  try {
    await stat(includePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const sourceVersion = JSON.parse(await readFile(packagePath, "utf8")).version;
    const checkout = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (checkout.error) throw checkout.error;
    if (
      checkout.status !== 0 ||
      !isVerifiedLegacyReleaseRetry(process.env, sourceVersion, checkout.stdout.trim())
    ) {
      throw new Error(
        "Missing tracked Windows installer policy outside a verified legacy release retry",
      );
    }
    console.log(
      `Skipping product policy tests for verified legacy release ${process.env.AGENTKIB_VALIDATED_RELEASE_TAG}: its immutable source predates the hook. The real installer smoke and uninstall/user-data checks still run.`,
    );
    return;
  }

  if (process.platform !== "win32") {
    throw new Error("Native installer policy tests must run on Windows");
  }
  const desktopRequire = createRequire(packagePath);
  const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
  const { getMakeNsisPath } = builderRequire("app-builder-lib/out/toolsets/windows.js");
  // Resolve the checksum-pinned toolset, reusing the packaging cache if present.
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNativePolicyTests();
}
