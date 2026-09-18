import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateAuditReceipt, AuditRecorder } from "../src/sandbox/audit.js";
import { readAuditReceipts } from "../src/sandbox/read-audit.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolCall, assistantText } from "@prismshadow/penguin-core";

const input = {
  agentId: "ag-1",
  command: "git status",
  timestamp: 1700000000000,
  secret: "test-signing-key",
};

const context = {
  projectId: "p1",
  agentId: "a1",
  sessionId: "s1",
  provider: "custom",
  modelId: "test",
};

it("persists verifiable tool receipts across recorder recreation without copying tool secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "audit-signing-"));
  const forwarded: string[] = [];
  const next = {
    record: async (_ctx: typeof context, msg: { type: string }) => {
      forwarded.push(msg.type);
    },
  };
  const call = toolCall({
    name: "exec_command",
    arguments: '{"cmd":"echo private-value"}',
    toolCallId: "tc1",
  });
  const first = new AuditRecorder(root, next);
  await first.record(context, assistantText("not an audit event"));
  await first.record(context, call);
  const keyBefore = await fs.readFile(path.join(root, "audit", "signing.key"), "utf8");
  const second = new AuditRecorder(root, next);
  await second.record(context, call);
  expect(await fs.readFile(path.join(root, "audit", "signing.key"), "utf8")).toBe(keyBefore);
  const log = await fs.readFile(path.join(root, "audit", "events.jsonl"), "utf8");
  expect(log).not.toContain("private-value");
  const records = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(record.payload).toMatchObject({
      projectId: "p1",
      agentId: "a1",
      sessionId: "s1",
      type: "tool_call",
    });
    const hash = createHash("sha256").update(JSON.stringify(record.payload)).digest("hex");
    expect(record.payloadHash).toBe(hash);
    expect(record.signature).toBe(createHmac("sha256", keyBefore).update(hash).digest("hex"));
  }
  expect(forwarded).toHaveLength(3);
});

it("refuses a corrupt persisted key rather than silently rotating it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "audit-invalid-"));
  await fs.mkdir(path.join(root, "audit"));
  await fs.writeFile(path.join(root, "audit", "signing.key"), "invalid");
  expect(() => new AuditRecorder(root, { record: async () => {} })).toThrow(
    "Invalid audit signing key",
  );
});

describe("cryptographic audit receipt", () => {
  it("hashes the structured payload and authenticates the hash with HMAC-SHA256", () => {
    const payload = JSON.stringify([input.agentId, input.command, input.timestamp]);
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const signature = createHmac("sha256", input.secret).update(payloadHash).digest("hex");
    expect(generateAuditReceipt(input)).toEqual({
      payloadHash,
      signature,
      timestamp: input.timestamp,
    });
  });

  it("binds the receipt to every payload field and the signing key", () => {
    const receipt = generateAuditReceipt(input);
    expect(generateAuditReceipt(input)).toEqual(receipt);
    for (const change of [
      { agentId: "ag-2" },
      { command: "git diff" },
      { timestamp: input.timestamp + 1 },
      { secret: "different-test-key" },
    ]) {
      expect(generateAuditReceipt({ ...input, ...change }).signature).not.toBe(receipt.signature);
    }
  });

  it("does not confuse delimiters inside the agent id with command delimiters", () => {
    const first = generateAuditReceipt({ ...input, agentId: "agent:part", command: "status" });
    const second = generateAuditReceipt({ ...input, agentId: "agent", command: "part:status" });
    expect(first.payloadHash).not.toBe(second.payloadHash);
    expect(first.signature).not.toBe(second.signature);
  });
});

describe("bounded verified audit reader", () => {
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-audit-"));
    const recorder = new AuditRecorder(root, { record: async () => {} });
    const log = path.join(root, "audit", "events.jsonl");
    async function record(projectId: string, sessionId: string) {
      await recorder.record(
        { projectId, sessionId, agentId: "agent", provider: "custom", modelId: "test" },
        toolCall({
          name: "read_file",
          arguments: '{"path":"private-value"}',
          toolCallId: sessionId,
        }),
      );
    }
    return { root, log, record };
  }

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
      "executingSessionId",
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

  it("authenticates execution origin and does not invent it for legacy or malformed receipts", async () => {
    const f = await fixture();
    await f.record("alpha", "owner");
    const original = JSON.parse((await fs.readFile(f.log, "utf8")).trim());
    const secret = await fs.readFile(path.join(f.root, "audit", "signing.key"), "utf8");
    for (const origin of [undefined, ["child", "grandchild"], [17], [""], "child"]) {
      const payload = { ...original.payload, origin };
      const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const signature = createHmac("sha256", secret).update(payloadHash).digest("hex");
      await fs.appendFile(f.log, JSON.stringify({ payload, payloadHash, signature }) + "\n");
    }
    // Altering origin without signing it again must not change the attributed executor.
    await fs.appendFile(
      f.log,
      JSON.stringify({ ...original, payload: { ...original.payload, origin: ["forged"] } }) + "\n",
    );
    const result = await readAuditReceipts(f.root, { projectId: "alpha" });
    expect(result.receipts.map((r) => r.executingSessionId)).toEqual(["grandchild", null, "owner"]);
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
