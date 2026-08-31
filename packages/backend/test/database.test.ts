import { describe, expect, test } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/store/database.js";

describe("AgentKib SQLite persistence interface", () => {
  test("creates the existing schema 10 and FTS5 tables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentkib-store-"));
    const database = openDatabase(path.join(root, "agentkib.db"));
    expect(
      database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get(),
    ).toEqual({
      value: "10",
    });
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'")
        .get(),
    ).toEqual({
      1: 1,
    });
    database
      .prepare(
        "INSERT INTO memories(id, project_id, memory_type, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "memory-1",
        "project-1",
        "decision",
        "Use TypeScript backend",
        "approved",
        "2026-08-31T00:00:00.000Z",
      );
    expect(
      database.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH ?").get("TypeScript"),
    ).toEqual({
      id: "memory-1",
    });
    database.close();
    expect(await readFile(path.join(root, "agentkib.db"))).toBeInstanceOf(Buffer);
  });

  test("opens an existing schema 10 database without changing its version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentkib-store-"));
    const databasePath = path.join(root, "agentkib.db");
    const first = openDatabase(databasePath);
    first.prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?)").run("custom", "kept");
    first.close();
    const second = openDatabase(databasePath);
    expect(
      second.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get(),
    ).toEqual({
      value: "10",
    });
    expect(second.prepare("SELECT value FROM schema_meta WHERE key = 'custom'").get()).toEqual({
      value: "kept",
    });
    second.close();
  });
});
