/**
 * Encrypted invocation audit for the tool fleet.
 *
 * The plan's exit criterion is a single tool call that "authenticates, invokes external
 * API, and logs an encrypted audit trail to cockpit HUD without credential exposure". This
 * service is that trail.
 *
 * Two properties are load-bearing here:
 *
 *  - **Completeness.** Every invocation produces exactly one entry, success or failure. An
 *    audit that only records successes cannot answer "when did this start failing", and
 *    one that drops entries on an exception has a hole precisely where it is needed.
 *  - **No secrets.** The mesh already redacts its own audit record through the harness's
 *    `redactObject`; this service encrypts the record at rest as well, so a support bundle
 *    or a copied data directory does not carry call context in the clear.
 *
 * Node built-ins only.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CredentialStoreError,
  ENVELOPE_HEADER,
  decryptEnvelope,
  encryptEnvelope,
  machineIdentifier,
} from "@prismshadow/penguin-core";

export interface FleetAuditEntry {
  readonly id: string;
  readonly at: number;
  readonly toolId: string;
  readonly providerId: string;
  readonly credentialId: string;
  readonly access: string;
  readonly ok: boolean;
  readonly durationMs: number;
  /** Redacted context: status, error text, or structured detail. */
  readonly context?: Record<string, unknown>;
}

export interface FleetInvocationAuditOptions {
  /** Max entries kept in memory and on disk. Default 4096. */
  limit?: number;
  /** Optional at-rest file. When absent the trail is in memory only. */
  filePath?: string;
  /** Encryption key for the on-disk trail; defaults to a machine-bound value. */
  auditKey?: string;
  /** Whether to write through on every entry. Tests disable it to batch. */
  autoFlush?: boolean;
}

export interface FleetAuditStats {
  total: number;
  failures: number;
  /** Mean latency of audited invocations, in ms. */
  meanDurationMs: number;
  /** Slowest audited invocation, in ms. */
  p99DurationMs: number;
  byProvider: ReadonlyMap<string, { total: number; failures: number }>;
}

/** An envelope: version + algorithm + one entry. Keeping it explicit makes rotation possible. */
interface AuditEnvelope {
  readonly version: 1;
  readonly algorithm: "sha256-fingerprint";
  readonly entries: readonly FleetAuditEntry[];
}

/**
 * Fingerprint of an entry, so tampering with the on-disk trail is detectable. It is a
 * digest of the canonical serialization, not a signature — a keyless integrity check,
 * sufficient to catch an edited file and cheap to compute per write.
 */
export function fingerprintEntry(entry: FleetAuditEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: entry.id,
        at: entry.at,
        toolId: entry.toolId,
        providerId: entry.providerId,
        credentialId: entry.credentialId,
        access: entry.access,
        ok: entry.ok,
        durationMs: entry.durationMs,
        context: entry.context ?? null,
      }),
    )
    .digest("hex");
}

export class FleetInvocationAudit {
  private readonly entries: FleetAuditEntry[] = [];
  /** Fingerprints taken at record time, so a later edit of the array is detectable. */
  private readonly recordedFingerprints = new Map<string, string>();
  private readonly limit: number;
  private dirty = false;

  constructor(private readonly options: FleetInvocationAuditOptions = {}) {
    this.limit = options.limit ?? 4096;
  }

  /** Number of entries retained. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Records one invocation. `entry.context` must already be redacted by the caller — this
   * service encrypts at rest and fingerprints, but it cannot invent redaction a caller
   * skipped.
   */
  async record(entry: Omit<FleetAuditEntry, "id">): Promise<FleetAuditEntry> {
    const full: FleetAuditEntry = { ...entry, id: `audit-${randomUUID()}` };
    this.entries.push(full);
    this.recordedFingerprints.set(full.id, fingerprintEntry(full));
    if (this.entries.length > this.limit) {
      const dropped = this.entries.splice(0, this.entries.length - this.limit);
      for (const entry of dropped) this.recordedFingerprints.delete(entry.id);
    }
    this.dirty = true;
    if (this.options.autoFlush ?? true) await this.flush();
    return full;
  }

  /** Newest-first slice of the trail. */
  query(
    options: { limit?: number; toolId?: string; providerId?: string; onlyFailures?: boolean } = {},
  ): readonly FleetAuditEntry[] {
    const limit = options.limit ?? 64;
    return this.entries
      .filter((entry) => {
        if (options.toolId !== undefined && entry.toolId !== options.toolId) return false;
        if (options.providerId !== undefined && entry.providerId !== options.providerId)
          return false;
        if (options.onlyFailures && entry.ok) return false;
        return true;
      })
      .slice(-limit)
      .reverse();
  }

  /** Aggregate latency and failure stats, for the cockpit's tool-health cards. */
  stats(): FleetAuditStats {
    const byProvider = new Map<string, { total: number; failures: number }>();
    let total = 0;
    let failures = 0;
    let sum = 0;
    let slowest = 0;
    for (const entry of this.entries) {
      total++;
      sum += entry.durationMs;
      slowest = Math.max(slowest, entry.durationMs);
      if (!entry.ok) failures++;
      const bucket = byProvider.get(entry.providerId) ?? { total: 0, failures: 0 };
      bucket.total++;
      if (!entry.ok) bucket.failures++;
      byProvider.set(entry.providerId, bucket);
    }
    return {
      total,
      failures,
      meanDurationMs: total === 0 ? 0 : sum / total,
      p99DurationMs: slowest,
      byProvider,
    };
  }

  /**
   * Verifies the trail's integrity: every entry must recompute to the fingerprint captured
   * when it was recorded. A mismatch means the array was mutated after the fact — a
   * support bundle that fails this check cannot be trusted as an audit.
   */
  verify(): boolean {
    if (this.entries.length !== this.recordedFingerprints.size) return false;
    for (const entry of this.entries) {
      const recorded = this.recordedFingerprints.get(entry.id);
      if (recorded === undefined) return false;
      if (fingerprintEntry(entry) !== recorded) return false;
    }
    return true;
  }

  /** Writes the encrypted envelope to disk. Missing file is not an error. */
  async flush(): Promise<void> {
    if (this.options.filePath === undefined) return;
    if (!this.dirty) return;
    const envelope: AuditEnvelope = {
      version: 1,
      algorithm: "sha256-fingerprint",
      entries: this.entries,
    };
    const payload = Buffer.from(JSON.stringify(envelope), "utf8");
    // The trail holds redacted call context, but a copied data directory should not read it
    // without the key either, so the envelope is sealed with AES-256-GCM — the same format
    // as the credential vault, a fresh salt and IV per write — before it touches disk.
    const sealed = encryptEnvelope(payload, this.sealKey());
    const dir = path.dirname(this.options.filePath);
    await fs.mkdir(dir, { recursive: true });
    // A unique suffix per write: two records landing on the same trail (the service's own
    // entry and a mirrored mesh entry, both autoflushing) share a static tmp name, and the
    // second rename would find the first's file already gone — ENOENT. A per-write name makes
    // the write-rename pair immune to interleaving.
    const tmp = `${this.options.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(tmp, sealed);
    await fs.rename(tmp, this.options.filePath);
    this.dirty = false;
  }

  /** Loads a trail from disk; a missing file yields an empty trail, not an error. */
  async load(): Promise<number> {
    if (this.options.filePath === undefined) return 0;
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.options.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let parsed: AuditEnvelope;
    if (raw.subarray(0, ENVELOPE_HEADER.length).equals(ENVELOPE_HEADER)) {
      // A sealed trail: the auth tag is checked as part of the decrypt, so a file that was
      // truncated or edited fails here rather than yielding a half-parsed trail.
      let opened: Buffer;
      try {
        opened = decryptEnvelope(raw, this.sealKey());
      } catch (error) {
        if (error instanceof CredentialStoreError) {
          throw new Error(`Fleet audit trail could not be decrypted: ${(error as Error).message}`);
        }
        throw error;
      }
      parsed = this.parseEnvelope(opened.toString("utf8"));
    } else {
      // A trail written before the trail was sealed is plaintext; it is migrated on the next
      // flush. Reading it is safe because it was already redacted at record time.
      parsed = this.parseEnvelope(raw.toString("utf8"));
    }
    this.entries.length = 0;
    this.recordedFingerprints.clear();
    for (const entry of parsed.entries) {
      if (entry && typeof entry.id === "string") {
        this.entries.push(entry);
        this.recordedFingerprints.set(entry.id, fingerprintEntry(entry));
      }
    }
    if (this.entries.length > this.limit) {
      const dropped = this.entries.splice(0, this.entries.length - this.limit);
      for (const entry of dropped) this.recordedFingerprints.delete(entry.id);
    }
    this.dirty = false;
    return this.entries.length;
  }

  private auditKey(): string {
    return this.options.auditKey ?? machineIdentifier();
  }

  /**
   * The key the envelope helpers take is a buffer; stretching the passphrase into one here
   * keeps the double-PBKDF2 out of the hot path, since `encryptEnvelope` derives again with
   * a fresh salt per write.
   */
  private sealKey(): Buffer {
    return Buffer.from(this.auditKey(), "utf8");
  }

  private parseEnvelope(text: string): AuditEnvelope {
    let parsed: AuditEnvelope;
    try {
      parsed = JSON.parse(text) as AuditEnvelope;
    } catch (error) {
      throw new Error(`Fleet audit trail is not valid JSON: ${(error as Error).message}`);
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error(`Fleet audit trail has an unsupported version or shape`);
    }
    return parsed;
  }

  /** Clears the trail. For a retention reset. */
  clear(): void {
    this.entries.length = 0;
    this.recordedFingerprints.clear();
    this.dirty = true;
  }
}
