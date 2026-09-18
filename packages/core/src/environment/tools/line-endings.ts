/**
 * line-endings — line-terminator detection and normalization, shared by the file tools.
 *
 * The Harness runs on Windows, where a file's bytes may use CRLF while every tool *shows*
 * the model LF: read_file strips the trailing `\r` of each line, and the model then quotes
 * that LF text back into edit_file's exact-string match — which fails against the real CRLF
 * bytes, or worse, lands LF content into a CRLF file and leaves the file with mixed
 * endings. The fix belongs in the tools, not in the model's reasoning: this module tells the
 * file tools what a file's bytes actually use, and converts between the display (LF) view and
 * the file's own style, so the model never has to spend a token on `\r`.
 *
 * Two halves:
 * - detection: `detectLineEndings` / `countLineEndings` / `lineEndingStyleFromCounts` — count
 *   the terminators in a text (CRLF, lone LF, lone CR) and name the file's style; a counting
 *   detector is also used by read_file's incremental byte-level scan, which cannot afford to
 *   materialize the text.
 * - conversion: `normalizeLineEndings` (any style → the style you ask for; `"lf"` is the
 *   display view) and `restoreLineEndings` (a display/LF string back to a file's own style).
 *
 * The write-back contract the file tools keep: edit_file and write_file preserve an existing
 * file's dominant terminator, matching old_string against the file's LF view so text copied
 * from read_file matches, and writing the result back in the file's style. A file with no
 * terminators at all keeps exactly what the caller supplied — there is nothing to preserve,
 * and converting would invent structure the file never had.
 *
 * Mixed-ending files are pathological (most tools refuse to create them): a replacement done
 * in the LF view cannot map per-line endings back onto a file whose lines disagree, so the
 * whole file is written in the dominant terminator. That is the only case where untouched
 * lines change their bytes, and it is the meaning of "preserve the dominant line ending".
 */
/** The style of a text as a whole: which terminator(s) it uses, or none at all. */
export type LineEndingStyle = "lf" | "crlf" | "cr" | "mixed" | "none";

/**
 * A concrete line terminator. `"none"` is a style, not a terminator, so it lives in
 * {@link LineEndingStyle} only; functions that convert need a real terminator.
 */
export type LineTerminator = "lf" | "crlf" | "cr";

/** Per-terminator counts over a text; the three add up to its total number of line terminators. */
export interface LineEndingCounts {
  lf: number;
  crlf: number;
  cr: number;
}

/** What `detectLineEndings` reports about a text. */
export interface LineEndingDetection {
  /** The style: one terminator used exclusively, `mixed` when more than one, `none` when zero. */
  style: LineEndingStyle;
  /** The counts the style came from. */
  counts: LineEndingCounts;
  /**
   * The most frequent terminator — `lf`/`crlf`/`cr` even when the file is mixed, `none` when
   * the text has no terminator at all. Ties break CRLF > LF > CR: a mixed file on a Windows
   * machine almost always means CRLF intent with LF introduced by a tool, not the reverse.
   */
  dominant: LineTerminator | "none";
}

/** `\r`, used by `detectLineEndings` and by the write-back helpers. */
const CR = 0x0d;
/** `\n`, used by `detectLineEndings` and by the write-back helpers. */
const LF = 0x0a;

/**
 * Counts the line terminators in `text`: each `\r\n` is one CRLF, each lone `\r` one CR, each
 * lone `\n` one LF. One pass, no allocation, no regex backtracking; the text is a whole string
 * here (read_file counts incrementally at the byte level and reuses {@link lineEndingStyleFromCounts}).
 */
export function countLineEndings(text: string): LineEndingCounts {
  const counts: LineEndingCounts = { lf: 0, crlf: 0, cr: 0 };
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === CR) {
      if (text.charCodeAt(i + 1) === LF) {
        counts.crlf += 1;
        i += 2;
      } else {
        counts.cr += 1;
        i += 1;
      }
    } else if (c === LF) {
      counts.lf += 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return counts;
}

/** The style of a text from counts (same rules as {@link detectLineEndings}), for a caller that counted incrementally. */
export function lineEndingStyleFromCounts(counts: LineEndingCounts): LineEndingStyle {
  const { lf, crlf, cr } = counts;
  if (lf === 0 && crlf === 0 && cr === 0) return "none";
  let styles = 0;
  if (lf > 0) styles += 1;
  if (crlf > 0) styles += 1;
  if (cr > 0) styles += 1;
  if (styles === 1) return lf > 0 ? "lf" : crlf > 0 ? "crlf" : "cr";
  return "mixed";
}

/** The most frequent terminator (`lf`/`crlf`/`cr`; ties → CRLF, then LF), or `none` when there is none. */
export function dominantLineEnding(counts: LineEndingCounts): LineTerminator | "none" {
  if (counts.crlf >= counts.lf && counts.crlf >= counts.cr && counts.crlf > 0) return "crlf";
  if (counts.lf >= counts.cr && counts.lf > 0) return "lf";
  if (counts.cr > 0) return "cr";
  return "none";
}

/** Detects a text's line-ending style in one pass; see {@link LineEndingDetection} for the fields. */
export function detectLineEndings(text: string): LineEndingDetection {
  const counts = countLineEndings(text);
  return {
    style: lineEndingStyleFromCounts(counts),
    counts,
    dominant: dominantLineEnding(counts),
  };
}

/**
 * Every line terminator in `text` becomes `style`: CRLF and lone CR both become LF when
 * `style` is `"lf"` (that is the display view read_file shows), and LF becomes `\r\n` or `\r`
 * for the other styles. Terminators inside a line are converted too — a lone CR in the middle
 * of a line is a terminator, whatever the file meant by it.
 */
export function normalizeLineEndings(text: string, style: LineTerminator): string {
  if (style === "lf") {
    // `\r\n` first so each CRLF collapses to one LF, not two.
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, terminatorString(style));
}

/**
 * The inverse direction for a caller holding a display/LF string: converts `text`'s LF endings
 * to `style`, leaving every other byte alone. Tolerant of a non-LF input (it normalizes first),
 * so it stays correct when the caller's text still carries a stray `\r` it should not —
 * restoring would otherwise produce `\r\r\n` instead of `\r\n`.
 */
export function restoreLineEndings(text: string, style: LineTerminator | "none"): string {
  if (style === "none" || style === "lf") return text;
  return normalizeLineEndings(text, style);
}

/** The terminator string a style writes (`"\r\n"`, `"\n"`, `"\r"`); `"none"` is the empty string. */
export function terminatorString(style: LineTerminator | "none"): string {
  switch (style) {
    case "crlf":
      return "\r\n";
    case "cr":
      return "\r";
    case "lf":
      return "\n";
    default:
      return "";
  }
}

/** A short model-facing name for a style: `LF`, `CRLF`, `CR`, `mixed`, or `no line endings`. */
export function lineEndingStyleLabel(style: LineEndingStyle): string {
  switch (style) {
    case "lf":
      return "LF";
    case "crlf":
      return "CRLF";
    case "cr":
      return "CR";
    case "mixed":
      return "mixed";
    default:
      return "no line endings";
  }
}

/**
 * The one-line note read_file appends when a file's bytes do not use LF, or `null` for the
 * common LF case (and for a file with no terminators) so the usual read costs nothing extra.
 * The wording is stable — tests and downstream prompts match it.
 */
export function lineEndingStyleNote(counts: LineEndingCounts): string | null {
  const style = lineEndingStyleFromCounts(counts);
  if (style === "lf" || style === "none") return null;
  if (style === "mixed") {
    const parts: string[] = [];
    if (counts.crlf > 0) parts.push(`${counts.crlf} CRLF`);
    if (counts.lf > 0) parts.push(`${counts.lf} LF`);
    if (counts.cr > 0) parts.push(`${counts.cr} CR`);
    return `(file uses mixed line endings: ${parts.join(", ")})`;
  }
  return `(file uses ${lineEndingStyleLabel(style)} line endings)`;
}

/**
 * The terminator a write-back should use for content derived from an existing file's bytes:
 * the file's dominant terminator, or `null` when the file has no terminators at all (keep the
 * caller's content as supplied — there is nothing to preserve). edit_file and write_file call
 * this on the file's current content, then {@link restoreLineEndings} the result with it.
 */
export function dominantTerminatorForWrite(existing: string): LineTerminator | null {
  const dominant = dominantLineEnding(countLineEndings(existing));
  return dominant === "none" ? null : dominant;
}
