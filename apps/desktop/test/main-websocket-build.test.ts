import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "vite";
import { resolveConfig } from "electron-vite";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");

describe("main process WebSocket bundle", () => {
  it("serves a WebSocket echo without installed runtime dependencies", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-main-ws-"));
    try {
      const output = path.join(directory, "build");
      const resolved = await resolveConfig(
        { root: desktopRoot, configFile: path.join(desktopRoot, "electron.vite.config.ts") },
        "build",
        "production",
      );
      const config = resolved.config!.main!;
      await build({
        ...config,
        logLevel: "silent",
        build: {
          ...config.build,
          outDir: output,
          lib: {
            ...config.build!.lib,
            entry: path.join(import.meta.dirname, "fixtures/main-websocket.ts"),
          },
        },
      });

      // The installer does not ship node_modules. Run only the built CJS file,
      // outside the repository, so workspace dependencies cannot hide externals.
      const runtime = path.join(directory, "runtime");
      await fs.mkdir(runtime);
      await fs.copyFile(path.join(output, "main.cjs"), path.join(runtime, "main.cjs"));
      expect(await fs.readdir(runtime)).toEqual(["main.cjs"]);
      const environment = { ...process.env };
      delete environment.NODE_PATH;
      delete environment.NODE_OPTIONS;
      const { stdout } = await run(
        process.execPath,
        ["--no-global-search-paths", path.join(runtime, "main.cjs")],
        { cwd: runtime, env: environment, timeout: 10_000, windowsHide: true },
      );
      expect(stdout.trim()).toBe("standalone WebSocket echo passed");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
