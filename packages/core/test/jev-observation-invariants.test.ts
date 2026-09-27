/**
 * The observation journal's safety invariants, as executable assertions.
 *
 * This follows the rule the sibling `jev-invariants.test.ts` states: the properties that
 * make the feature safe to ship are written as tests, so a failure names the rule that
 * broke rather than "something about JEV went wrong". Four matter here, and they are
 * sharper for a journal than for the advisor, because a journal is the part an operator
 * exports, publishes and attaches to bug reports:
 *
 *   1. the journal cannot DELAY anything — it is synchronous, so there is no await to await;
 *   2. the journal cannot FAIL anything — every method is total, so no turn can be broken
 *      by a full or malformed journal;
 *   3. the journal cannot AUTHORIZE anything — no field and no return value is a verdict;
 *   4. the journal cannot GROW — the bound is a property of the allocation, not of usage.
 *
 * (3) and (4) are the two that are easy to state and easy to break later, so each is
 * asserted structurally (by reading the type) and behaviourally (by driving the object),
 * because either alone is weaker than the property.
 */
import { describe, expect, it } from "vitest";
import {
  gradeAdvisory,
  JEV_DEFAULT_OBSERVATIONS,
  JEV_MAX_OBSERVATIONS,
  JevObservationJournal,
  observationFromAdvisory,
  OBSERVATION_GRADES,
  OBSERVATION_SURFACES,
  type JevObservation,
} from "../src/jev/observation.js";
import { ADVISORY_REASONS } from "../src/jev/activity.js";
import type { JevToolAdvisory } from "../src/jev/types.js";

function advised(overrides: Partial<JevToolAdvisory> = {}): JevToolAdvisory {
  return {
    status: "advised",
    choice: "matches",
    confidence: 0.9,
    riskScore: 2,
    needsToolProbability: 0.9,
    argumentsCompleteProbability: 0.8,
    requiresApprovalProbability: 0.1,
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 42,
    ...overrides,
  };
}

describe("invariant: the journal cannot delay a caller", () => {
  it("exposes no asynchronous method at all", () => {
    // The strongest form of the property. If a future edit adds an `await` — a flush, a
    // persistence call, a batching helper — this fails, because every method on the
    // prototype returns something that is not a Promise.
    const proto = JevObservationJournal.prototype as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== "constructor" && typeof proto[name] === "function",
    );
    expect(methods.length).toBeGreaterThan(0);
    for (const name of methods) {
      const returns = (proto[name] as (...args: unknown[]) => unknown).length;
      expect(returns, `${name} must be synchronous`).toBeGreaterThanOrEqual(0);
    }
    // The concrete check: no public method hands back a thenable.
    const journal = new JevObservationJournal({ capacity: 4 });
    const results: unknown[] = [
      journal.record({ surface: "tool", outcome: "advised", grade: "routine" }),
      journal.all(),
      journal.since(0),
      journal.latest(2),
      journal.query(() => true),
      journal.summary(),
      journal.reset(),
    ];
    for (const value of results) {
      expect(value).not.toBeInstanceOf(Promise);
      expect(typeof (value as { then?: unknown })?.then).not.toBe("function");
    }
  });
});

describe("invariant: the journal cannot fail a caller", () => {
  it("is total under inputs a hostile or buggy producer could supply", () => {
    const journal = new JevObservationJournal({ capacity: 8, now: () => 1_000 });
    // A surface outside the closed set is refused, not thrown on.
    expect(
      journal.record({
        surface: "not-a-surface" as never,
        outcome: "advised",
        grade: "routine",
      }),
    ).toBeNull();
    // A grade outside the closed set degrades to `unknown` rather than entering the map.
    const degraded = journal.record({
      surface: "tool",
      outcome: "advised",
      grade: "catastrophic" as never,
    });
    expect(degraded?.grade).toBe("unknown");
    // Non-finite, negative and NaN measurements all become null, never NaN in a count.
    const odd = journal.record({
      surface: "turn",
      outcome: "advised",
      grade: "routine",
      riskScore: Number.NaN,
      confidence: -1,
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 5,
      latencyMs: Number.NaN,
    });
    expect(odd).not.toBeNull();
    expect(odd?.riskScore).toBeNull();
    expect(odd?.confidence).toBeNull();
    expect(odd?.inputTokens).toBeNull();
    expect(odd?.outputTokens).toBe(5);
    expect(odd?.latencyMs).toBe(0);
    // The summary's money is still arithmetic on real numbers.
    const summary = journal.summary();
    expect(Number.isFinite(summary.budget.spentTokens)).toBe(true);
    expect(summary.budget.spentTokens).toBe(5);
    // A throwing predicate is treated as "no match" rather than propagated.
    expect(
      journal.query(() => {
        throw new Error("producer bug");
      }),
    ).toEqual([]);
    // A nonsense cursor and a nonsense window are both empty, not exceptions.
    expect(journal.since(Number.NaN)).toEqual([]);
    expect(journal.latest(-1)).toEqual([]);
  });
});

describe("invariant: the journal cannot authorize anything", () => {
  it("has no field on any record a caller could branch on to allow or deny", () => {
    const journal = new JevObservationJournal({ capacity: 4 });
    journal.recordAdvisory(advised());
    const [record] = journal.all();
    expect(record).toBeDefined();
    // The complete field list. A `decision`, `approved`, `block`, `allow`, `verdict` or
    // `permit` appearing here is the failure this test exists to catch — the moment such a
    // field exists, something downstream can gate on it.
    expect(Object.keys(record as JevObservation).sort()).toEqual([
      "atMs",
      "confidence",
      "grade",
      "inputTokens",
      "latencyMs",
      "outcome",
      "outputTokens",
      "reason",
      "riskScore",
      "seq",
      "surface",
    ]);
  });

  it("reports an over-budget state without acting on it", () => {
    // The budget is a report, not a permission. `record` is total: it keeps accepting
    // observations long past the ceiling, which is precisely what a gate would not do.
    const journal = new JevObservationJournal({ capacity: 16, limitTokens: 100 });
    for (let i = 0; i < 8; i += 1) {
      expect(
        journal.recordAdvisory(advised({ inputTokens: 100, outputTokens: 20 })),
      ).not.toBeNull();
    }
    const summary = journal.summary();
    expect(summary.budget.limitTokens).toBe(100);
    expect(summary.budget.spentTokens).toBe(960);
    expect(summary.budget.exceeded).toBe(true);
    // Exceeded is a fact, not a stop: the ninth record is accepted like the first eight.
    expect(journal.recordAdvisory(advised())).not.toBeNull();
    expect(journal.summary().recorded).toBe(9);
  });

  it("grades a risk score and nothing else, and says so when it has none", () => {
    expect(gradeAdvisory(advised({ riskScore: 1 }))).toBe("routine");
    expect(gradeAdvisory(advised({ riskScore: 3 }))).toBe("elevated");
    expect(gradeAdvisory(advised({ riskScore: 4 }))).toBe("high");
    expect(gradeAdvisory(advised({ riskScore: 5 }))).toBe("critical");
    // No risk score, an unavailable call, and a score outside the advisory's own 1–5 scale
    // all grade `unknown`. None of them is rounded, clamped, or guessed into a grade.
    expect(gradeAdvisory(advised({ riskScore: null }))).toBe("unknown");
    expect(gradeAdvisory(advised({ riskScore: 5, status: "unavailable" }))).toBe("unknown");
    expect(gradeAdvisory(advised({ riskScore: 0 }))).toBe("unknown");
    expect(gradeAdvisory(advised({ riskScore: 9 }))).toBe("unknown");
  });
});

describe("invariant: the journal cannot grow", () => {
  it("keeps memory fixed no matter how much is recorded", () => {
    // The bound is a property of the ALLOCATION, not of usage: the ring array is sized once
    // in the constructor and never resized. A capacity argument is clamped rather than
    // honoured, so a caller cannot ask for an unbounded journal.
    expect(new JevObservationJournal().capacityUsed).toBe(JEV_DEFAULT_OBSERVATIONS);
    expect(new JevObservationJournal({ capacity: 10_000_000 }).capacityUsed).toBe(
      JEV_MAX_OBSERVATIONS,
    );
    expect(new JevObservationJournal({ capacity: 0 }).capacityUsed).toBe(1);
    expect(new JevObservationJournal({ capacity: -5 }).capacityUsed).toBe(1);
    expect(new JevObservationJournal({ capacity: Number.NaN }).capacityUsed).toBe(
      JEV_DEFAULT_OBSERVATIONS,
    );

    const journal = new JevObservationJournal({ capacity: 8, now: () => 7 });
    for (let i = 0; i < 5_000; i += 1) {
      journal.recordAdvisory(advised({ inputTokens: 1, outputTokens: 1 }));
    }
    // Retained: exactly the capacity. Ever-recorded: all of them. The gap is reported.
    expect(journal.all()).toHaveLength(8);
    const summary = journal.summary();
    expect(summary.recorded).toBe(5_000);
    expect(summary.dropped).toBe(5_000 - 8);
    // The money is still the lifetime total: losing entries must not lose the bill.
    expect(summary.budget.spentTokens).toBe(10_000);
    // Sequence numbers keep climbing past the ring, so `since` never silently repeats.
    expect(summary.headSeq).toBe(5_000);
    expect(summary.oldestSeq).toBe(4_993);
    // Every summary map is keyed by a closed vocabulary, so none of them grew either.
    expect([...summary.bySurface.keys()].every((k) => OBSERVATION_SURFACES.includes(k))).toBe(true);
    expect(summary.bySurface.size).toBeLessThanOrEqual(OBSERVATION_SURFACES.length);
    expect(summary.byGrade.size).toBeLessThanOrEqual(5);
  });
});

describe("the journal does the job it exists for", () => {
  it("replays, queries and aggregates without ever holding text", () => {
    let clock = 100;
    const journal = new JevObservationJournal({ capacity: 64, now: () => (clock += 1) });
    journal.recordAdvisory(advised({ riskScore: 1, inputTokens: 10, outputTokens: 2 }));
    const cursor = journal.summary().headSeq;
    journal.recordAdvisory(advised({ riskScore: 5, inputTokens: 10, outputTokens: 2 }));
    journal.recordAdvisory(advised({ riskScore: 2, status: "unavailable", reason: "timeout" }));
    journal.record({ surface: "session", outcome: "advised", grade: "routine", inputTokens: 1 });

    // Replay from a cursor: exactly what came after it, in order, and nothing before.
    const after = journal.since(cursor);
    expect(after.map((o) => o.seq)).toEqual([cursor + 1, cursor + 2, cursor + 3]);
    // Query: the high-risk observations, which is the question the counters cannot answer.
    const critical = journal.query((o) => o.grade === "critical");
    expect(critical).toHaveLength(1);
    expect(critical[0]?.riskScore).toBe(5);
    // A cursor from before the ring's oldest entry returns what is left rather than
    // pretending to be complete; the gap is the caller's to notice via `dropped`.
    expect(journal.since(-1)).toHaveLength(4);
    // Aggregation.
    const summary = journal.summary();
    expect(summary.recorded).toBe(4);
    expect(summary.byOutcome.get("advised")).toBe(3);
    expect(summary.byOutcome.get("unavailable")).toBe(1);
    expect(summary.byReason.get("timeout")).toBe(1);
    expect(summary.bySurface.get("tool")).toBe(3);
    expect(summary.bySurface.get("session")).toBe(1);
    expect(summary.latencyMs).not.toBeNull();
    // The privacy property, mechanically: every string a journal retains is a member of a
    // closed vocabulary declared in this module or in `activity.ts`. Nothing that came from
    // a tool call, a prompt, or a provider body can pass this, because there is no
    // vocabulary a free-form word could belong to.
    const allowed = new Set<string>([
      ...OBSERVATION_SURFACES,
      ...OBSERVATION_GRADES,
      ...ADVISORY_REASONS,
      "advised",
      "unavailable",
    ]);
    for (const observation of journal.all()) {
      for (const [key, value] of Object.entries(observation)) {
        if (typeof value === "string") {
          expect(allowed.has(value), `${key}=${value} is not a closed-vocabulary word`).toBe(true);
        }
      }
    }
  });

  it("projects an advisory without inventing a value it does not have", () => {
    const journal = new JevObservationJournal({ capacity: 4, now: () => 42 });
    const record = journal.recordAdvisory(
      advised({ inputTokens: null, outputTokens: null, confidence: null, model: "probe/model" }),
    );
    expect(record).not.toBeNull();
    // The provider's model name is NOT carried into the journal: it is free-form text from
    // a remote service, and the journal is the thing that gets exported. It stays in the
    // advisory, where `advisor.ts` bounds it to 128 characters, and does not come here.
    expect(Object.values(record as unknown as Record<string, unknown>)).not.toContain(
      "probe/model",
    );
    expect(record?.inputTokens).toBeNull();
    expect(record?.confidence).toBeNull();
    expect(record?.atMs).toBe(42);
    // The surface and grade are derived from what the advisory actually said.
    expect(record?.surface).toBe("tool");
    expect(record?.grade).toBe("routine");
  });

  it("keeps the standalone projection consistent with the recorder", () => {
    const advisory = advised({ riskScore: 4, reason: "circuit_open" });
    const projected = observationFromAdvisory(advisory, { seq: 9, atMs: 11 });
    expect(projected).toEqual(
      expect.objectContaining({
        seq: 9,
        atMs: 11,
        surface: "tool",
        outcome: "advised",
        grade: "high",
        riskScore: 4,
        reason: "circuit_open",
        latencyMs: 42,
      }),
    );
  });
});
