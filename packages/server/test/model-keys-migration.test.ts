/**
 * Migration 8, `model-keys`: the table the named key fleet is stored in.
 *
 * What matters here is not that the DDL runs — every migration's does. It is that adding it
 * changed nothing about a database that already existed, that it is safe to run again on a
 * database it has already run on, that it is reversible, and that the UNIQUE index it
 * declares is a real constraint rather than a service check with good manners. The last one
 * is the whole reason the names live in SQLite at all, so it is asserted against the database
 * engine directly: a second row with the same name in the same fleet must be refused by
 * SQLite itself, with no application code in the loop.
 */
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  LATEST_VERSION,
  MIGRATIONS,
  migrate,
  rollbackTo,
  schemaVersion,
} from "../src/db/migrations.js";
import { SCHEMA_SQL } from "../src/db/schema.js";

const sqlite = process.getBuiltinModule("node:sqlite");

/**
 * A database from just before this migration: today's declared shape with `model_keys`
 * removed, stamped at the version before. Built by deleting the table rather than by
 * hand-copying the older schema, so the fixture cannot drift from what the product actually
 * shipped.
 *
 * Seeded with a user and a Project, because `model_keys.project_id` REFERENCES `projects` —
 * SQLite enforces that (the runtime opens every connection with `foreign_keys = ON`), and a
 * test that inserted a key for a Project that does not exist would be testing nothing.
 */
function openBefore(): DatabaseSync {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  db.exec("DROP INDEX IF EXISTS idx_model_keys_fleet_name; DROP TABLE IF EXISTS model_keys;");
  seedProject(db, "p1");
  db.exec(`PRAGMA user_version = ${LATEST_VERSION - 1}`);
  return db;
}

/** A user and the Project a key name hangs off. */
function seedProject(db: DatabaseSync, projectId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (user_id, password_hash, is_admin, created_at)" +
      " VALUES (?, 'h', 0, '2026-01-01T00:00:00.000Z')",
  ).run(`owner-of-${projectId}`);
  db.prepare(
    "INSERT INTO projects (project_id, owner_user_id, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
  ).run(projectId, `owner-of-${projectId}`);
}

function insertKey(
  db: DatabaseSync,
  over: Partial<{
    projectId: string;
    keyId: string;
    provider: string;
    modelId: string;
    name: string;
    label: string | null;
  }> = {},
): void {
  const row = {
    projectId: over.projectId ?? "p1",
    keyId: over.keyId ?? "k_0123456789ab",
    provider: over.provider ?? "deepseek",
    modelId: over.modelId ?? "deepseek-chat",
    name: over.name ?? "prod",
    label: over.label === undefined ? null : over.label,
  };
  db.prepare(
    "INSERT INTO model_keys (project_id, key_id, provider, model_id, name, label, created_at, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')",
  ).run(row.projectId, row.keyId, row.provider, row.modelId, row.name, row.label);
}

/** Whether the table is there at all, by SQLite's own catalogue. */
function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

describe("migration 8: model-keys", () => {
  it("adds the table and its index to a database that has neither", () => {
    const db = openBefore();
    try {
      expect(hasTable(db, "model_keys")).toBe(false);
      expect(migrate(db).applied).toEqual(["model-keys"]);
      expect(hasTable(db, "model_keys")).toBe(true);
      expect(schemaVersion(db)).toBe(LATEST_VERSION);
      // A fresh database is created with the same two objects by the declarative track, and
      // the two must agree — that is the ADOPTION contract the migration module documents.
      const fresh = new sqlite.DatabaseSync(":memory:");
      try {
        fresh.exec(SCHEMA_SQL);
        expect(
          fresh
            .prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'idx_model_keys%'")
            .all(),
        ).toEqual(
          db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'idx_model_keys%'").all(),
        );
      } finally {
        fresh.close();
      }
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second run changes nothing, and a run on a fresh database is a no-op", () => {
    const db = openBefore();
    try {
      migrate(db);
      insertKey(db);
      const rows = () =>
        db.prepare("SELECT key_id, name, label FROM model_keys ORDER BY key_id").all();
      const after = rows();
      expect(migrate(db).applied).toEqual([]);
      expect(rows()).toEqual(after);

      // The declarative track may have created the table before the migration ever sees it —
      // an unstamped database created by this build arrives already holding it. Running the
      // whole ladder over that must converge rather than fail, which is what the migration's
      // own IF NOT EXISTS buys, and a second pass must then do nothing at all.
      const declared = new sqlite.DatabaseSync(":memory:");
      try {
        declared.exec("PRAGMA foreign_keys = ON;");
        declared.exec(SCHEMA_SQL);
        expect(migrate(declared).applied).toEqual(MIGRATIONS.map((m) => m.name));
        expect(migrate(declared).applied).toEqual([]);
      } finally {
        declared.close();
      }
    } finally {
      db.close();
    }
  });

  it("leaves every existing row of every existing table alone", () => {
    const db = openBefore();
    try {
      db.exec(
        "INSERT INTO usage_records (ts, date, project_id, agent_id, session_id, provider, model_id," +
          " cache_read, cache_write, output, total)" +
          " VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01', 'p1', 'a1', 's1', 'deepseek', 'deepseek-chat'," +
          " 0, 0, 0, 0)",
      );
      migrate(db);
      expect(db.prepare("SELECT project_id FROM projects").all()).toEqual([{ project_id: "p1" }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM usage_records").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  /**
   * The rule the feature exists to enforce, asserted at the layer that actually enforces it.
   * Nothing here goes through a service: SQLite refuses the second write itself, which is the
   * difference between a constraint and a check-then-write another request can interleave.
   */
  it("the unique index refuses a second key with the same name in the same fleet", () => {
    const db = openBefore();
    try {
      migrate(db);
      insertKey(db, { keyId: "k_aaaaaaaaaaaa", name: "prod" });
      expect(() => insertKey(db, { keyId: "k_bbbbbbbbbbbb", name: "prod" })).toThrow(
        /UNIQUE constraint failed/i,
      );
      // The refused write left nothing behind: one key, still the one that was there first.
      expect(db.prepare("SELECT key_id FROM model_keys").all()).toEqual([
        { key_id: "k_aaaaaaaaaaaa" },
      ]);
    } finally {
      db.close();
    }
  });

  it("scopes that uniqueness to one fleet: the same name on another model is another key", () => {
    const db = openBefore();
    try {
      migrate(db);
      insertKey(db, {
        keyId: "k_aaaaaaaaaaaa",
        provider: "deepseek",
        modelId: "deepseek-chat",
        name: "prod",
      });
      expect(() =>
        insertKey(db, {
          keyId: "k_bbbbbbbbbbbb",
          provider: "deepseek",
          modelId: "deepseek-v4",
          name: "prod",
        }),
      ).not.toThrow();
      expect(() =>
        insertKey(db, {
          keyId: "k_cccccccccccc",
          provider: "openai",
          modelId: "deepseek-chat",
          name: "prod",
        }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("refuses a name differing only in case, so one fleet cannot hold two spellings", () => {
    const db = openBefore();
    try {
      migrate(db);
      insertKey(db, { keyId: "k_aaaaaaaaaaaa", name: "prod" });
      expect(() => insertKey(db, { keyId: "k_bbbbbbbbbbbb", name: "PROD" })).toThrow(
        /UNIQUE constraint failed/i,
      );
    } finally {
      db.close();
    }
  });

  it("down drops the names and the index, and leaves the rest of the database standing", () => {
    const db = openBefore();
    try {
      migrate(db);
      insertKey(db, { name: "prod", label: "shared team pool" });
      rollbackTo(db, LATEST_VERSION - 1);
      expect(schemaVersion(db)).toBe(LATEST_VERSION - 1);
      expect(hasTable(db, "model_keys")).toBe(false);
      expect(db.prepare("SELECT project_id FROM projects").all()).toEqual([{ project_id: "p1" }]);
      // And forward again: up ∘ down ∘ up lands on the same schema as up, with the names gone
      // (nothing rebuilds them — a rotated-away name is the user's to retype, not ours to invent).
      migrate(db);
      expect(db.prepare("SELECT COUNT(*) AS n FROM model_keys").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("is additive, so a rollback to a build without it survives the push path", () => {
    const migration = MIGRATIONS.find((m) => m.name === "model-keys");
    expect(migration?.swapSafe).toBe(true);
    // "Additive" is checked against the SQL, not the comment: the migration must not touch a
    // table that already existed, so a predecessor build has nothing it could be holding onto.
    const db = openBefore();
    try {
      db.exec("CREATE TABLE sentinel (x TEXT); INSERT INTO sentinel VALUES ('kept');");
      migrate(db);
      expect(db.prepare("SELECT x FROM sentinel").all()).toEqual([{ x: "kept" }]);
      rollbackTo(db, LATEST_VERSION - 1);
      expect(db.prepare("SELECT x FROM sentinel").all()).toEqual([{ x: "kept" }]);
    } finally {
      db.close();
    }
  });

  it("cascades: deleting a Project takes its key names with it, and nothing else", () => {
    const db = openBefore();
    try {
      migrate(db);
      seedProject(db, "p2");
      insertKey(db, { projectId: "p1" });
      insertKey(db, { projectId: "p2", keyId: "k_ffffffffffff", name: "staging" });
      db.prepare("DELETE FROM projects WHERE project_id = ?").run("p1");
      expect(db.prepare("SELECT project_id FROM model_keys").all()).toEqual([{ project_id: "p2" }]);
    } finally {
      db.close();
    }
  });
});
