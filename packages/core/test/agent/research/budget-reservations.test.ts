import { describe, it, expect } from "vitest";
import { ResearchBudget } from "../../../src/agent/research/research-budget.js";

function budget(maxTokens = 1000): ResearchBudget {
  return new ResearchBudget({ maxTokens });
}

describe("research budget reservations", () => {
  it("counts admitted work against what is left, before it has reported", () => {
    // The hole a post-hoc ledger has: nothing is spent until the phase finishes, so a second
    // concurrent call cannot see the first one's cost and both get admitted.
    const b = budget();
    expect(b.remainingTokens).toBe(1000);
    expect(b.reserve(600)).toBe(true);
    expect(b.remainingTokens).toBe(400);
    expect(b.reservedTokenCount).toBe(600);
    // The second call sees the first one's reservation and is refused rather than overrunning.
    expect(b.reserve(500)).toBe(false);
    expect(b.reserve(400)).toBe(true);
    expect(b.remainingTokens).toBe(0);
  });

  it("turns a reservation into real spend without double counting it", () => {
    const b = budget();
    b.reserve(300);
    expect(b.settleReservation(300, { tokens: 250, phase: "verifying" })).toBe(true);
    expect(b.tokensSpent).toBe(250);
    expect(b.reservedTokenCount).toBe(0);
    expect(b.remainingTokens).toBe(750);
    // Settling the same reservation twice must not inflate the books or strand a reservation.
    expect(b.settleReservation(300, { tokens: 250, phase: "verifying" })).toBe(false);
    expect(b.tokensSpent).toBe(250);
  });

  it("can charge more than it reserved, and says so honestly", () => {
    // The estimate is an estimate. A phase that overspends its reservation is recorded at its
    // real cost and can push the budget over — the alternative is a ledger that lies.
    const b = budget();
    b.reserve(100);
    expect(b.settleReservation(100, { tokens: 400, phase: "verifying" })).toBe(true);
    expect(b.tokensSpent).toBe(400);
    expect(b.remainingTokens).toBe(600);
  });

  it("releases a reservation for work that never ran", () => {
    const b = budget();
    b.reserve(500);
    expect(b.releaseReservation(500)).toBe(true);
    expect(b.remainingTokens).toBe(1000);
    expect(b.reservedTokenCount).toBe(0);
    // Releasing more than was held is refused rather than silently going negative.
    expect(b.releaseReservation(500)).toBe(false);
  });

  it("refuses a nonsense estimate instead of poisoning the books", () => {
    const b = budget();
    expect(b.reserve(-1)).toBe(false);
    expect(b.reserve(Number.NaN)).toBe(false);
    expect(b.reserve(Number.POSITIVE_INFINITY)).toBe(false);
    expect(b.remainingTokens).toBe(1000);
    expect(b.settleReservation(0, { tokens: 5 })).toBe(false);
    expect(b.settleReservation(Number.NaN)).toBe(false);
  });

  it("leaves the existing ledger behaviour untouched", () => {
    const b = budget();
    b.charge("fetching", { tokens: 100, papers: 1, verifications: 2 });
    expect(b.tokensSpent).toBe(100);
    expect(b.remainingPapers).toBe(31);
    expect(b.remainingTokens).toBe(900);
    const report = b.report();
    expect(report.tokens).toBe(100);
    expect(report.papers).toBe(1);
    expect(report.verifications).toBe(2);
  });
});
