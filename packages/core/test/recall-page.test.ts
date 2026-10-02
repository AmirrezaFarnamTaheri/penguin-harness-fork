/**
 * F18.1: the shared recall-page seam.
 *
 * The model-facing `recall_output` tool and host surfaces (the HTTP route, the CLI) cut pages
 * through this one helper, so a page is the same bytes wherever it is read: never split between
 * the halves of a surrogate pair, and `nextOffset` is null exactly when the text is complete.
 * `invalid-offset` is its own outcome so "that place does not exist" never looks like "no more
 * text here".
 */
import { describe, expect, it } from "vitest";
import {
  RECALL_ID_PATTERN,
  RECALL_OUTPUT_PAGE_CHARS,
  isValidRecallId,
  sliceRecallPage,
} from "../src/environment/tools/recall-output.js";

describe("F18.1 recall page slicing", () => {
  it("walks the whole text in bounded pages that reassemble exactly", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const pages: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 1000; guard += 1) {
      const slice = sliceRecallPage(text, offset, 100);
      expect(slice.status).toBe("ok");
      if (slice.status !== "ok") return;
      expect(slice.page.length).toBeLessThanOrEqual(100);
      pages.push(slice.page);
      expect(slice.totalChars).toBe(text.length);
      if (slice.nextOffset === null) break;
      expect(slice.nextOffset).toBeGreaterThan(offset);
      offset = slice.nextOffset;
    }
    expect(pages.join("")).toBe(text);
  });

  it("reports completion with a null next offset only at the end", () => {
    const text = "0123456789";
    expect(sliceRecallPage(text, 0, 10)).toEqual({
      status: "ok",
      page: text,
      nextOffset: null,
      totalChars: 10,
    });
    // Exactly one character before the end: a page that reaches the end is complete.
    expect(sliceRecallPage(text, 9, 10)).toMatchObject({ page: "9", nextOffset: null });
    // An empty text is complete at offset 0, not an error.
    expect(sliceRecallPage("", 0)).toEqual({
      status: "ok",
      page: "",
      nextOffset: null,
      totalChars: 0,
    });
  });

  it("never splits a surrogate pair across two pages", () => {
    // An emoji is a surrogate pair in UTF-16: a page ending mid-pair would hand the caller a
    // lone surrogate, and the pages would not reassemble into the original text.
    const text = `a${"\u{1f427}".repeat(3)}b`;
    const first = sliceRecallPage(text, 0, 2);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.page).toBe("a"); // the pair would have been cut at 2 — the page stops at 1
    expect(first.nextOffset).toBe(1);

    const whole = sliceRecallPage(text, 0, text.length);
    expect(whole).toMatchObject({ status: "ok", nextOffset: null, page: text });

    // Starting inside a pair is refused rather than silently returning half a character.
    expect(sliceRecallPage(text, 2, 4)).toEqual({
      status: "invalid-offset",
      totalChars: text.length,
    });
  });

  it("refuses offsets that are not places in this text", () => {
    const text = "abc";
    for (const offset of [-1, 4, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(sliceRecallPage(text, offset, 2), String(offset)).toEqual({
        status: "invalid-offset",
        totalChars: 3,
      });
    }
    // The end of the text is a valid place: it is a legal (empty) page start.
    expect(sliceRecallPage(text, 3, 2)).toMatchObject({ status: "ok", page: "", nextOffset: null });
    // A non-positive page size would loop forever; it is refused as invalid.
    expect(sliceRecallPage(text, 0, 0)).toEqual({ status: "invalid-offset", totalChars: 3 });
  });

  it("accepts only 12 or 32 hex characters as a recall id", () => {
    expect(new RegExp(RECALL_ID_PATTERN).source).toBe(RECALL_ID_PATTERN);
    expect(isValidRecallId("0123456789ab")).toBe(true);
    expect(isValidRecallId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidRecallId("0123456789AB")).toBe(true); // normalized to lowercase first
    for (const bad of [
      "0123456789a", // too short
      "0123456789abc", // 13
      "0123456789abz", // not hex
      "../../etc/passwd",
      "0123456789ab/../..",
      "0123456789ab.log",
      "sub/dir/0123456789ab",
      "",
      "0123456789ab\u0000",
    ]) {
      expect(isValidRecallId(bad), bad).toBe(false);
    }
  });

  it("keeps the default page size in one place", () => {
    expect(RECALL_OUTPUT_PAGE_CHARS).toBe(12_000);
    const long = "x".repeat(RECALL_OUTPUT_PAGE_CHARS + 5);
    const slice = sliceRecallPage(long, 0);
    expect(slice).toMatchObject({ status: "ok", nextOffset: RECALL_OUTPUT_PAGE_CHARS });
  });
});
