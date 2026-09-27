/**
 * Research-budget accounting: a ledger that cannot be made to under-report by a bad number, a
 * forgotten reservation, or a task boundary.
 */
import { describe, expect, it } from "vitest";
import { ResearchBudget } from "../../../src/agent/research/research-budget.js";

const budget = (overrides: Record<string, unknown> = {}) =>
  new ResearchBudget({ maxTokens: 1_000, ...overrides });

describe("charges from a provider report", () => {
  it("refuses a negative charge instead of refunding tokens that were never spent", () => {
    // A negative charge used to reduce `tokens`, so a phase could hand back more than it spent
    // and leave `remainingTokens` above the entire budget — a budget nobody can exhaust.
    const b = budget();
    b.charge("fetching", { tokens: 100 });
    b.charge("fetching", { tokens: -5_000 });
    expect(b.tokensSpent).toBe(100);
    expect(b.remainingTokens).toBe(900);
    expect(b.report().rejectedCharges).toBe(1);
  });

  it("refuses a NaN charge rather than poisoning every later figure", () => {
    // `NaN <= maxTokens` is false, so a single NaN made the ledger report "over budget" for a run
    // that had spent nothing, and `report()` divided NaN into its fractions.
    const b = budget();
    b.charge("fetching", { tokens: Number.NaN });
    expect(Number.isFinite(b.tokensSpent)).toBe(true);
    expect(b.remainingTokens).toBe(1_000);

    // And the ledger still works afterwards.
    b.charge("fetching", { tokens: 10 });
    expect(b.tokensSpent).toBe(10);
    expect(b.report().rejectedCharges).toBe(1);
  });

  it("refuses an infinite charge", () => {
    const b = budget();
    b.charge("fetching", { tokens: Infinity });
    expect(b.tokensSpent).toBe(0);
    expect(Number.isFinite(b.report().tokenBudgetUsed)).toBe(true);
    expect(b.report().rejectedCharges).toBe(1);
  });

  it("keeps a bad paper or verification count from corrupting the books too", () => {
    const b = budget();
    b.charge("fetching", { tokens: 10, papers: -3, verifications: Number.NaN });
    expect(b.report().papers).toBe(0);
    expect(b.report().verifications).toBe(0);
    expect(b.tokensSpent).toBe(10);
  });

  it("accepts a charge that lands exactly on zero", () => {
    // Zero is a real measurement (an empty response), not a bad value.
    const b = budget();
    b.charge("fetching", { tokens: 0 });
    expect(b.tokensSpent).toBe(0);
    expect(b.report().rejectedCharges).toBe(0);
  });
});

describe("reservations are part of what is affordable", () => {
  it("counts outstanding reservations in the predicate, not just in remainingTokens", () => {
    // `canSpendTokens` is what a caller asks right before dispatching. Leaving reservations out
    // of it while `remainingTokens` honoured them was the one optimistic path left: two
    // concurrent verifications both passed a check only the first should have.
    const b = budget({ maxTokens: 100 });
    expect(b.canSpendTokens(100)).toBe(true);

    expect(b.reserve(100)).toBe(true); // everything is now committed
    expect(b.remainingTokens).toBe(0);
    expect(b.canSpendTokens(1)).toBe(false);
    expect(b.canSpendTokens(100)).toBe(false);
  });

  it("lets a settled reservation hand its cost back to the ledger", () => {
    const b = budget({ maxTokens: 100 });
    b.reserve(100);
    expect(b.canSpendTokens(1)).toBe(false);
    expect(b.settleReservation(100, { tokens: 20 })).toBe(true);
    expect(b.canSpendTokens(80)).toBe(true);
  });

  it("refuses an unusable amount to canSpendTokens instead of passing it through", () => {
    const b = budget({ maxTokens: 100 });
    expect(b.canSpendTokens(Number.NaN)).toBe(false);
    expect(b.canSpendTokens(-1)).toBe(false);
    expect(b.canSpendTokens(Infinity)).toBe(false);
  });

  it("keeps a budget that hits exactly zero spendable at zero, not negative", () => {
    const b = budget({ maxTokens: 100 });
    b.charge("fetching", { tokens: 100 });
    expect(b.remainingTokens).toBe(0);
    expect(b.canSpendTokens(0)).toBe(true);
    expect(b.canSpendTokens(1)).toBe(false);
    expect(b.report().tokenBudgetUsed).toBe(1);
    expect(b.report().exhausted).toContain("maxTokens");
  });

  it("settles a reservation at most once", () => {
    const b = budget({ maxTokens: 100 });
    b.reserve(50);
    expect(b.settleReservation(50, { tokens: 10 })).toBe(true);
    expect(b.settleReservation(50, { tokens: 10 })).toBe(false);
    expect(b.tokensSpent).toBe(10);
  });
});

describe("a task boundary with calls still in flight", () => {
  it("charges outstanding reservations rather than handing them to the next task", () => {
    // The work was admitted and may have run. Releasing the reservation would give the fresh task
    // a budget the previous one had already promised away, and when the in-flight call settled it
    // would charge the NEW task's books — task A's spend landing in task B's totals.
    const b = budget({ maxTokens: 1_000 });
    b.reserve(300);
    b.charge("fetching", { tokens: 50 });
    expect(b.tokensSpent).toBe(50);
    expect(b.reservedTokenCount).toBe(300);

    b.reset();

    expect(b.tokensSpent).toBe(0); // the new task starts clean
    expect(b.reservedTokenCount).toBe(0); // and holds no promise on the old task's behalf
    expect(b.remainingTokens).toBe(1_000); // a full budget
    // But the abandoned spend is recorded rather than vanished.
    expect(b.abandonedTokenCount).toBe(300);
    expect(b.report().abandonedTokens).toBe(300);
  });

  it("does not double-charge when an abandoned reservation's owner settles late", () => {
    // The reservation was already charged at reset, so the late settle must not charge again.
    const b = budget({ maxTokens: 1_000 });
    b.reserve(300);
    b.reset();
    expect(b.settleReservation(300, { tokens: 280 })).toBe(false);
    expect(b.tokensSpent).toBe(0);
  });

  it("keeps per-phase state from the previous task out of the new one", () => {
    const b = budget({ maxTokens: 1_000 });
    b.charge("fetching", { tokens: 10, papers: 3 });
    b.reset();
    expect(b.report().tokens).toBe(0);
    expect(b.report().papers).toBe(0);
    expect(b.report().phases.size).toBe(0);
  });
});

describe("bounded growth", () => {
  it("keeps the phase map bounded by the phase vocabulary", () => {
    const b = budget({ maxTokens: Number.MAX_SAFE_INTEGER });
    const phases = [
      "planning",
      "searching",
      "fetching",
      "parsing",
      "extracting",
      "verifying",
      "synthesizing",
      "reporting",
    ] as const;
    for (let i = 0; i < 5_000; i++) b.charge(phases[i % phases.length]!, { tokens: 1 });
    // Eight keys, no matter how many charges — a per-phase ledger, not an append-only log.
    expect(b.report().phases.size).toBe(8);
    expect(b.tokensSpent).toBe(5_000);
  });
});
