import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OmniMessage } from "@prismshadow/penguin-core";
import type { UsageContext } from "../runtime/usage-recorder.js";

/** Server-owned recorder; raw arguments/output remain in the existing trace, not this log. */
export class AuditRecorder {
  private readonly secret: string;
  private readonly logPath: string;

  constructor(
    root: string,
    private readonly next: { record(ctx: UsageContext, msg: OmniMessage): Promise<void> },
  ) {
    const directory = path.join(root, "audit");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error("Audit directory cannot be a symlink");
    const keyPath = path.join(directory, "signing.key");
    try {
      fs.writeFileSync(keyPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    if (fs.lstatSync(keyPath).isSymbolicLink()) throw new Error("Audit key cannot be a symlink");
    this.secret = fs.readFileSync(keyPath, "utf8");
    if (!/^[a-f0-9]{64}$/.test(this.secret)) throw new Error("Invalid audit signing key");
    this.logPath = path.join(directory, "events.jsonl");
  }

  async record(ctx: UsageContext, msg: OmniMessage): Promise<void> {
    const payloadType = (msg.payload as { type?: string }).type;
    if (
      payloadType === "tool_call" ||
      payloadType === "tool_call_output" ||
      payloadType === "approval_decision"
    ) {
      const payload = {
        version: 1,
        projectId: ctx.projectId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        origin: msg.origin ?? [],
        timestamp: Date.now(),
        type: payloadType,
        eventHash: createHash("sha256").update(JSON.stringify(msg)).digest("hex"),
      };
      const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const signature = createHmac("sha256", this.secret).update(payloadHash).digest("hex");
      // Synchronous append+fsync keeps same-process writers ordered, including background streams.
      const fd = fs.openSync(
        this.logPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        fs.writeFileSync(fd, JSON.stringify({ payload, payloadHash, signature }) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    await this.next.record(ctx, msg);
  }
}

/** A keyed integrity receipt, not proof of who controlled the local server. */
export function generateAuditReceipt(opts: {
  agentId: string;
  command: string;
  timestamp: number;
  secret: string;
}): { payloadHash: string; signature: string; timestamp: number } {
  // JSON preserves field boundaries even when identifiers or commands contain colons.
  const payload = JSON.stringify([opts.agentId, opts.command, opts.timestamp]);
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const signature = createHmac("sha256", opts.secret).update(payloadHash).digest("hex");
  return { payloadHash, signature, timestamp: opts.timestamp };
}
