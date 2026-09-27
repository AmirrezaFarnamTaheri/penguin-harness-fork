/**
 * Repo for the user-set names of a Project's model API keys.
 *
 * WHAT THIS TABLE IS NOT: it is not a key store. Key material is write-only in
 * `.project_config.toml` and is not, was not, and must not become a column here. What a row
 * holds is an ANNOTATION — a name and an optional label — bound to one specific key by
 * `keyId`, a domain-separated SHA-256 prefix of that key (see `services/model-key-names.ts`).
 * Reading this table therefore cannot reveal a secret, and deleting it costs a name, never a
 * key.
 *
 * UNIQUENESS LIVES HERE, IN THE INDEX, NOT IN A SERVICE CHECK. `idx_model_keys_fleet_name`
 * makes a name unique per fleet — the same `name` twice under one `(provider, model_id)` is a
 * constraint violation, which the route turns into a 409. A service that SELECTed first and
 * INSERTed second would answer the same 409 in every case except the one that matters: two
 * writers naming two different keys "prod" at the same moment, where the second write is
 * exactly the one a check-then-write loses. The same name under a DIFFERENT model is a
 * different fleet and is allowed, which is why the index is scoped and not on `name` alone.
 *
 * A dumb store, like every other repo here: no interpretation of the name, no masking, no
 * business rules beyond the one the schema states. The service above it owns what a legal
 * name is; this file only turns SQLITE_CONSTRAINT into a named failure so the route can map
 * it, rather than letting a driver message reach a client.
 */
import type { DatabaseSync } from "node:sqlite";

export interface ModelKeyRow {
  projectId: string;
  keyId: string;
  provider: string;
  modelId: string;
  name: string;
  /** Optional free text; undefined = no label set. An empty string is stored as NULL. */
  label?: string;
  createdAt: string;
  updatedAt: string;
}

function toRow(row: Record<string, unknown>): ModelKeyRow {
  const label = row.label as string | null;
  return {
    projectId: row.project_id as string,
    keyId: row.key_id as string,
    provider: row.provider as string,
    modelId: row.model_id as string,
    name: row.name as string,
    // An empty string and NULL both mean "no label": the route trims, so a label of only
    // spaces never reaches here, and no consumer has to know which of the two it is looking at.
    ...(label !== null && label !== "" ? { label } : {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * The write lost a race, or would have broken the per-fleet name rule. Thrown rather than
 * returned so a caller cannot accidentally treat it as success — the distinguishing detail
 * (`err.code`) is what the route reads to answer 409 instead of 500.
 */
export class ModelKeyNameConflictError extends Error {
  readonly code = "model_key_name_taken";
  constructor(readonly fleet: { provider: string; modelId: string; name: string }) {
    super(`Another key in ${fleet.provider}/${fleet.modelId} is already named "${fleet.name}".`);
    this.name = "ModelKeyNameConflictError";
  }
}

/** The primary key already holds a row for this id (a re-put of the same key, not a rename). */
export class ModelKeyIdConflictError extends Error {
  readonly code = "model_key_id_taken";
  constructor(readonly keyId: string) {
    super(`A different key is already recorded under id ${keyId}.`);
    this.name = "ModelKeyIdConflictError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

export class ModelKeysRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Every named key of one Project, oldest first — the order names were given in. */
  listByProject(projectId: string): ModelKeyRow[] {
    const rows = this.db
      .prepare(
        "SELECT project_id, key_id, provider, model_id, name, label, created_at, updated_at" +
          " FROM model_keys WHERE project_id = ? ORDER BY created_at, name",
      )
      .all(projectId) as unknown as Record<string, unknown>[];
    return rows.map(toRow);
  }

  /** One row by its id, scoped to the Project so an id from another Project never resolves. */
  get(projectId: string, keyId: string): ModelKeyRow | undefined {
    const row = this.db
      .prepare(
        "SELECT project_id, key_id, provider, model_id, name, label, created_at, updated_at" +
          " FROM model_keys WHERE project_id = ? AND key_id = ?",
      )
      .get(projectId, keyId) as Record<string, unknown> | undefined;
    return row ? toRow(row) : undefined;
  }

  /**
   * Names a key, or renames the one already named under `keyId`.
   *
   * One statement, not a delete-then-insert: an UPDATE that would take a name another key in
   * the same fleet already holds fails on the unique index and leaves the existing row exactly
   * as it was. A delete-then-insert would, on that same collision, destroy the name it was
   * trying to move away from.
   */
  upsert(row: ModelKeyRow): ModelKeyRow {
    const label = row.label !== undefined && row.label !== "" ? row.label : null;
    try {
      if (this.get(row.projectId, row.keyId) !== undefined) {
        this.db
          .prepare(
            "UPDATE model_keys SET name = ?, label = ?, provider = ?, model_id = ?, updated_at = ?" +
              " WHERE project_id = ? AND key_id = ?",
          )
          .run(row.name, label, row.provider, row.modelId, row.updatedAt, row.projectId, row.keyId);
        return row;
      }
      this.db
        .prepare(
          "INSERT INTO model_keys (project_id, key_id, provider, model_id, name, label, created_at, updated_at)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          row.projectId,
          row.keyId,
          row.provider,
          row.modelId,
          row.name,
          label,
          row.createdAt,
          row.updatedAt,
        );
      return row;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The index names the columns it refused on: the per-fleet name rule when `name` is in
      // it, the primary key otherwise. Both are conflicts, never a server fault.
      const message = err instanceof Error ? err.message : String(err);
      if (/model_keys\.name/.test(message)) {
        throw new ModelKeyNameConflictError({
          provider: row.provider,
          modelId: row.modelId,
          name: row.name,
        });
      }
      throw new ModelKeyIdConflictError(row.keyId);
    }
  }

  /**
   * Forgets one key's name (the key itself is untouched — it lives in the Project config).
   * Returns whether a row was there, so a caller can answer 404 rather than a hollow 200.
   */
  delete(projectId: string, keyId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM model_keys WHERE project_id = ? AND key_id = ?")
      .run(projectId, keyId);
    return Number(res.changes) > 0;
  }
}
