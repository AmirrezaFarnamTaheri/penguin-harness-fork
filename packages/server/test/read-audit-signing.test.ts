import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolCall } from "@prismshadow/penguin-core";
import { describe, expect, it } from "vitest";
import { AuditRecorder } from "../src/sandbox/audit.js";
import { readAuditReceipts } from "../src/sandbox/read-audit.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-audit-"));
  const recorder = new AuditRecorder(root, { record: async () => {} });
  const log = path.join(root, "audit", "events.jsonl");
  async function record(projectId: string, sessionId: string) {
    await recorder.record(
      { projectId, sessionId, agentId: "agent", provider: "custom", modelId: "test" },
      toolCall({ name: "read_file", arguments: '{"path":"private-value"}', toolCallId: sessionId }),
    );
  }
  return { root, log, record };
}

describe("bounded verified audit reader", () => {
  it("returns newest project receipts, omits raw data and leaves the log/key unchanged", async () => {
    const f = await fixture();
    await f.record("alpha", "first");
    await f.record("beta", "other-project");
    await f.record("alpha", "last");
    const before = await fs.readFile(f.log, "utf8");
    const keyPath = path.join(f.root, "audit", "signing.key");
    const key = await fs.readFile(keyPath, "utf8");
    const result = await readAuditReceipts(f.root, { projectId: "alpha" });
    expect(result.receipts.map((r) => r.sessionId)).toEqual(["last", "first"]);
    expect(Object.keys(result.receipts[0]!).sort()).toEqual([
      "agentId",
      "eventHash",
      "payloadHash",
      "projectId",
      "sessionId",
      "timestamp",
      "type",
    ]);
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(await fs.readFile(f.log, "utf8")).toBe(before);
    expect(await fs.readFile(keyPath, "utf8")).toBe(key);
    expect(await readAuditReceipts(f.root, { projectId: "alpha", limit: 1 })).toMatchObject({
      receipts: [{ sessionId: "last" }],
      truncated: true,
    });
  });

  it("drops malformed lines, altered payloads/hashes and valid hashes with invalid HMACs", async () => {
    const f = await fixture();
    await f.record("alpha", "original");
    const original = JSON.parse((await fs.readFile(f.log, "utf8")).trim());
    const altered = { ...original, payload: { ...original.payload, sessionId: "altered" } };
    const hashOnly = {
      ...altered,
      payloadHash: createHash("sha256").update(JSON.stringify(altered.payload)).digest("hex"),
    };
    const badHash = { ...original, payloadHash: "0".repeat(64) };
    await fs.appendFile(
      f.log,
      [altered, hashOnly, badHash].map((r) => JSON.stringify(r)).join("\n") + "\n{broken}\n",
    );
    expect(
      (await readAuditReceipts(f.root, { projectId: "alpha" })).receipts.map((r) => r.sessionId),
    ).toEqual(["original"]);
  });

  it("bounds the result and byte window and ignores incomplete appends", async () => {
    const f = await fixture();
    await f.record("alpha", "too-old");
    await fs.appendFile(f.log, "x".repeat(1024 * 1024) + "\n");
    for (let i = 0; i < 52; i++) await f.record("alpha", `s${i}`);
    await fs.appendFile(f.log, '{"payload":');
    const result = await readAuditReceipts(f.root, { projectId: "alpha", limit: 999 });
    expect(result.truncated).toBe(true);
    expect(result.receipts).toHaveLength(50);
    expect(result.receipts[0]?.sessionId).toBe("s51");
    expect(result.receipts.at(-1)?.sessionId).toBe("s2");
  });

  it("returns empty for no log, but rejects a corrupt key when a log exists", async () => {
    const f = await fixture();
    expect(await readAuditReceipts(f.root, { projectId: "alpha" })).toEqual({
      receipts: [],
      truncated: false,
    });
    await f.record("alpha", "recorded");
    await fs.writeFile(path.join(f.root, "audit", "signing.key"), "invalid");
    await expect(readAuditReceipts(f.root, { projectId: "alpha" })).rejects.toThrow(
      "Invalid audit signing key",
    );
  });
});
