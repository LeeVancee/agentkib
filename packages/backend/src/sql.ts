import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { storedTime, utcNow } from "./workspaces";
export type Row = Record<string, unknown>;
export class Sql {
  constructor(readonly database: DatabaseSync) {}
  rows(sql: string, ...values: SQLInputValue[]): Row[] {
    const statement = this.database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...values);
  }
  one(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.rows(sql, ...values)[0];
  }
  run(sql: string, ...values: SQLInputValue[]): void {
    this.database.prepare(sql).run(...values);
  }
  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  audit(project: string | null, action: string, detail: string): void {
    const at = storedTime(utcNow());
    this.run(
      "INSERT INTO audit_events(id,project_id,action,detail,created_at) VALUES (?,?,?,?,?)",
      randomUUID(),
      project,
      action,
      detail,
      at,
    );
    const code =
      action === "changeset.apply"
        ? "special-first-changeset"
        : action === "memory.review" && detail.endsWith(":approved")
          ? "special-first-memory"
          : null;
    if (code)
      this.run(
        "INSERT INTO achievement_unlocks(code,unlocked_at,rule_version) VALUES (?,?,1) ON CONFLICT(code) DO UPDATE SET unlocked_at=excluded.unlocked_at, rule_version=1 WHERE achievement_unlocks.rule_version=0",
        code,
        at,
      );
  }
}
export function positive(value: unknown): number {
  return Math.max(0, Number(value ?? 0));
}
