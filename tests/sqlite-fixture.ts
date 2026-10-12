import { DatabaseSync } from "node:sqlite";
import {
  migrateDatabase,
  NoteRepository,
  type SqlDatabase,
  type SqlExecutor,
} from "../src/persistence/repository";

// Real SQLite adapter for persistence and integrity tests.
class TestDatabase implements SqlDatabase {
  native: DatabaseSync;
  failOn: string | undefined;
  failOnOccurrence: number | undefined;
  writeStatements = 0;
  highlightInsertStatements = 0;
  maxBindParameters = 0;
  private matchingWrites = 0;
  constructor(path = ":memory:") {
    this.native = new DatabaseSync(path);
  }
  resetMeasurements() {
    this.writeStatements = 0;
    this.highlightInsertStatements = 0;
    this.maxBindParameters = 0;
    this.matchingWrites = 0;
  }
  async execAsync(sql: string) {
    this.native.exec(sql);
  }
  async runAsync(sql: string, ...params: (string | number | null)[]) {
    this.writeStatements++;
    if (sql.startsWith("INSERT INTO highlights"))
      this.highlightInsertStatements++;
    this.maxBindParameters = Math.max(this.maxBindParameters, params.length);
    if (
      this.failOn &&
      sql.includes(this.failOn) &&
      (this.failOnOccurrence === undefined ||
        ++this.matchingWrites === this.failOnOccurrence)
    )
      throw new Error("Simulated write failure");
    const result = this.native.prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }
  async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) {
    return (this.native.prepare(sql).get(...params) as T) ?? null;
  }
  async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) {
    return this.native.prepare(sql).all(...params) as T[];
  }
  async withExclusiveTransactionAsync(
    task: (tx: SqlExecutor) => Promise<void>,
  ) {
    this.native.exec("BEGIN");
    try {
      await task(this);
      this.native.exec("COMMIT");
    } catch (error) {
      this.native.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function repository(path?: string) {
  const db = new TestDatabase(path);
  await migrateDatabase(db);
  return { db, repo: new NoteRepository(db) };
}
