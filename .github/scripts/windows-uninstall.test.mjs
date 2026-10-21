import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const powershell = process.env.AGENTKIB_PWSH || "pwsh";
const availability = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"]);
const harness = fileURLToPath(new URL("./windows-uninstall.test.ps1", import.meta.url));

for (const scenario of [
  "success",
  "actual-failure",
  "residual",
  "running-timeout",
  "removed-before-exit",
  "delayed-termination",
  "user-data-loss",
  "copy-failure",
  "unsafe-copy-location",
  "diagnostic-failure",
]) {
  test(
    `real NSIS uninstall observation: ${scenario}`,
    {
      skip:
        availability.error && process.platform !== "win32" ? "PowerShell is unavailable" : false,
    },
    () => {
      assert.ifError(availability.error);
      assert.equal(availability.status, 0);
      const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-File", harness, scenario], {
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`passed: ${scenario}`));
    },
  );
}
