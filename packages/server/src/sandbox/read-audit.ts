import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AuditReceipt, AuditReceiptsResponse } from "../api/types.js";

// Bound disk I/O, parsing and response size independently of the append-only log's age.
const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_RECEIPTS = 50;
const DIGEST = /^[a-f0-9]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verifyLine(line: string, secret: string): AuditReceipt | null {
  let receipt: unknown;
  try {
    receipt = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(receipt) || !isObject(receipt.payload)) return null;
  const { payload, payloadHash, signature } = receipt;
  if (
    typeof payloadHash !== "string" ||
    !DIGEST.test(payloadHash) ||
    typeof signature !== "string" ||
    !DIGEST.test(signature)
  )
    return null;
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  if (hash !== payloadHash) return null;
  const expected = createHmac("sha256", secret).update(hash).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
  const { version, projectId, agentId, sessionId, timestamp, type, eventHash } = payload;
  if (
    version !== 1 ||
    typeof projectId !== "string" ||
    typeof agentId !== "string" ||
    typeof sessionId !== "string" ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    Math.abs(timestamp) > 8.64e15 ||
    (type !== "tool_call" && type !== "tool_call_output" && type !== "approval_decision") ||
    typeof eventHash !== "string" ||
    !DIGEST.test(eventHash)
  )
    return null;
  // Derive execution scope only from authenticated origin metadata. Keep ownership
  // unchanged; a child session ID does not establish the child's Agent State identity.
  const { origin } = payload;
  if (
    origin !== undefined &&
    (!Array.isArray(origin) || !origin.every((id) => typeof id === "string" && id.length > 0))
  )
    return null;
  const executingSessionId =
    origin === undefined ? null : origin.length ? origin[origin.length - 1] : sessionId;
  // Allowlist the view: never expose the key or the complete origin chain to clients.
  return {
    payloadHash,
    projectId,
    agentId,
    sessionId,
    executingSessionId,
    timestamp,
    type,
    eventHash,
  };
}

async function openRegular(file: string) {
  if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("Audit file cannot be a symlink");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error("Audit file must be regular");
  }
  return handle;
}

/** Read-only verified projection, newest append first; not a causal chain or a full-log audit. */
export async function readAuditReceipts(
  root: string,
  { projectId, limit = MAX_RECEIPTS }: { projectId: string; limit?: number },
): Promise<AuditReceiptsResponse> {
  const count = Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_RECEIPTS, Math.floor(limit)))
    : MAX_RECEIPTS;
  const directory = path.join(root, "audit");
  let log;
  try {
    if ((await fs.lstat(directory)).isSymbolicLink())
      throw new Error("Audit directory cannot be a symlink");
    log = await openRegular(path.join(directory, "events.jsonl"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { receipts: [], truncated: false };
    }
    throw error;
  }
  try {
    // A missing/corrupt key with an existing log is an error, never an empty verified feed.
    const key = await openRegular(path.join(directory, "signing.key"));
    let secret: string;
    try {
      if ((await key.stat()).size !== 64) throw new Error("Invalid audit signing key");
      const bytes = Buffer.alloc(64);
      const { bytesRead } = await key.read(bytes, 0, bytes.length, 0);
      secret = bytes.subarray(0, bytesRead).toString("utf8");
      if (!DIGEST.test(secret)) throw new Error("Invalid audit signing key");
    } finally {
      await key.close();
    }
    const size = (await log.stat()).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const bytes = Buffer.alloc(Math.min(size, MAX_TAIL_BYTES));
    const { bytesRead } = await log.read(bytes, 0, bytes.length, start);
    const tail = bytes.subarray(0, bytesRead).toString("utf8");
    // Ignore both the leading partial line and an append not yet terminated by a newline.
    const first = start > 0 ? tail.indexOf("\n") + 1 : 0;
    const last = tail.lastIndexOf("\n");
    const lines = last >= first ? tail.slice(first, last).split("\n") : [];
    const receipts: AuditReceipt[] = [];
    let truncated = start > 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const receipt = verifyLine(lines[i]!, secret);
      if (!receipt || receipt.projectId !== projectId) continue;
      if (receipts.length === count) {
        truncated = true;
        break;
      }
      receipts.push(receipt);
    }
    return { receipts, truncated };
  } finally {
    await log.close();
  }
}
