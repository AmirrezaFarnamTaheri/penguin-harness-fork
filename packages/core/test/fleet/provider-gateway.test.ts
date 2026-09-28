/**
 * The ProviderGateway state machine, and the shadow comparison that gates the flip.
 *
 * The assertions here are chosen to pin the two things that are easy to get wrong and hard to
 * notice: the *order* of the classification rules (a 403 with a quota code is a quota, a bare
 * 403 is not, and swapping the branches silently converts one into a disabled key), and the
 * *action* a classification implies (which is what a behaviour flip would actually change —
 * the kind names are new, the action is the thing the old pools did).
 *
 * Nothing in this file sleeps. Both the clock and the jitter source are injected, so a backoff
 * is asserted as an exact number and a cooldown is crossed by moving a variable.
 */
import { describe, expect, it, vi } from "vitest";
import type { UniEvent } from "@prismshadow/agenthub";

import { GenerativeModel } from "../../src/llm/generative-model.js";
import { userText } from "../../src/omnimessage/index.js";

import {
  DEFAULT_BACKOFF_OPTIONS,
  FAILURE_KIND,
  LEGACY_ACTION,
  ProviderGateway,
  RECOVERY,
  backoffMs,
  classifyFailure,
  collectFailure,
  observeFailure,
  type LegacyAction,
  type ProviderFailure,
  type ShadowRecord,
} from "../../src/fleet/provider-gateway.js";

/** A clock the test moves by hand, and a jitter source pinned to the bottom of its band. */
function fixedEnv(seed = { now: 1_000_000 }) {
  const state = { now: seed.now };
  return {
    state,
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
    // `random` at 0 puts jitter at the low end of the band (0.75×), so the backoff assertions
    // below can name an exact millisecond instead of a range.
    options: { now: () => state.now, random: () => 0 },
  };
}

describe("classifyFailure — the rule order is the design", () => {
  it("treats an explicit credential code as a dead credential whatever status wrapped it", () => {
    // Gemini and several OpenAI-compatible servers answer a bad key with a 400, not a 401.
    // A status-first classifier calls that a bad request and retries it forever.
    expect(classifyFailure({ status: 400, code: "invalid_api_key" })).toMatchObject({
      kind: FAILURE_KIND.CredentialRejected,
      recovery: RECOVERY.Disable,
      evidence: "credential-code",
    });
    expect(classifyFailure({ status: 429, type: "authentication_error" }).kind).toBe(
      FAILURE_KIND.CredentialRejected,
    );
  });

  it("treats a 401 as a dead credential", () => {
    expect(classifyFailure({ status: 401 })).toMatchObject({
      kind: FAILURE_KIND.CredentialRejected,
      recovery: RECOVERY.Disable,
      evidence: "status-401",
    });
  });

  it("splits a 403 four ways, because a bare 403 says almost nothing", () => {
    // This is the status the old `"other"` branch could not express. Each verdict has a
    // different consequence, and picking the wrong one either kills a live key or retries a
    // request that can never succeed.
    expect(classifyFailure({ status: 403, code: "insufficient_user_quota" }).kind).toBe(
      FAILURE_KIND.QuotaExhausted,
    );
    expect(classifyFailure({ status: 403, code: "overloaded_error" }).kind).toBe(
      FAILURE_KIND.ProviderUnavailable,
    );
    expect(classifyFailure({ status: 403 })).toMatchObject({
      kind: FAILURE_KIND.RequestRejected,
      recovery: RECOVERY.Surface,
      evidence: "status-403-bare",
    });
    expect(classifyFailure({ status: 403 }).recovery).not.toBe(RECOVERY.Disable);
  });

  it("keeps a rate limit and a spent quota apart — their recoveries differ", () => {
    expect(classifyFailure({ status: 429 })).toMatchObject({
      kind: FAILURE_KIND.RateLimited,
      recovery: RECOVERY.CoolDown,
    });
    expect(classifyFailure({ status: 429, code: "insufficient_quota" })).toMatchObject({
      kind: FAILURE_KIND.QuotaExhausted,
      recovery: RECOVERY.CoolDownUntilReset,
    });
  });

  it("blames the provider, not the credential, for 5xx and overload", () => {
    for (const status of [500, 502, 503, 504, 529]) {
      expect(classifyFailure({ status }).recovery, `status ${status}`).toBe(RECOVERY.Ignore);
    }
    expect(classifyFailure({ status: 408 }).recovery).toBe(RECOVERY.Ignore);
    expect(classifyFailure({ code: "overloaded_error" }).kind).toBe(
      FAILURE_KIND.ProviderUnavailable,
    );
  });

  it("surfaces a definitive 4xx without touching the credential", () => {
    expect(classifyFailure({ status: 400 })).toMatchObject({
      kind: FAILURE_KIND.RequestRejected,
      recovery: RECOVERY.Surface,
    });
    expect(classifyFailure({ status: 404 }).kind).toBe(FAILURE_KIND.RequestRejected);
  });

  it("observes an unrecognisable failure instead of guessing", () => {
    expect(classifyFailure({})).toMatchObject({
      kind: FAILURE_KIND.Unknown,
      recovery: RECOVERY.Observe,
      evidence: "no-signal",
    });
  });

  it("never reads prose — the anti-slop assertion", () => {
    // The classifiers this replaces matched strings like /usage limit reached/i and /\b429\b/.
    // A provider that changes its message must not change behaviour, and a rate limit mentioned
    // in some unrelated field must not park a key. Neither happens here: the only inputs are
    // structural.
    const lying: ProviderFailure = { status: 400, code: "bad_request" };
    expect(classifyFailure(lying).kind).not.toBe(FAILURE_KIND.RateLimited);
    expect(classifyFailure(lying).recovery).not.toBe(RECOVERY.CoolDown);
    // Even a status the old table would have caught by number, if the number is absent.
    expect(classifyFailure({ code: "some_new_provider_error" }).kind).toBe(FAILURE_KIND.Unknown);
  });

  it("carries Retry-After through to the caller", () => {
    expect(classifyFailure({ status: 429, retryAfterMs: 12_000 }).retryAfterMs).toBe(12_000);
  });
});

describe("backoffMs", () => {
  it("doubles per consecutive failure between the floor and the ceiling", () => {
    expect(backoffMs(1)).toBe(DEFAULT_BACKOFF_OPTIONS.baseMs);
    expect(backoffMs(2)).toBe(DEFAULT_BACKOFF_OPTIONS.baseMs * 2);
    expect(backoffMs(3)).toBe(DEFAULT_BACKOFF_OPTIONS.baseMs * 4);
  });

  it("is bounded on both ends", () => {
    // The ceiling is what keeps a persistently throttled credential in the game: without it,
    // doubling would take it out of rotation for the rest of the session.
    for (const n of [8, 12, 40, 1000]) {
      expect(backoffMs(n)).toBe(DEFAULT_BACKOFF_OPTIONS.ceilingMs);
    }
    // The floor only binds when it is raised above the base. With the defaults (base 2000,
    // floor 1000) it is not the binding constraint, and a test claiming otherwise would be
    // asserting a number the function has never returned.
    expect(backoffMs(1, { baseMs: 100, floorMs: 5_000 })).toBe(5_000);
    // Monotonic and never below the base, from any starting point.
    let previous = 0;
    for (let n = 1; n <= 10; n++) {
      const value = backoffMs(n);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(DEFAULT_BACKOFF_OPTIONS.baseMs);
      previous = value;
    }
  });
});

describe("ProviderGateway.health transitions", () => {
  it("cools a credential down on a 429 and brings it back when the window lapses", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a", "key-b"]);

    const classified = classifyFailure({ status: 429 });
    const parked = gateway.recordFailure("key-a", classified, env.state.now);

    expect(parked.state).toBe("cooling");
    expect(parked.kind).toBe(FAILURE_KIND.RateLimited);
    // Pinned jitter (random → 0) puts the cooldown at the low end of the band: 2000 × 0.75.
    expect(parked.cooldownRemainingMs).toBe(1500);
    expect(gateway.health("key-a", env.state.now).state).toBe("cooling");

    // Halfway through, still cooling. Just past the end, healthy again.
    env.advance(1499);
    expect(gateway.health("key-a", env.state.now).state).toBe("cooling");
    env.advance(2);
    expect(gateway.health("key-a", env.state.now).state).toBe("healthy");
    expect(gateway.health("key-a", env.state.now).cooldownRemainingMs).toBe(0);
  });

  it("disables a credential permanently on a 401 and only revive brings it back", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a", "key-b"]);

    gateway.recordFailure("key-a", classifyFailure({ status: 401 }), env.state.now);
    expect(gateway.health("key-a", env.state.now).state).toBe("disabled");

    // No amount of waiting clears it — a revoked token does not un-revoke.
    env.advance(60 * 60 * 1000);
    expect(gateway.health("key-a", env.state.now).state).toBe("disabled");
    expect(gateway.select(env.state.now)).toMatchObject({ credentialId: "key-b" });

    gateway.revive("key-a", env.state.now);
    expect(gateway.health("key-a", env.state.now).state).toBe("healthy");
  });

  it("resets the streak on a success, so the next backoff restarts from the floor", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);
    const throttled = classifyFailure({ status: 429 });

    gateway.recordFailure("key-a", throttled, env.state.now);
    env.advance(2000);
    gateway.recordFailure("key-a", throttled, env.state.now);
    // Second consecutive parking: 4000 × 0.75.
    expect(gateway.health("key-a", env.state.now).consecutiveFailures).toBe(2);

    env.advance(5000);
    gateway.recordSuccess("key-a", env.state.now);
    expect(gateway.health("key-a", env.state.now).consecutiveFailures).toBe(0);
    expect(gateway.health("key-a", env.state.now).successCount).toBe(1);

    // Without the reset this would be the third parking (8000 × 0.75) — a credential that
    // failed once at 09:00 and worked all day would be backing off like a repeat offender.
    gateway.recordFailure("key-a", throttled, env.state.now);
    expect(gateway.health("key-a", env.state.now).cooldownRemainingMs).toBe(1500);
  });

  it("retains the retry streak when a cooldown lapses and ignores unattributable failures for backoff", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);
    gateway.recordFailure("key-a", classifyFailure({ status: 429 }), env.state.now);
    env.advance(1501);
    expect(gateway.health("key-a", env.state.now).consecutiveFailures).toBe(1);

    gateway.recordFailure("key-a", classifyFailure({}), env.state.now);
    expect(gateway.health("key-a", env.state.now).consecutiveFailures).toBe(1);
    expect(gateway.health("key-a", env.state.now).failureCount).toBe(2);

    const secondThrottle = gateway.recordFailure(
      "key-a",
      classifyFailure({ status: 429 }),
      env.state.now,
    );
    expect(secondThrottle.consecutiveFailures).toBe(2);
    expect(secondThrottle.cooldownRemainingMs).toBe(3000);
  });

  it("does not let an older concurrent result overwrite a newer result", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);
    const older = gateway.select(env.state.now);
    const newer = gateway.select(env.state.now);
    if (older.status !== "selected" || newer.status !== "selected") {
      throw new Error("expected selections");
    }

    gateway.recordSuccess("key-a", env.state.now, newer.attempt);
    gateway.recordFailure("key-a", classifyFailure({ status: 401 }), env.state.now, older.attempt);
    expect(gateway.health("key-a", env.state.now)).toMatchObject({
      state: "healthy",
      successCount: 1,
      failureCount: 0,
    });
  });

  it("does not apply an outstanding attempt receipt after credential re-registration", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);
    const old = gateway.select(env.state.now);
    if (old.status !== "selected") throw new Error("expected selection");
    gateway.unregister(["key-a"]);
    gateway.register(["key-a"]);
    const current = gateway.select(env.state.now);
    if (current.status !== "selected") throw new Error("expected selection");

    gateway.recordSuccess("key-a", env.state.now, old.attempt);
    expect(gateway.health("key-a", env.state.now).successCount).toBe(0);
    gateway.recordSuccess("key-a", env.state.now, current.attempt);
    expect(gateway.health("key-a", env.state.now).successCount).toBe(1);
  });

  it("honours Retry-After in preference to the computed backoff", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);

    const parked = gateway.recordFailure(
      "key-a",
      classifyFailure({ status: 429, retryAfterMs: 45_000 }),
      env.state.now,
    );
    // The provider knows its window; guessing 1.5s and hammering it back is worse.
    expect(parked.cooldownRemainingMs).toBe(45_000);
    expect(parked.lastRetryAfterMs).toBe(45_000);

    env.advance(44_999);
    expect(gateway.health("key-a", env.state.now).state).toBe("cooling");
    env.advance(2);
    expect(gateway.health("key-a", env.state.now).state).toBe("healthy");
  });

  it("still bounds a Retry-After that claims a day-long reset", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway({ ...env.options, maxCooldownMs: 300_000 });
    gateway.register(["key-a"]);

    const parked = gateway.recordFailure(
      "key-a",
      classifyFailure({ status: 429, retryAfterMs: 24 * 60 * 60 * 1000 }),
      env.state.now,
    );
    expect(parked.cooldownRemainingMs).toBe(300_000);
  });

  it("falls back to the computed backoff when Retry-After is absent or nonsense", () => {
    // Zero, negative and NaN must all degrade to a real wait, never to "free" or "gone". A
    // fresh gateway per case, so each one is the *first* parking and the expected backoff is
    // the same 2000 × 0.75 rather than a compounding streak.
    for (const retryAfterMs of [0, -5000, Number.NaN]) {
      const env = fixedEnv();
      const gateway = new ProviderGateway(env.options);
      gateway.register(["key-a"]);
      const parked = gateway.recordFailure(
        "key-a",
        classifyFailure({ status: 429, retryAfterMs }),
        env.state.now,
      );
      expect(parked.cooldownRemainingMs).toBe(1500);
      expect(parked.state).toBe("cooling");
    }
  });

  it("leaves the credential untouched for a provider outage and for a bad request", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);

    for (const failure of [{ status: 503 }, { status: 400 }]) {
      const after = gateway.recordFailure("key-a", classifyFailure(failure), env.state.now);
      expect(after.state).toBe("healthy");
      // Not "parked for a bit", not "counted neutrally" — untouched. A record that accumulates
      // the provider's weather describes the weather, not the key.
      expect(after.failureCount).toBe(0);
      expect(after.lastFailureAt).toBeUndefined();
    }
  });

  it("counts an unclassifiable failure without parking it", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);

    const after = gateway.recordFailure("key-a", classifyFailure({}), env.state.now);
    expect(after.state).toBe("healthy");
    expect(after.failureCount).toBe(1);
  });

  it("keeps a credential's health across a pool reload", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);
    gateway.recordFailure("key-a", classifyFailure({ status: 401 }), env.state.now);

    // A settings save re-registers the pool. Resetting here would clear every cooldown exactly
    // when somebody is editing the key list.
    gateway.register(["key-a", "key-b"]);
    expect(gateway.health("key-a", env.state.now).state).toBe("disabled");
    expect(gateway.size).toBe(2);
  });
});

describe("ProviderGateway.select", () => {
  it("rotates round-robin over a stable, sorted order", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    // Registered out of order on purpose: the rotation is over the sorted ids, so the same
    // pool always produces the same sequence regardless of how it was configured.
    gateway.register(["key-c", "key-a", "key-b"]);

    const picks = [0, 1, 2].map(() => {
      const result = gateway.select(env.state.now);
      expect(result.status).toBe("selected");
      return result.status === "selected" ? result.credentialId : "";
    });
    expect(picks).toEqual(["key-a", "key-b", "key-c"]);
  });

  it("skips a cooling credential without consuming a turn", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a", "key-b", "key-c"]);
    gateway.recordFailure("key-b", classifyFailure({ status: 429 }), env.state.now);

    const first = gateway.select(env.state.now);
    expect(first).toMatchObject({ status: "selected", credentialId: "key-a" });
    // The skipped key is reported, with the reason and how long is left.
    expect(first.status === "selected" ? first.skipped : []).toContainEqual({
      credentialId: "key-b",
      state: "cooling",
      cooldownRemainingMs: 1500,
    });

    // Skipping must not advance the cursor past a second usable key: key-c is next, not key-c
    // then key-c again. If a cooling key consumed a turn, the rotation rate would double for
    // every healthy key while one was throttled.
    const second = gateway.select(env.state.now);
    expect(second).toMatchObject({ status: "selected", credentialId: "key-c" });
    const third = gateway.select(env.state.now);
    expect(third).toMatchObject({ status: "selected", credentialId: "key-a" });
  });

  it("re-enters the rotation the moment the window lapses", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a", "key-b"]);
    gateway.recordFailure("key-a", classifyFailure({ status: 429 }), env.state.now);
    env.advance(1501);

    const picks = [0, 1, 2].map(() => {
      const r = gateway.select(env.state.now);
      return r.status === "selected" ? r.credentialId : "";
    });
    expect(picks).toEqual(["key-a", "key-b", "key-a"]);
  });

  it("says so when the pool is empty", () => {
    const gateway = new ProviderGateway();
    expect(gateway.select(0)).toEqual({
      status: "exhausted",
      reason: "no_credentials",
      cooldownRemainingMs: 0,
      skipped: [],
    });
  });

  it("says so when every credential is cooling, and when it will be worth retrying", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a", "key-b"]);
    gateway.recordFailure(
      "key-a",
      classifyFailure({ status: 429, retryAfterMs: 10_000 }),
      env.state.now,
    );
    gateway.recordFailure(
      "key-b",
      classifyFailure({ status: 429, retryAfterMs: 4_000 }),
      env.state.now,
    );

    const result = gateway.select(env.state.now);
    expect(result.status).toBe("exhausted");
    if (result.status !== "exhausted") throw new Error("expected exhaustion");
    expect(result.reason).toBe("all_cooling");
    // The earliest one, not the latest: a caller asking "may I wait?" wants the first chance.
    expect(result.cooldownRemainingMs).toBe(4000);
    expect(result.retryAt).toBe(env.state.now + 4000);
    expect(result.skipped).toHaveLength(2);
  });

  it("says so when every credential is disabled, with no retry to offer", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a", "key-b"]);
    gateway.recordFailure("key-a", classifyFailure({ status: 401 }), env.state.now);
    gateway.recordFailure("key-b", classifyFailure({ status: 401 }), env.state.now);

    const result = gateway.select(env.state.now);
    expect(result).toMatchObject({ status: "exhausted", reason: "all_disabled" });
    expect(result.status === "exhausted" && result.retryAt).toBeUndefined();
  });

  it("never returns a cooling credential, because that is how one 429 becomes a storm", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);
    const parked = gateway.recordFailure("key-a", classifyFailure({ status: 429 }), env.state.now);

    // Every step stays strictly inside the 1500ms window (10 × 100 = 1000), so this asks the
    // real question: is a cooling key ever handed back while it is cooling?
    for (let i = 0; i < 10; i++) {
      env.advance(100);
      expect(gateway.select(env.state.now).status).toBe("exhausted");
    }
    // And it comes back on its own, without anybody having to clear it.
    env.advance(500);
    expect(gateway.select(env.state.now).status).toBe("selected");
    expect(parked.state).toBe("cooling");
  });
});

describe("jitter", () => {
  it("stays inside its band and never exceeds the maximum wait", () => {
    // The band is [1 - 0.25, 1 + 0.25] of the raw backoff, so with the base at 2000 the three
    // pinned sources land on 1500 / 2000 / 2499. (2499, not 2500: 0.999 is the largest value
    // `Math.random` can return, and 0.75 + 2·0.25·0.999 is 1.2495.)
    for (const [random, expected] of [
      [0, 1500],
      [0.5, 2000],
      [0.999, 2499],
    ] as const) {
      const state = { now: 1_000_000 };
      const gateway = new ProviderGateway({ now: () => state.now, random: () => random });
      gateway.register(["key-a"]);
      const parked = gateway.recordFailure("key-a", classifyFailure({ status: 429 }), state.now);
      expect(parked.cooldownRemainingMs).toBe(expected);
    }
  });

  it("spreads a fleet that fails together, so they do not retry in lockstep", () => {
    // The point of jitter: the same failure at the same instant must not produce the same
    // cooldown for every credential, or the whole pool comes back at once.
    const state = { now: 1_000_000 };
    let calls = 0;
    const gateway = new ProviderGateway({
      now: () => state.now,
      random: () => {
        calls += 1;
        return calls / 10;
      },
    });
    gateway.register(["key-a", "key-b", "key-c"]);

    const waits = ["key-a", "key-b", "key-c"].map(
      (id) =>
        gateway.recordFailure(id, classifyFailure({ status: 429 }), state.now).cooldownRemainingMs,
    );
    expect(new Set(waits).size).toBe(3);
  });

  it("keeps a long streak under the maximum wait even with the widest jitter", () => {
    const state = { now: 1_000_000 };
    const gateway = new ProviderGateway({ now: () => state.now, random: () => 0.999 });
    gateway.register(["key-a"]);
    for (let i = 0; i < 20; i++) {
      state.now += 120_000;
      gateway.recordFailure("key-a", classifyFailure({ status: 429 }), state.now);
    }
    const health = gateway.health("key-a", state.now);
    expect(health.cooldownRemainingMs).toBeLessThanOrEqual(DEFAULT_BACKOFF_OPTIONS.maxCooldownMs);
  });
});

describe("collectFailure", () => {
  it("reads a status, code and type through a cause chain", () => {
    const transport = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const sdk = Object.assign(new Error("Bad Request"), {
      status: 400,
      error: { code: "invalid_api_key", type: "authentication_error" },
      cause: transport,
    });
    expect(collectFailure(sdk)).toEqual({
      status: 400,
      code: "invalid_api_key",
      type: "authentication_error",
    });
  });

  it("survives a cycle in the cause chain", () => {
    const a: Record<string, unknown> = { status: 429, code: "rate_limit_exceeded" };
    const b: Record<string, unknown> = { cause: a };
    a["cause"] = b;
    expect(collectFailure(b)).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
  });

  it("parses Retry-After as seconds, as an HTTP date, and from a body field", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");

    expect(
      collectFailure(
        { status: 429, headers: { get: (n: string) => (n === "retry-after" ? "30" : null) } },
        now,
      ),
    ).toMatchObject({ retryAfterMs: 30_000 });
    expect(collectFailure({ status: 429, headers: { "retry-after": "12" } }, now)).toMatchObject({
      retryAfterMs: 12_000,
    });

    // The HTTP-date form needs the caller's clock, which is exactly why `collectFailure` takes
    // one. `toUTCString` drops sub-second precision, so 20s lands on a whole 20_000ms.
    const dated = collectFailure(
      { status: 429, headers: { get: () => new Date(now + 20_000).toUTCString() } },
      now,
    );
    expect(dated.retryAfterMs).toBe(20_000);
    // A date already in the past degrades to "retry now", not to a negative or absurd wait.
    expect(
      collectFailure(
        { status: 429, headers: { get: () => new Date(now - 60_000).toUTCString() } },
        now,
      ).retryAfterMs,
    ).toBe(0);

    expect(collectFailure({ status: 429, error: { reset_after: 90 } }, now)).toMatchObject({
      retryAfterMs: 90_000,
    });
  });

  it("returns nothing rather than guessing when the error carries no structure", () => {
    expect(collectFailure(new Error("boom"))).toEqual({});
    expect(collectFailure("a bare string")).toEqual({});
    expect(collectFailure(undefined)).toEqual({});
  });
});

describe("shadow mode", () => {
  function capture() {
    const records: ShadowRecord[] = [];
    return { records, sink: (r: ShadowRecord) => records.push(r) };
  }

  it("reports both verdicts and agrees on the structured cases", () => {
    const { records, sink } = capture();
    const { record } = observeFailure(
      { failure: { status: 401 }, legacy: LEGACY_ACTION.Evict },
      { sink },
    );
    expect(record).toMatchObject({
      legacy: LEGACY_ACTION.Evict,
      kind: FAILURE_KIND.CredentialRejected,
      recovery: RECOVERY.Disable,
      agrees: true,
      evidence: "status-401",
      status: 401,
    });
    expect(records).toHaveLength(1);
  });

  it("changes no state — the old pools are still the ones deciding", () => {
    const env = fixedEnv();
    const gateway = new ProviderGateway(env.options);
    gateway.register(["key-a"]);
    const before = gateway.health("key-a", env.state.now);

    // A 429, reported against the cool_down the call site just performed. If the shadow were
    // doing anything at all, this is where it would show.
    observeFailure(
      { failure: { status: 429 }, legacy: LEGACY_ACTION.CoolDown },
      { sink: () => {} },
    );

    expect(gateway.health("key-a", env.state.now)).toEqual(before);
  });

  it("never logs a credential, because the caller has to be able to paste a line into a bug report", () => {
    const { records, sink } = capture();
    observeFailure(
      { failure: { status: 401 }, legacy: LEGACY_ACTION.Evict, provider: "https://api.x.test" },
      { sink },
    );
    expect(JSON.stringify(records[0])).not.toMatch(/sk-|Bearer|apiKey/);
    expect(records[0]?.provider).toBe("https://api.x.test");
  });
});

describe("shadow wiring in the real catch chain", () => {
  // The unit tests above prove the vocabulary; this one proves the wiring, which is the part
  // that can silently rot: a renamed branch or a refactored catch would leave the vocabulary
  // perfect and the shadow log empty, and "no `agrees=false` lines" would then be evidence of
  // nothing. So this drives the *actual* `streamGenerate` catch through the `openStream` seam
  // that the existing outcome-classification tests use — no network, no mock of the code under
  // test, and the same code path a real 401 takes.
  class SeamModel extends GenerativeModel {
    constructor(
      private readonly source: () => AsyncIterable<UniEvent>,
      apiKey: string,
    ) {
      super({ modelId: "claude-sonnet-4-6", tools: [], apiKey, baseUrl: "https://api.test/v1" });
    }
    protected override openStream(): AsyncIterable<UniEvent> {
      return this.source();
    }
  }

  async function drive(model: GenerativeModel): Promise<unknown> {
    const gen = model.streamGenerate({ newMessages: [userText("go")] });
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    return res.value;
  }

  it("emits one line per failure, carrying both the old and the new verdict", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const model = new SeamModel(async function* () {
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      }, "sk-live-looking-secret-value");

      // The old chain still decides: a 401 evicts the key, which is why this model is fatal.
      const outcome = await drive(model);
      expect(outcome).toMatchObject({ status: "fatal", errorCode: "auth" });

      const shadow = lines.filter((l) => l.startsWith("[provider-gateway/shadow]"));
      expect(shadow).toHaveLength(1);
      expect(shadow[0]).toContain("legacy=evict");
      expect(shadow[0]).toContain("kind=credential_rejected");
      expect(shadow[0]).toContain("agrees=true");
      // The provider is identified; the credential is not, because the credential is the secret.
      expect(shadow[0]).toContain("https://api.test/v1");
      expect(shadow[0]).not.toContain("sk-live-looking-secret-value");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a provider outage as a disagreement, which is the finding the release exists for", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const model = new SeamModel(async function* () {
        throw Object.assign(new Error("service unavailable"), { status: 503 });
      }, "sk-second-secret");

      // A 503 is retryable and the old chain marks the credential "other" — the enumerated
      // divergence, observed through the real path rather than asserted in a table.
      const outcome = await drive(model);
      expect(outcome).toMatchObject({ status: "retryable", errorCode: "network" });

      const shadow = lines.find((l) => l.startsWith("[provider-gateway/shadow]"));
      expect(shadow).toContain("legacy=observe");
      expect(shadow).toContain("kind=provider_unavailable");
      expect(shadow).toContain("recovery=ignore");
      expect(shadow).toContain("agrees=false");
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The acceptance harness for the flip. Every row is a real error shape the current code
 * produces, run through both the new vocabulary and the action the old call site takes.
 *
 * Rows in `agrees` are the ones where a flip would change nothing. Rows in
 * `KNOWN_DIVERGENCES` are the ones where it would, each with the reason it is acceptable.
 * **A disagreement that is not in this table is a finding** — it means the vocabulary is
 * missing a provider shape or the evidence collector is not reading a field the old
 * classifier did. Fix the collector; never the old branch.
 */
type Row = { name: string; failure: ProviderFailure; legacy: LegacyAction; reason: string };

const AGREEING: Array<{ name: string; failure: ProviderFailure; legacy: LegacyAction }> = [
  {
    name: "401 with an invalid-key code",
    failure: { status: 401, code: "invalid_api_key" },
    legacy: LEGACY_ACTION.Evict,
  },
  { name: "bare 401", failure: { status: 401 }, legacy: LEGACY_ACTION.Evict },
  { name: "429", failure: { status: 429 }, legacy: LEGACY_ACTION.CoolDown },
  {
    name: "429 with a rate-limit code",
    failure: { status: 429, code: "rate_limit_exceeded" },
    legacy: LEGACY_ACTION.CoolDown,
  },
  {
    name: "403 with a quota code (SDK mislabelled as a permission error)",
    failure: { status: 403, code: "insufficient_user_quota" },
    legacy: LEGACY_ACTION.CoolDown,
  },
  {
    name: "bare 403 — fatal, nothing recorded against the key",
    failure: { status: 403 },
    legacy: LEGACY_ACTION.None,
  },
  {
    name: "400 — a bad request is not a credential fact",
    failure: { status: 400 },
    legacy: LEGACY_ACTION.None,
  },
  { name: "404", failure: { status: 404 }, legacy: LEGACY_ACTION.None },
  // A network drop with no status at all: Unknown → observe, the same action the old `else`
  // branch took. It is here, in the agreeing set, because the kind names differ while the
  // action does not — which is precisely why the comparison is made at the action level.
  { name: "a network drop with no status at all", failure: {}, legacy: LEGACY_ACTION.Observe },
];

const KNOWN_DIVERGENCES: Row[] = [
  {
    name: "503 from a provider that is down",
    failure: { status: 503 },
    legacy: LEGACY_ACTION.Observe,
    reason:
      "Intentional. The old `else` branch recorded a failure against the credential for every " +
      "5xx; the provider's outage is not a fact about the key and the same 503 will hit every " +
      "credential in the pool. Ignoring it is the improvement this vocabulary exists for.",
  },
  {
    name: "500 (same reasoning, pinned separately so a 502-only regression is visible)",
    failure: { status: 500 },
    legacy: LEGACY_ACTION.Observe,
    reason: "Same as 503: provider-side, not credential-side.",
  },
  {
    name: "529 overloaded",
    failure: { status: 529 },
    legacy: LEGACY_ACTION.Observe,
    reason:
      "Same as 503: a capacity signal from the provider, not a fact about the credential. " +
      "Pinned as its own row so a regression that only affects 529 is still visible.",
  },
  {
    name: "408 request timeout",
    failure: { status: 408 },
    legacy: LEGACY_ACTION.Observe,
    reason:
      "A transport event: the provider never finished reading the request. Marking the " +
      "credential for a timeout it did not cause is how a pool poisons itself under load.",
  },
  {
    name: "a provider that only ever signals throttling in prose",
    failure: { code: "some_unmapped_provider_error" },
    legacy: LEGACY_ACTION.CoolDown,
    reason:
      "The intended shape of the gap. The old classifier read /usage limit reached/i against " +
      "this same error and cooled the key; this one has no prose to read and lands on Unknown → " +
      "observe. It is enumerated because a provider added to the closed code set resolves it — " +
      "a one-line edit to a declared set, not a change to any branch — and because until then " +
      "the honest answer is that we do not know what this error was.",
  },
];

describe("shadow acceptance corpus", () => {
  it("agrees on every structured case the old classifier handles", () => {
    for (const row of AGREEING) {
      const { record } = observeFailure(
        { failure: row.failure, legacy: row.legacy },
        { sink: () => {} },
      );
      expect(record.agrees, `${row.name}: legacy=${row.legacy} recovery=${record.recovery}`).toBe(
        true,
      );
    }
  });

  it("disagrees on exactly the enumerated cases, and only those", () => {
    for (const row of KNOWN_DIVERGENCES) {
      const { record } = observeFailure(
        { failure: row.failure, legacy: row.legacy },
        { sink: () => {} },
      );
      expect(record.agrees, `${row.name} should be an enumerated divergence`).toBe(false);
      // Every divergence carries its reason, so the enumeration cannot rot into a shrug.
      expect(row.reason.length).toBeGreaterThan(40);
    }
  });

  it("leaves no unenumerated disagreement for a reviewer to discover in production", () => {
    // The number a reviewer greps for. If this test fails, a provider shape appeared that the
    // release notes do not explain, and the flip is not ready.
    const enumerated = new Set(KNOWN_DIVERGENCES.map((row) => row.name));
    const unexpected = AGREEING.filter(
      (row) =>
        !observeFailure({ failure: row.failure, legacy: row.legacy }, { sink: () => {} }).record
          .agrees && !enumerated.has(row.name),
    );
    expect(unexpected.map((r) => r.name)).toEqual([]);
  });
});
