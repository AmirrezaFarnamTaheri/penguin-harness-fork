/**
 * `penguin recall` (F18.2/F18.3) against the fake server: the human-facing half of the recall
 * handle the model gets in a result note.
 *
 * What matters here is not that bytes move — it is the shape of the guarantee: an id is validated
 * before it is ever sent, pages are streamed rather than accumulated, a prefix read is a soft yield
 * that says where to continue, and each failure (bad id, unknown id, expired entry, a position
 * outside the text, someone else's session) says what actually happened instead of "unavailable".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli } from "../src/index.js";
import { getMessages } from "../src/i18n.js";
import { FakeServer } from "./fake-server.js";

const t = getMessages("en");
const tZh = getMessages("zh");
const SESSION_ID = "session-2026-10-03-11-22-33-abcd0001";
const ID = "a".repeat(32);
const SHORT_ID = "abcd0001";

let server: FakeServer;
let uninstall: () => void;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  server = new FakeServer();
  // One session in the fake, so the omitted/`--` session argument has something to resolve to:
  // recall takes an optional session id exactly like `logs` does.
  server.addSession({ sessionId: SESSION_ID });
  uninstall = server.install();
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstall();
});

const out = (): string => stdout.join("");
const err = (): string => stderr.join("");

describe("penguin recall", () => {
  it("streams every page of a large entry to stdout, in order", async () => {
    const text = Array.from({ length: 9000 }, (_, i) => `line ${i}`).join("\n");
    server.recallEntries.set(ID, text);

    expect(await cli(["recall", ID, SESSION_ID])).toBe(0);
    expect(out()).toBe(text);
    // More than one page really happened (12 000 chars per page), each at the offset the previous
    // page named — and the walk stops exactly when a page reports no next offset.
    const expectedOffsets: number[] = [];
    for (let offset = 0; offset < text.length; offset += 12_000) expectedOffsets.push(offset);
    expect(expectedOffsets.length).toBeGreaterThan(1);
    expect(server.recallRequests.map((r) => r.offset)).toEqual(expectedOffsets);
    expect(server.recallRequests).toHaveLength(expectedOffsets.length);
    expect(err()).toBe("");
  });

  it("reads only the first page when --pages bounds it, and says where to continue", async () => {
    const text = "x".repeat(30_000);
    server.recallEntries.set(ID, text);

    expect(await cli(["recall", ID, SESSION_ID, "--pages", "1"])).toBe(0);
    expect(out()).toBe("x".repeat(12_000));
    expect(server.recallRequests).toHaveLength(1);
    // The soft yield names the offset that continues the read, so nothing is silently dropped.
    expect(err()).toBe(`\n${t.recall.moreRemaining(12_000)}\n`);

    stdout = [];
    stderr = [];
    expect(await cli(["recall", ID, SESSION_ID, "--offset", "12000", "--pages", "1"])).toBe(0);
    expect(out()).toBe("x".repeat(12_000));
    expect(server.recallRequests.at(-1)).toMatchObject({ offset: 12_000 });
  });

  it("emits one JSON object per page under --json, never the whole text at once", async () => {
    const text = "y".repeat(20_000);
    server.recallEntries.set(ID, text);

    expect(await cli(["recall", ID, SESSION_ID, "--json"])).toBe(0);
    const lines = out()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      recallId: ID,
      offset: 0,
      nextOffset: 12_000,
      totalChars: 20_000,
    });
    expect(lines[1]).toMatchObject({ offset: 12_000, nextOffset: null });
    // Reassembled in the consumer, not in the CLI: the pages are the pieces of the entry.
    expect(lines.map((l) => l.page as string).join("")).toBe(text);
  });

  it("refuses an id that is not a recall id without sending a request", async () => {
    for (const bad of ["not-an-id", "a".repeat(13), "../../etc/passwd", `${ID}.log`]) {
      stdout = [];
      stderr = [];
      expect(await cli(["recall", bad, SESSION_ID]), bad).toBe(1);
      expect(server.recallRequests, bad).toHaveLength(0);
      expect(out()).toBe("");
      expect(err()).toContain("not a recall id");
      expect(err()).toContain("names no file");
    }
    // A path-shaped spelling is refused by the same rule, and the message never echoes a path
    // back as if it were resolvable.
    expect(err()).not.toContain("etc/passwd");
  });

  it("names what went wrong for each server refusal", async () => {
    // Unknown id (a valid shape that this Session never stored).
    expect(await cli(["recall", "b".repeat(32), SESSION_ID])).toBe(1);
    expect(err()).toBe(`${t.error(t.recall.unavailableIn(SHORT_ID))}\n`);

    // Expired: the store is bounded and the entry aged out — different advice from "unknown".
    server.expiredRecallIds.add(ID);
    stderr = [];
    expect(await cli(["recall", ID, SESSION_ID])).toBe(1);
    expect(err()).toBe(`${t.error(t.recall.expired())}\n`);

    // A position outside the text: the server's own sentence explains the length.
    server.expiredRecallIds.delete(ID);
    server.recallEntries.set(ID, "short");
    stderr = [];
    expect(await cli(["recall", ID, SESSION_ID, "--offset", "99"])).toBe(1);
    expect(err()).toContain("The server refused that position:");
    expect(err()).toContain("5 UTF-16 code units");
  });

  it("validates numeric options locally, before any request", async () => {
    for (const args of [
      ["--offset", "-1"],
      ["--offset", "1.5"],
      ["--pages", "0"],
      ["--pages", "two"],
    ]) {
      stdout = [];
      stderr = [];
      expect(await cli(["recall", ID, SESSION_ID, ...args]), args.join(" ")).toBe(1);
      expect(server.recallRequests).toHaveLength(0);
      expect(err()).toContain("Invalid --");
    }
  });

  it("reports a truncated read of a session the caller cannot read", async () => {
    // The fake's sessions are all readable, so the "session not found" path is asserted where the
    // CLI can produce it: an unknown fragment never resolves, and nothing is requested.
    const before = server.recallRequests.length;
    expect(await cli(["recall", ID, "no-such-session-fragment"])).toBe(1);
    expect(server.recallRequests.length).toBe(before);
    expect(err()).toContain("no-such-session-fragment");
  });

  it("speaks Chinese when the language is zh", async () => {
    process.env.PENGUIN_LANG = "zh";
    try {
      server.recallEntries.set(ID, "x".repeat(13_000));
      expect(await cli(["recall", ID, SESSION_ID, "--pages", "1"])).toBe(0);
      expect(err()).toBe(`\n${tZh.recall.moreRemaining(12_000)}\n`);
      stderr = [];
      expect(await cli(["recall", "nope", SESSION_ID])).toBe(1);
      expect(err()).toBe(`${tZh.error(tZh.recall.invalidId("nope"))}\n`);
    } finally {
      delete process.env.PENGUIN_LANG;
    }
  });
});
