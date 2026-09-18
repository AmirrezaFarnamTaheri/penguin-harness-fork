import { describe, expect, it } from "vitest";

import {
  apportionByWeight,
  availableChunkTokens,
  CHARS_PER_TOKEN,
  contextTokensFromUsage,
  estimateMessagesTokens,
  estimateTokens,
  imageTokens,
  MESSAGE_OVERHEAD_TOKENS,
  parseTokenBudgetValue,
  type UsageRecord,
} from "../../src/memory/token-math.js";

describe("token-math", () => {
  describe("estimateTokens", () => {
    it("estimates 4 chars per token, rounding up", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens("abcd")).toBe(1);
      expect(estimateTokens("abcde")).toBe(2);
      expect(estimateTokens("abcdefgh")).toBe(2);
    });

    it("treats a nullish input as empty", () => {
      expect(estimateTokens(undefined as unknown as string)).toBe(0);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("charges content plus the role label plus per-message overhead", () => {
      const messages = [{ role: "user", content: "abcd" }];
      const chars = "abcd".length + "user".length + MESSAGE_OVERHEAD_TOKENS * CHARS_PER_TOKEN;
      expect(estimateMessagesTokens(messages)).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
      expect(estimateMessagesTokens(messages)).toBe(12);
    });

    it("sums across messages and rounds once at the end", () => {
      const tokens = estimateMessagesTokens([
        { role: "system", content: "1234" },
        { role: "user", content: "5678" },
        { role: "assistant", content: "90" },
      ]);
      const chars =
        "1234".length +
        "system".length +
        "5678".length +
        "user".length +
        "90".length +
        "assistant".length +
        3 * MESSAGE_OVERHEAD_TOKENS * CHARS_PER_TOKEN;
      expect(tokens).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
    });

    it("tolerates messages with nullish content", () => {
      expect(
        estimateMessagesTokens([{ role: "user", content: undefined as unknown as string }]),
      ).toBe(
        Math.ceil(("user".length + MESSAGE_OVERHEAD_TOKENS * CHARS_PER_TOKEN) / CHARS_PER_TOKEN),
      );
    });
  });

  describe("imageTokens", () => {
    it("charges the fixed estimate per image", () => {
      expect(imageTokens()).toBe(1200);
      expect(imageTokens(1)).toBe(1200);
      expect(imageTokens(3)).toBe(3600);
    });
  });

  describe("contextTokensFromUsage", () => {
    it("prefers totalTokens when present", () => {
      expect(contextTokensFromUsage({ totalTokens: 500, input: 10 })).toBe(500);
    });

    it("reconstructs the context from input + output + cache when total is absent", () => {
      expect(contextTokensFromUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 })).toBe(
        165,
      );
      expect(contextTokensFromUsage({ input: 40, output: 0 })).toBe(40);
    });

    it("returns undefined when no usable field is present", () => {
      expect(contextTokensFromUsage({})).toBeUndefined();
    });

    it("returns undefined for an all-zero record so a placeholder cannot anchor an empty context", () => {
      const allZero: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      expect(contextTokensFromUsage(allZero)).toBeUndefined();
    });

    it("rejects a non-positive total and falls through to the component sum", () => {
      expect(contextTokensFromUsage({ totalTokens: -5, input: 30, output: 30 })).toBe(60);
      expect(contextTokensFromUsage({ totalTokens: 0 })).toBeUndefined();
    });

    it("rejects non-finite values", () => {
      expect(contextTokensFromUsage({ totalTokens: Number.POSITIVE_INFINITY })).toBeUndefined();
      expect(contextTokensFromUsage({ input: Number.NaN })).toBeUndefined();
    });
  });

  describe("parseTokenBudgetValue", () => {
    it("parses plain integers", () => {
      expect(parseTokenBudgetValue("200000")).toBe(200_000);
      expect(parseTokenBudgetValue("42")).toBe(42);
    });

    it("applies k/m suffixes", () => {
      expect(parseTokenBudgetValue("200k")).toBe(200_000);
      expect(parseTokenBudgetValue("1m")).toBe(1_000_000);
      expect(parseTokenBudgetValue("5K")).toBe(5_000);
      expect(parseTokenBudgetValue("2M")).toBe(2_000_000);
    });

    it("tolerates underscores and thousands separators", () => {
      expect(parseTokenBudgetValue("1_000k")).toBe(1_000_000);
      expect(parseTokenBudgetValue("200,000")).toBe(200_000);
      expect(parseTokenBudgetValue("  100  ")).toBe(100);
    });

    it("rejects anything that is not a positive integer token count", () => {
      expect(parseTokenBudgetValue("0")).toBeNull();
      expect(parseTokenBudgetValue("-5")).toBeNull();
      expect(parseTokenBudgetValue("abc")).toBeNull();
      expect(parseTokenBudgetValue("1.5k")).toBeNull();
      expect(parseTokenBudgetValue("")).toBeNull();
      expect(parseTokenBudgetValue("1x")).toBeNull();
    });
  });

  describe("apportionByWeight", () => {
    it("distributes a total exactly, using largest-remainder rounding", () => {
      const out = apportionByWeight(
        [
          { key: "a", tokens: 1 },
          { key: "b", tokens: 2 },
        ],
        10,
      );
      expect(out).toEqual({ a: 3, b: 7 });
      expect(out.a! + out.b!).toBe(10);
    });

    it("floors exact divisions with no leftover", () => {
      const out = apportionByWeight(
        [
          { key: "a", tokens: 1 },
          { key: "b", tokens: 1 },
        ],
        10,
      );
      expect(out).toEqual({ a: 5, b: 5 });
    });

    it("gives every key a 0 quota when the total is non-positive", () => {
      expect(apportionByWeight([{ key: "a", tokens: 1 }], 0)).toEqual({ a: 0 });
      expect(apportionByWeight([{ key: "a", tokens: 1 }], -10)).toEqual({ a: 0 });
    });

    it("returns an empty map for no weights", () => {
      expect(apportionByWeight([], 100)).toEqual({});
    });

    it("gives every key a 0 quota when all weights are non-positive", () => {
      expect(
        apportionByWeight(
          [
            { key: "a", tokens: 0 },
            { key: "b", tokens: -5 },
          ],
          100,
        ),
      ).toEqual({ a: 0, b: 0 });
    });

    it("never over-allocates when the total is smaller than the weight count", () => {
      const out = apportionByWeight(
        [
          { key: "a", tokens: 1 },
          { key: "b", tokens: 1 },
          { key: "c", tokens: 1 },
        ],
        2,
      );
      const total = Object.values(out).reduce((acc, value) => acc + value, 0);
      expect(total).toBe(2);
    });
  });

  describe("availableChunkTokens", () => {
    it("subtracts the system prompt, query and default buffer from the total", () => {
      expect(
        availableChunkTokens({
          maxTotalTokens: 1000,
          systemPromptTokens: 200,
          queryTokens: 100,
        }),
      ).toBe(500);
    });

    it("honours an explicit buffer override", () => {
      expect(
        availableChunkTokens({
          maxTotalTokens: 1000,
          systemPromptTokens: 200,
          queryTokens: 100,
          bufferTokens: 0,
        }),
      ).toBe(700);
    });

    it("stays negative rather than clamping to 0 when fixed costs exceed the total", () => {
      expect(
        availableChunkTokens({
          maxTotalTokens: 100,
          systemPromptTokens: 200,
          queryTokens: 100,
        }),
      ).toBe(-400);
    });
  });
});
