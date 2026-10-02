/**
 * Write pressure policy — the guardrail for the harness's own **nonessential writes**.
 *
 * ## What this is, and what it is deliberately not
 *
 * `agent/resource/pressure-probe.ts` observes and never gates: its directory states, and must
 * keep stating, that no pressure reading has a path to a refusal. This module is the other half
 * of that discipline — a *named, bounded* policy over writes the harness makes **for its own
 * convenience**, where refusing one costs convenience and never work:
 *
 * - the tool-output **truncation archive** (`truncated-tool-output-archive.ts`, the `.log`
 *   capture files) and the **recall store** (the recallable copies the `recall_output` tool reads)
 *   are the two nonessential producers. If either write is refused, the tool result is still in
 *   the conversation and the model still has the compressed output; nothing is lost that the
 *   Session needs to continue or to recover.
 * - the user's own work is **not** a producer here. `write_file` / `edit_file` are exempt
 *   (`user-work`): the harness does not refuse the write the user asked for because a disk is
 *   nearly full. The `resource_pressure` tool stays observational.
 *
 * The policy's shape follows from the recovery requirement: **export, deletion, cleanup and
 * recovery are exempt by construction, not by an override.** A policy that blocked them would be
 * a policy that traps a machine at 40 MiB free with no way out; the whole point of firing under
 * pressure is that the operations which *relieve* pressure keep working.
 *
 * ## Thresholds, and the unit they are stated in
 *
 * 200 MiB warns and 50 MiB blocks, and the unit is **bytes**, which is the unit the probe already
 * reports (`statfs`: `bsize * bavail`, and `os.freemem()` — both bytes). The thresholds are
 * written as the explicit products the card asks for, so nothing here depends on a reader
 * knowing what a "MiB" multiplies to:
 *
 * | threshold | MiB | bytes        |
 * | --------- | --- | ------------ |
 * | warn      | 200 | 209,715,200  |
 * | block     | 50  | 52,428,800   |
 *
 * Comparison is **strictly below** (`free < threshold`), which is what makes the boundary
 * readings behave as specified: at exactly 200 MiB neither rule fires, and at exactly 50 MiB the
 * warn rule fires while the stricter block rule does not. A file that lands between the two
 * thresholds is written with a warning; one below the block threshold is refused (unless a
 * trusted override covers that write).
 *
 * ## Three ways to have no valid measurement — all of them warn, none of them block
 *
 *  1. **The probe is unavailable** (no probe configured, the sweep threw, the path's sample
 *     carries an `error`). The decision is `warn` with `write_pressure_probe_unavailable`.
 *  2. **The reading is for a different volume** than the one the producer writes to. Applying
 *     another filesystem's free space would be worse than no number: `warn` with
 *     `write_pressure_wrong_volume`.
 *  3. **The reading is not a usable number** (`NaN`, `Infinity`, negative). Same treatment.
 *
 * In every one of those cases `freeBytes` is `null` in the decision, never `0`: "no measurement"
 * and "zero bytes free" are different answers, and a caller that conflates them would either
 * block on a guess or report a volume as full when nobody measured it.
 *
 * A *measured* `freeBytes: 0` **does** block — that is a real reading from a full filesystem, and
 * it is reachable only through the measured path.
 *
 * ## The override
 *
 * A refusal is a decision made for the agent, and the card requires the human to be able to take
 * it back — authenticated, recorded, and scoped to the one write it was granted for. Hence
 * {@link PressureOverrideStore}: grants are keyed by `(sessionId, producerId, toolCallId,
 * volumePath)`, carry who granted them and when, are **single-use** (consuming one records
 * `consumedAt`), and cannot be reached by anything the model writes. That last property is
 * structural rather than a check: {@link evaluateWritePressure} takes a producer id, a reading
 * and an override *lookup key* — it has no parameter for tool arguments, so an argument named
 * `force`, `overrideId` or `pressure` has nowhere to enter the decision. The test file asserts
 * this by driving the same decisions with payload-shaped objects in scope.
 *
 * ## Reversibility (the card's rollback)
 *
 * Nothing here changes the probe or the `resource_pressure` tool: the policy reads the probe's
 * TTL-cached report and is off unless a caller injects a gate (see
 * `truncated-tool-output-archive.ts`). Removing the injection restores the previous behavior
 * exactly; no persisted format depends on the policy.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ResourcePressureReport } from "../agent/resource/pressure-probe.js";
import { atomicWriteFile } from "./atomic-write.js";

/** 200 MiB, in bytes — the number statfs reports (`bsize * bavail`). */
export const PRESSURE_WARN_BELOW_BYTES = 200 * 1024 * 1024; // 209_715_200

/** 50 MiB, in bytes — strictly-below comparison, so a volume with exactly this much warns but does not block. */
export const PRESSURE_BLOCK_BELOW_BYTES = 50 * 1024 * 1024; // 52_428_800

/** The unit both thresholds are stated in, and the unit the probe reports (`bsize * bavail`). */
export const PRESSURE_THRESHOLD_UNIT = "bytes" as const;

/** Why a write is outside this policy. Each one is a named decision, never a silence. */
export type WriteExemption =
  /** Reads, indexes, searches: they do not write. */
  | "read-only"
  /** The user's own files. The harness does not refuse the work it was asked to do. */
  | "user-work"
  /** A child Session's own calls are checked at their own boundary. */
  | "delegated"
  /** Frees space (deletion, eviction, prune): blocking these under pressure removes the way out. */
  | "frees-space"
  /** Exports and backups: the recovery path. */
  | "export"
  /** A command's destination is not in its arguments, so only the warning applies. */
  | "unresolvable-destination";

/** One entry of the inventory: either a blockable nonessential producer or a named exemption. */
export interface WriteProducerInventoryEntry {
  /** Tool name or producer id — the key the boundary passes in, never a model-supplied string. */
  readonly id: string;
  /** Nonessential producers are the policy's only refusal surface. */
  readonly nonessential: boolean;
  /** Why this entry is where it is; an exemption's reason is the decision. */
  readonly reason: string;
  /** For a nonessential producer: the id the boundary admits against. */
  readonly producerId?: NonessentialProducerId;
}

/** The harness's own convenience writers — the only two things this policy may refuse. */
export type NonessentialProducerId = "tool-output-archive" | "recall-store";

export const NONESSENTIAL_PRODUCERS: readonly NonessentialProducerId[] = [
  "tool-output-archive",
  "recall-store",
];

/**
 * The inventory the card asks for: every write-capable tool / producer, classified, with the
 * reason recorded. The fixture in the test file asserts this table entry by entry, so an
 * exemption cannot be added by becoming silent.
 */
export const WRITE_PRODUCER_INVENTORY: readonly WriteProducerInventoryEntry[] = [
  // Nonessential producers (blockable).
  {
    id: "tool-output-archive",
    nonessential: true,
    producerId: "tool-output-archive",
    reason:
      "the .log capture of an over-long tool result; refusing it keeps the result in the conversation",
  },
  {
    id: "recall-store",
    nonessential: true,
    producerId: "recall-store",
    reason:
      "the recallable copy read by recall_output; refusing it costs the id, not the tool result",
  },
  // Read-only tools.
  ...(
    [
      "read_file",
      "code_graph",
      "knowledge_graph",
      "environment_info",
      "recall_output",
      "resource_pressure",
      "web_search",
    ] as const
  ).map((id) => ({ id, nonessential: false, reason: "read-only: it does not write" }) as const),
  // The user's own files.
  {
    id: "write_file",
    nonessential: false,
    reason: "user-work: the file the user asked for is not a convenience write",
  },
  {
    id: "edit_file",
    nonessential: false,
    reason: "user-work: the file the user asked for is not a convenience write",
  },
  // Delegation: the child's calls are admitted at their own boundary.
  {
    id: "run_subagent",
    nonessential: false,
    reason: "delegated: the child Session's calls are checked at the child's own boundary",
  },
  {
    id: "input_subagent",
    nonessential: false,
    reason: "delegated: the child Session's calls are checked at the child's own boundary",
  },
  // Shell: no resolvable destination in the arguments — warn, never block.
  {
    id: "exec_command",
    nonessential: false,
    reason:
      "unresolvable-destination: a command's target volume is not in its arguments (see the module's reopen condition)",
  },
  {
    id: "input_command",
    nonessential: false,
    reason: "unresolvable-destination: characters typed into a running command name no destination",
  },
  // Space-relieving and recovery operations.
  {
    id: "session-delete",
    nonessential: false,
    reason: "frees-space: deleting a Session releases the bytes the policy is reacting to",
  },
  {
    id: "archive-eviction",
    nonessential: false,
    reason: "frees-space: eviction/prune is the archive's own cleanup path",
  },
  {
    id: "session-export",
    nonessential: false,
    reason: "export: a backup is the recovery path and must work under pressure",
  },
];

/** The inventory entry for an id, or null when the id is not in the table at all. */
export function writeProducerEntry(id: string): WriteProducerInventoryEntry | null {
  return WRITE_PRODUCER_INVENTORY.find((entry) => entry.id === id) ?? null;
}

/** A measurement of one volume, or a named reason there is none. */
export type PressureReading =
  | { readonly kind: "measured"; readonly volumePath: string; readonly freeBytes: number }
  | { readonly kind: "unavailable"; readonly volumePath: string; readonly reason: string };

/** The named signals. A warning carries one; it is never folded into "the write failed". */
export type PressureSignal =
  | "write_pressure_low"
  | "write_pressure_probe_unavailable"
  | "write_pressure_wrong_volume"
  | "write_pressure_blocked";

/** What the boundary does with one write. */
export interface PressureDecision {
  readonly action: "allow" | "warn" | "block";
  /** The signal that fired, or null when the write proceeded with nothing to report. */
  readonly signal: PressureSignal | null;
  readonly producerId: string;
  readonly volumePath: string;
  /** The measured free space, or null when there was no valid measurement — never 0-as-unknown. */
  readonly freeBytes: number | null;
  /** Human-readable reason, present whenever a signal fired. */
  readonly reason: string;
  /** The consumed override that admitted this write, when one did. */
  readonly overrideId: string | null;
}

/** The identity of one write, as the trusted boundary knows it — never from tool arguments. */
export interface PressureWriteKey {
  readonly sessionId: string;
  readonly producerId: string;
  readonly toolCallId: string;
  readonly volumePath: string;
}

/** A granted override. `grant` is the only way to create one; the store records who and when. */
export interface PressureOverrideRecord extends PressureWriteKey {
  readonly overrideId: string;
  readonly grantedBy: "operator" | "cli" | "approval";
  readonly grantedAt: number;
  readonly reason: string;
  /** Set when this override admitted a write. A consumed override admits nothing else. */
  readonly consumedAt?: number;
}

/**
 * Single-use, write-scoped overrides.
 *
 * The store is the only place an override can come from, and it is populated by the
 * authenticated surfaces (the approval decision, the CLI, an operator action) — none of which is
 * reachable from a tool call's payload. Keying on all four fields is what makes an override
 * incapable of widening anything: a grant for one Session, producer, call or volume cannot admit
 * another, and {@link consume} returns a record exactly once.
 */
export class PressureOverrideStore {
  private readonly records = new Map<string, PressureOverrideRecord>();
  private sequence = 0;
  private readonly now: () => number;
  /** When set, grants are recorded here and re-read before a consume, so a grant survives a restart. */
  private readonly persistPath: string | undefined;
  /** The last serialized state this process wrote or read — used to skip a redundant re-read. */
  private loadedText: string | null = null;

  constructor(options: { now?: () => number; persistPath?: string } = {}) {
    this.now = options.now ?? Date.now;
    this.persistPath = options.persistPath;
  }

  /**
   * Records a grant.
   *
   * `write: false` keeps it in memory (tests, and hosts that do not want a file); the default
   * persists it, because "recorded" is the property the card asks for and an in-memory record
   * dies with the process that made it.
   */
  async grant(
    request: PressureWriteKey & {
      grantedBy: PressureOverrideRecord["grantedBy"];
      reason: string;
      write?: boolean;
    },
  ): Promise<PressureOverrideRecord> {
    this.sequence += 1;
    const record: PressureOverrideRecord = {
      sessionId: request.sessionId,
      producerId: request.producerId,
      toolCallId: request.toolCallId,
      volumePath: request.volumePath,
      grantedBy: request.grantedBy,
      reason: request.reason,
      overrideId: `pressure-override-${this.sequence}`,
      grantedAt: this.now(),
    };
    await this.loadFromDisk();
    this.records.set(overrideKey(record), record);
    if (this.persistPath !== undefined && request.write !== false) await this.saveToDisk();
    return record;
  }

  /**
   * Takes the override for exactly this write, marking it consumed. Returns null if none.
   *
   * Re-reads the record file first: the grant may have been made by another process (the server
   * route that authenticated the human), and consuming a stale copy would either miss it or hand
   * the same grant to two writes.
   */
  async consume(key: PressureWriteKey): Promise<PressureOverrideRecord | null> {
    await this.loadFromDisk();
    const lookup = overrideKey(key);
    const record = this.records.get(lookup);
    if (record === undefined || record.consumedAt !== undefined) return null;
    const consumed: PressureOverrideRecord = { ...record, consumedAt: this.now() };
    this.records.set(lookup, consumed);
    if (this.persistPath !== undefined) await this.saveToDisk();
    return consumed;
  }

  /** Every grant this store has accepted, consumed ones included — the record the card asks for. */
  list(): readonly PressureOverrideRecord[] {
    return [...this.records.values()];
  }

  /**
   * Reads the durable records, tolerating every failure mode by *not* inventing grants: a missing
   * file is an empty store, and a corrupt one is treated as empty (and left alone) rather than
   * parsed into something that could admit a write. The refusal that would have needed a grant
   * still stands, which is the safe direction.
   */
  private async loadFromDisk(): Promise<void> {
    if (this.persistPath === undefined) return;
    let text: string;
    try {
      text = await readFile(this.persistPath, "utf8");
    } catch {
      this.loadedText = null;
      return;
    }
    if (text === this.loadedText) return;
    try {
      const parsed = JSON.parse(text) as { records?: unknown };
      if (!Array.isArray(parsed.records)) throw new Error("records is not an array");
      const next = new Map<string, PressureOverrideRecord>();
      for (const candidate of parsed.records) {
        const record = asPressureOverrideRecord(candidate);
        if (record !== null) next.set(overrideKey(record), record);
      }
      this.records.clear();
      for (const [key, record] of next) this.records.set(key, record);
      this.loadedText = text;
    } catch {
      // Corrupt file: ignore it, keep whatever this process already knew. Nothing is admitted
      // because of it, and nothing is overwritten until the next explicit grant.
      this.loadedText = null;
    }
  }

  private async saveToDisk(): Promise<void> {
    if (this.persistPath === undefined) return;
    const payload = JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] });
    await mkdir(path.dirname(this.persistPath), { recursive: true });
    await atomicWriteFile(this.persistPath, payload, { mode: 0o600 });
    this.loadedText = payload;
  }
}

/** A parsed record, or null when the entry is not a complete, well-typed grant. */
function asPressureOverrideRecord(value: unknown): PressureOverrideRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const strings = [
    "sessionId",
    "producerId",
    "toolCallId",
    "volumePath",
    "overrideId",
    "reason",
  ] as const;
  for (const field of strings) {
    if (typeof record[field] !== "string") return null;
  }
  if (typeof record.grantedAt !== "number" || !Number.isFinite(record.grantedAt)) return null;
  if (
    record.grantedBy !== "operator" &&
    record.grantedBy !== "cli" &&
    record.grantedBy !== "approval"
  )
    return null;
  if (record.consumedAt !== undefined && typeof record.consumedAt !== "number") return null;
  const consumedAt = record.consumedAt as number | undefined;
  return {
    sessionId: record.sessionId as string,
    producerId: record.producerId as string,
    toolCallId: record.toolCallId as string,
    volumePath: record.volumePath as string,
    overrideId: record.overrideId as string,
    reason: record.reason as string,
    grantedAt: record.grantedAt,
    grantedBy: record.grantedBy,
    ...(consumedAt === undefined ? {} : { consumedAt }),
  };
}

function overrideKey(key: PressureWriteKey): string {
  return [key.sessionId, key.producerId, key.toolCallId, key.volumePath].join("\u0000");
}

/**
 * The decision, from three inputs and nothing else.
 *
 * There is deliberately no parameter for a tool call's arguments: the model cannot reach this
 * function's inputs, which is a stronger guarantee than validating a field it could set.
 */
export async function evaluateWritePressure(options: {
  producerId: string;
  reading: PressureReading | null;
  /** The id the *boundary* resolved for this producer, from the inventory — not from payload. */
  inventoryId?: string;
  /** The key of this write, looked up in `overrides` when the decision would otherwise block. */
  writeKey: PressureWriteKey;
  overrides?: PressureOverrideStore;
}): Promise<PressureDecision> {
  const { producerId, reading, writeKey, overrides } = options;
  const entry = writeProducerEntry(options.inventoryId ?? producerId);
  const base = { producerId, volumePath: writeKey.volumePath };

  // Exempt, or not in the inventory at all: the policy has no opinion on this write. An unknown
  // id is treated as exempt rather than blocked — this is a guardrail for the harness's own two
  // producers, not a gate on everything a future tool might do.
  if (entry === null || !entry.nonessential) {
    return {
      ...base,
      action: "allow",
      signal: null,
      freeBytes: null,
      reason: entry?.reason ?? "not a nonessential producer in the inventory",
      overrideId: null,
    };
  }

  const measured = measuredReading(reading, writeKey.volumePath);
  if (measured === null) {
    return {
      ...base,
      action: "warn",
      signal:
        reading === null || reading.kind === "unavailable"
          ? "write_pressure_probe_unavailable"
          : "write_pressure_wrong_volume",
      freeBytes: null,
      reason:
        reading === null
          ? "no pressure reading was available for this volume"
          : reading.kind === "unavailable"
            ? reading.reason
            : `the reading was for ${reading.volumePath}, not ${writeKey.volumePath}`,
      overrideId: null,
    };
  }

  if (measured < PRESSURE_BLOCK_BELOW_BYTES) {
    const override = (await overrides?.consume(writeKey)) ?? null;
    if (override !== null) {
      return {
        ...base,
        action: "allow",
        signal: null,
        freeBytes: measured,
        reason: `a recorded override (${override.overrideId}) admitted this write`,
        overrideId: override.overrideId,
      };
    }
    return {
      ...base,
      action: "block",
      signal: "write_pressure_blocked",
      freeBytes: measured,
      reason: `${measured} bytes free is below the ${PRESSURE_BLOCK_BELOW_BYTES}-byte block threshold`,
      overrideId: null,
    };
  }

  if (measured < PRESSURE_WARN_BELOW_BYTES) {
    return {
      ...base,
      action: "warn",
      signal: "write_pressure_low",
      freeBytes: measured,
      reason: `${measured} bytes free is below the ${PRESSURE_WARN_BELOW_BYTES}-byte warning threshold`,
      overrideId: null,
    };
  }

  return {
    ...base,
    action: "allow",
    signal: null,
    freeBytes: measured,
    reason: "free space is above the warning threshold",
    overrideId: null,
  };
}

/**
 * The reading's byte count, but only when it is a real measurement *of this volume*.
 * `NaN`, `Infinity` and negative values are not measurements; zero is.
 */
function measuredReading(reading: PressureReading | null, volumePath: string): number | null {
  if (reading === null || reading.kind !== "measured") return null;
  if (reading.volumePath !== volumePath) return null;
  const free = reading.freeBytes;
  if (!Number.isFinite(free) || free < 0) return null;
  return free;
}

/**
 * The gate a write boundary consults before a nonessential write (I7.2).
 *
 * `admit` never throws: a probe failure becomes a `warn` decision inside
 * {@link createProbeWritePressureGate}, because a boundary that cannot tell "no reading" from
 * "allow" would have to choose between failing open and failing closed on its own — and neither
 * is its call to make.
 */
export interface WritePressureGate {
  admit(request: {
    producerId: NonessentialProducerId;
    /** The boundary's own identity for this write (a tool call id); never read from payload. */
    toolCallId: string;
  }): Promise<PressureDecision>;
}

/**
 * The production gate: the probe's TTL-cached report for one volume, the inventory, and the
 * override store — bound to one Session and one volume by the caller that owns them.
 */
export function createProbeWritePressureGate(options: {
  probe: PressureReportSource;
  volumePath: string;
  sessionId: string;
  overrides?: PressureOverrideStore;
}): WritePressureGate {
  return {
    async admit({ producerId, toolCallId }): Promise<PressureDecision> {
      const reading = await readVolumePressure(options.probe, options.volumePath);
      return await evaluateWritePressure({
        producerId,
        reading,
        writeKey: {
          sessionId: options.sessionId,
          producerId,
          toolCallId,
          volumePath: options.volumePath,
        },
        ...(options.overrides ? { overrides: options.overrides } : {}),
      });
    },
  };
}

/** The probing half the boundary needs; `ResourcePressureProbe.probe` satisfies it. */
export interface PressureReportSource {
  probe(force?: boolean): Promise<ResourcePressureReport>;
}

/**
 * Reads one volume's free space out of the probe's report.
 *
 * The probe's TTL cache and single-flight are the point of going through it: a burst of writes
 * costs one statfs sweep, and each sample's `ageMs` is the probe's business, not this module's.
 * A sample carrying an `error` is unavailable — the probe reports a failed path with zero bytes
 * and an error message, and reading that zero as "the disk is full" would be the exact
 * invention this policy must not make.
 */
export async function readVolumePressure(
  probe: PressureReportSource,
  volumePath: string,
): Promise<PressureReading> {
  let report: ResourcePressureReport;
  try {
    report = await probe.probe();
  } catch (err) {
    return {
      kind: "unavailable",
      volumePath,
      reason: `the pressure probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const sample = report.disks.find((disk) => disk.path === volumePath);
  if (sample === undefined) {
    return {
      kind: "unavailable",
      volumePath,
      reason: `the pressure probe has no reading for ${volumePath}`,
    };
  }
  if (sample.error !== undefined) {
    return {
      kind: "unavailable",
      volumePath,
      reason: `the pressure probe could not read ${volumePath}: ${sample.error}`,
    };
  }
  return { kind: "measured", volumePath, freeBytes: sample.freeBytes };
}
