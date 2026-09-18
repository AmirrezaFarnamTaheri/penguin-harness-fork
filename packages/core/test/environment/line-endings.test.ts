/**
 * Unit tests for line-endings.ts — the detector and the two converters that back the file
 * tools' preserve-on-edit contract. Pure functions, no I/O: every style is constructed
 * directly, including the pathological mixed case.
 */
import { describe, expect, it } from "vitest";
import {
  countLineEndings,
  detectLineEndings,
  dominantLineEnding,
  dominantTerminatorForWrite,
  lineEndingStyleFromCounts,
  lineEndingStyleLabel,
  lineEndingStyleNote,
  normalizeLineEndings,
  restoreLineEndings,
  terminatorString,
} from "../../src/environment/tools/line-endings.js";

describe("line-endings — detection", () => {
  it("reports lf for an LF file and none for a file with no terminators", () => {
    expect(detectLineEndings("alpha\nbeta\n")).toEqual({
      style: "lf",
      counts: { lf: 2, crlf: 0, cr: 0 },
      dominant: "lf",
    });
    expect(detectLineEndings("one line, no terminator")).toEqual({
      style: "none",
      counts: { lf: 0, crlf: 0, cr: 0 },
      dominant: "none",
    });
    expect(detectLineEndings("")).toEqual({
      style: "none",
      counts: { lf: 0, crlf: 0, cr: 0 },
      dominant: "none",
    });
  });

  it("reports crlf for a CRLF file, counting the pairs and not the halves", () => {
    expect(detectLineEndings("alpha\r\nbeta\r\n")).toEqual({
      style: "crlf",
      counts: { lf: 0, crlf: 2, cr: 0 },
      dominant: "crlf",
    });
    // A final line with no terminator still leaves the file unambiguously CRLF.
    expect(detectLineEndings("a\r\nb\r\nc")).toEqual({
      style: "crlf",
      counts: { lf: 0, crlf: 2, cr: 0 },
      dominant: "crlf",
    });
  });

  it("reports cr for a classic-Mac (CR-only) file, including a CR inside a line", () => {
    expect(detectLineEndings("alpha\rbeta\r")).toEqual({
      style: "cr",
      counts: { lf: 0, crlf: 0, cr: 2 },
      dominant: "cr",
    });
    expect(countLineEndings("a\rb\rc\n")).toEqual({ lf: 1, crlf: 0, cr: 2 });
  });

  it("reports mixed when more than one terminator appears, and dominant picks the majority", () => {
    // 2 CRLF, 1 LF, 0 CR — dominant is CRLF even though the file is mixed.
    const mixed = detectLineEndings("a\r\nb\r\nc\nd");
    expect(mixed.style).toBe("mixed");
    expect(mixed.counts).toEqual({ lf: 1, crlf: 2, cr: 0 });
    expect(mixed.dominant).toBe("crlf");
    // 3 LF vs 1 CR: dominant is LF.
    expect(dominantLineEnding(detectLineEndings("a\nb\nc\rd\n").counts)).toBe("lf");
  });

  it("breaks count ties toward CRLF, then LF", () => {
    expect(dominantLineEnding({ lf: 1, crlf: 1, cr: 0 })).toBe("crlf");
    expect(dominantLineEnding({ lf: 1, crlf: 0, cr: 1 })).toBe("lf");
    expect(dominantLineEnding({ lf: 0, crlf: 0, cr: 3 })).toBe("cr");
    expect(dominantLineEnding({ lf: 0, crlf: 0, cr: 0 })).toBe("none");
  });

  it("resolves CRLF before lone CR, so \\r\\r\\n is one CRLF plus one CR", () => {
    expect(countLineEndings("a\r\r\nb")).toEqual({ lf: 0, crlf: 1, cr: 1 });
    expect(countLineEndings("a\r\r\rb")).toEqual({ lf: 0, crlf: 0, cr: 3 });
  });

  it("counts a lone CR at the very end of the text", () => {
    expect(countLineEndings("abc\r")).toEqual({ lf: 0, crlf: 0, cr: 1 });
  });

  it("agrees between the whole-string detector and the incremental style function", () => {
    for (const text of ["a\nb\n", "a\r\nb\r\n", "a\rb\r", "plain", "a\r\nb\nc\r"]) {
      expect(lineEndingStyleFromCounts(countLineEndings(text))).toBe(detectLineEndings(text).style);
    }
  });
});

describe("line-endings — conversion", () => {
  it("normalizes every style to the one asked for", () => {
    expect(normalizeLineEndings("a\r\nb\r\nc", "lf")).toBe("a\nb\nc");
    expect(normalizeLineEndings("a\rb\rc", "lf")).toBe("a\nb\nc");
    expect(normalizeLineEndings("a\r\nb\rc\n", "lf")).toBe("a\nb\nc\n");
    expect(normalizeLineEndings("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
    expect(normalizeLineEndings("a\r\nb\n", "cr")).toBe("a\rb\r");
  });

  it("is idempotent: normalizing an already-normalized text changes nothing", () => {
    const crlf = "a\r\nb\r\n";
    expect(normalizeLineEndings(normalizeLineEndings(crlf, "crlf"), "crlf")).toBe(crlf);
    const lf = "a\nb\n";
    expect(normalizeLineEndings(normalizeLineEndings(lf, "lf"), "lf")).toBe(lf);
  });

  it("restores a display (LF) string to a file's own style", () => {
    expect(restoreLineEndings("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
    expect(restoreLineEndings("a\nb\n", "cr")).toBe("a\rb\r");
    expect(restoreLineEndings("a\nb\n", "lf")).toBe("a\nb\n");
    expect(restoreLineEndings("a\nb\n", "none")).toBe("a\nb\n");
  });

  it("tolerates a non-LF input instead of producing a doubled terminator", () => {
    // A stray \r in the display string must not become \r\r\n.
    expect(restoreLineEndings("a\r\nb\n", "crlf")).toBe("a\r\nb\r\n");
    expect(normalizeLineEndings("a\r\n\r\nb", "crlf")).toBe("a\r\n\r\nb");
  });

  it("maps styles to their terminator strings", () => {
    expect(terminatorString("crlf")).toBe("\r\n");
    expect(terminatorString("lf")).toBe("\n");
    expect(terminatorString("cr")).toBe("\r");
    expect(terminatorString("none")).toBe("");
  });

  it("labels styles for model-facing notes", () => {
    expect(lineEndingStyleLabel("lf")).toBe("LF");
    expect(lineEndingStyleLabel("crlf")).toBe("CRLF");
    expect(lineEndingStyleLabel("cr")).toBe("CR");
    expect(lineEndingStyleLabel("mixed")).toBe("mixed");
    expect(lineEndingStyleLabel("none")).toBe("no line endings");
  });

  it("emits the read_file note only for non-LF files, with the stable CRLF wording", () => {
    expect(lineEndingStyleNote(countLineEndings("a\nb\n"))).toBeNull();
    expect(lineEndingStyleNote(countLineEndings("no endings"))).toBeNull();
    expect(lineEndingStyleNote(countLineEndings("a\r\nb\r\n"))).toBe(
      "(file uses CRLF line endings)",
    );
    expect(lineEndingStyleNote(countLineEndings("a\rb\r"))).toBe("(file uses CR line endings)");
    expect(lineEndingStyleNote(countLineEndings("a\r\nb\nc\r"))).toBe(
      "(file uses mixed line endings: 1 CRLF, 1 LF, 1 CR)",
    );
  });

  it("reports the write-back terminator for an existing file, or null when it has none", () => {
    expect(dominantTerminatorForWrite("a\r\nb\r\n")).toBe("crlf");
    expect(dominantTerminatorForWrite("a\nb\n")).toBe("lf");
    expect(dominantTerminatorForWrite("a\rb\r")).toBe("cr");
    // A mixed file is written in its dominant terminator.
    expect(dominantTerminatorForWrite("a\r\nb\r\nc\n")).toBe("crlf");
    // No terminators at all: nothing to preserve, the caller's bytes stand.
    expect(dominantTerminatorForWrite("one line")).toBeNull();
    expect(dominantTerminatorForWrite("")).toBeNull();
  });
});
