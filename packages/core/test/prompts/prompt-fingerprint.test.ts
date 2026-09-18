import { describe, expect, it } from "vitest";

import {
  arePromptsDuplicates,
  estimateTokens,
  findDuplicateDigests,
  fingerprintPrompt,
  fnv1a64,
  normalizedDigest,
  promptSimilarity,
  sha256Fingerprint,
  utf8ByteLength,
  wordShingles,
} from "../../src/prompts/prompt-fingerprint.js";

describe("prompt-fingerprint / FNV-1a 64", () => {
  // The canonical FNV-1a reference vectors: any correct implementation reproduces these.
  it("reproduces the standard FNV-1a 64 test vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });

  it("emits a 16-character lowercase hex digest", () => {
    expect(fnv1a64("You are a helpful assistant.")).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("is deterministic and distinguishes inputs", () => {
    expect(fnv1a64("one prompt")).toBe(fnv1a64("one prompt"));
    expect(fnv1a64("one prompt")).not.toBe(fnv1a64("two prompt"));
  });
});

describe("prompt-fingerprint / bytes, lines and tokens", () => {
  it("utf8ByteLength counts multibyte sequences correctly", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("日本")).toBe(6);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("estimateTokens over-counts rather than under-counts", () => {
    expect(estimateTokens("")).toBe(0);
    // 8 latin characters -> 2 tokens by the 4-chars-per-token rule.
    expect(estimateTokens("abcdefgh")).toBe(2);
    // Each CJK code point is its own token, so 4 CJK characters cost 4, not 1.
    expect(estimateTokens("日本語彙")).toBe(4);
  });

  it("fingerprintPrompt reports the full identity record", () => {
    const text = "You are an agent.\r\nWorking in /tmp.";
    const fp = fingerprintPrompt(text);
    expect(fp.algorithm).toBe("fnv1a-64");
    expect(fp.chars).toBe(text.length);
    expect(fp.bytes).toBe(text.length);
    expect(fp.lines).toBe(2);
    expect(fp.estTokens).toBe(Math.ceil(text.length / 4));
    // The raw text carries a CR the normalised form drops, so the two digests differ.
    expect(fp.digest).not.toBe(fp.normalizedDigest);
  });

  it("fingerprintPrompt reports zero lines for empty text", () => {
    const fp = fingerprintPrompt("");
    expect(fp.lines).toBe(0);
    expect(fp.chars).toBe(0);
  });
});

describe("prompt-fingerprint / normalisation and duplicates", () => {
  it("cosmetic edits do not change the normalised digest", () => {
    const base = "You are an agent.\n\n\n\nWork in the workspace.";
    const cosmetic = "You are an agent.\n\nWork in the workspace.   \r\n";
    expect(normalizedDigest(base)).toBe(normalizedDigest(cosmetic));
    expect(fnv1a64(base)).not.toBe(fnv1a64(cosmetic));
  });

  it("frontmatter is ignored for identity but kept in the raw digest", () => {
    const withFrontmatter = '<!--\nname: "x"\n-->\nYou are an agent.';
    expect(normalizedDigest(withFrontmatter)).toBe(normalizedDigest("You are an agent."));
    expect(fingerprintPrompt(withFrontmatter).chars).toBe(withFrontmatter.length);
  });

  it("arePromptsDuplicates collapses re-releases of one prompt", () => {
    expect(
      arePromptsDuplicates(
        "You are Cline, a highly skilled software engineer.\n\n\nRules.",
        "You are Cline, a highly skilled software engineer.\n\nRules.",
      ),
    ).toBe(true);
    expect(arePromptsDuplicates("one prompt", "a different prompt")).toBe(false);
  });

  it("findDuplicateDigests reports digests shared by more than one text", () => {
    const dupes = findDuplicateDigests([
      "Same prompt.\n\n\nHere.",
      "Same prompt.\n\nHere.",
      "A different prompt.",
      "A different prompt.",
    ]);
    expect(dupes).toHaveLength(2);
  });
});

describe("prompt-fingerprint / similarity", () => {
  it("wordShingles splits text into lower-cased word triples", () => {
    expect(wordShingles("You are a helpful agent", 3)).toEqual([
      "you are a",
      "are a helpful",
      "a helpful agent",
    ]);
    // Fewer words than the shingle size falls back to the words themselves.
    expect(wordShingles("you are", 3)).toEqual(["you", "are"]);
  });

  it("promptSimilarity is 1.0 for identical wording and lower for edits", () => {
    const a = "You are a highly skilled software engineer with extensive knowledge.";
    expect(promptSimilarity(a, a).score).toBe(1);

    // A revision that reorders and rewords drops meaningfully below 1.
    const revised = "You are a very capable software engineer with broad knowledge.";
    expect(promptSimilarity(a, revised).score).toBeLessThan(1);
    expect(promptSimilarity(a, revised).score).toBeGreaterThan(0.2);
  });

  it("promptSimilarity reports near zero for unrelated prompts", () => {
    const { score } = promptSimilarity(
      "You are a coding agent that edits files.",
      "The weather in Reykjavik is mild today.",
    );
    expect(score).toBeLessThan(0.2);
  });

  it("promptSimilarity handles empty input", () => {
    expect(promptSimilarity("", "something")).toEqual({
      score: 0,
      sharedShingles: 0,
      minShingles: 0,
    });
  });

  it("promptSimilarity is order-insensitive", () => {
    const a = "You are a helpful agent working in a workspace.";
    const b = "Working in a workspace, you are a helpful agent.";
    expect(promptSimilarity(a, b).score).toBe(promptSimilarity(b, a).score);
  });
});

describe("prompt-fingerprint / sha256", () => {
  it("produces the canonical SHA-256 of the empty string", () => {
    return sha256Fingerprint("").then((digest) => {
      expect(digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      expect(digest).toHaveLength(64);
    });
  });

  it("differs from the FNV identity digest in length and value", async () => {
    const text = "You are a helpful assistant.";
    const sha = await sha256Fingerprint(text);
    expect(sha).toHaveLength(64);
    expect(sha).not.toBe(fnv1a64(text));
  });
});
