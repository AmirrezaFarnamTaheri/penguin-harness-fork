/**
 * Quota / auth / overload classification, reset-window parsing, and cooldowns.
 *
 * `detectQuotaExhaustion` is the input to key rotation and to the combo cascade's fallback
 * triggers (model-combos.ts reads `isQuota` and `isAuthenticationFailure` first), so a pattern
 * that silently stops matching a provider's 429 wording turns a backoff into a hard failure.
 * Each table below is exercised case by case — including the cases the tables do NOT cover,
 * which are pinned so the gap is visible instead of latent.
 *
 * `parseResetDuration` returns seconds and `parseDurationToMs` returns milliseconds; both are
 * asserted at their own units.
 */
import { describe, expect, it } from "vitest";
import {
  CooldownRegistry,
  DEFAULT_COOLDOWN_SEC,
  detectQuotaExhaustion,
  formatDurationMs,
  parseDurationToMs,
  parseResetDuration,
} from "../../src/llm/quota-parser.js";

describe("parseResetDuration", () => {
  it("converts h/m/s components to seconds", () => {
    expect(parseResetDuration("1h30m")).toBe(5400);
    expect(parseResetDuration("2h")).toBe(7200);
    expect(parseResetDuration("30m")).toBe(1800);
    expect(parseResetDuration("45s")).toBe(45);
    expect(parseResetDuration("1h0m0s")).toBe(3600);
    expect(parseResetDuration("  1h  ")).toBe(3600);
  });

  it("returns undefined when no component is present", () => {
    expect(parseResetDuration("")).toBeUndefined();
  });

  it("treats an all-zero window as 0 seconds, not as an absent window", () => {
    // The groups are non-empty strings, so the "nothing matched" guard does not trip: "0h0m0s"
    // parses to a real 0. Callers that conflate 0 with undefined would treat an expired limit as
    // an unknown one.
    expect(parseResetDuration("0h0m0s")).toBe(0);
    expect(parseResetDuration("0s")).toBe(0);
  });

  it("rejects malformed windows", () => {
    expect(parseResetDuration("abc")).toBeUndefined();
    // Anchored at both ends, so trailing text defeats it.
    expect(parseResetDuration("1h30m extra")).toBeUndefined();
    expect(parseResetDuration("1.5h")).toBeUndefined();
    expect(parseResetDuration("-30m")).toBeUndefined();
  });
});

describe("parseDurationToMs", () => {
  it("converts h/m/s windows and bare positive numbers to milliseconds", () => {
    expect(parseDurationToMs("1h30m")).toBe(5_400_000);
    expect(parseDurationToMs("60")).toBe(60_000);
  });

  it("returns undefined for empty, zero, and non-numeric text", () => {
    expect(parseDurationToMs("")).toBeUndefined();
    // The bare-number branch requires rawNum > 0, so a literal 0 is not a window.
    expect(parseDurationToMs("0")).toBeUndefined();
    expect(parseDurationToMs("soon")).toBeUndefined();
  });
});

describe("detectQuotaExhaustion: quota patterns", () => {
  const quotaMessages: readonly string[] = [
    "RESOURCE_EXHAUSTED",
    "rate_limit_exceeded",
    "quota_exceeded",
    "insufficient_quota",
    "too many requests",
    "HTTP 429",
    "exceeded your current quota",
    "usage limit reached",
    "tokens per minute exceeded",
    "requests per minute exceeded",
    "requests per day exceeded",
  ];

  it("classifies every quota wording as a quota failure", () => {
    for (const message of quotaMessages) {
      const result = detectQuotaExhaustion(message);
      expect(result.isQuota, message).toBe(true);
      expect(result.isAuthenticationFailure, message).toBe(false);
      expect(result.reason, message).toBe("Rate limit or quota exhausted");
    }
  });

  it("reports a default 60s reset when the message carries no window", () => {
    // No "Resets in", no retry-after, no reset_after: the parser still has to give the caller a
    // backoff to sleep, so it falls back to 60s.
    const result = detectQuotaExhaustion("quota_exceeded");
    expect(result.resetMs).toBe(60_000);
    expect(result.resetText).toBe("60s");
  });

  it("matches the literal 429 even inside prose, which is a real over-match", () => {
    // \b429\b is a word boundary, not a HTTP-status check, so any prose containing the number
    // classifies as a quota failure. Pinned as current behaviour.
    const result = detectQuotaExhaustion("your booking for room 429 is confirmed");
    expect(result.isQuota).toBe(true);
    expect(result.isAuthenticationFailure).toBe(false);
  });

  it("does not match 429 when it is part of a longer number", () => {
    // The word boundary is what saves this: 4291 has no boundary after the 9.
    const result = detectQuotaExhaustion("booking reference 42912 confirmed");
    expect(result.isQuota).toBe(false);
    expect(result.isAuthenticationFailure).toBe(false);
    expect(result.isOverloaded).toBe(false);
    expect(result.isContextLengthExceeded).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("does not classify an unrelated transient error as a quota failure", () => {
    const result = detectQuotaExhaustion("connection reset by peer");
    expect(result.isQuota).toBe(false);
    expect(result.isAuthenticationFailure).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

describe("detectQuotaExhaustion: authentication patterns", () => {
  const authMessages: readonly string[] = [
    "invalid_api_key",
    "authentication_error",
    "unauthorized",
    "HTTP 401",
    "incorrect api key",
    "permission denied",
  ];

  it("classifies every auth wording as an authentication failure", () => {
    for (const message of authMessages) {
      const result = detectQuotaExhaustion(message);
      expect(result.isAuthenticationFailure, message).toBe(true);
      expect(result.isQuota, message).toBe(false);
      expect(result.reason, message).toBe("Authentication error / invalid API key");
      // An auth failure carries no reset window: there is nothing to sleep off.
      expect(result.resetMs, message).toBeUndefined();
    }
  });
});

describe("detectQuotaExhaustion: overload patterns", () => {
  const overloadMessages: readonly string[] = [
    "the model is overloaded, please retry",
    "overloading",
    "temporarily unavailable",
    "service unavailable: 503",
    "server busy right now",
    "HTTP 529",
  ];

  it("classifies every overload wording as overloaded without marking it a quota failure", () => {
    for (const message of overloadMessages) {
      const result = detectQuotaExhaustion(message);
      expect(result.isOverloaded, message).toBe(true);
      expect(result.isQuota, message).toBe(false);
      expect(result.isAuthenticationFailure, message).toBe(false);
      expect(result.reason, message).toBe("Provider overloaded or temporarily unavailable");
      expect(result.resetMs, message).toBeUndefined();
    }
  });
});

describe("detectQuotaExhaustion: context-length patterns", () => {
  const contextMessages: readonly string[] = [
    "context_length_exceeded",
    "maximum context length exceeded",
    "max tokens exceeded",
    "too many tokens",
    "this exceeds the context window limit",
  ];

  it("classifies context-length wording without escalating it to a quota failure", () => {
    for (const message of contextMessages) {
      const result = detectQuotaExhaustion(message);
      expect(result.isContextLengthExceeded, message).toBe(true);
      expect(result.isQuota, message).toBe(false);
      expect(result.reason, message).toBe("Context length exceeded");
    }
  });

  it("does not classify wording the table does not reach", () => {
    // /context[_\s-]*(?:length|window)/ needs "length" or "window" after "context"; a bare
    // "context too long" matches nothing. Gap, not a feature.
    const result = detectQuotaExhaustion("context too long");
    expect(result.isContextLengthExceeded).toBe(false);
    expect(result.isQuota).toBe(false);
  });
});

describe("detectQuotaExhaustion: precedence", () => {
  it("prefers authentication over quota when a message matches both", () => {
    // The auth branch returns first, so a 401 that also mentions the rate limit is treated as
    // a key problem — the right call, since sleeping off a window will not fix a bad key.
    const result = detectQuotaExhaustion(
      "401 unauthorized: invalid_api_key, rate_limit_exceeded and quota_exceeded",
    );
    expect(result.isAuthenticationFailure).toBe(true);
    expect(result.isQuota).toBe(false);
    expect(result.reason).toBe("Authentication error / invalid API key");
    expect(result.resetMs).toBeUndefined();
  });

  it("still reports the overload flag when an auth failure is the verdict", () => {
    // isQuota is what the branch suppresses; the overload/context signals are computed before it.
    const result = detectQuotaExhaustion("401 unauthorized, service is overloaded");
    expect(result.isAuthenticationFailure).toBe(true);
    expect(result.isQuota).toBe(false);
    expect(result.isOverloaded).toBe(true);
  });

  it("prefers the reset window over the retry-after header when both are present", () => {
    // RESET_DURATION_RE is tried first, so "Resets in 1h" wins over the 30s retry-after.
    const result = detectQuotaExhaustion("RESOURCE_EXHAUSTED. Resets in 1h (retry-after: 30)");
    expect(result.isQuota).toBe(true);
    expect(result.resetMs).toBe(3_600_000);
    expect(result.resetText).toBe("1h");
  });
});

describe("detectQuotaExhaustion: reset window parsing", () => {
  it("reads 'Resets in <h><m><s>' as the window", () => {
    expect(detectQuotaExhaustion("RESOURCE_EXHAUSTED. Resets in 1h30m")).toEqual(
      expect.objectContaining({
        isQuota: true,
        resetMs: 5_400_000,
        resetText: "1h30m",
      }),
    );
    expect(detectQuotaExhaustion("429: too many requests. Resets in 45s")).toEqual(
      expect.objectContaining({ resetMs: 45_000, resetText: "45s" }),
    );
  });

  it("reads a retry-after header in seconds", () => {
    expect(detectQuotaExhaustion("too many requests, retry-after: 30")).toEqual(
      expect.objectContaining({ resetMs: 30_000, resetText: "30s" }),
    );
    expect(detectQuotaExhaustion("quota_exceeded, retry-after: 90")).toEqual(
      expect.objectContaining({ resetMs: 90_000 }),
    );
  });

  it("reads a reset_after field in seconds, including a fractional one", () => {
    expect(detectQuotaExhaustion("insufficient_quota reset_after: 45")).toEqual(
      expect.objectContaining({ resetMs: 45_000, resetText: "45s" }),
    );
    expect(detectQuotaExhaustion("429 reset_after 12.5s")).toEqual(
      expect.objectContaining({ resetMs: 12_500, resetText: "12.5s" }),
    );
  });

  it("parses no window from a message that carries one but is not a quota failure", () => {
    // "Rate limit exceeded" is written in spaces, and the table only lists the underscored
    // `rate_limit_exceeded`, so this message matches no pattern at all — and the reset regexes
    // below are only reached from inside the quota branch. A provider that sends this wording
    // gets neither a quota verdict nor its own backoff window.
    const result = detectQuotaExhaustion("Rate limit exceeded. Resets in 1h30m");
    expect(result.isQuota).toBe(false);
    expect(result.resetMs).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });
});

describe("detectQuotaExhaustion: input shapes", () => {
  it("reads an Error's name and message", () => {
    // Errors are stringified as `${name}: ${message}`, so an error class name is part of the
    // scanned text.
    const result = detectQuotaExhaustion(new Error("RESOURCE_EXHAUSTED (code 429)"));
    expect(result.isQuota).toBe(true);
    expect(result.reason).toBe("Rate limit or quota exhausted");
    // An Error carries no code/status/statusCode field, so the code is absent.
    expect(result.code).toBeUndefined();
  });

  it("extracts a status code from a JSON body", () => {
    expect(detectQuotaExhaustion({ code: 429 })).toEqual(
      expect.objectContaining({ isQuota: true, code: 429 }),
    );
    expect(detectQuotaExhaustion({ status: 401 })).toEqual(
      expect.objectContaining({ isAuthenticationFailure: true, code: 401 }),
    );
    expect(detectQuotaExhaustion({ statusCode: 503 })).toEqual(
      expect.objectContaining({ isOverloaded: true, code: 503 }),
    );
  });

  it("carries the code through even when the classification is inconclusive", () => {
    expect(detectQuotaExhaustion({ code: 500 })).toEqual(
      expect.objectContaining({ isQuota: false, isAuthenticationFailure: false, code: 500 }),
    );
  });
});

describe("formatDurationMs", () => {
  it("formats a duration in h/m/s", () => {
    expect(formatDurationMs(900_000)).toBe("15m");
    expect(formatDurationMs(5_400_000)).toBe("1h 30m");
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(10_000_000)).toBe("2h 46m 40s");
  });

  it("collapses a non-positive duration to 0s", () => {
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(-1)).toBe("0s");
  });
});

describe("CooldownRegistry", () => {
  const start = 1_000_000;
  let now = start;
  const registry = () => new CooldownRegistry(() => now);

  it("defaults to DEFAULT_COOLDOWN_SEC when no window is given", () => {
    expect(DEFAULT_COOLDOWN_SEC).toBe(15 * 60);
    const models = registry();
    models.set("openai:gpt-4o");
    expect(models.cooling("openai:gpt-4o")).toBe(true);
    expect(models.describe("openai:gpt-4o")).toBe("15m");
    // The default window is exactly DEFAULT_COOLDOWN_SEC past `now`.
    now = start + DEFAULT_COOLDOWN_SEC * 1000 - 1;
    expect(models.cooling("openai:gpt-4o")).toBe(true);
    now = start + DEFAULT_COOLDOWN_SEC * 1000;
    expect(models.cooling("openai:gpt-4o")).toBe(false);
    expect(models.describe("openai:gpt-4o")).toBe("ready");
  });

  it("uses the reported window verbatim, including one larger than the default", () => {
    // set() substitutes the default; it does not clamp to it — a provider-reported window of
    // nearly three hours is honoured as-is, which is what a caller parsing "Resets in 2h46m40s"
    // needs.
    const models = registry();
    models.set("deepseek:deepseek-chat", 10_000);
    expect(models.describe("deepseek:deepseek-chat")).toBe("2h 46m 40s");
    expect(models.cooling("deepseek:deepseek-chat")).toBe(true);
  });

  it("treats a zero window as already expired", () => {
    // now + 0 equals now, and cooling() requires strictly greater than now.
    const models = registry();
    models.set("local:local-model", 0);
    expect(models.cooling("local:local-model")).toBe(false);
    expect(models.describe("local:local-model")).toBe("ready");
  });

  it("reports a model it has never seen as ready and not cooling", () => {
    const models = registry();
    expect(models.cooling("never-set")).toBe(false);
    expect(models.describe("never-set")).toBe("ready");
  });

  it("clears one model and the whole registry", () => {
    const models = registry();
    models.set("a");
    models.set("b");
    models.clear("a");
    expect(models.cooling("a")).toBe(false);
    expect(models.cooling("b")).toBe(true);
    models.clear();
    expect(models.cooling("b")).toBe(false);
  });
});
