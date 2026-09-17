import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateAuditReceipt, AuditRecorder } from "../src/sandbox/audit.js";
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
