import { describe, expect, it } from "vitest";
import { maxRetryAttempts, PoolRetryPolicy } from "../../src/llm/retry-policy.js";
import type { ParsedDelay } from "../../src/llm/retry-delay.js";

const delay = (bufferedMs: number): ParsedDelay => ({
  rawMs: Math.max(1, bufferedMs - 200),
  bufferedMs,
  source: "header",
});

describe("pool retry policy reference branches", () => {
  it("grants one grace when a short hint also covers the full pool cooldown", () => {
    const policy = new PoolRetryPolicy(1);
    const failure = {
      accountId: "opaque",
      rateLimited: true,
      delay: delay(1200),
      poolUnavailableForMs: 1200,
    };
    policy.startAttempt();
    expect(policy.afterFailure(failure)).toEqual({
      kind: "retry",
      mode: "same_account",
      delayMs: 1200,
    });
    policy.startAttempt();
    expect(policy.afterFailure(failure)).toEqual({ kind: "retry", mode: "wait", delayMs: 1200 });
  });
  it.each([
    [0, 3],
    [1, 3],
    [2, 4],
    [3, 6],
    [6, 12],
    [100, 12],
  ])("bounds a pool of %i at %i total attempts", (pool, expected) => {
    expect(maxRetryAttempts(pool)).toBe(expected);
    const policy = new PoolRetryPolicy(pool);
    for (let ordinal = 1; ordinal <= expected; ordinal++)
      expect(policy.startAttempt()).toBe(ordinal);
    expect(policy.startAttempt()).toBeNull();
    expect(policy.afterFailure({ rateLimited: true }).kind).toBe("stop");
  });

  it.each([
    { pool: 0, attempt: 1, rateLimited: false, expected: 4000, mode: "wait" },
    { pool: 1, attempt: 1, rateLimited: false, expected: 2000, mode: "wait" },
    { pool: 1, attempt: 1, rateLimited: true, expected: 3000, mode: "wait" },
    { pool: 1, attempt: 2, rateLimited: true, expected: 6000, mode: "wait" },
    { pool: 2, attempt: 1, rateLimited: true, expected: 50, mode: "rotate" },
    { pool: 2, attempt: 2, rateLimited: false, expected: 2000, mode: "wait" },
    { pool: 2, attempt: 3, rateLimited: true, expected: 4000, mode: "wait" },
    { pool: 3, attempt: 2, rateLimited: false, expected: 50, mode: "rotate" },
    { pool: 3, attempt: 5, rateLimited: true, expected: 5000, mode: "wait" },
  ])(
    "uses the reference delay for pool $pool, attempt $attempt, 429=$rateLimited",
    ({ pool, attempt, rateLimited, expected, mode }) => {
      const policy = new PoolRetryPolicy(pool);
      for (let index = 0; index < attempt; index++) policy.startAttempt();
      expect(policy.afterFailure({ rateLimited })).toEqual({
        kind: "retry",
        mode,
        delayMs: expected,
      });
    },
  );

  it.each([
    [1, 1, 20_000, 10_000, "wait"],
    [2, 2, 20_000, 12_000, "wait"],
    [3, 3, 20_000, 50, "rotate"],
    [2, 2, 5000, 5000, "same_account"],
  ] as const)(
    "honors parsed delays for pool %i, attempt %i",
    (pool, attempt, providerMs, expected, mode) => {
      const policy = new PoolRetryPolicy(pool);
      for (let index = 0; index < attempt; index++) policy.startAttempt();
      expect(
        policy.afterFailure({
          accountId: "opaque-account",
          rateLimited: true,
          delay: delay(providerMs),
        }),
      ).toEqual({ kind: "retry", mode, delayMs: expected });
    },
  );

  it("grants grace once per account and shares an immutable countdown/sleep plan", () => {
    const policy = new PoolRetryPolicy(3);
    policy.startAttempt();
    policy.startAttempt();
    policy.startAttempt();
    const failure = { accountId: "a", rateLimited: true, delay: delay(1000) };
    const plan = policy.afterFailure(failure);
    expect(policy.afterFailure(failure)).toBe(plan);
    expect(plan).toEqual({ kind: "retry", mode: "same_account", delayMs: 1000 });
    policy.startAttempt();
    expect(policy.afterFailure(failure)).toEqual({ kind: "retry", mode: "wait", delayMs: 1000 });
    policy.startAttempt();
    expect(policy.afterFailure({ ...failure, accountId: "b" }).kind).toBe("retry");
    expect(policy.afterFailure({ ...failure, accountId: "b" })).toMatchObject({
      mode: "same_account",
    });
  });

  it("latches cancellation and respects a stricter host ceiling", () => {
    const policy = new PoolRetryPolicy(6, 2);
    policy.startAttempt();
    expect(policy.afterFailure({ rateLimited: true, cancelled: true })).toEqual({
      kind: "stop",
      reason: "cancelled",
    });
    expect(policy.startAttempt()).toBeNull();
    const limited = new PoolRetryPolicy(6, 2);
    limited.startAttempt();
    limited.startAttempt();
    expect(limited.afterFailure({ rateLimited: false })).toEqual({
      kind: "stop",
      reason: "exhausted",
    });
  });
});
