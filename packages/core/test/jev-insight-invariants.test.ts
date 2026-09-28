/**
 * The second-order analysis layer's safety invariants.
 *
 * The companion file (`jev-observation-invariants.test.ts`) proves the storage layer cannot
 * delay, fail, authorize or grow. This file proves the same four properties for the layer
 * that READS that storage, plus the two that are specific to it: a fold over an unbounded
 * input must return a bounded answer, and an explanation must never read like a verdict.
 */
import { describe, expect, it } from "vitest";
import * as INSIGHT from "../src/jev/insight.js";
import {
  correlateIncidents,
  explainObservations,
  isRedundant,
  JEV_MAX_INCIDENTS,
  JEV_MAX_INCIDENT_OBSERVATIONS,
  observationFingerprint,
  presentReasons,
} from "../src/jev/insight.js";
import {
  JevObservationJournal,
  type JevObservation,
  type ObservationGrade,
  type ObservationSurface,
} from "../src/jev/observation.js";

function observation(overrides: Partial<JevObservation> = {}): JevObservation {
  return {
    seq: 1,
    atMs: 1_000,
    surface: "tool",
    outcome: "advised",
    grade: "routine",
    riskScore: 1,
    confidence: 0.9,
    reason: null,
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 40,
    ...overrides,
  };
}

/** Builds a stream without going through the journal, so the tests read as data. */
function stream(count: number, make: (index: number) => Partial<JevObservation>): JevObservation[] {
  return Array.from({ length: count }, (_, index) =>
    observation({ seq: index + 1, ...make(index) }),
  );
}

describe("invariant: the analysis layer cannot delay or fail a caller", () => {
  it("exposes no asynchronous function and no throwing path", () => {
    for (const [name, value] of Object.entries(INSIGHT)) {
      if (typeof value === "function") {
        expect(value.constructor.name, `${name} must be a plain synchronous function`).toBe(
          "Function",
        );
        // Calling each with junk must not produce a thenable or throw synchronously.
        const result = (value as (input: unknown) => unknown)([]);
        expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
      }
    }
  });

  it("is total on empty, malformed and adversarial input", () => {
    expect(explainObservations([]).condition).toBe("silent");
    expect(correlateIncidents([])).toEqual([]);
    expect(observationFingerprint([])).toBe(observationFingerprint([]));
    expect(presentReasons([])).toEqual([]);
    // Nonsense options are clamped, not honoured.
    for (const options of [
      { windowMs: Number.NaN, maxIncidents: -1, maxSeqs: 0 },
      { windowMs: Number.POSITIVE_INFINITY, maxIncidents: 1e9, maxSeqs: 1e9 },
    ]) {
      const incidents = correlateIncidents(
        stream(3, () => ({ grade: "high" })),
        options,
      );
      expect(incidents.length).toBeLessThanOrEqual(JEV_MAX_INCIDENTS);
      for (const incident of incidents) {
        expect(incident.seqs.length).toBeLessThanOrEqual(JEV_MAX_INCIDENT_OBSERVATIONS);
      }
    }
    // isRedundant never throws, whatever it is handed.
    expect(isRedundant(observation(), observation())).toBe(true);
  });
});

describe("invariant: the analysis layer cannot authorize anything", () => {
  it("produces descriptions, and the condition vocabulary contains no verdict", () => {
    const explanation = explainObservations(
      stream(4, () => ({ outcome: "unavailable", grade: "unknown", reason: "circuit_open" })),
    );
    expect(explanation.condition).toBe("offline");
    expect(explanation.dominantReason).toBe("circuit_open");
    // No member of the vocabulary says what to DO. It describes the stream's health; it
    // is not an instruction, a recommendation, or a permission decision, and none of these
    // words could be read as one even by a caller that wanted to.
    const conditions = ["silent", "healthy", "degraded", "offline", "unavailable"] as const;
    expect(conditions).toContain(explanation.condition);
    const VERDICT_WORD = /allow|deny|block|permit|approve|reject|halt|abort|continue|retry|should/i;
    for (const condition of conditions) {
      expect(VERDICT_WORD.test(condition)).toBe(false);
    }
    // And the explanation has no numeric field a caller could threshold into a gate.
    const numericFields = Object.entries(explanation).filter(
      ([, value]) => typeof value === "number",
    );
    for (const [name] of numericFields) {
      expect(["total", "answered", "unavailable", "notable"]).toContain(name);
    }
  });

  it("names a single reason only when one reason explains everything", () => {
    // The intersection rule from JevRev: a dominant reason requires that EVERY failure
    // shared it. Two different causes is not one cause, and saying "circuit_open" there
    // would send an operator to fix the wrong thing.
    const allTimeout = stream(3, () => ({
      outcome: "unavailable",
      grade: "unknown",
      reason: "timeout",
    }));
    expect(explainObservations(allTimeout).dominantReason).toBe("timeout");

    const mixed = [
      observation({ seq: 1, outcome: "unavailable", grade: "unknown", reason: "timeout" }),
      observation({
        seq: 2,
        outcome: "unavailable",
        grade: "unknown",
        reason: "circuit_open",
      }),
    ];
    const explained = explainObservations(mixed);
    expect(explained.dominantReason).toBeNull();
    // Nothing answered, but nothing shares a cause either — so `unavailable`, not
    // `offline`. Those are different problems and an operator must not be sent to the
    // circuit breaker for a timeout that the breaker never saw.
    expect(explained.condition).toBe("unavailable");
    expect(presentReasons(mixed)).toEqual(["circuit_open", "timeout"]);
    // A stream that partly answers is never "offline", whatever its worst member.
    const partial = [...mixed, observation({ seq: 3, outcome: "advised", grade: "routine" })];
    const partialExplanation = explainObservations(partial);
    expect(partialExplanation.condition).not.toBe("offline");
    expect(partialExplanation.dominantReason).toBeNull();
  });
});

describe("invariant: a fold over an unbounded stream returns a bounded answer", () => {
  it("caps incidents and per-incident sequence lists", () => {
    // 20,000 noteworthy observations on four surfaces, each burst far apart in time so
    // every one of them opens a new incident.
    const observations = stream(20_000, (index) => ({
      surface: (["tool", "turn", "session", "context"] as const)[index % 4]!,
      grade: "high" as ObservationGrade,
      atMs: index * 10_000_000,
    }));
    const incidents = correlateIncidents(observations, { windowMs: 1_000, maxIncidents: 6 });
    // Every one of these bursts is far past the window from the last, so each opens and
    // seals its own incident: 20,000 candidate incidents from 20,000 observations. The
    // fold keeps the NEWEST 6 and drops the rest, so a stream of any length produces a
    // fixed-size answer. This is the assertion that caught the original unbounded `done`.
    expect(incidents).toHaveLength(6);
    // Each of the 20,000 is its own incident, so the six survivors are exactly the last
    // six sequence numbers, in replay order.
    expect(incidents.map((i) => i.firstSeq)).toEqual([
      19_995, 19_996, 19_997, 19_998, 19_999, 20_000,
    ]);

    // Now a single long burst: one incident, a capped sequence list, and a truthful count.
    const burst = stream(5_000, (index) => ({
      grade: "high" as ObservationGrade,
      atMs: 1_000 + index,
    }));
    const [incident] = correlateIncidents(burst, { maxSeqs: 8 });
    expect(incident?.count).toBe(5_000);
    expect(incident?.seqs).toHaveLength(8);
    expect(incident?.truncated).toBe(true);
    expect(incident?.firstSeq).toBe(1);
    expect(incident?.lastSeq).toBe(5_000);
    // With the cap raised, `truncated` falls out on its own at seal time.
    const [whole] = correlateIncidents(stream(5, () => ({ grade: "high" })));
    expect(whole?.truncated).toBe(false);
    expect(whole?.seqs).toHaveLength(5);
  });

  it("groups by surface and by time, and reports the worst grade seen", () => {
    const observations: JevObservation[] = [
      observation({ seq: 1, atMs: 0, surface: "tool", grade: "elevated" }),
      observation({ seq: 2, atMs: 100, surface: "tool", grade: "critical" }),
      // Same surface, far past the window: a new incident.
      observation({ seq: 3, atMs: 90_000, surface: "tool", grade: "elevated" }),
      // Different surface, well inside the window: also a new incident.
      observation({ seq: 4, atMs: 90_050, surface: "turn", grade: "high" }),
      // Routine never starts or joins an incident.
      observation({ seq: 5, atMs: 90_060, surface: "session", grade: "routine" }),
    ];
    const incidents = correlateIncidents(observations, { windowMs: 1_000 });
    expect(incidents.map((i) => [i.surface, i.count])).toEqual([
      ["tool", 2],
      ["tool", 1],
      ["turn", 1],
    ]);
    // Severity is the worst seen, not the newest: an incident that peaked at critical
    // stays critical after calming down, because that peak is why anyone is reading it.
    expect(incidents[0]?.grade).toBe("critical");
    expect(incidents[1]?.grade).toBe("elevated");
    expect(incidents.map((i) => i.firstSeq)).toEqual([1, 3, 4]);
  });
});

describe("the analysis layer does the job it exists for", () => {
  it("fingerprints content, not bookkeeping", () => {
    const a = observation({ seq: 1, atMs: 1_000 });
    const b = observation({ seq: 99, atMs: 999_999 });
    // Sequence and wall-clock are bookkeeping. Two records that say the same thing must
    // hash the same, or the fingerprint is useless for the change detection it exists for.
    expect(observationFingerprint([a])).toBe(observationFingerprint([b]));
    // Content is what changes the hash.
    expect(observationFingerprint([a])).not.toBe(
      observationFingerprint([observation({ ...a, grade: "high", riskScore: 5 })]),
    );
    // Order is part of the fingerprint, because it is the replay order.
    const p = observation({ seq: 1, grade: "routine" });
    const q = observation({ seq: 2, grade: "high", riskScore: 5 });
    expect(observationFingerprint([p, q])).not.toBe(observationFingerprint([q, p]));
    // Prefixing is detected: [p] and [p, q] are different streams.
    expect(observationFingerprint([p])).not.toBe(observationFingerprint([p, q]));
    // Stability across calls, which is the only property that makes it comparable.
    expect(observationFingerprint([p, q])).toBe(observationFingerprint([p, q]));
  });

  it("detects a re-observation that carries no new information", () => {
    // The cost control: a repeat of the same finding costs egress and buys nothing.
    const first = observation({ grade: "critical", riskScore: 5, confidence: 0.8 });
    const sameAgain = observation({
      seq: 2,
      atMs: 5_000,
      grade: "critical",
      riskScore: 5,
      confidence: 0.8,
    });
    // Confidence and latency are not part of the comparison: a different confidence on the
    // same finding is the same finding, and a slower answer to it is still the same answer.
    const slightlyDifferent = observation({
      seq: 3,
      atMs: 6_000,
      grade: "critical",
      riskScore: 5,
      confidence: 0.2,
      latencyMs: 900,
    });
    expect(isRedundant(first, sameAgain)).toBe(true);
    expect(isRedundant(first, slightlyDifferent)).toBe(true);
    // But a different grade, surface, reason or spend is genuinely new information.
    expect(isRedundant(first, observation({ ...first, grade: "high" }))).toBe(false);
    expect(isRedundant(first, observation({ ...first, surface: "turn" }))).toBe(false);
    expect(isRedundant(first, observation({ ...first, reason: "timeout" }))).toBe(false);
    expect(isRedundant(first, observation({ ...first, inputTokens: 101 }))).toBe(false);
  });

  it("composes end to end with the journal it reads", () => {
    // The real integration: a journal fills up, and the analysis layer reduces it to a
    // sentence and a bounded set of incidents without touching the journal's own bounds.
    let clock = 1_000;
    const journal = new JevObservationJournal({ capacity: 64, now: () => (clock += 10) });
    for (let index = 0; index < 40; index += 1) {
      journal.record({
        surface: "tool" as ObservationSurface,
        outcome: index < 30 ? "advised" : "unavailable",
        grade:
          index >= 20 && index < 25
            ? ("high" as ObservationGrade)
            : ("routine" as ObservationGrade),
        riskScore: index >= 20 && index < 25 ? 4 : 1,
        inputTokens: 100,
        outputTokens: 10,
        reason: index >= 30 ? "timeout" : null,
        latencyMs: 40 + index,
      });
    }
    const retained = journal.all();
    expect(retained).toHaveLength(40);

    const explanation = explainObservations(retained);
    expect(explanation.total).toBe(40);
    expect(explanation.answered).toBe(30);
    expect(explanation.unavailable).toBe(10);
    expect(explanation.notable).toBe(5);
    expect(explanation.worstGrade).toBe("high");
    // 30 answered, 10 not: the stream is up and lossy, which is `degraded` whatever the
    // ratio. `notable` is a separate axis, so a lossy stream with five alarming
    // observations in it reports both rather than collapsing to one word.
    expect(explanation.condition).toBe("degraded");
    // All ten failures share one reason, so the intersection names it — the JevRev rule:
    // a dominant reason requires that EVERY failure carried it.
    expect(explanation.dominantReason).toBe("timeout");

    const incidents = correlateIncidents(retained, { windowMs: 10_000 });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.count).toBe(5);
    expect(incidents[0]?.grade).toBe("high");
    // The incident's sequence range is directly replayable through the journal: from
    // `firstSeq` the caller gets the burst, and the high-grade entries in that range are
    // exactly the ones the incident counted.
    const replayed = journal.since((incidents[0]?.firstSeq ?? 0) - 1);
    const range = replayed.filter(
      (o) => o.seq >= (incidents[0]?.firstSeq ?? 0) && o.seq <= (incidents[0]?.lastSeq ?? 0),
    );
    expect(range.map((o) => o.seq)).toEqual(incidents[0]?.seqs);
    expect(range.every((o) => o.grade === "high")).toBe(true);
    // And a journal that overran its cap is explained without being read past the bound.
    const small = new JevObservationJournal({ capacity: 4, now: () => 1 });
    for (let index = 0; index < 10; index += 1) {
      small.recordAdvisory({
        status: "unavailable",
        choice: "unknown",
        confidence: null,
        riskScore: null,
        needsToolProbability: null,
        argumentsCompleteProbability: null,
        requiresApprovalProbability: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: 1,
        reason: "circuit_open",
      });
    }
    expect(small.summary().dropped).toBe(6);
    expect(explainObservations(small.all()).condition).toBe("offline");
  });
});
