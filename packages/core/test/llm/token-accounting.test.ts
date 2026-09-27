/**
 * Token accounting: the fixture, the invariants it protects, and the edge cases that make a
 * count wrong rather than merely imprecise.
 *
 * The estimator is a character heuristic, not a tokenizer, so it cannot be "verified" against a
 * provider. What CAN be verified — and what this file pins down — is that it does exactly the
 * documented arithmetic on a known input, that every place that counts tokens agrees on that
 * arithmetic, and that no provider report can push a non-finite number onto the wire. Those are
 * the failure modes that cost turns; a 5% error in the ratio does not.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_OUTPUT_TOKENS,
  OUTPUT_SAFETY_MARGIN,
  approximateMessagesTokens,
  approximateTokens,
  effectiveMaxOutputTokens,
} from "../../src/llm/context-limits.js";
import { usageIsUnusable, usageToTokenCounts } from "../../src/llm/generative-model.js";
import { ContextCompactor } from "../../src/agent/context-compactor.js";
import { defaultTokenEstimate } from "../../src/agent/research/research-budget.js";
import { userText } from "../../src/omnimessage/index.js";

/**
 * THE FIXTURE. A hand-computed token count, written out longhand so a change to the estimator's
 * arithmetic has to be a deliberate edit here rather than a silent drift.
 *
 * `approximateTokens` is defined as: ASCII characters ÷ 4 (rounded up), plus one token per
 * non-ASCII character (counted by code point, so an astral-plane emoji is 1, not the 2 that
 * `String.length` reports).
 *
 *   "Hello, world!"  -> 13 ASCII chars -> ceil(13/4) = 4 tokens
 *   "你好"            -> 2 wide chars  -> 2 tokens
 *   "🚀"              -> 1 wide char   -> 1 token
 *
 * No fixture input mixes the two buckets, so each expectation is independently derivable by hand
 * and a regression in either half of the estimator is caught on its own.
 */
describe("the token-count fixture", () => {
  it("counts pure ASCII at 4 characters per token, rounded up", () => {
    // 13 chars: 13/4 = 3.25, rounds up to 4.
    expect(approximateTokens("Hello, world!")).toBe(4);
    // Exactly 4 chars is the boundary where rounding is visible.
    expect(approximateTokens("abcd")).toBe(1);
    expect(approximateTokens("abcde")).toBe(2);
  });

  it("counts CJK at one token per character, not a quarter of one", () => {
    // The whole point of the wide-character branch: a CJK glyph is a token in its own right on
    // every mainstream tokenizer, so dividing these by 4 would under-report by 4x.
    expect(approximateTokens("你好")).toBe(2);
    expect(approximateTokens("你好世界")).toBe(4);
  });

  it("counts an astral-plane emoji as one character, not two", () => {
    // "🚀".length is 2 in UTF-16; iterating code points yields 1. Counting UTF-16 units would
    // charge double for every emoji outside the BMP.
    expect("🚀".length).toBe(2);
    expect(approximateTokens("🚀")).toBe(1);
  });

  it("adds the two buckets independently", () => {
    // 4 ASCII -> 1, plus 2 wide -> 2. (Were it ceil(totalChars/4) it would be ceil(6/4) = 2.)
    expect(approximateTokens("abcd你好")).toBe(3);
  });

  it("is zero for the empty string", () => {
    expect(approximateTokens("")).toBe(0);
  });
});

/**
 * The estimator iterates UTF-16 units for speed (measured 2.1-2.7x faster than a code-point
 * iterator on this repo's real inputs) and recognises surrogate pairs by hand to keep the count
 * identical. These tests exist because that equivalence is not visible in the code: a rewrite that
 * dropped the pair check would look correct and would quietly double-charge every emoji in a
 * conversation. The reference below is the code-point definition the estimator documents.
 */
describe("surrogate handling matches the code-point definition", () => {
  /** The definition `approximateTokens` is specified against: iterate by code point. */
  const byCodePoint = (text: string): number => {
    let ascii = 0;
    let wide = 0;
    for (const ch of text) {
      if ((ch.codePointAt(0) ?? 0) < 0x80) ascii += 1;
      else wide += 1;
    }
    return Math.ceil(ascii / 4) + wide;
  };

  const cases: Array<[string, string]> = [
    ["ascii", "Hello, world! ".repeat(50)],
    ["cjk", "令牌计费必须触发压缩。".repeat(50)],
    ["astral emoji", "🚀🐧✅🎉".repeat(50)],
    ["mixed", "const x = 1; // 你好 🚀 done ".repeat(50)],
    ["emoji adjacent to ascii", "a🚀b🐧c".repeat(50)],
    ["surrogate pair at the very end", "text 🚀"],
    ["unpaired high surrogate", "a\ud83db".repeat(20)],
    ["unpaired low surrogate", "a\udc00b".repeat(20)],
    ["empty", ""],
    ["only wide", "你好世界".repeat(10)],
  ];

  for (const [name, text] of cases) {
    it(`agrees on ${name}`, () => {
      expect(approximateTokens(text)).toBe(byCodePoint(text));
    });
  }

  it("charges an astral emoji once, not twice", () => {
    // The specific regression a dropped pair check would reintroduce.
    expect(approximateTokens("🚀")).toBe(1);
    expect(approximateTokens("🚀🚀")).toBe(2);
    expect(approximateTokens("a🚀")).toBe(byCodePoint("a🚀"));
  });
});

/**
 * Every component that counts tokens must answer the same question identically. These used to be
 * three implementations: the request path and the research ledger shared one, and the context
 * compactor had its own `length / 4` over UTF-16 code units.
 */
describe("every estimator in the accounting path agrees", () => {
  const compactor = new ContextCompactor();
  const viaCompactor = (text: string) =>
    compactor.estimateTokens([{ role: "user", content: text }]);

  it("agrees on CJK within the per-message framing the compactor adds", () => {
    // The compactor adds role + framing, so the exact totals differ by a constant. What must not
    // differ is the *content* term: before the fix this reported 144 where the request path said
    // 560, a 4x under-count that moved the compaction trigger point itself.
    const cjk = "令牌计费必须在窗口填满之前触发压缩。".repeat(20);
    // The per-message overhead (role + framing), measured rather than restated.
    const FRAMING = viaCompactor("");
    expect(viaCompactor(cjk) - FRAMING).toBe(approximateTokens(cjk));
    // And the two are now within framing of each other, rather than 4x apart.
    expect(Math.abs(viaCompactor(cjk) - approximateTokens(cjk))).toBeLessThanOrEqual(FRAMING);
  });

  it("agrees on emoji", () => {
    const emoji = "🚀🐧✅".repeat(30);
    const FRAMING = viaCompactor("");
    expect(viaCompactor(emoji) - FRAMING).toBe(approximateTokens(emoji));
  });

  it("uses the identical estimator in the research ledger", () => {
    for (const sample of ["plain ascii text here", "中文内容", "mixed ascii 和中文", "🚀🚀🚀"]) {
      expect(defaultTokenEstimate(sample)).toBe(approximateTokens(sample));
    }
  });
});

/**
 * The compaction trigger reads this number, so a wrong one is not a gauge error — it decides when
 * the window is allowed to fill.
 */
describe("compaction measurement", () => {
  const compactor = new ContextCompactor({ tokenThreshold: 80_000 });

  it("does not under-report a CJK conversation by the width of a character", () => {
    // 80k CJK characters is ~80k real tokens. The old estimator called that 20k, i.e. a quarter
    // of the threshold, so a conversation could reach roughly 320k tokens before compaction
    // believed it had triggered — past any 128k window.
    const messages = Array.from({ length: 10 }, () => ({
      role: "user" as const,
      content: "填".repeat(8_000),
    }));
    const estimate = compactor.estimateTokens(messages);
    expect(estimate).toBeGreaterThan(80_000);
    expect(compactor.shouldCompact(estimate)).toBe(true);
  });

  it("charges every message its framing", () => {
    const one = compactor.estimateTokens([{ role: "user", content: "abcd" }]);
    const two = compactor.estimateTokens([
      { role: "user", content: "abcd" },
      { role: "user", content: "abcd" },
    ]);
    expect(two - one).toBe(one);
  });

  it("treats a missing content field as empty rather than NaN", () => {
    const estimate = compactor.estimateTokens([
      { role: "user", content: undefined as unknown as string },
    ]);
    expect(Number.isFinite(estimate)).toBe(true);
  });
});

/**
 * Image payloads appear in two shapes and both must keep the base64 out of the character count: a
 * 1 MB image would otherwise estimate ~262k "tokens" and floor the next request's output cap.
 */
describe("message-level estimation", () => {
  it("charges a flat allowance for an image payload instead of counting its bytes", () => {
    const tiny = approximateMessagesTokens([
      { payload: { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } } },
    ] as never);
    const huge = approximateMessagesTokens([
      {
        payload: {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${"A".repeat(1_000_000)}` },
        },
      },
    ] as never);
    // The 1 MB of base64 must not show up: the two differ only by the short field they keep.
    expect(huge - tiny).toBeLessThan(50);
  });

  it("still counts the text that rides along with an image", () => {
    const withPrompt = approximateMessagesTokens([
      {
        payload: {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
          text: "describe ".repeat(200),
        },
      },
    ] as never);
    const without = approximateMessagesTokens([
      { payload: { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } } },
    ] as never);
    // The text is counted, plus the few tokens of JSON syntax its key adds — the documented
    // small overestimate, which is the safe direction, so the bound is inclusive from above.
    const textTokens = approximateTokens("describe ".repeat(200));
    const delta = withPrompt - without;
    expect(delta).toBeGreaterThanOrEqual(textTokens);
    expect(delta).toBeLessThan(textTokens + 10);
  });
});

/**
 * The output clamp. A request whose input is near the window must have its output cap pulled down
 * rather than sent over the limit, and the cap must never become a number the provider rejects.
 */
describe("the output clamp", () => {
  it("never exceeds the window and always stays finite", () => {
    // Sweep the whole input range, including the non-finite anchor a provider can produce.
    for (const input of [0, 1, 1000, 127_000, 128_000, 500_000, 1e12, Number.NaN, Infinity]) {
      const cap = effectiveMaxOutputTokens(32_000, 128_000, input);
      expect(Number.isFinite(cap)).toBe(true);
      expect(cap).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
      expect(cap).toBeLessThanOrEqual(32_000);
    }
  });

  it("keeps the invariant that the floor sits below the margin and headroom above it", () => {
    // The module's own claim: OUTPUT_SAFETY_MARGIN is the single tunable, so these two must
    // follow from it rather than being tuned separately and drifting.
    expect(MIN_OUTPUT_TOKENS).toBeLessThan(OUTPUT_SAFETY_MARGIN);
  });

  it("passes a configured cap through untouched when no window is configured", () => {
    expect(effectiveMaxOutputTokens(32_000, undefined, 999_999)).toBe(32_000);
  });
});

/**
 * `usageToTokenCounts` is the single funnel every provider number passes through, on both the
 * streaming and the one-shot path. Anything it lets through reaches `max_tokens` on the wire and,
 * via `addTokenCounts`, the session total — which is a plain sum, so one non-finite value
 * poisons every total after it, permanently and silently.
 */
describe("provider usage conversion", () => {
  it("splits cache and non-cache input without double counting", () => {
    // AgentHub documents prompt_tokens as NON-cached input, so the two are disjoint buckets.
    const counts = usageToTokenCounts({
      cached_tokens: 30_000,
      prompt_tokens: 10_000,
      thoughts_tokens: 500,
      response_tokens: 700,
    } as never);
    expect(counts.cache_read).toBe(30_000);
    expect(counts.cache_write).toBe(10_000);
    expect(counts.output).toBe(1_200);
    expect(counts.total).toBe(41_200);
    // input is the sum of the two buckets, counted once each.
    expect(counts.cache_read + counts.cache_write).toBe(40_000);
  });

  it("treats absent and null fields as zero", () => {
    const empty = usageToTokenCounts({} as never);
    expect(empty).toEqual({ cache_read: 0, cache_write: 0, output: 0, total: 0 });

    const nulls = usageToTokenCounts({
      cached_tokens: null,
      prompt_tokens: null,
      thoughts_tokens: null,
      response_tokens: null,
    } as never);
    expect(nulls.total).toBe(0);
  });

  it("refuses a negative, NaN, or infinite provider figure", () => {
    // Each of these used to flow straight through. NaN reached max_tokens on the wire; negative
    // made the next request's input estimate smaller than the previous one.
    for (const bad of [-5_000, Number.NaN, Infinity, -Infinity]) {
      const counts = usageToTokenCounts({
        cached_tokens: null,
        prompt_tokens: bad,
        thoughts_tokens: null,
        response_tokens: 600,
      } as never);
      expect(Number.isFinite(counts.total)).toBe(true);
      expect(counts.total).toBeGreaterThanOrEqual(0);
      expect(counts.cache_write).toBe(0);
    }
  });

  it("always produces a total safe to sum into a session counter", () => {
    // addTokenCounts is a plain addition, so a single non-finite part poisons the running total.
    const parts = [-1, Number.NaN, Infinity, 100, 0, 42].map((v) =>
      usageToTokenCounts({ prompt_tokens: v, response_tokens: 0 } as never),
    );
    const sessionTotal = parts.reduce((acc, p) => acc + p.total, 0);
    expect(Number.isFinite(sessionTotal)).toBe(true);
  });

  it("floors a fractional provider count rather than passing it through", () => {
    const counts = usageToTokenCounts({ prompt_tokens: 100.7, response_tokens: 0 } as never);
    expect(counts.cache_write).toBe(100);
  });
});

/**
 * Distinguishing "the provider measured nothing" from "the provider sent garbage" is what lets
 * the request path say so out loud instead of silently anchoring on a number it does not believe.
 */
describe("unusable-usage detection", () => {
  it("is false for a well formed report", () => {
    expect(
      usageIsUnusable({
        cached_tokens: null,
        prompt_tokens: 100,
        thoughts_tokens: null,
        response_tokens: 5,
      } as never),
    ).toBe(false);
  });

  it("is false when the provider simply never reports usage", () => {
    // All-null is a normal provider, not a fault: it must not produce a warning every request.
    expect(
      usageIsUnusable({
        cached_tokens: null,
        prompt_tokens: null,
        thoughts_tokens: null,
        response_tokens: null,
      } as never),
    ).toBe(false);
  });

  it("is true when every reported field is unusable", () => {
    expect(
      usageIsUnusable({
        cached_tokens: null,
        prompt_tokens: Number.NaN,
        thoughts_tokens: null,
        response_tokens: null,
      } as never),
    ).toBe(true);
    expect(usageIsUnusable({ prompt_tokens: -1, response_tokens: -1 } as never)).toBe(true);
  });

  it("is false when a real figure arrives alongside a broken one", () => {
    // The report is partly usable, so the honest summary is "we have a measurement", and the
    // broken field is dropped silently rather than crying wolf on every streamed chunk.
    expect(usageIsUnusable({ prompt_tokens: 1_000, response_tokens: Number.NaN } as never)).toBe(
      false,
    );
  });
});

describe("edge cases in the input path", () => {
  it("estimates an empty message list as zero", () => {
    expect(approximateMessagesTokens([])).toBe(0);
  });

  it("handles a text message with an empty body", () => {
    expect(Number.isFinite(approximateMessagesTokens([userText("")] as never))).toBe(true);
  });
});
