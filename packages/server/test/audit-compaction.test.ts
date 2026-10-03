/**
 * I6 — compact audit payloads: privacy and readback fixtures.
 *
 * The named negatives from the card each have a case here: nested credential, truncated secret,
 * unknown header, large multibyte body, invalid integrity, and "an export must not leak or claim a
 * complete omitted payload". The recorder round-trip case uses the real `AuditRecorder` and the real
 * `readAuditReceipts`, so the compaction is proven against the reader that verifies it.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIT_CIRCULAR_MARKER,
  AUDIT_DETAILS_MAX_BYTES,
  AUDIT_DETAILS_MAX_STRING_CHARS,
  AUDIT_DIGEST_KEY,
  AUDIT_STRUCTURE_KEY,
  AUDIT_TRUNCATED_SUFFIX,
  auditStoredPayloadHash,
  auditStoredPayloadSignature,
  compactAuditDetails,
  redactAuditValue,
} from "../src/sandbox/audit-compaction.js";
import { redactTraceRecord } from "@prismshadow/penguin-core";
import { AuditRecorder } from "../src/sandbox/audit.js";
import { readAuditReceipts } from "../src/sandbox/read-audit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "penguin-audit-compaction-"));
  roots.push(root);
  return root;
}

const SECRET = "sk-live-0123456789abcdef0123456789abcdef";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";

describe("I6.2 — redact before anything is kept", () => {
  it("redacts a credential nested three levels deep and keeps the structure readable", () => {
    const details = compactAuditDetails({
      request: { outer: { inner: { apiKey: SECRET, note: "kept" } } },
    });
    const text = JSON.stringify(details.value);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("sk-live-");
    // Structure survives: the shape is the point of the digest.
    expect(text).toContain('"request"');
    expect(text).toContain('"outer"');
    expect(text).toContain('"inner"');
    expect(text).toContain('"apiKey"');
    expect(text).toContain(AUDIT_DIGEST_KEY);
    expect(details.omittedPaths).toContain("request.outer.inner.apiKey");
  });

  it("stores no part of a secret-bearing body, short or long", () => {
    // The secret sits at the *start* of a long string: keeping any prefix would publish it, and a
    // digest of the raw text would be an oracle. The body is stored as size + hash only.
    const details = compactAuditDetails({ output: `${SECRET} ${"x".repeat(4000)}` });
    const text = JSON.stringify(details.value);
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("0123456789abcdef");
    expect(text).not.toContain("xxxxxxxx");
    expect(details.omittedPaths).toEqual(["output"]);
    expect(details.shortenedPaths).toEqual([]);
    expect(details.truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(300);
  });

  it("digests an ordinary argument too: the log is not a copy of the call", () => {
    // The I1-era signing test is the specification here — a plain (non-secret) tool argument must
    // not appear in the log either.
    const details = compactAuditDetails({
      type: "tool_call",
      role: "assistant",
      name: "exec_command",
      arguments: '{"cmd":"echo private-value"}',
    });
    const text = JSON.stringify(details.value);
    expect(text).not.toContain("private-value");
    // Correlation fields keep their values, so a reader still knows what happened.
    expect((details.value as Record<string, unknown>).type).toBe("tool_call");
    expect((details.value as Record<string, unknown>).name).toBe("exec_command");
    expect(details.omittedPaths).toEqual(["arguments"]);
  });

  it("fails closed for an unknown header and keeps the allowlisted protocol ones", () => {
    const details = compactAuditDetails({
      headers: {
        authorization: BEARER,
        "x-unknown-vendor-token": SECRET,
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    const value = details.value as { headers: Record<string, string> };
    expect(value.headers.authorization).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(value.headers["x-unknown-vendor-token"]).not.toContain(SECRET);
    // I1's allowlist contract: routine protocol metadata stays readable.
    expect(value.headers.accept).toBe("application/json");
    expect(value.headers["content-type"]).toBe("application/json");
  });

  it("summarizes a nested error rather than storing its stack and raw message", () => {
    const inner = new Error(`upstream rejected ${SECRET}`);
    const outer = new Error("prompt failed", { cause: inner });
    const details = compactAuditDetails({ error: outer });
    const text = JSON.stringify(details.value);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack frames
    const error = (
      details.value as { error: { name: string; message: string; cause: { message: string } } }
    ).error;
    expect(error.name).toBe("Error");
    expect(error.message).toBe("prompt failed");
    expect(error.cause.message).toContain("<redacted>");
  });

  it("never mutates the value it is given", () => {
    const original = { request: { apiKey: SECRET }, list: [BEARER] };
    const snapshot = JSON.parse(JSON.stringify(original)) as unknown;
    compactAuditDetails(original);
    expect(original).toEqual(snapshot);
  });

  it("redacts bare strings through the same rules as objects", () => {
    expect(String(redactAuditValue(`token=${SECRET}`))).not.toContain(SECRET);
    expect(String(redactAuditValue("mail me at user@example.com"))).not.toContain(
      "user@example.com",
    );
  });
});

describe("I6.3 — deterministic bounds and structure", () => {
  it("keeps the serialized details under the byte ceiling for a large multibyte body", () => {
    const body = "日本語テキストと絵文字🀄".repeat(2000);
    const details = compactAuditDetails({ body, other: "kept" });
    const text = JSON.stringify(details.value);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(AUDIT_DETAILS_MAX_BYTES);
    expect(details.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(details.truncated).toBe(true);
    // The body is digested (so the multibyte text never reaches the log), and the digest is valid
    // UTF-8 throughout the JSON: no split code point, no replacement character.
    expect(text).not.toContain("日本語");
    expect(text).not.toContain("\uFFFD");
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  });

  it("shortens a kept multibyte value on a code-point boundary when the ceiling forces it", () => {
    // Each value is inside the verbatim budget (<= 512 bytes) so it is kept, and the three together
    // are over the 250-byte ceiling, which is what forces real shortening of real multibyte text.
    const value = "日本語テキスト".repeat(10);
    const details = compactAuditDetails(
      { name: value, status: value, mode: value },
      { maxBytes: 250 },
    );
    const text = JSON.stringify(details.value);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(250);
    expect(text).toContain(AUDIT_TRUNCATED_SUFFIX);
    expect(text).not.toContain("\uFFFD");
    expect(details.shortenedPaths.length).toBeGreaterThan(0);
    expect(details.truncated).toBe(true);
    // The shortened text is still valid UTF-8 text, not a split code point.
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  });

  it("is deterministic: the same value compacts to the same bytes every time", () => {
    const value = { body: "x".repeat(9000), nested: { a: [1, 2, 3], b: SECRET } };
    const first = compactAuditDetails(value);
    const second = compactAuditDetails(value);
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
    expect(second.shortenedPaths).toEqual(first.shortenedPaths);
    expect(second.bytes).toBe(first.bytes);
  });

  it("replaces over-deep and over-wide subtrees with structural summaries, not values", () => {
    const deep = { a: { b: { c: { d: { e: { secret: SECRET } } } } } };
    const deepDetails = compactAuditDetails(deep, { maxDepth: 3 });
    const deepText = JSON.stringify(deepDetails.value);
    expect(deepText).not.toContain(SECRET);
    expect(deepDetails.omittedPaths).toEqual(["a.b.c"]);
    expect(deepText).toContain(AUDIT_STRUCTURE_KEY);
    expect(deepText).toContain('"type":"object"');

    const wide = { list: Array.from({ length: 60 }, (_value, index) => `entry-${index}`) };
    const wideDetails = compactAuditDetails(wide, { maxChildren: 8 });
    expect(wideDetails.omittedPaths).toEqual(["list"]);
    const summary = (wideDetails.value as { list: Record<string, unknown> }).list;
    expect(summary[AUDIT_STRUCTURE_KEY]).toEqual({
      type: "array",
      count: 60,
      bytes: expect.any(Number),
    });
    // A summary states shape and size only — no `value`/`values` field to misread as content.
    expect(Object.keys(summary[AUDIT_STRUCTURE_KEY] as object).sort()).toEqual([
      "bytes",
      "count",
      "type",
    ]);
  });

  it("reports every shortening and omission so a reader cannot mistake a summary for the whole", () => {
    const details = compactAuditDetails({
      name: "n".repeat(400),
      status: "completed",
      deep: { a: { b: { c: { d: 1 } } } },
      body: "y".repeat(AUDIT_DETAILS_MAX_STRING_CHARS + 1),
    });
    expect(details.truncated).toBe(true);
    // `body` was omitted (digested), not shortened; `deep.a.b.c` was summarized.
    expect(details.omittedPaths).toContain("body");
    expect(details.omittedPaths).toContain("deep.a.b.c");
    const text = JSON.stringify(details.value);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(AUDIT_DETAILS_MAX_BYTES);
    // Values that were neither shortened nor omitted are not claimed as either.
    expect(details.shortenedPaths).not.toContain("status");
    expect((details.value as Record<string, unknown>).status).toBe("completed");
  });

  it("handles a circular value without throwing, saying only that it is an object", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const details = compactAuditDetails({ value: circular });
    const text = JSON.stringify(details.value);
    expect(text).toContain('"name":"loop"'); // a short correlation value survives
    expect(details.omittedPaths).toEqual(["value.self"]);
    expect(details.truncated).toBe(true);
    // The marker is a value like any other, so it appears only as a digest: nothing about the
    // cycle's content is stored, and the walk terminated.
    expect(text).toContain(AUDIT_DIGEST_KEY);
  });
});

describe("I6.4 — integrity over the stored form", () => {
  it("hashes the redacted, compacted payload, so verification proves what is on disk", () => {
    const details = compactAuditDetails({ body: `${SECRET} ${"z".repeat(5000)}` });
    const payload = { version: 1, type: "tool_call", details: details.value };
    const hash = auditStoredPayloadHash(payload);
    const signature = auditStoredPayloadSignature(payload, "a".repeat(64));
    // Tampering with the stored details breaks the hash; the signature covers the hash.
    const tampered = { ...payload, details: { body: "other" } };
    expect(auditStoredPayloadHash(tampered)).not.toBe(hash);
    expect(auditStoredPayloadSignature(tampered, "a".repeat(64))).not.toBe(signature);
    expect(auditStoredPayloadSignature(payload, "a".repeat(64))).toBe(signature);
  });
});

describe("I6.4 — recorder readback: correlation survives, secrets do not", () => {
  it("writes a bounded, redacted receipt that the reader still verifies", async () => {
    const root = tempRoot();
    const recorded: string[] = [];
    const recorder = new AuditRecorder(root, {
      record: async () => {
        recorded.push("next");
      },
    });
    const ctx = { projectId: "p1", agentId: "a1", sessionId: "s1" };
    await recorder.record(
      ctx as never,
      {
        origin: ["s1", "child-session"],
        payload: {
          type: "tool_call_output",
          output: `${SECRET} ${"body ".repeat(4000)}`,
          request: {
            headers: { authorization: BEARER, accept: "application/json" },
            nested: { apiKey: SECRET },
          },
        },
      } as never,
    );
    expect(recorded).toEqual(["next"]); // the recorder still forwards to the next sink

    const logPath = path.join(root, "audit", "events.jsonl");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(readFileSync(logPath, "utf8")).not.toContain("sk-live");
    expect(readFileSync(logPath, "utf8")).not.toContain("eyJhbGciOiJIUzI1NiJ9");

    const receipt = JSON.parse(lines[0]!) as {
      payload: {
        type: string;
        sessionId: string;
        origin: string[];
        details: unknown;
        detailsMeta: { bytes: number; truncated: boolean; shortened: number; omitted: number };
      };
      payloadHash: string;
      signature: string;
    };
    // Correlation and type survive verbatim; the details are capped and say so.
    expect(receipt.payload.type).toBe("tool_call_output");
    expect(receipt.payload.sessionId).toBe("s1");
    expect(receipt.payload.origin).toEqual(["s1", "child-session"]);
    expect(receipt.payload.detailsMeta.truncated).toBe(true);
    expect(receipt.payload.detailsMeta.bytes).toBeLessThanOrEqual(AUDIT_DETAILS_MAX_BYTES);
    expect(receipt.payload.detailsMeta.omitted).toBeGreaterThan(0);
    expect(receipt.payload.detailsMeta.shortened).toBe(0);
    expect(auditStoredPayloadHash(receipt.payload)).toBe(receipt.payloadHash);
    const details = receipt.payload.details as {
      type: string;
      request: { headers: Record<string, string> };
    };
    expect(details.type).toBe("tool_call_output");
    expect(details.request.headers.accept).toBe("application/json");
    expect(details.request.headers.authorization).not.toContain("eyJhbGciOiJIUzI1NiJ9");

    const read = await readAuditReceipts(root, { projectId: "p1" });
    expect(read.receipts).toHaveLength(1);
    expect(read.receipts[0]).toMatchObject({
      type: "tool_call_output",
      projectId: "p1",
      agentId: "a1",
      sessionId: "s1",
      executingSessionId: "child-session",
    });
  });

  it("digests — rather than shortens — a verbatim field that is over its own budget", () => {
    // `name` is correlation, but a 2 KB name is a body in disguise; it is digested like one.
    const details = compactAuditDetails({ name: "n".repeat(2000) });
    expect(details.omittedPaths).toEqual(["name"]);
    expect(details.shortenedPaths).toEqual([]);
    expect(JSON.stringify(details.value)).not.toContain("nnnn");
  });

  it("does not spin when a kept value is already at the shortening floor", () => {
    // Every kept string is already nothing but the truncation suffix, so no shortening can make it
    // shorter while the total is still over the ceiling. Without the loop's no-progress guard this
    // case never terminates; with it the digest falls back to a structure-only summary.
    const floor = "…[truncated]";
    const details = compactAuditDetails(
      { name: floor, status: floor, mode: floor },
      { maxBytes: 30 },
    );
    const text = JSON.stringify(details.value);
    expect(text).toContain(AUDIT_STRUCTURE_KEY);
    expect(details.omittedPaths).toContain("");
    expect(details.truncated).toBe(true);
  });

  it("hashes the redacted message, not the raw one, for eventHash", async () => {
    const root = tempRoot();
    const recorder = new AuditRecorder(root, { record: async () => {} });
    const message = { payload: { type: "tool_call", arguments: `{"cmd":"echo ${SECRET}"}` } };
    await recorder.record(
      { projectId: "p1", agentId: "a1", sessionId: "s1" } as never,
      message as never,
    );
    const line = JSON.parse(readFileSync(path.join(root, "audit", "events.jsonl"), "utf8")) as {
      payload: { eventHash: string };
    };
    // The recorded hash is over the redacted message: it equals the redacted digest and differs
    // from the raw one, so the hash can never be an oracle for a redacted credential.
    const redactedHash = createHash("sha256")
      .update(JSON.stringify(redactTraceRecord(message)))
      .digest("hex");
    const rawHash = createHash("sha256").update(JSON.stringify(message)).digest("hex");
    expect(line.payload.eventHash).toBe(redactedHash);
    expect(line.payload.eventHash).not.toBe(rawHash);
  });

  it("keeps an over-cap payload bounded on disk over many events", async () => {
    const root = tempRoot();
    const recorder = new AuditRecorder(root, { record: async () => {} });
    const ctx = { projectId: "p1", agentId: "a1", sessionId: "s1" };
    for (let index = 0; index < 5; index++) {
      await recorder.record(
        ctx as never,
        { payload: { type: "tool_call", args: { blob: "q".repeat(50_000), index } } } as never,
      );
    }
    const logPath = path.join(root, "audit", "events.jsonl");
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      // Envelope + one capped details block; nowhere near the 50 KB payload per event.
      expect(Buffer.byteLength(line, "utf8")).toBeLessThan(4096);
    }
  });

  it("skips a tampered line on readback instead of accepting an edited payload", async () => {
    const root = tempRoot();
    const recorder = new AuditRecorder(root, { record: async () => {} });
    const logPath = path.join(root, "audit", "events.jsonl");
    await recorder.record(
      { projectId: "p1", agentId: "a1", sessionId: "s1" } as never,
      { payload: { type: "tool_call", args: { command: "ls" } } } as never,
    );
    const line = JSON.parse(readFileSync(logPath, "utf8").trim()) as {
      payload: Record<string, unknown>;
    };
    line.payload.details = { args: { command: "rm -rf /" } };
    await fs.writeFile(logPath, `${JSON.stringify(line)}\n`, "utf8");
    const read = await readAuditReceipts(root, { projectId: "p1" });
    expect(read.receipts).toEqual([]);
  });
});
