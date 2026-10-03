import { describe, expect, it } from "vitest";
import {
  graceWindow,
  parseProviderDelay,
  parseRetryAfter,
  parseStructuredDelay,
  parseTextDelay,
} from "../../src/llm/retry-delay.js";

describe("retry delay parsing", () => {
  it("parses Retry-After seconds and HTTP dates with a safety buffer", () => {
    expect(parseRetryAfter("2.5")).toEqual({
      rawMs: 2500,
      source: "header",
      bufferedMs: 2700,
    });

    const dateDelay = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
    expect(dateDelay?.source).toBe("header");
    expect(dateDelay?.rawMs).toBeGreaterThan(3000);
    expect(dateDelay?.rawMs).toBeLessThanOrEqual(5000);
    expect(dateDelay?.bufferedMs).toBe(dateDelay!.rawMs + 200);
  });

  it("caps provider retry waits at 60 seconds", () => {
    expect(parseRetryAfter("90")).toEqual({
      rawMs: 90_000,
      source: "header",
      bufferedMs: 60_000,
    });
    expect(parseTextDelay("retry in 1h16m0.667s")?.bufferedMs).toBe(60_000);
  });

  it.each(["", "0", "-1", "NaN", "tomorrow", "Infinity"])(
    "rejects invalid Retry-After value %j",
    (value) => {
      expect(parseRetryAfter(value)).toBeNull();
    },
  );

  it("finds separator-insensitive structured keys through nested provider bodies", () => {
    const delay = parseStructuredDelay({
      response: {
        data: {
          error: {
            details: [{ retry_delay: "1.5s" }],
          },
        },
      },
    });

    expect(delay).toEqual({
      rawMs: 1500,
      source: "structured",
      bufferedMs: 1700,
    });
  });

  it("walks at most eight nested levels and tolerates circular bodies", () => {
    let eightLevels: unknown = { RetryAfter: "2s" };
    for (let i = 0; i < 8; i += 1) eightLevels = { cause: eightLevels };
    expect(parseStructuredDelay(eightLevels)?.rawMs).toBe(2000);

    let nineLevels: unknown = { RetryAfter: "2s" };
    for (let i = 0; i < 9; i += 1) nineLevels = { cause: nineLevels };
    expect(parseStructuredDelay(nineLevels)).toBeNull();

    const circular: Record<string, unknown> = { retry_after: "3s" };
    circular.self = circular;
    expect(parseStructuredDelay(circular)?.rawMs).toBe(3000);
  });

  it("uses header, then structured data, then text as delay sources", () => {
    const headerWins = Object.assign(new Error("retry in 9s"), {
      response: {
        headers: new Headers({ "retry-after": "2" }),
        data: { retryDelay: "4s" },
      },
    });
    expect(parseProviderDelay(headerWins)).toEqual({
      rawMs: 2000,
      source: "header",
      bufferedMs: 2200,
    });

    const structuredWins = Object.assign(new Error("retry in 9s"), {
      response: { data: { retry_after: "4s" } },
    });
    expect(parseProviderDelay(structuredWins)).toEqual({
      rawMs: 4000,
      source: "structured",
      bufferedMs: 4200,
    });

    expect(parseProviderDelay(new Error("retry in 1h16m0.667s"))).toEqual({
      rawMs: 4_560_667,
      source: "text",
      bufferedMs: 60_000,
    });
  });

  it("parses compound durations in text and ignores text without a duration", () => {
    expect(parseTextDelay("quota exhausted; retry in 1h16m0.667s")).toEqual({
      rawMs: 4_560_667,
      source: "text",
      bufferedMs: 60_000,
    });
    expect(parseTextDelay("retry when capacity is available")).toBeNull();
  });

  it("falls back when a provider supplies a nonsense Retry-After value", () => {
    const error = Object.assign(new Error("rate limit exceeded"), {
      response: { headers: { "Retry-After": "not-a-time" } },
    });
    expect(parseProviderDelay(error)).toBeNull();
  });

  it("classifies only positive buffered delays up to five seconds as a grace window", () => {
    expect(graceWindow({ rawMs: 4800, source: "header", bufferedMs: 5000 })).toBe(true);
    expect(graceWindow({ rawMs: 4801, source: "header", bufferedMs: 5001 })).toBe(false);
    expect(graceWindow({ rawMs: 0, source: "header", bufferedMs: 0 })).toBe(false);
    expect(graceWindow({ rawMs: -1, source: "text", bufferedMs: Number.NaN })).toBe(false);
  });
});
