/**
 * Fleet invocation audit tests: the encrypted audit trail.
 *
 * The two properties that make this an audit rather than a log:
 *
 *  - Completeness — every invocation lands exactly one entry, success or failure. A trail
 *    that skips failures cannot answer "when did this start breaking".
 *  - Integrity — an entry written cannot be silently edited afterwards; the on-disk trail is
 *    sealed, and an in-memory edit is caught by a fingerprint check.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ENVELOPE_HEADER } from "@prismshadow/penguin-core";

import {
  FleetInvocationAudit,
  fingerprintEntry,
  type FleetAuditEntry,
} from "../../src/services/tool-fleet/index.js";

const SEAL_KEY = "fleet-audit-seal-key";
const NOW = 1_000_000;

async function makeDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pnmesh-audit-"));
}

function entry(parts: Partial<FleetAuditEntry> = {}): Omit<FleetAuditEntry, "id"> {
  return {
    at: NOW,
    toolId: "github_create_issue",
    providerId: "github",
    credentialId: "fleet_github_one",
    access: "write",
    ok: true,
    durationMs: 42,
    ...parts,
  };
}

describe("FleetInvocationAudit", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("records an entry and reports it newest first", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    const first = await audit.record(entry({ at: NOW }));
    const second = await audit.record(entry({ at: NOW + 1000 }));
    expect(audit.size).toBe(2);
    expect(audit.query().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it("assigns an unguessable id to every entry", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    const a = await audit.record(entry());
    const b = await audit.record(entry());
    expect(a.id).toMatch(/^audit-[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("records a failure exactly like a success", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    await audit.record(entry({ ok: true }));
    await audit.record({
      ...entry({ ok: false }),
      context: { status: 503, error: "upstream 503" },
    });
    const failures = audit.query({ onlyFailures: true });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.context).toMatchObject({ status: 503, error: "upstream 503" });
    expect(audit.stats().failures).toBe(1);
  });

  it("filters by tool and by provider", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    await audit.record(entry({ toolId: "slack_post", providerId: "slack" }));
    await audit.record(entry({ toolId: "github_create_issue", providerId: "github" }));
    await audit.record(entry({ toolId: "github_list_issues", providerId: "github" }));
    expect(audit.query({ providerId: "github" })).toHaveLength(2);
    expect(audit.query({ toolId: "slack_post" })).toHaveLength(1);
    expect(audit.query({ providerId: "linear" })).toHaveLength(0);
  });

  it("reports mean and worst latency, and per-provider buckets", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    await audit.record(entry({ providerId: "github", durationMs: 10 }));
    await audit.record(entry({ providerId: "github", durationMs: 30 }));
    await audit.record(entry({ providerId: "slack", durationMs: 8, ok: false }));
    const stats = audit.stats();
    expect(stats.total).toBe(3);
    expect(stats.failures).toBe(1);
    expect(stats.meanDurationMs).toBe((10 + 30 + 8) / 3);
    expect(stats.p99DurationMs).toBe(30);
    expect(stats.byProvider.get("github")).toEqual({ total: 2, failures: 0 });
    expect(stats.byProvider.get("slack")).toEqual({ total: 1, failures: 1 });
  });

  it("reports zeroed stats for an empty trail", () => {
    const audit = new FleetInvocationAudit();
    expect(audit.stats()).toMatchObject({
      total: 0,
      failures: 0,
      meanDurationMs: 0,
      p99DurationMs: 0,
    });
  });

  it("evicts the oldest entries past the limit and keeps the trail verifiable", async () => {
    const audit = new FleetInvocationAudit({ limit: 3, autoFlush: false });
    for (let index = 0; index < 5; index++) {
      await audit.record(entry({ at: NOW + index, durationMs: index }));
    }
    expect(audit.size).toBe(3);
    expect(audit.query().map((item) => item.durationMs)).toEqual([4, 3, 2]);
    expect(audit.verify()).toBe(true);
  });

  it("verifies a clean trail", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    await audit.record(entry());
    expect(audit.verify()).toBe(true);
  });

  it("detects an entry mutated after the fact", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    const stored = await audit.record(entry({ ok: true }));
    expect(audit.verify()).toBe(true);
    // A rewrite of history: flip the outcome and re-fingerprint would be needed to pass.
    (stored as { ok: boolean }).ok = false;
    expect(audit.verify()).toBe(false);
  });

  it("seals the trail on disk so a copy cannot be read in the clear", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const filePath = path.join(dir, "audit.bin");
    const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY });
    await audit.record(entry({ context: { argv: ["gh", "issue", "create"], exitCode: 0 } }));
    const onDisk = await fs.readFile(filePath);
    // The envelope header is the marker that the payload is sealed, not JSON.
    expect(onDisk.subarray(0, ENVELOPE_HEADER.length).equals(ENVELOPE_HEADER)).toBe(true);
    expect(onDisk.toString("utf8")).not.toContain("gh issue create");
  });

  it("round-trips through disk and re-verifies", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const filePath = path.join(dir, "audit.bin");
    {
      const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY });
      await audit.record(entry({ durationMs: 77 }));
      await audit.record({
        ...entry({ ok: false, durationMs: 9 }),
        context: { status: 504, error: "timeout" },
      });
      expect(audit.size).toBe(2);
    }
    {
      const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY, autoFlush: false });
      expect(await audit.load()).toBe(2);
      expect(audit.verify()).toBe(true);
      const stats = audit.stats();
      expect(stats.total).toBe(2);
      expect(stats.failures).toBe(1);
      expect(stats.meanDurationMs).toBe((77 + 9) / 2);
    }
  });

  it("refuses a sealed trail read with the wrong key", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const filePath = path.join(dir, "audit.bin");
    {
      const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY });
      await audit.record(entry());
    }
    const audit = new FleetInvocationAudit({ filePath, auditKey: "not-the-key" });
    await expect(audit.load()).rejects.toThrow(/could not be decrypted/);
  });

  it("migrates a plaintext trail written before the seal", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const filePath = path.join(dir, "audit.bin");
    // Simulate an older trail: a plaintext envelope, as written before sealing existed.
    const legacy: { version: 1; algorithm: "sha256-fingerprint"; entries: FleetAuditEntry[] } = {
      version: 1,
      algorithm: "sha256-fingerprint",
      entries: [{ ...entry(), id: "audit-legacy" }],
    };
    await fs.writeFile(filePath, JSON.stringify(legacy), "utf8");
    const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY });
    expect(await audit.load()).toBe(1);
    expect(audit.query()[0]!.id).toBe("audit-legacy");
    expect(audit.verify()).toBe(true);
  });

  it("rejects a trail with an unsupported version", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const filePath = path.join(dir, "audit.bin");
    await fs.writeFile(filePath, JSON.stringify({ version: 99, entries: [] }), "utf8");
    const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY });
    await expect(audit.load()).rejects.toThrow(/unsupported version or shape/);
  });

  it("rejects a trail that is not JSON", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const filePath = path.join(dir, "audit.bin");
    await fs.writeFile(filePath, "not json at all", "utf8");
    const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY });
    await expect(audit.load()).rejects.toThrow(/not valid JSON/);
  });

  it("treats a missing trail file as an empty one", async () => {
    const audit = new FleetInvocationAudit({
      filePath: path.join(os.tmpdir(), "pnmesh-audit-missing", "audit.bin"),
      auditKey: SEAL_KEY,
    });
    expect(await audit.load()).toBe(0);
  });

  it("clears the trail and marks it dirty", async () => {
    const audit = new FleetInvocationAudit({ autoFlush: false });
    await audit.record(entry());
    audit.clear();
    expect(audit.size).toBe(0);
    expect(audit.query()).toHaveLength(0);
  });

  it("does not flush when nothing was recorded", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const filePath = path.join(dir, "audit.bin");
    const audit = new FleetInvocationAudit({ filePath, auditKey: SEAL_KEY });
    expect(await audit.flush()).toBeUndefined();
    // No record ever happened, so no file was written.
    await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("fingerprintEntry", () => {
  /** A complete entry, since the fingerprint covers the record exactly as stored. */
  function fullEntry(parts: Partial<FleetAuditEntry> = {}): FleetAuditEntry {
    return {
      id: "a",
      at: NOW,
      toolId: "github_create_issue",
      providerId: "github",
      credentialId: "fleet_github_one",
      access: "write",
      ok: true,
      durationMs: 42,
      ...parts,
    };
  }

  it("is stable for the same entry and differs across entries", () => {
    const a = fingerprintEntry(fullEntry({ durationMs: 1 }));
    expect(fingerprintEntry(fullEntry({ durationMs: 1 }))).toBe(a);
    expect(fingerprintEntry(fullEntry({ id: "b", durationMs: 1 }))).not.toBe(a);
    expect(fingerprintEntry(fullEntry({ durationMs: 2 }))).not.toBe(a);
    expect(fingerprintEntry(fullEntry({ ok: false }))).not.toBe(a);
  });

  it("ignores a missing context the way it treats a null one", () => {
    const without = fingerprintEntry(fullEntry({ context: undefined }));
    expect(without).toBe(fingerprintEntry(fullEntry({ context: null as unknown as undefined })));
  });
});
