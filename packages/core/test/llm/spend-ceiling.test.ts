import { describe, it, expect } from "vitest";
import { SpendCeiling } from "../../src/llm/spend-ceiling.js";

function ceiling(overrides: Partial<ConstructorParameters<typeof SpendCeiling>[0]> = {}) {
  let clock = 1_000_000;
  return new SpendCeiling({
    limitUsd: 1,
    reserveUsd: 0.3,
    now: () => clock,
    ...overrides,
  });
}

describe("SpendCeiling", () => {
  it("rejects a nonsensical configuration rather than silently allowing everything", () => {
    expect(() => new SpendCeiling({ limitUsd: 0, reserveUsd: 1 })).toThrow(/limitUsd/);
    expect(() => new SpendCeiling({ limitUsd: 1, reserveUsd: 0 })).toThrow(/reserveUsd/);
    expect(() => new SpendCeiling({ limitUsd: Infinity, reserveUsd: 1 })).toThrow(/limitUsd/);
    expect(() => new SpendCeiling({ limitUsd: 1, reserveUsd: NaN })).toThrow(/reserveUsd/);
    expect(() => new SpendCeiling({ limitUsd: 1, reserveUsd: 2 })).toThrow(/reserveUsd/);
    expect(() => ceiling({ reservationTtlMs: 0 })).toThrow(/reservationTtlMs/);
    expect(() => ceiling({ maxReservations: 1.5 })).toThrow(/maxReservations/);
  });

  it("counts in-flight calls against the limit, which is the whole point", () => {
    // Three concurrent calls at 0.30 each fit inside 1.00; the FOURTH is refused even though
    // nothing has been spent yet. A ceiling that only counted completed spend would admit it
    // and then discover, one call later, that it had overrun.
    const c = ceiling();
    expect(c.admit().allowed).toBe(true);
    expect(c.admit().allowed).toBe(true);
    expect(c.admit().allowed).toBe(true);
    const fourth = c.admit();
    expect(fourth.allowed).toBe(false);
    if (fourth.allowed) throw new Error("expected a refusal");
    expect(fourth.reservedUsd).toBeCloseTo(0.9, 6);
    expect(fourth.limitUsd).toBe(1);
    expect(fourth.reason).toContain("spend ceiling reached");
  });

  it("frees the room a settled call used once its real cost is known", () => {
    const c = ceiling();
    const a = c.admit();
    const b = c.admit();
    const d = c.admit();
    if (a.allowed === false || b.allowed === false || d.allowed === false) {
      throw new Error("expected admissions");
    }
    // Cheaper than reserved: the ceiling now has room again.
    expect(c.settle(a.reservationId, 0.05)).toBe(true);
    expect(c.snapshot().spentUsd).toBeCloseTo(0.05, 6);
    expect(c.admit().allowed).toBe(true);
  });

  it("counts a duplicated usage event once and says so", () => {
    // A replayed Trace or a reconnect can deliver the same usage twice. Silently adding it again
    // would inflate the spend; silently ignoring it would hide a real second call. Refusing and
    // reporting lets the caller decide.
    const c = ceiling();
    const a = c.admit();
    if (a.allowed === false) throw new Error("expected an admission");
    expect(c.settle(a.reservationId, 0.2)).toBe(true);
    expect(c.settle(a.reservationId, 0.2)).toBe(false);
    expect(c.settle("never-admitted", 0.2)).toBe(false);
    expect(c.snapshot().spentUsd).toBeCloseTo(0.2, 6);
  });

  it("releases a reservation for a call that produced nothing", () => {
    const c = ceiling();
    const a = c.admit();
    if (a.allowed === false) throw new Error("expected an admission");
    expect(c.cancel(a.reservationId)).toBe(true);
    expect(c.cancel(a.reservationId)).toBe(false);
    expect(c.snapshot().reservedUsd).toBe(0);
  });

  it("reclaims a reservation nothing settled, and says how many it reclaimed", () => {
    let clock = 1_000_000;
    const c = ceiling({ reservationTtlMs: 60_000, now: () => clock });
    const stuck = c.admit("stuck");
    if (stuck.allowed === false) throw new Error("expected an admission");
    // Nothing resolves: the agent died, the socket dropped, the call was abandoned.
    clock += 120_000;
    const snapshot = c.snapshot();
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.reclaimed).toBe(1);
    // Reclamation frees the in-flight slot but charges its estimate; this must not silently
    // turn an unresolved provider call into free capacity.
    expect(snapshot.spentUsd).toBeCloseTo(0.3, 6);
    expect(c.admit().allowed).toBe(true); // 0.3 committed + 0.3 reserved still fits under 1.0.
    expect(c.settle(stuck.reservationId, 0.8)).toBe(true);
    expect(c.snapshot().spentUsd).toBeCloseTo(0.8, 6); // late usage replaces the estimate.
  });

  it("evicts the oldest reservation rather than refusing once the map is full", () => {
    // Refusing at the cap would make a leak permanent; the cap exists to bound memory, not to
    // decide policy.
    const c = ceiling({ maxReservations: 3, limitUsd: 100, reserveUsd: 0.01 });
    for (let i = 0; i < 5; i += 1) expect(c.admit(`r${i}`).allowed).toBe(true);
    expect(c.snapshot().inFlight).toBeLessThanOrEqual(3);
    expect(c.snapshot().reclaimed).toBeGreaterThan(0);
  });

  it("reports a ceiling that has been reached, not just a refusal", () => {
    // 0.06 does not fit twice inside 0.10, so the second call is the one that is refused. (Two
    // calls of exactly 0.05 WOULD both fit — the limit is inclusive, which is the right way
    // round: refusing a call that lands exactly on the budget would be surprising.)
    const c = ceiling({ limitUsd: 0.1, reserveUsd: 0.06 });
    const first = c.admit();
    if (first.allowed === false) throw new Error("expected an admission");
    const second = c.admit();
    expect(second.allowed).toBe(false);
    const snapshot = c.snapshot();
    expect(snapshot.availableUsd).toBeCloseTo(0.04, 6);
    expect(snapshot.limitUsd).toBe(0.1);
    expect(snapshot.inFlight).toBe(1);
  });

  it("records actual spend above an estimate and refuses further work", () => {
    const c = ceiling({ limitUsd: 1, reserveUsd: 0.3 });
    const call = c.admit();
    if (!call.allowed) throw new Error("expected an admission");
    expect(c.settle(call.reservationId, 1.2)).toBe(true);
    expect(c.snapshot().spentUsd).toBeCloseTo(1.2, 6);
    expect(c.admit().allowed).toBe(false);
  });
});
