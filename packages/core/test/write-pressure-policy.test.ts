/**
 * Write pressure policy (I7.1/I7.3/I7.4): the named pressure matrix with exact byte values.
 *
 * The two numbers the card fixes are asserted as literal byte counts, not as MiB arithmetic that
 * a reader has to redo: 200 MiB = 209,715,200 and 50 MiB = 52,428,800, and the probe already
 * reports bytes (`bsize * bavail`), so no unit conversion happens anywhere at the boundary. The
 * boundary readings are the interesting ones: comparison is strictly below, so at exactly 200 MiB
 * neither rule fires, and at exactly 50 MiB the warning fires while the stricter block rule does
 * not.
 *
 * The exemption fixture below enumerates every entry of the inventory with its reason. That is
 * the card's requirement made mechanical: a write cannot become exempt by falling out of a
 * classification, and no exemption is a silence.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionWritePressureGate,
  evaluateWritePressure,
  NONESSENTIAL_PRODUCERS,
  PRESSURE_BLOCK_BELOW_BYTES,
  PRESSURE_THRESHOLD_UNIT,
  PRESSURE_WARN_BELOW_BYTES,
  PressureOverrideStore,
  readVolumePressure,
  sessionPressureOverridePath,
  WRITE_PRODUCER_INVENTORY,
  writeProducerEntry,
} from "../src/internal/write-pressure-policy.js";
import type { PressureReading, PressureWriteKey } from "../src/internal/write-pressure-policy.js";
import type { ResourcePressureReport } from "../src/agent/resource/pressure-probe.js";

const MiB = 1024 * 1024;
const VOLUME = "/data";
const KEY: PressureWriteKey = {
  sessionId: "session-1",
  producerId: "recall-store",
  toolCallId: "call-1",
  volumePath: VOLUME,
};

const measured = (freeBytes: number, volumePath = VOLUME): PressureReading => ({
  kind: "measured",
  volumePath,
  freeBytes,
});

function pressureReport(volumePath: string, freeBytes: number): ResourcePressureReport {
  return {
    memory: {
      kind: "os-counter",
      freeBytes: 1,
      totalBytes: 2,
      usedBytes: 1,
      usedRatio: 0.5,
      sampledAt: 0,
      ageMs: 0,
      caveat: "test",
    },
    disks: [
      {
        path: volumePath,
        kind: "statfs-cache",
        freeBytes,
        totalBytes: 2,
        usedBytes: 1,
        usedRatio: 0.5,
        sampledAt: 0,
        ageMs: 0,
        servedFromCache: false,
      },
    ],
    droppedPathCount: 0,
    diskTtlMs: 5000,
  };
}

async function decide(
  reading: PressureReading | null,
  overrides?: PressureOverrideStore,
  key: PressureWriteKey = KEY,
) {
  return await evaluateWritePressure({
    producerId: key.producerId,
    reading,
    writeKey: key,
    ...(overrides ? { overrides } : {}),
  });
}

describe("I7 thresholds are exact byte values in the probe's unit", () => {
  it("states 200 MiB and 50 MiB explicitly", () => {
    expect(PRESSURE_WARN_BELOW_BYTES).toBe(209_715_200);
    expect(PRESSURE_BLOCK_BELOW_BYTES).toBe(52_428_800);
    expect(PRESSURE_WARN_BELOW_BYTES).toBe(200 * MiB);
    expect(PRESSURE_BLOCK_BELOW_BYTES).toBe(50 * MiB);
    expect(PRESSURE_THRESHOLD_UNIT).toBe("bytes");
  });

  it.each([
    ["well above both", 2 * 1024 * MiB, "allow", null],
    ["one byte above the warning threshold", 209_715_201, "allow", null],
    ["exactly at the warning threshold", 209_715_200, "allow", null],
    ["one byte below the warning threshold", 209_715_199, "warn", "write_pressure_low"],
    ["midway", 100 * MiB, "warn", "write_pressure_low"],
    ["one byte above the block threshold", 52_428_801, "warn", "write_pressure_low"],
    // At the block threshold the stricter rule has not fired; the warning still applies.
    ["exactly at the block threshold", 52_428_800, "warn", "write_pressure_low"],
    ["one byte below the block threshold", 52_428_799, "block", "write_pressure_blocked"],
    // A measured zero is a real reading from a full filesystem: it blocks.
    ["measured zero", 0, "block", "write_pressure_blocked"],
  ])("%s (%i bytes) → %s", async (_label, freeBytes, action, signal) => {
    const decision = await decide(measured(freeBytes));
    expect(decision.action).toBe(action);
    expect(decision.signal).toBe(signal);
    expect(decision.freeBytes).toBe(freeBytes);
  });
});

describe("I7 no valid measurement ever blocks", () => {
  it.each([
    ["no reading at all", null, "write_pressure_probe_unavailable"],
    [
      "probe unavailable",
      { kind: "unavailable", volumePath: VOLUME, reason: "probe exploded" } as PressureReading,
      "write_pressure_probe_unavailable",
    ],
    ["another volume's reading", measured(0, "/other"), "write_pressure_wrong_volume"],
    ["NaN", measured(Number.NaN), "write_pressure_wrong_volume"],
    ["Infinity", measured(Number.POSITIVE_INFINITY), "write_pressure_wrong_volume"],
    ["negative", measured(-1), "write_pressure_wrong_volume"],
  ])("%s → warn, never block, freeBytes null", async (_label, reading, signal) => {
    const decision = await decide(reading);
    expect(decision.action).toBe("warn");
    expect(decision.signal).toBe(signal);
    // "No measurement" must not be reported as zero bytes free.
    expect(decision.freeBytes).toBeNull();
  });

  it("treats an unreadable probe path as unavailable rather than a full disk", async () => {
    const reading = await readVolumePressure(
      {
        probe: async () => ({
          memory: {
            kind: "os-counter",
            freeBytes: 1,
            totalBytes: 2,
            usedBytes: 1,
            usedRatio: 0.5,
            sampledAt: 0,
            ageMs: 0,
            caveat: "test",
          },
          disks: [
            {
              path: VOLUME,
              kind: "statfs-cache",
              freeBytes: 0,
              totalBytes: 0,
              usedBytes: 0,
              usedRatio: 0,
              sampledAt: 0,
              ageMs: 0,
              servedFromCache: false,
              error: "EACCES",
            },
          ],
          droppedPathCount: 0,
          diskTtlMs: 5000,
        }),
      },
      VOLUME,
    );
    expect(reading).toEqual({
      kind: "unavailable",
      volumePath: VOLUME,
      reason: expect.stringContaining("EACCES"),
    });
    expect((await decide(reading)).action).toBe("warn");
  });

  it("reports a missing path and a thrown probe as unavailable", async () => {
    const empty = {
      probe: async () => ({
        memory: {
          kind: "os-counter" as const,
          freeBytes: 1,
          totalBytes: 2,
          usedBytes: 1,
          usedRatio: 0.5,
          sampledAt: 0,
          ageMs: 0,
          caveat: "test",
        },
        disks: [],
        droppedPathCount: 0,
        diskTtlMs: 5000,
      }),
    };
    expect((await readVolumePressure(empty, VOLUME)).kind).toBe("unavailable");
    const throwing = {
      probe: async () => {
        throw new Error("statfs unavailable");
      },
    };
    const reading = await readVolumePressure(throwing, VOLUME);
    expect(reading.kind).toBe("unavailable");
    expect((await decide(reading)).signal).toBe("write_pressure_probe_unavailable");
  });
});

describe("I7 inventory: every exemption is enumerated, the two producers are the only refusals", () => {
  it("has exactly the two nonessential producers from the card's inventory", () => {
    expect(NONESSENTIAL_PRODUCERS).toEqual(["tool-output-archive", "recall-store"]);
    const blockable = WRITE_PRODUCER_INVENTORY.filter((entry) => entry.nonessential).map(
      (entry) => entry.id,
    );
    expect(blockable).toEqual([...NONESSENTIAL_PRODUCERS]);
  });

  it("names each exemption with its reason", () => {
    const fixture: Array<[string, string]> = [
      ["read_file", "read-only: it does not write"],
      ["code_graph", "read-only: it does not write"],
      ["knowledge_graph", "read-only: it does not write"],
      ["environment_info", "read-only: it does not write"],
      ["recall_output", "read-only: it does not write"],
      ["resource_pressure", "read-only: it does not write"],
      ["web_search", "read-only: it does not write"],
      ["write_file", "user-work: the file the user asked for is not a convenience write"],
      ["edit_file", "user-work: the file the user asked for is not a convenience write"],
      [
        "run_subagent",
        "delegated: the child Session's calls are checked at the child's own boundary",
      ],
      [
        "input_subagent",
        "delegated: the child Session's calls are checked at the child's own boundary",
      ],
      [
        "exec_command",
        "unresolvable-destination: a command's target volume is not in its arguments (see the module's reopen condition)",
      ],
      [
        "input_command",
        "unresolvable-destination: characters typed into a running command name no destination",
      ],
      [
        "session-delete",
        "frees-space: deleting a Session releases the bytes the policy is reacting to",
      ],
      ["archive-eviction", "frees-space: eviction/prune is the archive's own cleanup path"],
      ["session-export", "export: a backup is the recovery path and must work under pressure"],
    ];
    for (const [id, reason] of fixture) {
      const entry = writeProducerEntry(id);
      expect(entry, id).not.toBeNull();
      expect(entry?.reason, id).toBe(reason);
      expect(entry?.nonessential, id).toBe(false);
    }
    // The fixture covers the whole table: no entry is unaccounted for, and none was added silently.
    expect(WRITE_PRODUCER_INVENTORY.map((entry) => entry.id).sort()).toEqual(
      [...fixture.map(([id]) => id), "recall-store", "tool-output-archive"].sort(),
    );
  });

  it("allows the recovery, cleanup, export and read-only paths under block pressure", async () => {
    const full = measured(1); // deep below the block threshold
    for (const id of [
      "read_file",
      "recall_output",
      "write_file",
      "edit_file",
      "session-delete",
      "archive-eviction",
      "session-export",
      "run_subagent",
      "exec_command",
    ]) {
      const decision = await evaluateWritePressure({
        producerId: id,
        inventoryId: id,
        reading: full,
        writeKey: { ...KEY, producerId: id },
      });
      expect(decision.action, id).toBe("allow");
      expect(decision.signal, id).toBeNull();
      // An exempt write is never given a number to be judged by.
      expect(decision.freeBytes, id).toBeNull();
    }
  });

  it("treats an unknown producer id as exempt rather than blocked", async () => {
    const decision = await evaluateWritePressure({
      producerId: "some-future-tool",
      inventoryId: "some-future-tool",
      reading: measured(1),
      writeKey: { ...KEY, producerId: "some-future-tool" },
    });
    expect(decision.action).toBe("allow");
  });
});

describe("I7 override: recorded, single-use, scoped to the write", () => {
  it("admits the refused write once and records who granted it", async () => {
    const store = new PressureOverrideStore({ now: () => 1000 });
    const record = await store.grant({
      sessionId: "session-1",
      producerId: "recall-store",
      toolCallId: "call-1",
      volumePath: VOLUME,
      grantedBy: "operator",
      reason: "the user accepted the risk once",
    });
    const decision = await decide(measured(1), store);
    expect(decision.action).toBe("allow");
    expect(decision.overrideId).toBe(record.overrideId);
    expect(decision.freeBytes).toBe(1);
    // Recorded: granted by, granted at, consumed at.
    expect(store.list()).toEqual([
      {
        ...record,
        consumedAt: 1000,
        grantedBy: "operator",
        reason: "the user accepted the risk once",
      },
    ]);
    // Single-use: the same grant cannot admit a second write.
    expect((await decide(measured(1), store)).action).toBe("block");
  });

  it("does not let an override widen to another Session, call, producer or volume", async () => {
    const store = new PressureOverrideStore();
    await store.grant({
      sessionId: "session-1",
      producerId: "recall-store",
      toolCallId: "call-1",
      volumePath: VOLUME,
      grantedBy: "cli",
      reason: "one write",
    });
    const others: Array<Partial<PressureWriteKey>> = [
      { sessionId: "session-2" },
      { toolCallId: "call-2" },
      { producerId: "tool-output-archive" },
      { volumePath: "/workspace" },
    ];
    for (const delta of others) {
      const key = { ...KEY, ...delta } as PressureWriteKey;
      // The reading follows the case's volume: a volume mismatch would warn (no valid
      // measurement for that volume) rather than block, which is a different assertion.
      expect(
        (await decide(measured(1, key.volumePath), store, key)).action,
        JSON.stringify(delta),
      ).toBe("block");
    }
    // The grant was never consumed by the attempts above: the write it was granted for still works.
    expect((await decide(measured(1), store)).action).toBe("allow");
  });

  it("never consults an override above the block threshold", async () => {
    const store = new PressureOverrideStore();
    const record = await store.grant({
      sessionId: "session-1",
      producerId: "recall-store",
      toolCallId: "call-1",
      volumePath: VOLUME,
      grantedBy: "approval",
      reason: "granted early",
    });
    // A warning is not a refusal, so there is nothing to override: the grant stays unconsumed.
    const decision = await decide(measured(100 * MiB), store);
    expect(decision.action).toBe("warn");
    expect(decision.overrideId).toBeNull();
    expect(store.list()[0]?.consumedAt).toBeUndefined();
    // …and it is still there for the moment the disk actually crosses the block threshold.
    expect((await decide(measured(100 * MiB), store)).action).toBe("warn");
    const blocked = await decide(measured(1), store);
    expect(blocked.action).toBe("allow");
    expect(blocked.overrideId).toBe(record.overrideId);
  });

  it("cannot be forged by payload-shaped fields in scope", async () => {
    // The evaluator takes a producer id, a reading and a trusted lookup key. There is no
    // parameter a tool call's arguments can reach, so these payload-shaped values are inert —
    // and the grant store has no entry, so the decision stays a refusal.
    const payload = {
      force: true,
      overrideId: "pressure-override-1",
      pressure: "allow",
      sessionId: "session-1",
      producerId: "recall-store",
      toolCallId: "call-1",
    };
    const decision = await evaluateWritePressure({
      producerId: KEY.producerId,
      reading: measured(1),
      writeKey: KEY,
      ...({ arguments: JSON.stringify(payload) } as Record<string, unknown>),
    });
    expect(decision.action).toBe("block");
    expect(decision.overrideId).toBeNull();
    expect(JSON.stringify(payload)).toContain("overrideId");
  });
});

describe("I7.3 a grant is recorded durably and stays single-use across processes", () => {
  let roots: string[] = [];
  afterEach(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots = [];
  });
  async function tempPath(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "pressure-overrides-"));
    roots.push(root);
    return path.join(root, "pressure-overrides.json");
  }

  it("survives a restart: a second store honors the first store's grant exactly once", async () => {
    const persistPath = await tempPath();
    const first = new PressureOverrideStore({ now: () => 1000, persistPath });
    const record = await first.grant({
      sessionId: "session-1",
      producerId: "recall-store",
      toolCallId: "call-1",
      volumePath: VOLUME,
      grantedBy: "operator",
      reason: "granted before the write",
    });
    // A fresh store in a fresh "process" reads the recorded grant.
    const second = new PressureOverrideStore({ now: () => 2000, persistPath });
    const decision = await decide(measured(1), second, KEY);
    expect(decision.action).toBe("allow");
    expect(decision.overrideId).toBe(record.overrideId);
    // The consumption is durable too: a third store refuses the same write.
    const third = new PressureOverrideStore({ now: () => 3000, persistPath });
    expect((await decide(measured(1), third, KEY)).action).toBe("block");
    const onDisk = JSON.parse(await readFile(persistPath, "utf8")) as {
      records: Array<{ overrideId: string; consumedAt?: number }>;
    };
    expect(onDisk.records).toEqual([
      expect.objectContaining({ overrideId: record.overrideId, consumedAt: 2000 }),
    ]);
  });

  it("treats a corrupt or missing record file as no grants, never as a grant", async () => {
    const persistPath = await tempPath();
    await writeFile(persistPath, "{ not json");
    const store = new PressureOverrideStore({ persistPath });
    expect((await decide(measured(1), store, KEY)).action).toBe("block");
    // A record shaped like a grant but missing who granted it is not a grant either.
    await writeFile(
      persistPath,
      JSON.stringify({ schemaVersion: 1, records: [{ ...KEY, overrideId: "forged" }] }),
    );
    const second = new PressureOverrideStore({ persistPath });
    expect((await decide(measured(1), second, KEY)).action).toBe("block");
    expect(second.list()).toEqual([]);
  });

  it("keeps the whole-record shape, including who granted it and why", async () => {
    const persistPath = await tempPath();
    const store = new PressureOverrideStore({ now: () => 42, persistPath });
    const record = await store.grant({
      sessionId: "session-1",
      producerId: "tool-output-archive",
      toolCallId: "call-7",
      volumePath: "/data",
      grantedBy: "approval",
      reason: "the operator accepted the risk for this call",
    });
    expect(record).toMatchObject({
      grantedBy: "approval",
      grantedAt: 42,
      reason: "the operator accepted the risk for this call",
    });
    const reloaded = new PressureOverrideStore({ persistPath });
    await reloaded.consume({
      sessionId: "session-1",
      producerId: "tool-output-archive",
      toolCallId: "call-7",
      volumePath: "/data",
    });
    expect(reloaded.list()[0]).toMatchObject({ grantedBy: "approval", grantedAt: 42 });
  });

  it("composes the Agent gate on the same scratchpad volume used by authenticated grants", async () => {
    const persistPath = await tempPath();
    const sessionScratchpadDir = path.dirname(persistPath);
    const sessionId = "session-gate";
    const toolCallId = "call-gate";
    expect(sessionPressureOverridePath(sessionScratchpadDir)).toBe(persistPath);

    const grantor = new PressureOverrideStore({ persistPath });
    const grant = await grantor.grant({
      sessionId,
      producerId: "recall-store",
      toolCallId,
      volumePath: sessionScratchpadDir,
      grantedBy: "operator",
      reason: "the operator accepted this one write",
    });
    const gate = createSessionWritePressureGate({
      sessionId,
      sessionScratchpadDir,
      probe: { probe: async () => pressureReport(sessionScratchpadDir, 1) },
    });

    const admitted = await gate.admit({ producerId: "recall-store", toolCallId });
    expect(admitted).toMatchObject({
      action: "allow",
      volumePath: sessionScratchpadDir,
      overrideId: grant.overrideId,
    });
    // Consumption is durable and single-use through the production composition too.
    expect(await gate.admit({ producerId: "recall-store", toolCallId })).toMatchObject({
      action: "block",
      volumePath: sessionScratchpadDir,
      overrideId: null,
    });
  });
});
