import { describe, it, expect } from "vitest";
import {
  ResearchBudget,
  withRetry,
  trimCitations,
  defaultTokenEstimate,
  type ResearchPhase,
} from "../../../src/agent/research/research-budget.js";

describe("defaultTokenEstimate", () => {
  it("charges roughly four ascii characters per token and two for a wide character", () => {
    expect(defaultTokenEstimate("")).toBe(0);
    expect(defaultTokenEstimate("abcd")).toBe(1);
    expect(defaultTokenEstimate("ab")).toBe(1);
    expect(defaultTokenEstimate("语")).toBe(1);
  });
});

describe("ResearchBudget", () => {
  it("charges phases and accumulates the spend", () => {
    const budget = new ResearchBudget({ maxPapers: 10, maxTokens: 1000 });
    budget.charge("searching", { text: "a query about things" });
    budget.charge("fetching", { papers: 3 });
    budget.charge("verifying", { verifications: 5, durationNs: 1000 });

    const report = budget.report();
    expect(report.papers).toBe(3);
    expect(report.verifications).toBe(5);
    expect(report.tokens).toBe(defaultTokenEstimate("a query about things"));
    expect(report.paperBudgetUsed).toBeCloseTo(0.3);
    expect(report.retries).toBe(0);
    expect(report.exhausted).toHaveLength(0);
  });

  it("estimates tokens from text when no explicit count is given", () => {
    const budget = new ResearchBudget({ maxTokens: 1000 });
    budget.charge("parsing", { text: "hello world" });
    expect(budget.report().tokens).toBe(defaultTokenEstimate("hello world"));
  });

  it("accepts an injected token estimator", () => {
    const budget = new ResearchBudget({ maxTokens: 1000, estimateTokens: () => 7 });
    budget.charge("parsing", { text: "anything" });
    expect(budget.report().tokens).toBe(7);
  });

  it("aggregates per-phase spend across charges", () => {
    const budget = new ResearchBudget();
    budget.charge("fetching", { papers: 2 });
    budget.charge("fetching", { papers: 1 });
    const fetching = budget.report().phases.get("fetching" as ResearchPhase);
    expect(fetchgingCheck(fetching)).toEqual({ papers: 3, attempts: 2 });
  });

  it("reports exhaustion for every limit that is met", () => {
    const budget = new ResearchBudget({
      maxPapers: 2,
      maxTokens: 100,
      maxVerifications: 1,
      maxDurationNs: 1,
    });
    budget.charge("fetching", { papers: 2 });
    budget.charge("verifying", { verifications: 1 });
    const report = budget.report();
    expect(report.exhausted).toContain("maxPapers");
    expect(report.exhausted).toContain("maxVerifications");
    // The time budget of 1ns has certainly elapsed.
    expect(report.exhausted).toContain("maxDurationNs");
  });

  it("gates further work with canFetch, canVerify and canSpendTokens", () => {
    const budget = new ResearchBudget({ maxPapers: 2, maxVerifications: 2, maxTokens: 10 });
    expect(budget.canFetch(2)).toBe(true);
    budget.charge("fetching", { papers: 2 });
    expect(budget.canFetch()).toBe(false);
    expect(budget.canVerify(3)).toBe(false);
    expect(budget.canSpendTokens(100)).toBe(false);
    expect(budget.remainingPapers).toBe(0);
  });

  it("produces a deterministic, bounded backoff schedule", () => {
    const schedule = () => {
      const budget = new ResearchBudget({
        backoffBaseNs: 1_000_000,
        backoffMaxNs: 10_000_000,
        jitter: 0.25,
      });
      return [
        budget.nextBackoff("fetching", 0),
        budget.nextBackoff("fetching", 1),
        budget.nextBackoff("fetching", 20),
      ];
    };
    const [a, b, c] = schedule();
    // Same budget state and attempt ⇒ same delays, jitter included.
    expect(schedule()).toEqual([a, b, c]);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(10_000_000);
    expect(c).toBeLessThanOrEqual(10_000_000);
  });

  it("disables jitter when jitter is zero", () => {
    const budget = new ResearchBudget({ backoffBaseNs: 4_000_000, jitter: 0 });
    expect(budget.nextBackoff("fetching", 0)).toBe(4_000_000);
    expect(budget.nextBackoff("fetching", 1)).toBe(8_000_000);
  });

  it("classifies which failures are worth retrying", () => {
    const budget = new ResearchBudget();
    expect(budget.shouldRetry(new Error("connection error"))).toBe(true);
    expect(budget.shouldRetry(new Error("server disconnected"))).toBe(true);
    expect(budget.shouldRetry(new Error("too many requests"))).toBe(true);
    expect(budget.shouldRetry(new Error("malformed request body"))).toBe(false);
    expect(budget.shouldRetry("timeout waiting for header")).toBe(true);
  });

  it("resets the ledger but keeps the configured limits", () => {
    const budget = new ResearchBudget({ maxPapers: 3 });
    budget.charge("fetching", { papers: 3 });
    expect(budget.report().exhausted).toContain("maxPapers");
    budget.reset();
    expect(budget.report().papers).toBe(0);
    expect(budget.maxPapers).toBe(3);
    expect(budget.canFetch()).toBe(true);
  });

  it("exposes the configured retry attempt count", () => {
    expect(new ResearchBudget({ maxRetries: 7 }).maxAttempts).toBe(7);
  });
});

describe("withRetry", () => {
  it("returns the first success", async () => {
    const budget = new ResearchBudget();
    await expect(withRetry(budget, "fetching", () => "ok")).resolves.toBe("ok");
    expect(budget.report().retries).toBe(0);
  });

  it("retries a transient failure and succeeds on a later attempt", async () => {
    const budget = new ResearchBudget({
      backoffBaseNs: 1,
      backoffMaxNs: 1,
      jitter: 0,
      maxRetries: 4,
    });
    let attempts = 0;
    await expect(
      withRetry(budget, "fetching", () => {
        attempts += 1;
        if (attempts < 3) throw new Error("connection error");
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("propagates immediately for a non-retryable error", async () => {
    const budget = new ResearchBudget({ backoffBaseNs: 1 });
    await expect(
      withRetry(budget, "fetching", () => {
        throw new Error("malformed request body");
      }),
    ).rejects.toThrow(/malformed request body/);
    expect(budget.report().retries).toBe(0);
  });

  it("gives up after exhausting the retry attempts", async () => {
    const budget = new ResearchBudget({
      backoffBaseNs: 1,
      backoffMaxNs: 1,
      jitter: 0,
      maxRetries: 2,
    });
    let attempts = 0;
    await expect(
      withRetry(budget, "fetching", () => {
        attempts += 1;
        throw new Error("server disconnected");
      }),
    ).rejects.toThrow(/server disconnected/);
    expect(attempts).toBe(2);
  });

  it("wraps a non-error rejection in an Error", async () => {
    const budget = new ResearchBudget();
    await expect(
      withRetry(budget, "fetching", () => Promise.reject("string failure")),
    ).rejects.toThrow(/string failure/);
  });
});

describe("trimCitations", () => {
  it("keeps the most influential citations within the ceiling", () => {
    const kept = trimCitations(
      [
        { id: "low", influence: 0.1 },
        { id: "high", influence: 0.9 },
        { id: "mid", influence: 0.5 },
      ],
      2,
    );
    expect(kept).toEqual(["high", "mid"]);
  });

  it("returns an empty list for a zero or negative ceiling", () => {
    expect(trimCitations([{ id: "a", influence: 1 }], 0)).toEqual([]);
  });

  it("keeps everything when the list already fits", () => {
    expect(trimCitations([{ id: "a", influence: 1 }], 5)).toEqual(["a"]);
  });
});

function fetchgingCheck(spend: { papers: number; attempts: number } | undefined) {
  if (!spend) return { papers: -1, attempts: -1 };
  return { papers: spend.papers, attempts: spend.attempts };
}
