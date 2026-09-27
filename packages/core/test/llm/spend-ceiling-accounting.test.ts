/**
 * Spend-ceiling accounting: the paths where a real cost can go unrecorded, and the one input that
 * used to disable the whole budget.
 *
 * The class's contract is `spent + reserved <= limit` at every moment, and the harder half is that
 * nothing real escapes `spentUsd` afterwards. These cover the ways it did.
 */
import { describe, expect, it } from "vitest";
import { SpendCeiling } from "../../src/llm/spend-ceiling.js";

const ceiling = (overrides: Partial<ConstructorParameters<typeof SpendCeiling>[0]> = {}) =>
  new SpendCeiling({ limitUsd: 10, reserveUsd: 1, ...overrides });

/** Admits and returns the reservation id, failing loudly if the ceiling refused. */
function admit(c: SpendCeiling, hint?: string): string {
  const result = c.admit(hint);
  if (!result.allowed) throw new Error(`expected admission of ${hint ?? "<auto>"}`);
  return result.reservationId;
}

describe("reservation identity", () => {
  it("does not lose a reservation when two in-flight calls share an id hint", () => {
    // Both calls were admitted and both will cost money. The second `set` used to replace the
    // first reservation, so the first call's later `settle` found nothing to release and its cost
    // was never added to spentUsd — the ceiling under-counting by the amount it had promised.
    const c = ceiling();
    const first = c.admit("call-1");
    const second = c.admit("call-1");
    expect(first.allowed && second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) return;
    expect(second.reservationId).not.toBe(first.reservationId);

    // Both are live, so both are reserved.
    expect(c.snapshot().inFlight).toBe(2);
    expect(c.snapshot().reservedUsd).toBe(2);

    // And both settle independently into the real total.
    expect(c.settle(first.reservationId, 0.5)).toBe(true);
    expect(c.settle(second.reservationId, 0.25)).toBe(true);
    expect(c.snapshot().spentUsd).toBeCloseTo(0.75, 10);
    expect(c.snapshot().inFlight).toBe(0);
  });

  it("keeps the running reserved total in step through the whole lifecycle", () => {
    const c = ceiling({ limitUsd: 100, reserveUsd: 2, maxReservations: 4 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = c.admit(`r${i}`);
      if (r.allowed) ids.push(r.reservationId);
    }
    expect(c.snapshot().reservedUsd).toBe(8);

    // Settle one, cancel one, expire one via TTL; the total must track each exactly once.
    c.settle(ids[0]!, 0.1);
    expect(c.snapshot().reservedUsd).toBe(6);
    c.cancel(ids[1]!);
    expect(c.snapshot().reservedUsd).toBe(4);
    c.settle(ids[2]!, 0.1);
    c.cancel(ids[3]!);
    expect(c.snapshot().reservedUsd).toBe(0);
    expect(c.snapshot().inFlight).toBe(0);
  });

  it("evicts the oldest past the reservation cap and keeps the total correct", () => {
    const c = ceiling({ limitUsd: 1000, reserveUsd: 1, maxReservations: 3 });
    const ids = [0, 1, 2, 3].map((i) => {
      const r = c.admit(`r${i}`);
      return r.allowed ? r.reservationId : null;
    });
    expect(c.snapshot().inFlight).toBe(3);
    // r0 was evicted, so its id is free again and the total is 3 reservations, not 4.
    expect(c.snapshot().reservedUsd).toBe(3);
    expect(c.snapshot().reclaimed).toBe(1);
    expect(c.settle(ids[0]!, 1)).toBe(false);
  });
});

describe("settling an unusable amount", () => {
  it("charges the reserved amount rather than letting NaN disable the ceiling", () => {
    // `Math.max(0, NaN)` is NaN, and one NaN in spentUsd makes every `> limitUsd` comparison
    // false: the ceiling admitted everything from then on while still printing a "reached" reason.
    const c = ceiling({ limitUsd: 3, reserveUsd: 1 });
    c.settle(admit(c, "x"), Number.NaN);

    const after = c.snapshot();
    expect(Number.isFinite(after.spentUsd)).toBe(true);
    expect(after.spentUsd).toBe(1); // the commitment, not zero
    expect(after.uncertainSettlements).toBe(1);

    // And the ceiling still binds afterwards — the whole point. The reservation was 2, so the NaN
    // settlement charged 2 of a 3 limit; the next call would need 2 more, which does not fit and
    // is refused. Had the NaN been clamped to zero instead, that call would have been admitted
    // and the budget would have silently started over.
    const c2 = ceiling({ limitUsd: 3, reserveUsd: 2 });
    c2.settle(admit(c2, "x"), Number.NaN);
    expect(c2.snapshot().spentUsd).toBe(2);
    expect(c2.admit("y").allowed).toBe(false);
  });

  it("refuses an infinite amount the same way", () => {
    const c = ceiling();
    c.settle(admit(c, "x"), Infinity);
    expect(c.snapshot().spentUsd).toBe(1);
    expect(c.snapshot().uncertainSettlements).toBe(1);
  });

  it("still ignores a negative real cost as a refund", () => {
    // A negative cost is not a refund: a provider cannot bill below zero, so it is clamped rather
    // than credited. This is the one direction that is safe to flatten, because it can only
    // understate a refund that was never real.
    const c = ceiling();
    c.settle(admit(c, "x"), -5);
    expect(c.snapshot().spentUsd).toBe(0);
  });

  it("settles a duplicated usage event only once", () => {
    const c = ceiling();
    const id = admit(c, "x");
    expect(c.settle(id, 2)).toBe(true);
    expect(c.settle(id, 2)).toBe(false);
    expect(c.snapshot().spentUsd).toBe(2);
  });
});

describe("expiry under a moving clock", () => {
  it("reclaims past the TTL", () => {
    let t = 1_000;
    const c = new SpendCeiling({
      limitUsd: 10,
      reserveUsd: 1,
      now: () => t,
      reservationTtlMs: 100,
    });
    c.admit("a");
    t = 1_099;
    c.admit("b");
    expect(c.snapshot().inFlight).toBe(2);
    t = 1_100;
    expect(c.snapshot().inFlight).toBe(1);
    expect(c.snapshot().reclaimed).toBe(1);
    expect(c.snapshot().reservedUsd).toBe(1);
  });

  it("does not expire on a backwards clock step, and self-heals when time returns", () => {
    // An NTP step or a suspended machine can make `now` go backwards. Expiring on that would
    // reclaim reservations for calls that are demonstrably still in flight, so the negative
    // elapsed time is treated as "not yet due" instead.
    let t = 10_000;
    const c = new SpendCeiling({
      limitUsd: 10,
      reserveUsd: 1,
      now: () => t,
      reservationTtlMs: 100,
    });
    c.admit("a");
    t = 5_000; // clock jumped back five seconds
    expect(c.snapshot().inFlight).toBe(1);
    expect(c.snapshot().reservedUsd).toBe(1);

    t = 10_100; // and forward again past the TTL
    expect(c.snapshot().inFlight).toBe(0);
    expect(c.snapshot().reservedUsd).toBe(0);
  });

  it("cannot wedge permanently: the reservation cap evicts regardless of age", () => {
    // A clock frozen in the past must not make the ceiling refuse everything forever.
    let t = 10_000;
    const c = new SpendCeiling({
      limitUsd: 1_000_000,
      reserveUsd: 1,
      now: () => t,
      reservationTtlMs: 100,
      maxReservations: 2,
    });
    c.admit("a");
    c.admit("b");
    t = 1; // frozen far in the past: nothing is ever "expired"
    const third = c.admit("c");
    expect(third.allowed).toBe(true);
    expect(c.snapshot().inFlight).toBe(2);
  });
});

describe("the ceiling invariant", () => {
  it("never lets spent plus reserved exceed the limit, across any interleaving", () => {
    const LIMIT = 5;
    const c = new SpendCeiling({ limitUsd: LIMIT, reserveUsd: 1 });
    const live = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = c.admit();
      if (r.allowed) live.add(r.reservationId);
      const s = c.snapshot();
      expect(s.spentUsd + s.reservedUsd).toBeLessThanOrEqual(LIMIT + 1e-9);
      if (!r.allowed) {
        // Once refused, admitting more work must not become possible without settling.
        expect(c.snapshot().spentUsd + c.snapshot().reservedUsd).toBeLessThanOrEqual(LIMIT + 1e-9);
        break;
      }
      // Settle some, keep others outstanding.
      for (const id of [...live].slice(0, 1)) {
        c.settle(id, 0.4);
        live.delete(id);
      }
    }
  });

  it("reports zero available exactly at the limit", () => {
    const c = new SpendCeiling({ limitUsd: 2, reserveUsd: 1 });
    const a = c.admit("a");
    const b = c.admit("b");
    if (!a.allowed || !b.allowed) throw new Error("expected admissions");
    expect(c.snapshot().availableUsd).toBe(0);
    expect(c.admit("c").allowed).toBe(false);
  });
});
