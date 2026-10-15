import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenPackage = ["@agentkib", "conversation-ui"].join("/");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

describe("Desktop conversation UI boundary", () => {
  it("does not depend on the shared conversation UI package", () => {
    const files = [
      path.join(desktopRoot, "package.json"),
      ...sourceFiles(path.join(desktopRoot, "src")),
    ];
    const offenders = files
      .filter((file) => readFileSync(file, "utf8").includes(forbiddenPackage))
      .map((file) => path.relative(desktopRoot, file));

    expect(offenders).toEqual([]);
  });
});
