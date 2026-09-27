/**
 * A bounded, queryable journal of advisory observations.
 *
 * WHY THIS EXISTS. The rest of this module can count (`activity.ts`) and can ask
 * (`advisor.ts`, `surfaces.ts`), but it cannot answer the only two questions an operator
 * actually has after the fact: *what did the advisory say about that call?* and *what
 * changed between then and now?* Counters answer "is it healthy"; they cannot answer either.
 * The families under `JEV-Family/` that keep a real observation history all do it the same
 * way — a fixed-capacity ring plus a monotonic sequence number — and the sequence number is
 * what makes "everything after X" a subtraction rather than a guess. See PROVENANCE below.
 *
 * WHY IT IS SAFE TO SHIP. It is observation-only in the strongest available sense, and that
 * is structural rather than promised:
 *
 * - **No provider call.** This file makes no request, opens no socket, and imports no client.
 *   The only import from the rest of the module is a TYPE, so this cannot create a cycle
 *   through `client.ts` and cannot be wired into a request path by accident.
 * - **Total.** Every method is synchronous and total. There is no `await`, so there is no
 *   way for a journal operation to delay a caller, and no throw path, so a full or corrupted
 *   journal cannot fail a turn that is already running. `record` on a full journal drops the
 *   oldest entry; it never rejects the newest.
 * - **No text anywhere.** Every field is a number, `null`, or a word from a closed
 *   vocabulary. This mirrors the rule `activity.ts` already states: a metric whose key space
 *   comes from data is a memory leak and a cardinality explosion waiting to happen. There is
 *   no string in {@link JevObservation} that came from a tool call, a prompt, or a provider
 *   body, so there is nothing here to redact later and nothing to leak when it is exported.
 * - **Cannot be a control-flow input.** {@link JevObservation} has no field a caller could
 *   branch on to allow or deny anything: no `decision`, no `approved`, no `block`. The
 *   journal's own API reinforces this — it returns observations and counts, never a verdict.
 *   `budget.exceeded` below is a REPORTED FACT about spend, not a permission to spend; see
 *   the note on `JevBudget` for why that distinction is load-bearing.
 * - **Bounded.** Capacity is clamped to {@link JEV_MAX_OBSERVATIONS} and the backing store is
 *   a fixed-size ring allocated once in the constructor, so the memory a journal occupies is
 *   decided when it is built and cannot grow with traffic, sessions, or fleet size. This
 *   codebase has been bitten by unbounded growth twice; the ring is the answer, and
 *   `packages/core/test/jev-observation-invariants.test.ts` asserts the bound rather than
 *   trusting it.
 *
 * WHAT IT IS NOT. It is not a control surface, not an alerting pipeline, and not a query
 * language. It is a bounded ring with three reads over it. If a caller needs the full run,
 * that is a trace store's job, and pointing this at one is how the memory bound gets lost.
 *
 * PROVENANCE. See `packages/core/src/jev/PROVENANCE.md` for the per-idea audit trail. In
 * summary: the fixed-capacity ring and the monotonic-sequence `since()` cursor are adapted
 * from JEV-Family's `jev-gateway` (`src/events.ts`, MIT (c) 2026 Vinicius Lana) and the
 * closed-vocabulary classification is adapted from `jev-pruner` (`src/retention.ts`,
 * MIT (c) 2025). Both were read, understood, and rewritten for this module's shape; no code
 * was copied verbatim, and neither author is placed on a code path they did not consent to.
 */

import type { AdvisoryReason, AdvisorySurface } from "./activity.js";
import type { JevToolAdvisory } from "./types.js";

/**
 * The largest journal this module will build, whatever a caller asks for. The cap exists
 * because the capacity is a memory decision, and a memory decision made by an untrusted
 * caller is not a memory decision.
 */
export const JEV_MAX_OBSERVATIONS = 1024;

/** The default capacity: roughly one busy minute of tool calls, and 256 small records. */
export const JEV_DEFAULT_OBSERVATIONS = 256;

/**
 * Where an observation came from. A closed set for the same reason {@link AdvisoryReason}
 * is one: these strings index a summary map, so a key space drawn from data would be a
 * cardinality explosion. `tool` is the tool advisor; the rest are the non-tool surfaces
 * declared by the sibling `AdvisorySurface` union in `activity.ts`.
 */
export type ObservationSurface = "tool" | AdvisorySurface;

export const OBSERVATION_SURFACES: readonly ObservationSurface[] = [
  "tool",
  "turn",
  "session",
  "context",
];

/**
 * How much attention an observation deserves, derived from the advisory's own 1–5 risk
 * score and nothing else.
 *
 * The vocabulary is deliberately four words wide and deliberately not a priority. `elevated`
 * means "look at this", which is exactly as strong a claim as a bounded observation can
 * support — a real risk score is the provider's opinion, not a finding, and this module
 * refuses to launder an opinion into a verdict. `unknown` is a real value here and is used
 * whenever the risk score was absent, which is what an `unavailable` observation always is.
 */
export type ObservationGrade = "routine" | "elevated" | "high" | "critical" | "unknown";

export const OBSERVATION_GRADES: readonly ObservationGrade[] = [
  "routine",
  "elevated",
  "high",
  "critical",
  "unknown",
];

/**
 * One recorded observation. Every field is a number, `null`, or a closed-vocabulary word.
 *
 * The field list is the privacy policy: there is no field here that could hold a tool name,
 * an argument, a path, a prompt, or a provider string. A journal is the kind of thing that
 * gets attached to a bug report, so anything worth keeping in it has to be worth publishing.
 */
export interface JevObservation {
  /** Monotonic within one journal, starting at 1. The cursor {@link JevObservationJournal.since} reads from. */
  readonly seq: number;
  /** Wall-clock time of the observation, from the journal's injected clock. Never from a payload. */
  readonly atMs: number;
  readonly surface: ObservationSurface;
  /** Mirrors `JevAdvisoryStatus`: did the advisory produce a usable answer. */
  readonly outcome: "advised" | "unavailable";
  /** Derived from `riskScore`; `unknown` whenever there was no usable risk score. */
  readonly grade: ObservationGrade;
  /** The advisory's own 1–5 scale, unmodified, or null when it never arrived. */
  readonly riskScore: number | null;
  /** The provider's reported confidence, or null. Never rounded, never re-scaled. */
  readonly confidence: number | null;
  /** A bucket from `activity.ts`'s closed vocabulary, or null when the call succeeded. */
  readonly reason: AdvisoryReason | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
}

/**
 * Spend, reported and never enforced.
 *
 * `exceeded` is a statement about a counter crossing a threshold. It is NOT a gate, and no
 * method on this module consults it: `record` is total and accepts an observation whatever
 * the budget says, because a budget that could refuse a record would be a control-flow
 * input, and a control-flow input is the one thing this module must never have. A host that
 * wants to stop spending has to do it in `advisor.ts`'s circuit breaker, which is a
 * transport concern and already exists; duplicating it here would be a second, quieter gate.
 */
export interface JevBudget {
  /** Host-declared advisory token ceiling, or null when the host declared none. */
  readonly limitTokens: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** input + output. The only number a ceiling should be compared against. */
  readonly spentTokens: number;
  /** Whether `spentTokens` has passed `limitTokens`. Reported, never acted on. */
  readonly exceeded: boolean;
}

export interface JevObservationSummary {
  readonly recorded: number;
  /** Entries lost to the capacity bound since the journal was built or last reset. */
  readonly dropped: number;
  readonly bySurface: ReadonlyMap<ObservationSurface, number>;
  readonly byGrade: ReadonlyMap<ObservationGrade, number>;
  readonly byReason: ReadonlyMap<AdvisoryReason, number>;
  /** `advised` vs `unavailable` counts. */
  readonly byOutcome: ReadonlyMap<"advised" | "unavailable", number>;
  readonly budget: JevBudget;
  /** p50/p95 latency of the entries still in the ring, or null when it is empty. */
  readonly latencyMs: { p50: number; p95: number } | null;
  /** The newest sequence number handed out, or 0 when nothing has been recorded. */
  readonly headSeq: number;
  /**
   * The oldest sequence number still retained. A reader that saw `headSeq` and wants
   * everything after it asks `since(oldestSeq - 1)`; the gap between the two is what
   * `dropped` counts.
   */
  readonly oldestSeq: number;
}

function boundedCapacity(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return JEV_DEFAULT_OBSERVATIONS;
  return Math.min(JEV_MAX_OBSERVATIONS, Math.max(1, Math.floor(value)));
}

function nonNegativeNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Derives the grade from the advisory's own risk score.
 *
 * A threshold, and nothing cleverer, because a risk score is a provider opinion on a 1–5
 * scale and this module has no standing to reinterpret one. Anything that could not use
 * the score — an unavailable call, a null risk, a value outside 1–5 — grades `unknown`
 * rather than guessing, and the caller can see `unknown` in the summary and count it.
 */
export function gradeAdvisory(advisory: JevToolAdvisory): ObservationGrade {
  const score = advisory.riskScore;
  if (advisory.status !== "advised") return "unknown";
  if (typeof score !== "number" || !Number.isFinite(score) || score < 1 || score > 5) {
    return "unknown";
  }
  if (score >= 5) return "critical";
  if (score >= 4) return "high";
  if (score >= 3) return "elevated";
  return "routine";
}

/**
 * Projects a tool advisory onto the journal's record shape.
 *
 * This is the caller seam. The two producers of observations in this module are
 * `JevToolAdvisor.advise` (returns a {@link JevToolAdvisory}) and `JevSurfaceAdvisor`
 * (returns the sibling `JevSurfaceAdvisory`); this function handles the first, and the
 * journal accepts the second through `record` directly since a surface advisory already has
 * the same closed-enum shape. Nothing else in the module needs to know the difference.
 */
export function observationFromAdvisory(
  advisory: JevToolAdvisory,
  input: { seq: number; atMs: number },
): JevObservation {
  return {
    seq: input.seq,
    atMs: input.atMs,
    surface: "tool",
    outcome: advisory.status,
    grade: gradeAdvisory(advisory),
    riskScore: nonNegativeNumber(advisory.riskScore),
    confidence: nonNegativeNumber(advisory.confidence),
    reason: (advisory.reason as AdvisoryReason | undefined) ?? null,
    inputTokens: nonNegativeNumber(advisory.inputTokens),
    outputTokens: nonNegativeNumber(advisory.outputTokens),
    latencyMs: nonNegativeNumber(advisory.latencyMs) ?? 0,
  };
}

export interface JevObservationJournalOptions {
  /**
   * Entries to retain. Clamped to [1, {@link JEV_MAX_OBSERVATIONS}]; anything else falls
   * back to {@link JEV_DEFAULT_OBSERVATIONS}. A journal with capacity 1 is legal and
   * answers "what happened most recently" exactly.
   */
  capacity?: number;
  /**
   * Advisory token ceiling to report against. Reporting only — see {@link JevBudget}.
   */
  limitTokens?: number;
  /** Injectable clock, so a test does not have to sleep to get ordered entries. */
  now?: () => number;
}

/**
 * A fixed-capacity ring of observations with a monotonic cursor.
 *
 * Every method is synchronous and total. The backing array is allocated once, in the
 * constructor, at exactly `capacity` slots and never resized — which is the whole point:
 * the memory a journal costs is fixed before the first observation exists, so no amount of
 * traffic, sessions, or concurrent journals can change it.
 */
export class JevObservationJournal {
  private readonly capacity: number;
  private readonly slots: (JevObservation | undefined)[];
  private readonly now: () => number;
  private readonly limitTokens: number | null;
  /** Write cursor into `slots`. */
  private write = 0;
  /** Occupied slots, saturating at capacity. */
  private size = 0;
  private headSeq = 0;
  private dropped = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(options: JevObservationJournalOptions = {}) {
    this.capacity = boundedCapacity(options.capacity);
    this.slots = new Array<JevObservation | undefined>(this.capacity).fill(undefined);
    this.now = options.now ?? Date.now;
    const limit = options.limitTokens;
    this.limitTokens =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  }

  /**
   * Appends an observation and returns it with its assigned sequence number, or null when
   * the observation carried no usable surface.
   *
   * Returns the stored record rather than nothing so a caller can log "observed as N"
   * without a second read. It is NOT a confirmation that anything was done about the
   * observation, and the returned value must not be branched on.
   */
  record(input: {
    surface: ObservationSurface;
    outcome: "advised" | "unavailable";
    grade: ObservationGrade;
    riskScore?: number | null;
    confidence?: number | null;
    reason?: AdvisoryReason | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    latencyMs?: number;
  }): JevObservation | null {
    if (!OBSERVATION_SURFACES.includes(input.surface)) return null;
    const observation: JevObservation = {
      seq: this.reserve(),
      atMs: this.now(),
      surface: input.surface,
      outcome: input.outcome,
      grade: OBSERVATION_GRADES.includes(input.grade) ? input.grade : "unknown",
      riskScore: nonNegativeNumber(input.riskScore),
      confidence: nonNegativeNumber(input.confidence),
      reason: input.reason ?? null,
      inputTokens: nonNegativeNumber(input.inputTokens),
      outputTokens: nonNegativeNumber(input.outputTokens),
      latencyMs: nonNegativeNumber(input.latencyMs) ?? 0,
    };
    this.writeObservation(observation);
    return observation;
  }

  /** Convenience for the tool advisor: project, then append. */
  recordAdvisory(advisory: JevToolAdvisory): JevObservation | null {
    const stored = this.reserve();
    if (stored === null) return null;
    const observation = observationFromAdvisory(advisory, { seq: stored, atMs: this.now() });
    this.writeObservation(observation);
    return observation;
  }

  /**
   * Everything still retained, oldest first. A copy: mutating it cannot corrupt the ring.
   */
  all(): JevObservation[] {
    const out: JevObservation[] = [];
    let at = (this.write - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      const entry = this.slots[at];
      if (entry !== undefined) out.push(entry);
      at = (at + 1) % this.capacity;
    }
    return out;
  }

  /**
   * Replay: every retained observation with `seq` strictly greater than `cursor`.
   *
   * A cursor from before the ring's oldest entry is NOT an error and does not return
   * everything: the entries it lost are reported by `summary().dropped`, and a caller that
   * needs no gaps should compare `headSeq` against its own cursor to find out. Returning a
   * silently-truncated stream that looks complete is the failure mode this shape avoids.
   */
  since(cursor: number): JevObservation[] {
    if (!Number.isFinite(cursor)) return [];
    return this.all().filter((entry) => entry.seq > cursor);
  }

  /** The newest `n` observations, oldest first. `n` is clamped to the capacity. */
  latest(n: number): JevObservation[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    const keep = Math.min(this.capacity, Math.floor(n));
    return this.all().slice(-keep);
  }

  /**
   * The query surface: every retained observation matching a caller-supplied predicate.
   *
   * A function, not a filter object, on purpose. A declarative filter language is a
   * dependency every future field has to be added to; a predicate is a function the caller
   * already knows how to write, and it can express anything the record can express because
   * the record is all it is given.
   */
  query(predicate: (observation: JevObservation) => boolean): JevObservation[] {
    return this.all().filter((observation) => {
      try {
        return predicate(observation) === true;
      } catch {
        // A throwing predicate must not take a turn down with it. Treating it as "no match"
        // is the fail-soft rule the rest of the module already follows.
        return false;
      }
    });
  }

  /**
   * Aggregate state: counts by the closed vocabularies, spend, and the retention window.
   *
   * Every returned map is keyed by a value from a closed set declared in this file or in
   * `activity.ts`, so none of them can grow with traffic — the property `activity.ts` was
   * built to have and the reason this summary is safe to attach to a bug report.
   */
  summary(): JevObservationSummary {
    const bySurface = new Map<ObservationSurface, number>();
    const byGrade = new Map<ObservationGrade, number>();
    const byReason = new Map<AdvisoryReason, number>();
    const byOutcome = new Map<"advised" | "unavailable", number>();
    const latencies: number[] = [];

    for (const observation of this.all()) {
      bySurface.set(observation.surface, (bySurface.get(observation.surface) ?? 0) + 1);
      byGrade.set(observation.grade, (byGrade.get(observation.grade) ?? 0) + 1);
      byOutcome.set(observation.outcome, (byOutcome.get(observation.outcome) ?? 0) + 1);
      if (observation.reason !== null) {
        byReason.set(observation.reason, (byReason.get(observation.reason) ?? 0) + 1);
      }
      latencies.push(observation.latencyMs);
    }

    const spentTokens = this.inputTokens + this.outputTokens;
    const oldest = this.all()[0]?.seq ?? 0;
    return {
      recorded: this.headSeq,
      dropped: this.dropped,
      bySurface,
      byGrade,
      byReason,
      byOutcome,
      budget: {
        limitTokens: this.limitTokens,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        spentTokens,
        exceeded: this.limitTokens !== null && spentTokens > this.limitTokens,
      },
      latencyMs: percentiles(latencies),
      headSeq: this.headSeq,
      oldestSeq: oldest,
    };
  }

  /**
   * Clears the ring and the counters. Sequence numbers restart at 0, so a consumer holding
   * a cursor must be told a reset happened — which is why this is not called implicitly by
   * anything that could run mid-session.
   */
  reset(): void {
    this.slots.fill(undefined);
    this.write = 0;
    this.size = 0;
    this.headSeq = 0;
    this.dropped = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  /** The capacity actually in force, after clamping. Exposed so a test can assert the bound. */
  get capacityUsed(): number {
    return this.capacity;
  }

  /**
   * Reserves the next sequence number. Split out so `recordAdvisory` and `record` cannot
   * drift on how a sequence is allocated.
   */
  private reserve(): number {
    this.headSeq += 1;
    return this.headSeq;
  }

  private writeObservation(observation: JevObservation): void {
    // Full: the write cursor is about to overwrite the oldest entry, so count the loss
    // rather than letting the reader discover a gap with no explanation for it.
    if (this.size === this.capacity) this.dropped += 1;
    this.slots[this.write] = observation;
    this.write = (this.write + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
    // Spend is counted on the LIFETIME total, not the ring, so entries the ring dropped
    // still cost money — a reader who loses entries must not lose the bill as well.
    this.inputTokens += observation.inputTokens ?? 0;
    this.outputTokens += observation.outputTokens ?? 0;
  }
}

/**
 * p50/p95 over the retained entries, or null when there are none.
 *
 * A copy is sorted rather than the ring mutated in place: the ring's order is its meaning
 * (it is the replay order), and a percentile helper that reshuffles it would be a bug that
 * only shows up under load.
 */
function percentiles(values: readonly number[]): { p50: number; p95: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { p50: at(0.5), p95: at(0.95) };
}
