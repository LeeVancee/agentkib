import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "../../../packages/backend/src/catalog";
import { Sql } from "../../../packages/backend/src/sql";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE catalog_assets (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      workspace_id TEXT,
      agent TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at TEXT,
      summary_key TEXT,
      summary_params TEXT NOT NULL
    );
  `);
  const sql = new Sql(database);
  const records = [
    ["windows", "AGENTS.md", String.raw`C:\Users\Example\agentkib-path-repro\demo\AGENTS.md`],
    ["unix", "CLAUDE.md", "/home/example/project/CLAUDE.md"],
    ["literal", "file_%_safe.txt", String.raw`C:\Users\Example\file_%_safe.txt`],
    ["ordinary", "file-abc-safe.txt", String.raw`C:\Users\Example\file-abc-safe.txt`],
  ] as const;
  for (const [id, name, path] of records) {
    sql.run(
      "INSERT INTO catalog_assets (id, scope, agent, kind, name, path, summary, size, summary_params) VALUES (?, 'workspace', 'codex', 'instruction', ?, ?, '', 0, '{}')",
      id,
      name,
      path,
    );
  }
  return new Catalog(sql);
}

describe("catalog asset search", () => {
  it.each([
    ["AGENTS.md", ["windows"]],
    [String.raw`agentkib-path-repro\demo\AGENTS.md`, ["windows"]],
    [String.raw`C:\Users\Example\agentkib-path-repro\demo\AGENTS.md`, ["windows"]],
    ["\\demo\\", ["windows"]],
    ["file_%_safe", ["literal"]],
    ["project/CLAUDE.md", ["unix"]],
  ] as const)("finds the expected assets for %s", (query, ids) => {
    const catalog = fixture();
    const result = catalog.assets({ query, limit: 500 });
    expect(result.map((asset) => asset.id).sort()).toEqual([...ids].sort());
  });

  it("treats SQL wildcard characters in searches as literal text", () => {
    const catalog = fixture();
    expect(catalog.assets({ query: "%_", limit: 500 }).map((asset) => asset.id)).toEqual([
      "literal",
    ]);
    expect(catalog.assets({ query: "file-abc", limit: 500 }).map((asset) => asset.id)).toEqual([
      "ordinary",
    ]);
  });

  it("preserves unfiltered catalog reads", () => {
    const catalog = fixture();
    expect(catalog.assets({ query: "", limit: 500 })).toHaveLength(4);
  });
});
