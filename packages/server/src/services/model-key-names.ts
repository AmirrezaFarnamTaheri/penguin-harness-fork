/**
 * Names for the API keys of a Project's model key pools.
 *
 * THE PROBLEM THIS SOLVES. A pool is a comma-separated string on one model entry, so three
 * keys for the same model appear as three rows that differ by a masked suffix. Nothing tells
 * a human which is the staging key, which is the one that 429s, or which to replace. A NAME
 * is the identifier a person can actually use ("prod", "staging"), and an optional LABEL
 * carries what a name cannot ("shared team pool — do not rotate").
 *
 * WHY THE NAME LIVES IN SQLITE AND THE KEY STAYS IN THE CONFIG FILE. Two reasons, and the
 * second is the one that decides it:
 *
 *  1. Uniqueness has to be a CONSTRAINT. "Prod" on two keys of one fleet is the failure this
 *     feature exists to prevent, and a service that SELECTed-then-INSERTed would lose that
 *     race between two writers. The unique index is what makes the 409 real.
 *  2. A name is an ANNOTATION, not a credential. It travels to the fleet table, the pool
 *     view, and every toast that names a key, and none of those is a place to keep a secret.
 *     So the secret never comes here: what binds a name to one key is `keyId`, a
 *     domain-separated SHA-256 prefix of the key. Deterministic, so the same key under the
 *     same fleet always resolves to the same row; fleet-scoped, so one key configured on two
 *     models is two separately-named keys; and 14 characters, so nothing here can be walked
 *     back to a key by anything shorter than a preimage attack on the key itself.
 *
 * THE COST, STATED PLAINLY: the keys travel with the Project directory (and to the machines a
 * Project syncs to), and these names do not — a name survives on the server that stored it,
 * not in `.project_config.toml`. Moving a Project to another server brings its keys and loses
 * its names. That is the one thing to revisit if Projects ever move as a unit; storing the
 * pair as a positional array beside `api_keys` would travel, but could not be constrained and
 * would shift every name after it whenever a key was inserted in the middle.
 *
 * NO BACKFILL, DELIBERATELY. An existing key gets no name. Writing "Key 1" would invent a
 * choice the user never made, and the name is precisely a record of a choice; the only value
 * derivable from an unnamed key is a digest, which is not something a person would call a
 * key. So a key with no row is UNNAMED, and the UI says so in as many words and offers the
 * rename. The consequence for the migration is that it is pure DDL: no data to write, hence
 * nothing to get wrong on a re-run.
 */
import { createHash } from "node:crypto";
import { maskApiKey as fleetMaskApiKey, parseApiKeys } from "@prismshadow/penguin-core";
import {
  ModelKeyNameConflictError,
  type ModelKeyRow,
  type ModelKeysRepo,
} from "../db/repos/model-keys.js";
import { badRequest, notFound } from "../http/validate.js";
import { HttpError } from "../http/errors.js";
import { disambiguateKeyMasks, maskApiKey as narrowMaskApiKey } from "./model-key-health.js";
import { maskApiKey as rowMaskApiKey } from "./project-config-service.js";
import type { ProjectConfigService } from "./project-config-service.js";

/** Longest name: it is an identifier, it goes in toasts, and it shares a column with nothing. */
export const MAX_KEY_NAME_LENGTH = 64;
/** Longest label: free text, but bounded so one paste cannot turn a row into a document. */
export const MAX_KEY_LABEL_LENGTH = 500;

/**
 * Names are compared case-INSENSITIVELY. The column is COLLATE NOCASE, so the unique index
 * refuses "Prod" over "prod": two keys in one fleet whose names differ only in case are the
 * ambiguity this feature removes, and the stored spelling stays exactly as the user typed it.
 */
const NAME_PATTERN = new RegExp(`^[^\\p{Cc}\\p{Cf}]{1,${MAX_KEY_NAME_LENGTH}}$`, "u");

export interface ModelKeyNameDto {
  keyId: string;
  provider: string;
  modelId: string;
  name: string;
  label?: string;
  /**
   * The fleet mask (core's `maskApiKey`), which is the exact string `GET /api/cockpit/keys`
   * already puts on screen for this same key to this same audience — the fleet view joins on
   * it. It is a masked form, never the key, and it is not a wider view of the key than the
   * key-health report this service also feeds already gives. Absent on an orphan: its key is
   * gone, so there is nothing left to mask.
   */
  maskedKey?: string;
  /**
   * The models table's mask for the same key (`first4…last4`), for the surface that shows a
   * lone key on a model row and has no health report to join against. The narrowest of the
   * three the product renders, and the same one the models table already returns to every
   * member who can see the row. Absent on an orphan, for the same reason as `maskedKey`.
   */
  rowMask?: string;
  /**
   * The key this name was given to is no longer in the Project's pool — it was rotated or
   * deleted. The name is kept (deleting a user's words silently is worse) and reported, so
   * the pool view can say so instead of the name silently vanishing.
   */
  orphaned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a health report attaches to one key: the name, and the handle to rename it by. */
export interface KeyAnnotation {
  keyId: string;
  name: string;
  label?: string;
}

/** One key of a pool, resolved server-side. `key` never leaves this module's callers. */
interface PoolKey {
  keyId: string;
  /** Raw key material. Read from the config, used only to derive `keyId` and the masks. */
  key: string;
  /** core's mask — the cockpit fleet report's key identity. */
  fleetMask: string;
  /** The narrower mask the key-health report uses. */
  narrowMask: string;
  /** The narrowest mask — the one the models table's credential row shows. */
  rowMask: string;
}

/**
 * The handle a client may hold for a key: `k_` + 12 hex of a SHA-256 over a domain-separated
 * tuple. Domain separation means a digest computed here can never collide with a digest of
 * the same bytes for any other purpose, and the four context fields mean the id names exactly
 * one key of exactly one fleet of exactly one Project.
 */
function keyIdFor(projectId: string, provider: string, modelId: string, key: string): string {
  const digest = createHash("sha256")
    .update("penguin/model-key/v1")
    .update("\n")
    .update(projectId)
    .update("\n")
    .update(provider)
    .update("\n")
    .update(modelId)
    .update("\n")
    .update(key)
    .digest("hex");
  return `k_${digest.slice(0, 12)}`;
}

/** A provider/model pair, normalized the way the key rotator normalizes it. */
function normalizeFleet(provider: string, modelId: string): { provider: string; modelId: string } {
  return { provider: provider.toLowerCase().trim(), modelId: modelId.trim() };
}

/**
 * A collision-free Map key for a fleet. JSON, not a separator character: a model id is
 * user-supplied text, so any single-character join could be forged by an id containing it.
 */
function fleetIdOf(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

export interface SetKeyNameInput {
  provider: string;
  modelId: string;
  /** The masked key as the UI shows it — either mask the server emits. */
  maskedKey: string;
  name: string;
  label?: string;
}

export class ModelKeyNamesService {
  constructor(
    private readonly repo: ModelKeysRepo,
    private readonly config: ProjectConfigService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Every key of one pool, in the order the rotator sees them, with the ids derived.
   *
   * The `#2`, `#3` disambiguation of a colliding mask is copied from `KeyFleetMonitor`
   * verbatim: the fleet report's `maskedKey` carries it, so a client that echoes the mask it
   * was given back at this service must resolve to the same key it would resolve to there.
   */
  private async poolKeys(projectId: string, provider: string, modelId: string): Promise<PoolKey[]> {
    const fleet = normalizeFleet(provider, modelId);
    const raw = await this.config.readRaw(projectId);
    const models = Array.isArray(raw.models) ? raw.models : [];
    const entry = models.find((m: unknown) => {
      if (typeof m !== "object" || m === null) return false;
      const rec = m as Record<string, unknown>;
      return (
        typeof rec.provider === "string" &&
        typeof rec.model_id === "string" &&
        normalizeFleet(rec.provider, rec.model_id).provider === fleet.provider &&
        normalizeFleet(rec.provider, rec.model_id).modelId === fleet.modelId
      );
    }) as Record<string, unknown> | undefined;
    if (entry === undefined) return [];
    const keys = parseApiKeys((entry.api_keys ?? entry.api_key) as string | string[] | undefined);
    const narrowMasks = disambiguateKeyMasks(keys, narrowMaskApiKey);
    const used = new Set<string>();
    return keys.map((key, index) => {
      const base = fleetMaskApiKey(key);
      let masked = base;
      for (let suffix = 2; used.has(masked); suffix++) masked = `${base}#${suffix}`;
      used.add(masked);
      return {
        keyId: keyIdFor(projectId, fleet.provider, fleet.modelId, key),
        key,
        fleetMask: masked,
        narrowMask: narrowMasks[index]!,
        rowMask: rowMaskApiKey(key),
      };
    });
  }

  /**
   * The one key a masked string names, in a named fleet.
   *
   * Accepts either mask the server emits (the fleet's and the health report's), because those
   * are the two a client can legitimately hold, and a caller that has one should not have to
   * know which surface it came from.
   */
  private async resolve(
    projectId: string,
    provider: string,
    modelId: string,
    maskedKey: string,
  ): Promise<PoolKey> {
    const pool = await this.poolKeys(projectId, provider, modelId);
    if (pool.length === 0) {
      throw notFound(
        `No key pool is configured for ${normalizeFleet(provider, modelId).provider}/${modelId}.`,
      );
    }
    const wanted = maskedKey.trim();
    const matches = pool.filter((p) => p.fleetMask === wanted || p.narrowMask === wanted);
    if (matches.length === 0) {
      throw notFound(
        `No key in ${normalizeFleet(provider, modelId).provider}/${modelId} matches "${wanted}". ` +
          `Send the masked key exactly as the fleet shows it.`,
      );
    }
    if (matches.length > 1) {
      // Two DISTINCT keys whose masks collide: naming one of them by its bare mask would be a
      // coin flip, and a name attached to the wrong key is worse than no name at all.
      throw badRequest(
        `"${wanted}" matches ${matches.length} keys in this pool, so it does not name one. ` +
          `Send the exact mask the fleet shows for the key you mean.`,
      );
    }
    return matches[0]!;
  }

  /**
   * Names a key, or renames the one already named. Rejects before touching the store when the
   * request itself is wrong; the per-fleet uniqueness is NOT re-checked here — it is the
   * unique index, and the conflict it raises is what becomes the 409.
   */
  async set(projectId: string, input: SetKeyNameInput): Promise<ModelKeyNameDto> {
    const fleet = normalizeFleet(input.provider, input.modelId);
    const name = input.name.trim();
    if (name === "") throw badRequest("A key name is required.");
    if (name.length > MAX_KEY_NAME_LENGTH) {
      throw badRequest(`A key name must be at most ${MAX_KEY_NAME_LENGTH} characters.`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw badRequest(
        "A key name must be plain text: no control characters, no zero-width marks.",
      );
    }
    let label: string | undefined;
    if (input.label !== undefined) {
      const trimmed = input.label.trim();
      if (trimmed.length > MAX_KEY_LABEL_LENGTH) {
        throw badRequest(`A key label must be at most ${MAX_KEY_LABEL_LENGTH} characters.`);
      }
      // An empty label is "no label", not "a label that is empty": there is no distinction to
      // preserve here, unlike a model's display name, which the client round-trips.
      if (trimmed !== "") label = trimmed;
    }
    const target = await this.resolve(projectId, fleet.provider, fleet.modelId, input.maskedKey);
    const at = this.now().toISOString();
    const existing = this.repo.get(projectId, target.keyId);
    const row: ModelKeyRow = {
      projectId,
      keyId: target.keyId,
      provider: fleet.provider,
      modelId: fleet.modelId,
      name,
      ...(label !== undefined ? { label } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    try {
      this.repo.upsert(row);
    } catch (err) {
      if (err instanceof ModelKeyNameConflictError) {
        throw new HttpError(409, "key_name_taken", err.message);
      }
      throw err;
    }
    return {
      keyId: row.keyId,
      provider: row.provider,
      modelId: row.modelId,
      name: row.name,
      ...(row.label !== undefined ? { label: row.label } : {}),
      maskedKey: target.fleetMask,
      rowMask: target.rowMask,
      orphaned: false,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Forgets one key's name. The key itself is untouched — it lives in the Project config. */
  clear(projectId: string, keyId: string): void {
    if (!this.repo.delete(projectId, keyId)) {
      throw notFound(`No key named ${keyId} in this Project.`);
    }
  }

  /**
   * Every name in the Project, joined onto the pools that still hold the key.
   *
   * One query for the rows, one pass over the config for the pools: a fleet of any size is
   * answered with a single read of each, never a per-key one. A name whose key is gone comes
   * back flagged `orphaned` rather than filtered out, because silently dropping a word the
   * user typed is the one outcome that teaches them the feature loses things.
   */
  async list(projectId: string): Promise<ModelKeyNameDto[]> {
    const rows = this.repo.listByProject(projectId);
    if (rows.length === 0) return [];
    const fleets = new Map<string, PoolKey[]>();
    const fleetRefs = new Map<string, { provider: string; modelId: string }>();
    for (const row of rows) {
      const ref = { provider: row.provider, modelId: row.modelId };
      fleetRefs.set(fleetIdOf(ref.provider, ref.modelId), ref);
    }
    await Promise.all(
      [...fleetRefs.entries()].map(async ([id, ref]) => {
        fleets.set(id, await this.poolKeys(projectId, ref.provider, ref.modelId));
      }),
    );
    return rows.map((row) => {
      const pool = fleets.get(fleetIdOf(row.provider, row.modelId)) ?? [];
      const target = pool.find((p) => p.keyId === row.keyId);
      return {
        keyId: row.keyId,
        provider: row.provider,
        modelId: row.modelId,
        name: row.name,
        ...(row.label !== undefined ? { label: row.label } : {}),
        ...(target !== undefined ? { maskedKey: target.fleetMask, rowMask: target.rowMask } : {}),
        orphaned: target === undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  /**
   * The names of one pool, keyed by a mask the CALLER already holds.
   *
   * The mask is a parameter because the two surfaces that show a key mask it differently —
   * `GET /models/keys/health` keeps 3 leading characters, the cockpit fleet report keeps up
   * to 7 — and each can only join onto the string it actually displays. Handing back the other
   * one would have the caller join on a value it was never shown, which is how a name ends up
   * attached to the wrong key.
   */
  async annotationsForFleet(
    projectId: string,
    provider: string,
    modelId: string,
    mask: (key: string) => string,
  ): Promise<Map<string, KeyAnnotation>> {
    const fleet = normalizeFleet(provider, modelId);
    const pool = await this.poolKeys(projectId, fleet.provider, fleet.modelId);
    if (pool.length === 0) return new Map();
    const rows = this.repo.listByProject(projectId);
    const byKeyId = new Map(rows.map((r) => [r.keyId, r] as const));
    const out = new Map<string, KeyAnnotation>();
    const masks = disambiguateKeyMasks(
      pool.map((p) => p.key),
      mask,
    );
    for (const [index, p] of pool.entries()) {
      const row = byKeyId.get(p.keyId);
      if (row === undefined) continue;
      out.set(masks[index]!, {
        keyId: row.keyId,
        name: row.name,
        ...(row.label !== undefined ? { label: row.label } : {}),
      });
    }
    return out;
  }
}

export { keyIdFor };
