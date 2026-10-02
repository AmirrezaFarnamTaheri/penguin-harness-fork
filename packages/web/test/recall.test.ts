/**
 * Web-side recall metadata parsing and bounded paging (F18.1).
 *
 * The renderer shows the note the harness writes next to a compressed result; this module is what
 * turns that note into a usable handle. The cases below are the ones that matter for safety and
 * for a reader: only a real metadata object yields an id (a path-shaped string in prose or in a
 * different field does not), the id shape is the same one the server enforces, and a multi-page
 * read is bounded and reports what it has instead of discarding a prefix on failure.
 */
import { describe, expect, it, vi } from "vitest";
import {
  collectRecallText,
  parseRecallMetadata,
  RECALL_ID_RE,
  recallPageUrl,
} from "../src/lib/recall.js";

const ID = "3f9a1c8b2d4e6f70a1b2c3d4e5f60718"; // 32 hex
const LEGACY_ID = "3f9a1c8b2d4e"; // 12 hex

const note = (id: string, extra = "") =>
  `[full output (12000 lines) is recoverable in this Session — {"recallId":"${id}","sizeBytes":524288,"tokenCount":131072}${extra} (tokenCount is a bytes/4 estimate); call recall_output with recall_id "${id}" and offset 0]`;

/** A fetch stub that serves pages of `text` in `pageSize` chunks, following the server's shape. */
function pageServer(text: string, pageSize: number) {
  const calls: string[] = [];
  const fetchPage = async (url: string) => {
    calls.push(url);
    const offset = Number(new URL(url, "http://test.invalid").searchParams.get("offset") ?? "0");
    const end = Math.min(text.length, offset + pageSize);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        recallId: ID,
        offset,
        page: text.slice(offset, end),
        nextOffset: end < text.length ? end : null,
        totalChars: text.length,
      }),
    };
  };
  return { fetchPage, calls };
}

describe("F18.1 recall metadata", () => {
  it("reads the id, size and token estimate out of a published note", () => {
    expect(parseRecallMetadata(note(ID))).toEqual({
      recallId: ID,
      sizeBytes: 524288,
      tokenCount: 131072,
    });
    // The legacy 12-character ids are still issued for older entries and still valid.
    expect(parseRecallMetadata(note(LEGACY_ID))?.recallId).toBe(LEGACY_ID);
    // A note with only the id (the archive's compact form) is enough.
    expect(parseRecallMetadata(`see {"recallId":"${ID}"} for the rest`)).toEqual({
      recallId: ID,
      sizeBytes: null,
      tokenCount: null,
    });
    // Case is normalized; the server's ids are lowercase anyway.
    expect(parseRecallMetadata(`{"recallId":"${ID.toUpperCase()}"}`)?.recallId).toBe(ID);
  });

  it("does not mistake prose, paths or other fields for a recall id", () => {
    for (const text of [
      "",
      "no metadata here",
      '{"recallId":"../../etc/passwd"}',
      '{"recallId":"3f9a1c8b2d4e6f70a1b2c3d4e5f60718.log"}',
      '{"recallId":"sub/3f9a1c8b2d4e6f70a1b2c3d4e5f60718"}',
      '{"recallId":"3f9a1c8b2d4e6f70a1b2c3d4e5f6071"}', // 31 chars
      '{"recallId":123456789012}',
      '{"recall_id":"3f9a1c8b2d4e6f70a1b2c3d4e5f60718"}', // the tool argument's name, not metadata
      `{not json ${ID}}`,
      '{"recallId":"3f9a1c8b2d4e6f70a1b2c3d4e5f60718"', // unterminated
    ]) {
      expect(parseRecallMetadata(text), text).toBeNull();
    }
    // A metadata-looking object early in the text that is NOT recall metadata must not stop the
    // scan: the real one later in the same text still wins.
    const text = `[stats {"sizeBytes":12} then {"recallId":"${ID}"}]`;
    expect(parseRecallMetadata(text)?.recallId).toBe(ID);
  });

  it("builds page URLs that cannot address anything but a recall id", () => {
    expect(recallPageUrl("session-1", ID, 0)).toBe(`/api/sessions/session-1/recall/${ID}?offset=0`);
    expect(recallPageUrl("session/one", LEGACY_ID, 12_000)).toBe(
      `/api/sessions/session%2Fone/recall/${LEGACY_ID}?offset=12000`,
    );
    for (const bad of ["../../etc/passwd", `${ID}.log`, "x", ""]) {
      expect(() => recallPageUrl("session-1", bad), bad).toThrow(/not a recall id/);
    }
    for (const badOffset of [-1, 1.5, Number.NaN]) {
      expect(() => recallPageUrl("session-1", ID, badOffset), String(badOffset)).toThrow(
        /invalid recall offset/,
      );
    }
    expect(RECALL_ID_RE.test(ID)).toBe(true);
    expect(RECALL_ID_RE.test("nope")).toBe(false);
  });

  it("walks every page in order and reassembles the text exactly", async () => {
    const text = "abcdefghij".repeat(25); // 250 chars
    const { fetchPage, calls } = pageServer(text, 40);
    const chunks: string[] = [];
    const result = await collectRecallText(fetchPage, {
      sessionId: "session-1",
      recallId: ID,
      onChunk: (chunk) => chunks.push(chunk),
    });
    expect(result).toEqual({ status: "complete", text, pages: 7 });
    expect(chunks.join("")).toBe(text);
    // Offsets advance by the page size, and the last request is the page that ends the text.
    expect(calls).toHaveLength(7);
    expect(calls[0]).toContain("offset=0");
    expect(calls[1]).toContain("offset=40");
    expect(calls.at(-1)).toContain("offset=240");
  });

  it("stops at the page limit and reports where to continue", async () => {
    const text = "x".repeat(1000);
    const { fetchPage, calls } = pageServer(text, 100);
    const result = await collectRecallText(fetchPage, {
      sessionId: "session-1",
      recallId: ID,
      pageLimit: 3,
    });
    expect(result).toEqual({ status: "partial", text: "x".repeat(300), pages: 3, nextOffset: 300 });
    expect(calls).toHaveLength(3);
    // Resuming with the reported offset continues exactly where the bounded read stopped.
    const rest = await collectRecallText(fetchPage, {
      sessionId: "session-1",
      recallId: ID,
      offset: 300,
      pageLimit: 7,
    });
    expect(rest.status).toBe("complete");
    expect((result as { text: string }).text + (rest as { text: string }).text).toBe(text);
  });

  it("keeps what it already read when a later page fails", async () => {
    const text = "0123456789".repeat(20);
    let calls = 0;
    const fetchPage = async (url: string) => {
      calls += 1;
      if (calls === 1) return pageServer(text, 50).fetchPage(url);
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: { message: "expired" } }),
      } as never;
    };
    const result = await collectRecallText(fetchPage, { sessionId: "session-1", recallId: ID });
    expect(result).toMatchObject({ status: "partial", pages: 1, nextOffset: 50 });
    expect((result as { text: string }).text).toBe(text.slice(0, 50));

    // A first-page failure is a failure, with the server's own message.
    const failing = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: "This output id is unavailable in this Session." } }),
    });
    expect(await collectRecallText(failing, { sessionId: "session-1", recallId: ID })).toEqual({
      status: "failed",
      text: "",
      pages: 0,
      error: "This output id is unavailable in this Session.",
    });

    // A throw (offline) is the same shape, and never escapes as an exception.
    const throwing = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await collectRecallText(throwing, { sessionId: "session-1", recallId: ID })).toEqual({
      status: "failed",
      text: "",
      pages: 0,
      error: "network down",
    });
  });

  it("treats an empty page that reports no next offset as the whole entry", async () => {
    const empty = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ recallId: ID, offset: 0, page: "", nextOffset: null, totalChars: 0 }),
    });
    expect(await collectRecallText(empty, { sessionId: "session-1", recallId: ID })).toEqual({
      status: "complete",
      text: "",
      pages: 1,
    });
  });
});
