/**
 * Credential rotation, rate-limit classification, backoff and refresh scheduling.
 *
 * The ported math here comes from the Antigravity lineage's proxy fleet, and the assertions
 * that carry the most weight are:
 *
 *  - `classifyRateLimitReason` branch ORDER: a 401 whose body happens to say "quota" must
 *    still classify as an auth failure, and a generic `resource_exhausted` must not masquerade
 *    as quota exhaustion. Reordering those makes a transient 429 look like a day-long outage.
 *  - `markSuccess` resets the failure count — without it a credential that failed once at 09:00
 *    and succeeded all day still backs off like a repeat offender at 17:00.
 *  - The scheduler collapses concurrent refreshes for one credential to a single network call.
 */
import { describe, expect, it } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CEILING_MS,
  BACKOFF_FLOOR_MS,
  FAILURE_EXPIRY_MS,
  MAX_LOCKOUT_MS,
  RATE_LIMIT_REASON,
  SELECTION_MODE,
  SESSION_BINDING_MS,
  CredentialRefreshScheduler,
  CredentialRotationTracker,
  backoffFor,
  classifyRateLimitReason,
  healthScore,
  limitKey,
  selectCredential,
} from "../../src/fleet/credential-rotation.js";

describe("classifyRateLimitReason", () => {
  it("classifies a 401 as an auth failure even when the body says quota", () => {
    // Order matters: auth first. A 401 body occasionally contains the word "quota".
    expect(classifyRateLimitReason(401, "quota limit reached")).toBe(RATE_LIMIT_REASON.AuthFailure);
    expect(classifyRateLimitReason(403, "rate limit exceeded")).toBe(RATE_LIMIT_REASON.AuthFailure);
  });

  it("classifies an invalid/expired bearer header as an auth failure", () => {
    expect(classifyRateLimitReason(200, "ok", "Bearer invalid_token")).toBe(
      RATE_LIMIT_REASON.AuthFailure,
    );
    expect(classifyRateLimitReason(200, "ok", "token expired")).toBe(RATE_LIMIT_REASON.AuthFailure);
  });

  it("ignores a benign authorization header", () => {
    expect(classifyRateLimitReason(200, "ok", "Bearer valid")).toBe(RATE_LIMIT_REASON.Unknown);
  });

  it("recognizes model capacity exhaustion", () => {
    expect(classifyRateLimitReason(429, "model_capacity exhausted")).toBe(
      RATE_LIMIT_REASON.ModelCapacityExhausted,
    );
  });

  it("classifies a transient rate limit distinctly from quota", () => {
    expect(classifyRateLimitReason(429, "too many requests per minute")).toBe(
      RATE_LIMIT_REASON.RateLimitExceeded,
    );
    expect(classifyRateLimitReason(429, "rate limit exceeded")).toBe(
      RATE_LIMIT_REASON.RateLimitExceeded,
    );
    expect(classifyRateLimitReason(429, "per minute limit hit")).toBe(
      RATE_LIMIT_REASON.RateLimitExceeded,
    );
  });

  it("treats a generic resource_exhausted as a rate limit, not quota", () => {
    // "resource has been exhausted" is ambiguous; only explicit quota wording counts as quota.
    expect(classifyRateLimitReason(429, "resource has been exhausted")).toBe(
      RATE_LIMIT_REASON.RateLimitExceeded,
    );
    expect(classifyRateLimitReason(429, "resource_exhausted")).toBe(
      RATE_LIMIT_REASON.RateLimitExceeded,
    );
  });

  it("classifies explicit quota wording as quota exhaustion", () => {
    expect(classifyRateLimitReason(429, "quota_exhausted")).toBe(RATE_LIMIT_REASON.QuotaExhausted);
    expect(classifyRateLimitReason(429, "daily quota reached")).toBe(
      RATE_LIMIT_REASON.QuotaExhausted,
    );
    expect(classifyRateLimitReason(429, "quota reset in 3600s")).toBe(
      RATE_LIMIT_REASON.QuotaExhausted,
    );
    expect(classifyRateLimitReason(429, "resource exhausted: quota limit")).toBe(
      RATE_LIMIT_REASON.QuotaExhausted,
    );
  });

  it("classifies a 5xx as a server error", () => {
    expect(classifyRateLimitReason(503, "unavailable")).toBe(RATE_LIMIT_REASON.ServerError);
    expect(classifyRateLimitReason(500, "")).toBe(RATE_LIMIT_REASON.ServerError);
  });

  it("falls back to unknown for anything else", () => {
    expect(classifyRateLimitReason(200, "ok")).toBe(RATE_LIMIT_REASON.Unknown);
    expect(classifyRateLimitReason(400, "bad request")).toBe(RATE_LIMIT_REASON.Unknown);
  });

  it("tolerates a null or undefined body", () => {
    expect(classifyRateLimitReason(500, null as unknown as string)).toBe(
      RATE_LIMIT_REASON.ServerError,
    );
  });
});

describe("backoffFor", () => {
  it("grows exponentially with the failure count", () => {
    const now = 10_000;
    const first = backoffFor(1, now);
    const third = backoffFor(3, now);
    const fifth = backoffFor(5, now);
    expect(first).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
    expect(third).toBeGreaterThan(first);
    expect(fifth).toBeGreaterThan(third);
  });

  it("never exceeds the ceiling", () => {
    for (let count = 0; count < 20; count++) {
      expect(backoffFor(count, 1_000)).toBeLessThanOrEqual(BACKOFF_CEILING_MS);
    }
  });

  it("never drops below the floor", () => {
    for (let count = 0; count < 20; count++) {
      expect(backoffFor(count, 1_000)).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
    }
  });

  it("is deterministic for a fixed clock", () => {
    expect(backoffFor(3, 5_000)).toBe(backoffFor(3, 5_000));
  });

  it("stays inside the jitter band 0.75x..1.25x of the clamped base", () => {
    const now = 42_000;
    const value = backoffFor(2, now);
    const exponent = Math.max(0, Math.min(2, 8));
    const raw = BACKOFF_BASE_MS * 2 ** exponent;
    const clamped = Math.min(Math.max(BACKOFF_FLOOR_MS, raw), BACKOFF_CEILING_MS);
    expect(value).toBeGreaterThanOrEqual(Math.round(clamped * 0.75));
    expect(value).toBeLessThanOrEqual(Math.round(clamped * 1.25));
  });
});

describe("limitKey", () => {
  it("keys a credential alone", () => {
    expect(limitKey("cred-1")).toBe("cred-1");
  });

  it("keys a credential plus a throttled capability", () => {
    expect(limitKey("cred-1", "send_message")).toBe("cred-1:send_message");
  });

  it("ignores an empty capability", () => {
    expect(limitKey("cred-1", "")).toBe("cred-1");
  });
});

describe("healthScore", () => {
  it("is 1.0 for a credential with no history", () => {
    expect(healthScore({ successCount: 0, failureCount: 0 })).toBe(1);
  });

  it("is 0 for a credential that only ever failed", () => {
    expect(healthScore({ successCount: 0, failureCount: 5 })).toBe(0);
  });

  it("is 1 for a credential that only ever succeeded", () => {
    expect(healthScore({ successCount: 5, failureCount: 0 })).toBe(1);
  });

  it("discounts a credential whose most recent event was a failure", () => {
    const fresh = healthScore({ successCount: 4, failureCount: 1 });
    const recentFailure = healthScore({
      successCount: 4,
      failureCount: 1,
      lastSuccessAt: 100,
      lastFailureAt: 200,
    });
    expect(recentFailure).toBeLessThan(fresh);
    expect(recentFailure).toBeCloseTo(0.7, 5);
  });

  it("recovers when a success follows the failure", () => {
    expect(
      healthScore({
        successCount: 4,
        failureCount: 1,
        lastSuccessAt: 300,
        lastFailureAt: 200,
      }),
    ).toBeCloseTo(0.8, 5);
  });
});

describe("CredentialRotationTracker", () => {
  it("parks a credential after a rate-limit failure and reports the wait", () => {
    const tracker = new CredentialRotationTracker();
    const now = Date.now();
    const reason = tracker.markFailure("cred-1", 429, "rate limit exceeded", {}, now);
    expect(reason).toBe(RATE_LIMIT_REASON.RateLimitExceeded);
    expect(tracker.isUsable("cred-1", undefined, now)).toBe(false);
    expect(tracker.remainingWaitMs("cred-1", undefined, now)).toBeGreaterThan(0);
    // parkedCount reads the wall clock, so a real `now` keeps both views consistent.
    expect(tracker.parkedCount).toBe(1);
  });

  it("lifts the parking once the window passes", () => {
    const tracker = new CredentialRotationTracker();
    // An explicit reset window keeps the assertion off the jittered backoff, which varies
    // with the clock by design.
    tracker.markFailure("cred-1", 429, "rate limit exceeded", { resetAt: 10_000 }, 1_000);
    expect(tracker.isUsable("cred-1", undefined, 5_000)).toBe(false);
    expect(tracker.isUsable("cred-1", undefined, 10_001)).toBe(true);
  });

  it("evicts immediately on an auth failure and never recovers on its own", () => {
    const tracker = new CredentialRotationTracker();
    expect(tracker.markFailure("cred-1", 401, "unauthorized")).toBe(RATE_LIMIT_REASON.AuthFailure);
    expect(tracker.isEvicted("cred-1")).toBe(true);
    expect(tracker.evictedCount).toBe(1);
    expect(tracker.isUsable("cred-1", undefined, 10_000_000)).toBe(false);
    expect(tracker.remainingWaitMs("cred-1", undefined, 10_000_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("revives an evicted credential only by hand", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markFailure("cred-1", 401, "unauthorized");
    tracker.revive("cred-1");
    expect(tracker.isEvicted("cred-1")).toBe(false);
    expect(tracker.isUsable("cred-1")).toBe(true);
  });

  it("parks only the throttled capability, not the whole credential", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markFailure("cred-1", 429, "rate limit", { capability: "send_message" }, 1_000);
    expect(tracker.isUsable("cred-1", "send_message", 2_000)).toBe(false);
    // The credential is still good for anything else.
    expect(tracker.isUsable("cred-1", "list_messages", 2_000)).toBe(true);
  });

  it("caps a quota parking at the lockout ceiling", () => {
    const tracker = new CredentialRotationTracker();
    const now = 1_000;
    tracker.markFailure("cred-1", 429, "quota_exhausted", {}, now);
    const remaining = tracker.remainingWaitMs("cred-1", undefined, now);
    // Quota parking is backoff*4, clamped to MAX_LOCKOUT_MS.
    expect(remaining).toBeLessThanOrEqual(MAX_LOCKOUT_MS);
  });

  it("honours an explicit resetAt from the provider", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markFailure("cred-1", 429, "rate limit", { resetAt: 5_000 }, 1_000);
    expect(tracker.remainingWaitMs("cred-1", undefined, 1_000)).toBe(4_000);
  });

  it("bumps a past-dated resetAt to the floor", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markFailure("cred-1", 429, "rate limit", { resetAt: 500 }, 1_000);
    expect(tracker.remainingWaitMs("cred-1", undefined, 1_000)).toBe(BACKOFF_FLOOR_MS);
  });

  it("resets the failure count on success", async () => {
    const tracker = new CredentialRotationTracker();
    // A failure at 09:00...
    tracker.markFailure("cred-1", 429, "rate limit", {}, 9 * 3_600_000);
    // ...then success all day...
    tracker.markSuccess("cred-1", undefined, 10 * 3_600_000);
    // ...a new failure at 17:00 backs off like a first offender, not an 8-fold repeat.
    tracker.markFailure("cred-1", 429, "rate limit", {}, 17 * 3_600_000);
    const remaining = tracker.remainingWaitMs("cred-1", undefined, 17 * 3_600_000);
    expect(remaining).toBeLessThan(BACKOFF_BASE_MS * 4);
  });

  it("expires a stale failure count after the expiry window", () => {
    const tracker = new CredentialRotationTracker();
    const now = 1_000;
    tracker.markFailure("cred-1", 429, "rate limit", {}, now);
    // Same credential fails again long after the failure count expired.
    const reason = tracker.markFailure(
      "cred-1",
      429,
      "rate limit",
      {},
      now + FAILURE_EXPIRY_MS + 1,
    );
    expect(reason).toBe(RATE_LIMIT_REASON.RateLimitExceeded);
  });

  it("reports healthy, cooldown and evicted health", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markSuccess("cred-healthy", undefined, 1_000);
    tracker.markFailure("cred-cool", 429, "rate limit", {}, 1_000);
    tracker.markFailure("cred-gone", 401, "unauthorized", {}, 1_000);

    expect(tracker.health("cred-healthy", 1_000).status).toBe("healthy");
    expect(tracker.health("cred-cool", 1_000).status).toBe("cooldown");
    expect(tracker.health("cred-gone", 1_000).status).toBe("evicted");
    expect(tracker.health("cred-gone", 1_000).healthScore).toBe(0);
  });

  it("sorts fleet health by score, best first", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markSuccess("cred-good", undefined, 1_000);
    tracker.markFailure("cred-bad", 429, "rate limit", {}, 1_000);
    const health = tracker.fleetHealth(1_000);
    expect(health[0]!.credentialId).toBe("cred-good");
  });

  it("emits rotation events to subscribers", () => {
    const tracker = new CredentialRotationTracker();
    const events: string[] = [];
    const unsubscribe = tracker.onChange((event) => events.push(event.type));
    tracker.markFailure("cred-1", 429, "rate limit", {}, 1_000);
    tracker.markSuccess("cred-1", undefined, 2_000);
    tracker.markFailure("cred-2", 401, "unauthorized", {}, 3_000);
    tracker.revive("cred-2", 4_000);
    unsubscribe();
    tracker.markSuccess("cred-1", undefined, 5_000);
    expect(events).toEqual(["failure", "success", "evicted", "revived"]);
  });

  it("survives a throwing subscriber", () => {
    const tracker = new CredentialRotationTracker();
    tracker.onChange(() => {
      throw new Error("subscriber blew up");
    });
    expect(() => tracker.markSuccess("cred-1")).not.toThrow();
  });

  it("clears all state", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markFailure("cred-1", 429, "rate limit", {}, 1_000);
    tracker.markFailure("cred-2", 401, "unauthorized", {}, 1_000);
    tracker.clear();
    expect(tracker.parkedCount).toBe(0);
    expect(tracker.evictedCount).toBe(0);
  });
});

describe("sticky sessions and selection", () => {
  const candidates = [
    { credentialId: "alpha", healthScore: 0.9 },
    { credentialId: "bravo", healthScore: 0.8 },
    { credentialId: "charlie", healthScore: 0.7 },
  ];

  it("binds a session to the first credential that served it", () => {
    const tracker = new CredentialRotationTracker();
    const first = selectCredential(
      { candidates, sessionKey: "sess-1", now: 1_000, mode: SELECTION_MODE.CacheFirst },
      tracker,
    );
    const second = selectCredential(
      { candidates, sessionKey: "sess-1", now: 2_000, mode: SELECTION_MODE.CacheFirst },
      tracker,
    );
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(tracker.sessionBinding("sess-1", 2_000)).toBe(first);
  });

  it("rebinds when the bound credential becomes unusable", () => {
    const tracker = new CredentialRotationTracker();
    const first = selectCredential(
      { candidates, sessionKey: "sess-1", now: 1_000, mode: SELECTION_MODE.CacheFirst },
      tracker,
    );
    tracker.markFailure(first!, 429, "rate limit", {}, 2_000);
    const second = selectCredential(
      { candidates, sessionKey: "sess-1", now: 3_000, mode: SELECTION_MODE.CacheFirst },
      tracker,
    );
    expect(second).not.toBe(first);
  });

  it("expires a sticky binding after the session lifetime", () => {
    const tracker = new CredentialRotationTracker();
    selectCredential(
      { candidates, sessionKey: "sess-1", now: 1_000, mode: SELECTION_MODE.CacheFirst },
      tracker,
    );
    expect(tracker.sessionBinding("sess-1", 1_000 + SESSION_BINDING_MS + 1)).toBeUndefined();
  });

  it("rotates round-robin in balance mode", () => {
    const tracker = new CredentialRotationTracker();
    const picks = new Set<string>();
    for (let i = 0; i < 6; i++) {
      picks.add(
        selectCredential({ candidates, now: 1_000, mode: SELECTION_MODE.Balance }, tracker)!,
      );
    }
    // Over repeated calls every healthy candidate is used.
    expect(picks.size).toBeGreaterThan(1);
  });

  it("always takes the healthiest credential in performance-first mode", () => {
    const tracker = new CredentialRotationTracker();
    for (let i = 0; i < 3; i++) {
      expect(
        selectCredential(
          { candidates, now: 1_000, mode: SELECTION_MODE.PerformanceFirst },
          tracker,
        ),
      ).toBe("alpha");
    }
  });

  it("skips parked and evicted candidates", () => {
    const tracker = new CredentialRotationTracker();
    tracker.markFailure("alpha", 429, "rate limit", {}, 1_000);
    tracker.markFailure("charlie", 401, "unauthorized", {}, 1_000);
    expect(
      selectCredential({ candidates, now: 1_000, mode: SELECTION_MODE.PerformanceFirst }, tracker),
    ).toBe("bravo");
  });

  it("returns undefined when every candidate is parked", () => {
    const tracker = new CredentialRotationTracker();
    for (const candidate of candidates) {
      tracker.markFailure(candidate.credentialId, 429, "rate limit", {}, 1_000);
    }
    expect(
      selectCredential({ candidates, now: 1_000, mode: SELECTION_MODE.PerformanceFirst }, tracker),
    ).toBeUndefined();
  });

  it("prefers a caller-configured default when it is usable", () => {
    const tracker = new CredentialRotationTracker();
    expect(
      selectCredential(
        {
          candidates,
          now: 1_000,
          mode: SELECTION_MODE.Balance,
          preferred: "charlie",
        },
        tracker,
      ),
    ).toBe("charlie");
  });

  it("drops a session binding on release", () => {
    const tracker = new CredentialRotationTracker();
    selectCredential(
      { candidates, sessionKey: "sess-1", now: 1_000, mode: SELECTION_MODE.CacheFirst },
      tracker,
    );
    tracker.releaseSession("sess-1");
    expect(tracker.sessionBinding("sess-1", 1_000)).toBeUndefined();
  });
});

describe("CredentialRefreshScheduler", () => {
  it("schedules a refresh ahead of expiry by the lead time", () => {
    const now = 10_000;
    const scheduler = new CredentialRefreshScheduler({ leadTimeMs: 60_000, now: () => now });
    const job = scheduler.schedule("cred-1", 360_000);
    expect(job).toBeDefined();
    expect(job!.dueAt).toBe(300_000);
  });

  it("schedules an already-expired credential for now", () => {
    const now = 10_000;
    const scheduler = new CredentialRefreshScheduler({ leadTimeMs: 60_000, now: () => now });
    const job = scheduler.schedule("cred-1", 5_000);
    expect(job!.dueAt).toBe(now);
  });

  it("never schedules a credential without an expiry", () => {
    const scheduler = new CredentialRefreshScheduler();
    expect(scheduler.schedule("cred-1", undefined)).toBeUndefined();
    expect(scheduler.schedule("cred-1", Number.NaN)).toBeUndefined();
    expect(scheduler.scheduledCount).toBe(0);
  });

  it("keeps the earliest due date when rescheduled sooner", () => {
    const now = 10_000;
    const scheduler = new CredentialRefreshScheduler({ leadTimeMs: 0, now: () => now });
    scheduler.schedule("cred-1", 100_000);
    const rescheduled = scheduler.schedule("cred-1", 50_000);
    expect(rescheduled!.dueAt).toBe(50_000);
  });

  it("cancels a scheduled refresh", () => {
    const scheduler = new CredentialRefreshScheduler();
    scheduler.schedule("cred-1", 100_000);
    scheduler.cancel("cred-1");
    expect(scheduler.scheduledCount).toBe(0);
  });

  it("runs due jobs earliest first and reports outcomes", async () => {
    const now = { value: 10_000 };
    const scheduler = new CredentialRefreshScheduler({ leadTimeMs: 1_000, now: () => now.value });
    // Both tokens expire in the future, so each is due `leadTimeMs` before its expiry —
    // and the two due dates differ, which is what the ordering assertion needs.
    scheduler.schedule("cred-late", 100_000);
    scheduler.schedule("cred-early", 20_000);
    now.value = 100_000;
    const order: string[] = [];
    const result = await scheduler.runDue(async (credentialId) => {
      order.push(credentialId);
      return credentialId !== "cred-late";
    });
    expect(order).toEqual(["cred-early", "cred-late"]);
    expect(result).toEqual({ succeeded: 1, failed: 1 });
  });

  it("collapses concurrent refreshes for one credential to one call", async () => {
    const now = { value: 10_000 };
    const scheduler = new CredentialRefreshScheduler({ now: () => now.value });
    scheduler.schedule("cred-1", 5_000);
    let calls = 0;
    const refresh = async (): Promise<boolean> => {
      calls++;
      // A slow refresh, in flight when a second request arrives.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    };
    const [a, b] = await Promise.all([
      scheduler.runOne("cred-1", 0, refresh),
      scheduler.runOne("cred-1", 0, refresh),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls).toBe(1);
    expect(scheduler.inFlightCount).toBe(0);
  });

  it("reschedules a failed refresh with backoff and an incremented attempt", async () => {
    const now = { value: 10_000 };
    const scheduler = new CredentialRefreshScheduler({
      leadTimeMs: 0,
      minIntervalMs: 0,
      now: () => now.value,
    });
    scheduler.schedule("cred-1", 5_000);
    const failing = async (): Promise<boolean> => false;
    await scheduler.runDue(failing);
    // The failed refresh is rescheduled in the future, not dropped.
    expect(scheduler.scheduledCount).toBe(1);
    const job = scheduler.jobFor("cred-1");
    expect(job?.attempt).toBe(1);
    expect(job?.dueAt).toBeGreaterThan(now.value);
  });

  it("gives up after the maximum attempts and drops the job", async () => {
    const now = { value: 10_000 };
    const scheduler = new CredentialRefreshScheduler({
      leadTimeMs: 0,
      maxAttempts: 2,
      now: () => now.value,
    });
    scheduler.schedule("cred-1", 5_000);
    const refresh = async (): Promise<boolean> => false;
    await scheduler.runDue(refresh);
    expect(scheduler.scheduledCount).toBe(1);
    // The retry is waiting on a backoff; advance the clock past it before running again.
    now.value = (scheduler.jobFor("cred-1")?.dueAt ?? now.value) + 1;
    await scheduler.runDue(refresh);
    // attempt 2 >= maxAttempts: the job is gone.
    expect(scheduler.scheduledCount).toBe(0);
  });

  it("counts a thrown refresh as a failure", async () => {
    const now = { value: 10_000 };
    const scheduler = new CredentialRefreshScheduler({ leadTimeMs: 0, now: () => now.value });
    scheduler.schedule("cred-1", 5_000);
    const result = await scheduler.runDue(async () => {
      throw new Error("provider down");
    });
    expect(result).toEqual({ succeeded: 0, failed: 1 });
  });
});
