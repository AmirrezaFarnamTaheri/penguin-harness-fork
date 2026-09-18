import { describe, expect, it } from "vitest";

import {
  byteCappedPrefix,
  byteLength,
  charSafePrefix,
  chunkMarkdown,
  chunkPlainText,
  type Chunk,
  DEFAULT_MAX_CHUNK_BYTES,
  middleTruncate,
  splitByTokenLimit,
  truncateListByTokenSize,
} from "../../src/memory/chunking.js";

const FENCE = "```";

/** Total UTF-8 byte length of a chunk's content. */
function chunkBytes(chunk: Chunk): number {
  return byteLength(chunk.content);
}

describe("chunking", () => {
  describe("byteLength", () => {
    it("counts UTF-8 bytes, not UTF-16 code units", () => {
      expect(byteLength("abc")).toBe(3);
      expect(byteLength("héllo")).toBe(6);
      expect(byteLength("😀")).toBe(4);
      expect(byteLength("")).toBe(0);
    });
  });

  describe("byteCappedPrefix", () => {
    it("returns the whole string when it already fits", () => {
      expect(byteCappedPrefix("abc", 10)).toBe("abc");
    });

    it("cuts at a code-point boundary for multibyte text", () => {
      expect(byteCappedPrefix("😀😀😀", 5)).toBe("😀");
      expect(byteCappedPrefix("a😀b", 2)).toBe("a");
    });

    it("returns an empty string for a non-positive budget", () => {
      expect(byteCappedPrefix("abc", 0)).toBe("");
      expect(byteCappedPrefix("abc", -1)).toBe("");
    });

    it("still emits the first code point whole when it alone exceeds the budget", () => {
      expect(byteCappedPrefix("😀", 2)).toBe("😀");
    });
  });

  describe("charSafePrefix", () => {
    it("returns the whole string when it already fits", () => {
      expect(charSafePrefix("abc", 10)).toBe("abc");
    });

    it("cuts at a code-unit boundary for plain text", () => {
      expect(charSafePrefix("abcdef", 3)).toBe("abc");
    });

    it("backs off a cut that would split a surrogate pair", () => {
      expect(charSafePrefix("a😀b", 2)).toBe("a");
    });

    it("returns an empty string rather than emitting a lone high surrogate", () => {
      expect(charSafePrefix("😀", 1)).toBe("");
      expect(charSafePrefix("😀tail", 1)).toBe("");
    });

    it("returns an empty string for a non-positive budget", () => {
      expect(charSafePrefix("abc", 0)).toBe("");
    });

    it("never produces a string that fails to round-trip through JSON", () => {
      for (let n = 0; n <= 6; n++) {
        const cut = charSafePrefix("ab😀😀cd", n);
        expect(() => JSON.parse(JSON.stringify(cut))).not.toThrow();
      }
    });
  });

  describe("chunkMarkdown", () => {
    it("returns no chunks for empty or whitespace-only input", () => {
      expect(chunkMarkdown("")).toEqual([]);
      expect(chunkMarkdown("   \n\n  ")).toEqual([]);
    });

    it("assigns ascending zero-based ordinals", () => {
      const chunks = chunkMarkdown("# A\n\nalpha\n\n# B\n\nbeta");
      expect(chunks.map((chunk) => chunk.order)).toEqual([0, 1]);
    });

    it("keeps the heading inside its chunk and uses it as the title", () => {
      const chunks = chunkMarkdown("# Alpha\n\nalpha prose");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.title).toBe("Alpha");
      expect(chunks[0]?.content).toContain("# Alpha");
      expect(chunks[0]?.hasCode).toBe(false);
    });

    it("falls back to the title Untitled when there is no heading", () => {
      expect(chunkMarkdown("just prose here")[0]?.title).toBe("Untitled");
    });

    it("builds a heading-path title for nested sections", () => {
      const chunks = chunkMarkdown("# Top\n\n## Child\n\nbody");
      expect(chunks.map((chunk) => chunk.title)).toEqual(["Top", "Top / Child"]);
    });

    it("pops shallower headings off the stack when a new section starts", () => {
      const chunks = chunkMarkdown("# A\n\n## B\n\n# C");
      expect(chunks.map((chunk) => chunk.title)).toEqual(["A", "A / B", "C"]);
    });

    it("treats a horizontal rule as a section boundary", () => {
      const chunks = chunkMarkdown("alpha prose\n\n---\n\nbeta prose");
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.content).toContain("alpha");
      expect(chunks[1]?.content).toContain("beta");
    });

    it("defaults the byte cap to DEFAULT_MAX_CHUNK_BYTES", () => {
      const small = "# A\n\nalpha";
      expect(chunkMarkdown(small)[0]).toEqual(chunkMarkdown(small, DEFAULT_MAX_CHUNK_BYTES)[0]);
    });

    it("splits an oversized section at paragraph boundaries and numbers the parts", () => {
      const paragraph = "This is a paragraph. ".repeat(10);
      const chunks = chunkMarkdown(
        `# Section\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`,
        500,
      );
      expect(chunks).toHaveLength(2);
      expect(chunks.map((chunk) => chunk.title)).toEqual(["Section (1)", "Section (2)"]);
      expect(chunkBytes(chunks[0]!)).toBeLessThanOrEqual(500);
    });

    it("emits a single oversized paragraph whole rather than shredding it", () => {
      const paragraph = "word ".repeat(100);
      const chunks = chunkMarkdown(paragraph, 100);
      expect(chunks).toHaveLength(1);
      expect(chunkBytes(chunks[0]!)).toBeGreaterThan(100);
    });

    it("keeps a fenced code block whole within its chunk", () => {
      const longParagraph = "word ".repeat(40);
      const block = `${FENCE}ts\nconst line = "value";\n${FENCE}`;
      const chunks = chunkMarkdown(`${longParagraph}\n\n${block}\n\n${longParagraph}`, 100);
      expect(chunks).toHaveLength(3);
      expect(chunks[1]?.content).toBe(block);
      expect(chunks[1]?.hasCode).toBe(true);
      expect(chunkBytes(chunks[1]!)).toBeLessThanOrEqual(100);
      // Only the fenced chunk is flagged as code.
      expect(chunks.filter((chunk) => chunk.hasCode)).toHaveLength(1);
    });

    it("truncates a very long heading title to the character cap", () => {
      const longHeading = `# ${"h".repeat(100)}`;
      expect(chunkMarkdown(longHeading)[0]?.title).toHaveLength(80);
    });
  });

  describe("chunkPlainText", () => {
    it("uses the first line as the title", () => {
      const chunks = chunkPlainText("First line here\nsecond line");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.title).toBe("First line here");
    });

    it("flushes at the lines-per-chunk limit", () => {
      const lines = Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n");
      const chunks = chunkPlainText(lines, DEFAULT_MAX_CHUNK_BYTES, 10);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]?.content.split("\n")).toHaveLength(10);
      expect(chunks[1]?.content.split("\n")).toHaveLength(10);
      expect(chunks[2]?.content.split("\n")).toHaveLength(5);
    });

    it("breaks a long spaceless line exactly at the byte cap", () => {
      const chunks = chunkPlainText("a".repeat(500), 100);
      expect(chunks).toHaveLength(5);
      for (const chunk of chunks) {
        expect(chunkBytes(chunk)).toBe(100);
        expect(chunk.hasCode).toBe(false);
      }
    });

    it("breaks a long wordy line at a whitespace boundary and never exceeds the cap", () => {
      const chunks = chunkPlainText("word ".repeat(50), 100);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunkBytes(chunk)).toBeLessThanOrEqual(100);
        expect(chunk.content.length).toBeGreaterThan(0);
      }
    });

    it("skips a chunk whose flushed content is only whitespace", () => {
      const chunks = chunkPlainText("   \n\n  \n\nreal content");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.content).toBe("real content");
    });
  });

  describe("splitByTokenLimit", () => {
    it("splits into token-sized pieces with no overlap by default", () => {
      const text = "a".repeat(400);
      const pieces = splitByTokenLimit(text, 50);
      expect(pieces).toHaveLength(2);
      expect(pieces[0]).toBe("a".repeat(200));
      expect(pieces[1]).toBe("a".repeat(200));
    });

    it("carries overlap between consecutive pieces", () => {
      const text = "a".repeat(400);
      const pieces = splitByTokenLimit(text, 50, 10);
      expect(pieces).toHaveLength(3);
      expect(pieces[1]).toBe("a".repeat(160) + "a".repeat(40));
      // Overlap means the tail of one piece reappears at the head of the next.
      expect(pieces[0]!.slice(-40)).toBe(pieces[1]!.slice(0, 40));
    });

    it("returns an empty list for a non-positive limit or empty text", () => {
      expect(splitByTokenLimit("abc", 0)).toEqual([]);
      expect(splitByTokenLimit("", 10)).toEqual([]);
    });

    it("clamps an overlap larger than the window so progress is guaranteed", () => {
      expect(splitByTokenLimit("abcdefgh", 2, 1_000)).toEqual(["abcdefgh"]);
    });
  });

  describe("truncateListByTokenSize", () => {
    it("keeps every item when the join fits", () => {
      const items = ["aaaa", "bbbb", "cccc"];
      expect(truncateListByTokenSize(items, (item) => item, "\n", 100)).toEqual(items);
    });

    it("drops trailing whole items until the budget fits, never a partial item", () => {
      const items = ["aaaa", "bbbb", "cccc"];
      const kept = truncateListByTokenSize(items, (item) => item, "\n", 3);
      expect(kept).toEqual(["aaaa", "bbbb"]);
      // The serialized result must actually fit the budget it was truncated to.
      const joined = kept.map((item) => item).join("\n");
      expect(Math.ceil(joined.length / 4)).toBeLessThanOrEqual(3);
    });

    it("counts the separator's own cost", () => {
      // 4 items of 4 chars: "aaaa|bbbb" = 9 chars = 3 tokens with the 1-char separator.
      const items = ["aaaa", "bbbb", "cccc", "dddd"];
      expect(truncateListByTokenSize(items, (item) => item, "|", 3)).toHaveLength(2);
    });

    it("returns an empty list for a non-positive budget or empty input", () => {
      expect(truncateListByTokenSize(["aaaa"], (item) => item, "\n", 0)).toEqual([]);
      expect(truncateListByTokenSize([], (item) => item, "\n", 100)).toEqual([]);
    });
  });

  describe("middleTruncate", () => {
    it("returns the input untouched when it already fits", () => {
      const text = "abc";
      expect(middleTruncate(text, 10)).toBe(text);
    });

    it("keeps head and tail and reports how many middle chars were dropped", () => {
      const result = middleTruncate("abcdefghij", 6);
      expect(result).toBe("a\n[truncated: dropped 8 middle chars to fit the context budget]\nj");
    });

    it("returns the input for a non-positive budget", () => {
      expect(middleTruncate("abc", 0)).toBe("abc");
    });

    it("clamps the tail when head and tail fractions overrun the budget", () => {
      const result = middleTruncate("abcdefghij", 4, 1.0, 0.3);
      // Head takes the whole budget, so the tail is clamped to empty.
      expect(result.startsWith("abcd\n[truncated:")).toBe(true);
      expect(result).toContain("dropped 6 middle chars");
      expect(result.endsWith("\n")).toBe(true);
    });
  });
});
