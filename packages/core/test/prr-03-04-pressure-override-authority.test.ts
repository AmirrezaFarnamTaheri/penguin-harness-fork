/**
 * PRR-03 and PRR-04 acceptance — durable pressure override authority.
 *
 * F3 (PRR-03): with a *valid* below-50-MiB measurement, `evaluateWritePressure` consumes the
 * override and a durable persistence failure during that consumption rejected. `admitWrite`
 * catches every gate rejection and turned it into `blocked: false` with a probe-unavailable
 * warning — so the archive wrote to disk with no durably consumed override, precisely under the
 * disk-pressure conditions the feature exists for. The repair keeps the measured block and
 * reports `write_pressure_override_unavailable`.
 *
 * F4 (PRR-04): `grant` and `consume` each read the whole ledger, mutated an instance-local Map and
 * replaced the file, with no shared lock. The HTTP route builds a store per request and the live
 * gate holds another for the same path, so an interleaving grant could load an unconsumed record,
 * let the gate consume and save it, then overwrite that consumption with its own stale copy — the
 * grant becomes usable a second time. The repair puts the whole reload → validate → mutate → save
 * transaction under the canonical-path file lock, and gives every grant a UUID instead of a
 * per-instance counter.
 *
 * The faults below are real, not stubbed: a ledger path under a regular file (ENOTDIR), a
 * corrupt ledger, a directory in the ledger's place, and a symlinked ledger. The one fault that
 * no filesystem can produce on every platform — a replacement that fails after the read
 * succeeded — is injected at the ledger write instead (see {@link saveFaultStore}); it is the
 * only way to reach that step, because the ledger's directory also holds the lock reservation
 * that a read-only directory would fail first. Every one is checked against the value the policy
 * is required to return, and the concurrent cases use separate store instances over one file —
 * the shape that failed before the repair.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../src/internal/atomic-write.js";
import { TruncatedToolOutputArchive } from "../src/environment/truncated-tool-output-archive.js";
import {
  PressureOverrideStore,
  PRESSURE_BLOCK_BELOW_BYTES,
  evaluateWritePressure,
} from "../src/internal/write-pressure-policy.js";
import type {
  PressureReading,
  PressureWriteKey,
  WritePressureGate,
} from "../src/internal/write-pressure-policy.js";

const VOLUME = "/data";
const ARCHIVE = "tool-output-archive";

const KEY: PressureWriteKey = {
  sessionId: "session-1",
  producerId: ARCHIVE,
  toolCallId: "call-1",
  volumePath: VOLUME,
};

/** A real, low reading for the write's own volume — strictly below the 50 MiB block threshold. */
const lowReading = (freeBytes = 1024): PressureReading => ({
  kind: "measured",
  volumePath: VOLUME,
  freeBytes,
});

const decide = (reading: PressureReading | null, overrides?: PressureOverrideStore) =>
  evaluateWritePressure({
    producerId: KEY.producerId,
    reading,
    writeKey: KEY,
    ...(overrides ? { overrides } : {}),
  });

const grantFor = (
  store: PressureOverrideStore,
  key: PressureWriteKey = KEY,
  reason = "acceptance fixture",
) =>
  store.grant({
    sessionId: key.sessionId,
    producerId: key.producerId,
    toolCallId: key.toolCallId,
    volumePath: key.volumePath,
    grantedBy: "operator",
    reason,
  });

let roots: string[] = [];
afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  roots = [];
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "prr-override-"));
  roots.push(root);
  return root;
}

async function ledgerPath(): Promise<string> {
  return path.join(await tempRoot(), "ledger.json");
}

/** A store whose ledger cannot even be created: its parent path is a regular file. */
async function unreachableLedgerStore(): Promise<PressureOverrideStore> {
  const root = await tempRoot();
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "not a directory");
  return new PressureOverrideStore({ persistPath: path.join(blocker, "ledger.json") });
}

/**
 * A store over a real ledger file whose save can be made to fail on demand.
 *
 * Every other fault here is produced by the filesystem; this one cannot be. Making the ledger
 * file unwritable refuses the replacement only on Windows, because POSIX decides rename by the
 * directory rather than the file's mode, and making the directory unwritable fails the lock
 * reservation beside it before a replacement is attempted. So the fault lands on the write
 * itself, where the read has already succeeded and the consumption is otherwise durable.
 */
async function saveFaultStore(): Promise<{
  file: string;
  store: PressureOverrideStore;
  failSave: (failing: boolean) => void;
}> {
  const file = await ledgerPath();
  let failing = false;
  const store = new PressureOverrideStore({
    persistPath: file,
    writeLedger: async (target, payload) => {
      if (failing)
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      await atomicWriteFile(target, payload, { mode: 0o600 });
    },
  });
  return { file, store, failSave: (next) => (failing = next) };
}

const readLedger = async (file: string): Promise<{ records: Record<string, unknown>[] }> =>
  JSON.parse(await readFile(file, "utf8")) as { records: Record<string, unknown>[] };

// ---------------------------------------------------------------------------
// PRR-03 — the measured block survives a durable authorization failure
// ---------------------------------------------------------------------------

describe("PRR-03 a durable override failure never downgrades a measured block", () => {
  it("blocks with the override-unavailable signal when the ledger is unreachable", async () => {
    const store = await unreachableLedgerStore();
    const decision = await decide(lowReading(), store);

    expect(decision.action).toBe("block");
    expect(decision.signal).toBe("write_pressure_override_unavailable");
    // The measurement was real and is reported as such — the point of the whole repair.
    expect(decision.freeBytes).toBe(1024);
    expect(decision.overrideId).toBeNull();
  });

  it("never reports a persistence failure as an unavailable measurement", async () => {
    const store = await unreachableLedgerStore();
    const decision = await decide(lowReading(), store);

    expect(decision.signal).not.toBe("write_pressure_probe_unavailable");
    // An unknown measurement is null; a refused authorization carries its byte count.
    expect(decision.freeBytes).not.toBeNull();
    expect(decision.reason).toContain("durable consumption failed");
  });

  it("blocks when the ledger is corrupt rather than treating it as empty authority", async () => {
    const file = await ledgerPath();
    await writeFile(file, "{ this is not json");
    const store = new PressureOverrideStore({ persistPath: file });

    const decision = await decide(lowReading(), store);
    expect(decision.action).toBe("block");
    expect(decision.signal).toBe("write_pressure_override_unavailable");
  });

  it("blocks when a granted override cannot be durably consumed", async () => {
    const { store, failSave } = await saveFaultStore();
    await grantFor(store);

    // The read succeeds; the replacement that would record consumption cannot.
    failSave(true);
    const decision = await decide(lowReading(), store);

    expect(decision.action).toBe("block");
    expect(decision.signal).toBe("write_pressure_override_unavailable");
    expect(decision.overrideId).toBeNull();
  });

  it("claims no durable consumption when the consume save failed", async () => {
    const { file, store, failSave } = await saveFaultStore();
    await grantFor(store);
    failSave(true);

    await expect(store.consume(KEY)).rejects.toThrow();

    // The ledger on disk still shows an unconsumed grant: the write was never authorized away.
    const persisted = await readLedger(file);
    expect(persisted.records).toHaveLength(1);
    expect(persisted.records[0]?.consumedAt).toBeUndefined();
  });

  it("recovers: once the fault clears, the same grant consumes exactly once", async () => {
    const { store, failSave } = await saveFaultStore();
    await grantFor(store);
    failSave(true);
    await expect(decide(lowReading(), store)).resolves.toMatchObject({
      action: "block",
      signal: "write_pressure_override_unavailable",
    });

    failSave(false);
    expect(await decide(lowReading(), store)).toMatchObject({
      action: "allow",
      overrideId: expect.stringContaining("pressure-override-"),
    });
    expect(await store.consume(KEY)).toBeNull();
  });

  it("keeps the ordinary unavailable-probe warning unchanged", async () => {
    const store = new PressureOverrideStore({ persistPath: await ledgerPath() });
    const decision = await decide(null, store);

    expect(decision.action).toBe("warn");
    expect(decision.signal).toBe("write_pressure_probe_unavailable");
    // An absent measurement is null, never a fabricated 0 or a real byte count.
    expect(decision.freeBytes).toBeNull();
  });

  it("keeps the plain below-threshold block unchanged when no override is configured", async () => {
    const decision = await decide(lowReading());
    expect(decision.action).toBe("block");
    expect(decision.signal).toBe("write_pressure_blocked");
    expect(decision.freeBytes).toBe(1024);
  });

  it("keeps the block at exactly one byte below the threshold", async () => {
    const store = await unreachableLedgerStore();
    const decision = await decide(lowReading(PRESSURE_BLOCK_BELOW_BYTES - 1), store);
    expect(decision.action).toBe("block");
    expect(decision.signal).toBe("write_pressure_override_unavailable");
  });

  it("does not consult the override store above the block threshold", async () => {
    const store = await unreachableLedgerStore();
    // An unreachable store would reject if it were consulted; above the threshold it is not.
    const decision = await decide(lowReading(PRESSURE_BLOCK_BELOW_BYTES), store);
    expect(decision.action).toBe("warn");
    expect(decision.signal).toBe("write_pressure_low");
  });

  it("refuses both archive producers at the boundary and leaves the destination untouched", async () => {
    const root = path.join(await tempRoot(), "scratchpad");
    const gate: WritePressureGate = {
      admit: async (request) => ({
        action: "block",
        signal: "write_pressure_override_unavailable",
        producerId: request.producerId,
        volumePath: VOLUME,
        freeBytes: 1024,
        reason: "low disk space requires an override, but its durable consumption failed",
        overrideId: null,
      }),
    };
    const archive = new TruncatedToolOutputArchive({ rootDir: root, writePressure: gate });

    expect(await archive.saveRecallEntry("exec_command", "hello", "call-1")).toEqual({
      status: "failed",
      code: "PRESSURE_BLOCKED",
    });
    const capture = archive.startCapture();
    capture.append("x".repeat(1000));
    expect(await capture.save("exec_command", "call-9")).toMatchObject({
      status: "failed",
      code: "PRESSURE_BLOCKED",
    });

    // Not merely "no entry": the archive never created its store directory at all.
    await expect(readFile(path.join(root, "index.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

// ---------------------------------------------------------------------------
// PRR-04 — serialized, single-use, uniquely identified durable overrides
// ---------------------------------------------------------------------------

describe("PRR-04 durable overrides are serialized and single-use", () => {
  it("preserves both records when two store instances grant concurrently", async () => {
    const file = await ledgerPath();
    const a = new PressureOverrideStore({ persistPath: file });
    const b = new PressureOverrideStore({ persistPath: file });

    // Distinct write keys: a grant for the *same* key legitimately supersedes the earlier one,
    // so this case has to race two independent records to show that neither is lost.
    await Promise.all([
      grantFor(a, { ...KEY, toolCallId: "call-1" }, "first"),
      grantFor(b, { ...KEY, toolCallId: "call-2" }, "second"),
    ]);

    const fresh = new PressureOverrideStore({ persistPath: file });
    const persisted = await readLedger(file);
    expect(persisted.records).toHaveLength(2);
    expect(new Set(persisted.records.map((r) => r.overrideId)).size).toBe(2);
    // And the reloaded store can still consume one of them — nothing was lost on the way out.
    expect(await fresh.consume({ ...KEY, toolCallId: "call-2" })).not.toBeNull();
  });

  it("preserves every grant across an interleaved storm of concurrent grants", async () => {
    const file = await ledgerPath();
    const stores = Array.from(
      { length: 6 },
      () => new PressureOverrideStore({ persistPath: file }),
    );

    await Promise.all(
      stores.map((store, index) =>
        grantFor(store, { ...KEY, toolCallId: `call-${index}` }, `grant-${index}`),
      ),
    );

    const persisted = await readLedger(file);
    expect(persisted.records).toHaveLength(6);
    expect(new Set(persisted.records.map((r) => r.overrideId)).size).toBe(6);
  });

  it("admits exactly one write when many instances consume the same grant", async () => {
    const file = await ledgerPath();
    const issuer = new PressureOverrideStore({ persistPath: file });
    await grantFor(issuer);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        new PressureOverrideStore({ persistPath: file }).consume(KEY),
      ),
    );

    expect(results.filter((record) => record !== null)).toHaveLength(1);
    const persisted = await readLedger(file);
    expect(persisted.records).toHaveLength(1);
    expect(persisted.records[0]?.consumedAt).toBeTypeOf("number");
  });

  it("never resurrects a consumed grant when an unrelated grant saves concurrently", async () => {
    const file = await ledgerPath();
    const issuer = new PressureOverrideStore({ persistPath: file });
    await grantFor(issuer, KEY, "original");

    // The pre-repair interleaving: the gate loads an unconsumed copy of call-1's record and
    // consumes it, while the route's store saves its own new grant for call-2 from a copy it
    // read before that consumption landed. Without the transaction lock the route's save wins
    // and call-1 becomes usable a second time.
    const gateStore = new PressureOverrideStore({ persistPath: file });
    const routeStore = new PressureOverrideStore({ persistPath: file });
    const [consumed, granted] = await Promise.all([
      gateStore.consume(KEY),
      grantFor(routeStore, { ...KEY, toolCallId: "call-2" }, "concurrent grant"),
    ]);

    expect(consumed).not.toBeNull();
    expect(granted.overrideId).not.toBe(consumed?.overrideId);

    // call-1 stays consumed for good; call-2 is separately usable exactly once.
    const after = new PressureOverrideStore({ persistPath: file });
    expect(await after.consume(KEY)).toBeNull();
    expect(await after.consume({ ...KEY, toolCallId: "call-2" })).not.toBeNull();
    expect((await readLedger(file)).records).toHaveLength(2);
  });

  it("gives every grant a globally unique id, including across processes' stores", async () => {
    const file = await ledgerPath();
    const ids = new Set<string>();
    for (let index = 0; index < 25; index++) {
      const store = new PressureOverrideStore({ persistPath: file });
      const record = await grantFor(store, { ...KEY, toolCallId: `call-${index}` });
      ids.add(record.overrideId);
    }
    expect(ids.size).toBe(25);
    for (const id of ids) expect(id).toMatch(/^pressure-override-[0-9a-f-]{36}$/);
  });

  it("survives a restart: a new store reads the granted record from disk", async () => {
    const file = await ledgerPath();
    await grantFor(new PressureOverrideStore({ persistPath: file }));

    const afterRestart = new PressureOverrideStore({ persistPath: file });
    const decision = await decide(lowReading(), afterRestart);
    expect(decision.action).toBe("allow");
    expect(decision.overrideId).toMatch(/^pressure-override-/);
  });

  it("refuses to admit anything from a corrupt ledger", async () => {
    const file = await ledgerPath();
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: [{ nope: true }] }));
    const store = new PressureOverrideStore({ persistPath: file });

    await expect(store.consume(KEY)).rejects.toThrow();
    await expect(grantFor(store)).rejects.toThrow();
  });

  it("refuses an unsupported ledger schema instead of ignoring it", async () => {
    const file = await ledgerPath();
    await writeFile(file, JSON.stringify({ schemaVersion: 99, records: [] }));
    await expect(new PressureOverrideStore({ persistPath: file }).consume(KEY)).rejects.toThrow();
  });

  it("refuses duplicate records rather than collapsing them", async () => {
    const file = await ledgerPath();
    const record = {
      sessionId: KEY.sessionId,
      producerId: KEY.producerId,
      toolCallId: KEY.toolCallId,
      volumePath: KEY.volumePath,
      overrideId: "pressure-override-11111111-1111-1111-1111-111111111111",
      grantedBy: "operator",
      grantedAt: 1,
      reason: "dup",
    };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: [record, { ...record }] }));
    await expect(new PressureOverrideStore({ persistPath: file }).consume(KEY)).rejects.toThrow();
  });

  it("rejects a nonplain authority file", async () => {
    const root = await tempRoot();
    const file = path.join(root, "ledger.json");
    await mkdir(file); // a directory where the ledger must be
    await expect(new PressureOverrideStore({ persistPath: file }).consume(KEY)).rejects.toThrow();
  });

  it("rejects a symlinked authority file", async () => {
    const root = await tempRoot();
    const real = path.join(root, "real.json");
    await writeFile(real, JSON.stringify({ schemaVersion: 1, records: [] }));
    const link = path.join(root, "ledger.json");
    // A junction is the Windows form that needs no elevation; lstat reports it as a link.
    await symlink(real, link, "junction");

    await expect(new PressureOverrideStore({ persistPath: link }).consume(KEY)).rejects.toThrow();
  });

  it("resolves the ledger path canonically, so one canonical path serializes all callers", async () => {
    const file = await ledgerPath();
    const viaDot = path.join(path.dirname(file), ".", path.basename(file));
    await Promise.all([
      grantFor(new PressureOverrideStore({ persistPath: file }), { ...KEY, toolCallId: "call-1" }),
      grantFor(new PressureOverrideStore({ persistPath: viaDot }), {
        ...KEY,
        toolCallId: "call-2",
      }),
    ]);
    expect((await readLedger(file)).records).toHaveLength(2);
  });

  it("discards cached grants after an authority failure instead of admitting them", async () => {
    const { store, failSave } = await saveFaultStore();
    await grantFor(store);
    expect(store.list().some((record) => record.consumedAt === undefined)).toBe(true);

    failSave(true);
    await expect(store.consume(KEY)).rejects.toThrow();

    // The failed transaction cleared this process's cached authority, so nothing it still
    // believes can admit a later write without re-reading the durable ledger.
    expect(store.list()).toHaveLength(0);
    await expect(store.consume(KEY)).rejects.toThrow();
  });

  it("scopes an override to its own session, producer, call and volume", async () => {
    const file = await ledgerPath();
    const store = new PressureOverrideStore({ persistPath: file });
    await grantFor(store);

    for (const altered of [
      { ...KEY, sessionId: "session-2" },
      { ...KEY, producerId: "recall-store" },
      { ...KEY, toolCallId: "call-2" },
      { ...KEY, volumePath: "/other" },
    ]) {
      expect(await store.consume(altered)).toBeNull();
    }
    expect(await store.consume(KEY)).not.toBeNull();
  });

  it("keeps an in-memory grant in memory", async () => {
    const store = new PressureOverrideStore();
    const record = await store.grant({ ...KEY, grantedBy: "cli", reason: "memory only" });
    expect(record.consumedAt).toBeUndefined();
    expect(await store.consume(KEY)).toMatchObject({ overrideId: record.overrideId });
    expect(await store.consume(KEY)).toBeNull();
  });
});
