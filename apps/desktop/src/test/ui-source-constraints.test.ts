import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function businessSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path === join(sourceRoot, "components", "ui")) return [];
      return businessSources(path);
    }
    if (
      (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".tsrx")) ||
      entry.name.endsWith(".test.tsx") ||
      entry.name.endsWith(".test.tsrx")
    )
      return [];
    return [path];
  });
}

describe("interaction component source constraints", () => {
  it("keeps native and hand-written interaction primitives out of business pages", () => {
    const forbidden = [
      /<(?:button|input|textarea|select|details)\b/,
      /\bwindow\.(?:alert|confirm|prompt)\s*\(/,
      /\brole=["'](?:dialog|tab|tablist)["']/,
      /\btype=["']checkbox["']/,
    ];
    const violations = businessSources(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbidden
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${path.replace(`${sourceRoot}/`, "")}: ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it("keeps Base UI tabs and full-surface buttons on their design-system state", () => {
    const sources = businessSources(sourceRoot).map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    }));
    const manualTabState = sources.flatMap(({ path, source }) =>
      source
        .split("\n")
        .filter((line) => /<TabsTrigger\b/.test(line) && /\bactive\s*=/.test(line))
        .map(() => path.replace(`${sourceRoot}/`, "")),
    );
    const surfaceClasses = [
      "workspace-row",
      "catalog-row",
      "agent-master-list",
      "conversation-list",
      "file-list",
    ];
    const incorrectlySizedSurfaces = sources.flatMap(({ path, source }) =>
      source
        .split("\n")
        .filter(
          (line) =>
            /<Button\b/.test(line) && surfaceClasses.some((className) => line.includes(className)),
        )
        .filter((line) => !line.includes('variant="bare"') || !line.includes('size="content"'))
        .map(() => path.replace(`${sourceRoot}/`, "")),
    );

    expect(manualTabState).toEqual([]);
    expect(incorrectlySizedSurfaces).toEqual([]);
  });
});
