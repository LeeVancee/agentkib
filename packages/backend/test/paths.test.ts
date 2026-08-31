import { describe, expect, test } from "vitest";
import { defaultDataDir, defaultDatabasePath, defaultBackupDir } from "../src/store/paths.js";

describe("AgentKib data path interface", () => {
  test("matches platform-local data roots and isolated development flavor", () => {
    expect(
      defaultDataDir({ platform: "darwin", homeDirectory: "/Users/tester", migrateLegacy: false }),
    ).toBe("/Users/tester/Library/Application Support/ai.agentkib");
    expect(
      defaultDataDir({
        platform: "win32",
        homeDirectory: "C:\\Users\\tester",
        environment: {},
        migrateLegacy: false,
      }),
    ).toBe("C:\\Users\\tester/AppData/Local/ai.agentkib");
    expect(
      defaultDataDir({
        platform: "linux",
        homeDirectory: "/home/tester",
        environment: { XDG_DATA_HOME: "/data" },
        migrateLegacy: false,
      }),
    ).toBe("/data/ai.agentkib");
    expect(
      defaultDataDir({
        platform: "linux",
        homeDirectory: "/home/tester",
        environment: { AGENTKIB_APP_FLAVOR: "ai.agentkib.dev" },
        migrateLegacy: false,
      }),
    ).toBe("/home/tester/.local/share/ai.agentkib.dev");
  });

  test("derives database and backup paths from the same data root", () => {
    const options = {
      platform: "linux" as const,
      homeDirectory: "/home/tester",
      migrateLegacy: false,
    };
    expect(defaultDatabasePath(options)).toBe("/home/tester/.local/share/ai.agentkib/agentkib.db");
    expect(defaultBackupDir(options)).toBe("/home/tester/.local/share/ai.agentkib/backups");
  });
});
