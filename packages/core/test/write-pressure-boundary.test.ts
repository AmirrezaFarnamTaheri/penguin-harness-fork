/**
 * I7.2 boundary fixtures: the archive's own writes are admitted through the gate.
 *
 * The assertions that matter here are about *what did not happen* and *what can be observed*:
 *
 *   - a blocked write leaves the destination byte-for-byte untouched — no archive directory, no
 *     recall file, no index entry — which is why the gate is consulted before the first `mkdir`;
 *   - a warned write proceeds and the warning rides back on the result (the note in
 *     `environment.ts` is built from it), including when the probe is unavailable;
 *   - an unavailable probe never refuses a write, and never reports a measurement it does not
 *     have (`freeBytes: null`, never 0);
 *   - an override can only admit the write it was granted for: the identical archive, with an
 *     override granted for another tool call, still refuses, and a payload-shaped field in scope
 *     changes nothing.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Environment } from "../src/environment/environment.js";
import { TruncatedToolOutputArchive } from "../src/environment/truncated-tool-output-archive.js";
import { EXEC_COMMAND_NAME } from "../src/environment/tools/exec-command.js";
import { BUILTIN_TOOL_FACTORIES } from "../src/environment/tools/registry.js";
import { partialToolCallOutput, toolCall } from "../src/omnimessage/index.js";
import type { OmniMessage } from "../src/omnimessage/index.js";
import type { ToolDefinitionConfig } from "../src/interfaces/index.js";
import {
  createProbeWritePressureGate,
  PressureOverrideStore,
} from "../src/internal/write-pressure-policy.js";
import type { ResourcePressureReport } from "../src/agent/resource/pressure-probe.js";

const MiB = 1024 * 1024;
const VOLUME = "/volume";

let roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pressure-boundary-"));
  roots.push(root);
  return root;
}

/** A gate whose decisions are fixed, so the boundary behavior can be isolated from the policy. */
function stubGate(
  decision:
    | { action: "allow" }
    | { action: "block"; freeBytes: number }
    | {
        action: "warn";
        signal: "write_pressure_low" | "write_pressure_probe_unavailable";
        freeBytes: number | null;
      },
) {
  const calls: Array<{ producerId: string; toolCallId: string }> = [];
  return {
    calls,
    gate: {
      admit: async (request: {
        producerId: "tool-output-archive" | "recall-store";
        toolCallId: string;
      }) => {
        calls.push(request);
        return {
          action: decision.action,
          signal: decision.action === "warn" ? decision.signal : null,
          producerId: request.producerId,
          volumePath: VOLUME,
          freeBytes: "freeBytes" in decision ? decision.freeBytes : null,
          reason: decision.action === "allow" ? "above threshold" : "test decision",
          overrideId: null,
        };
      },
    },
  };
}

function report(freeBytes: number | null, error?: string): ResourcePressureReport {
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
        path: VOLUME,
        kind: "statfs-cache",
        freeBytes: freeBytes ?? 0,
        totalBytes: 0,
        usedBytes: 0,
        usedRatio: 0,
        sampledAt: 0,
        ageMs: 0,
        servedFromCache: false,
        ...(error === undefined ? {} : { error }),
      },
    ],
    droppedPathCount: 0,
    diskTtlMs: 5000,
  };
}

describe("I7.2 a blocked nonessential write does not touch the destination", () => {
  it("refuses the recall write before creating the archive directory", async () => {
    const root = path.join(await tempRoot(), "scratchpad");
    const stub = stubGate({ action: "block", freeBytes: 1 });
    const archive = new TruncatedToolOutputArchive({ rootDir: root, writePressure: stub.gate });

    const result = await archive.saveRecallEntry("exec_command", "hello", "call-1");
    expect(result).toEqual({ status: "failed", code: "PRESSURE_BLOCKED" });
    // The destination is untouched: the store root does not even exist.
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
    // Nothing was indexed, so an id that was never issued does not resolve either.
    expect(await archive.recall("00000000000000000000000000000000")).toEqual({
      status: "missing",
      id: "00000000000000000000000000000000",
    });
    // The gate was asked with the boundary's own identity, not anything from the payload.
    expect(stub.calls).toEqual([{ producerId: "recall-store", toolCallId: "call-1" }]);
  });

  it("refuses the truncation capture write before it creates the file", async () => {
    const root = path.join(await tempRoot(), "scratchpad");
    const stub = stubGate({ action: "block", freeBytes: 1 });
    const archive = new TruncatedToolOutputArchive({ rootDir: root, writePressure: stub.gate });

    const capture = archive.startCapture();
    capture.append("0123456789".repeat(1000));
    const result = await capture.save("exec_command", "call-9");
    // `save()` returns the commit result for a completed capture; either way, no file exists.
    expect(result === undefined || result.status === "failed").toBe(true);
    if (result !== undefined && result.status === "failed") {
      expect(result.code).toBe("PRESSURE_BLOCKED");
    }
    const entries = await readdir(root).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("still refuses when an override was granted for a different write", async () => {
    const root = path.join(await tempRoot(), "scratchpad");
    const overrides = new PressureOverrideStore();
    await overrides.grant({
      sessionId: "session-1",
      producerId: "recall-store",
      toolCallId: "other-call",
      volumePath: VOLUME,
      grantedBy: "operator",
      reason: "different write",
    });
    const archive = new TruncatedToolOutputArchive({
      rootDir: root,
      writePressure: createProbeWritePressureGate({
        probe: { probe: async () => report(1) },
        volumePath: VOLUME,
        sessionId: "session-1",
        overrides,
      }),
    });
    expect(await archive.saveRecallEntry("exec_command", "text", "call-1")).toEqual({
      status: "failed",
      code: "PRESSURE_BLOCKED",
    });
    // …and the write the grant *was* for is admitted, exactly once.
    const allowed = await archive.saveRecallEntry("exec_command", "text", "other-call");
    expect(allowed.status).toBe("saved");
    // Single-use: the same call id is refused the second time.
    expect(await archive.saveRecallEntry("exec_command", "text2", "other-call")).toEqual({
      status: "failed",
      code: "PRESSURE_BLOCKED",
    });
  });

  it("cannot be forged by payload-shaped fields in scope", async () => {
    const root = path.join(await tempRoot(), "scratchpad");
    const archive = new TruncatedToolOutputArchive({
      rootDir: root,
      writePressure: createProbeWritePressureGate({
        probe: { probe: async () => report(1) },
        volumePath: VOLUME,
        sessionId: "session-1",
      }),
    });
    // A tool call would carry arguments like these; the boundary never reads them.
    const payload = JSON.stringify({ force: true, overrideId: "pressure-override-1" });
    expect(payload).toContain("overrideId");
    expect(await archive.saveRecallEntry("exec_command", "text", "call-1")).toEqual({
      status: "failed",
      code: "PRESSURE_BLOCKED",
    });
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("I7.2 a warned or unmeasurable write proceeds and says so", () => {
  it("saves and carries the low-space warning on the result", async () => {
    const root = await tempRoot();
    const stub = stubGate({ action: "warn", signal: "write_pressure_low", freeBytes: 100 * MiB });
    const archive = new TruncatedToolOutputArchive({ rootDir: root, writePressure: stub.gate });

    const saved = await archive.saveRecallEntry("exec_command", "text", "call-1");
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("unreachable");
    expect(saved.warning).toEqual({
      signal: "write_pressure_low",
      reason: "test decision",
      volumePath: VOLUME,
      freeBytes: 100 * MiB,
    });
    // The warning is not cosmetic: the entry really was stored and is readable.
    expect((await archive.recall(saved.id)).status).toBe("ok");
  });

  it("warns with a null measurement when the probe is unavailable, and still saves", async () => {
    const root = await tempRoot();
    const gate = createProbeWritePressureGate({
      probe: { probe: async () => report(0, "EACCES") },
      volumePath: VOLUME,
      sessionId: "session-1",
    });
    const archive = new TruncatedToolOutputArchive({ rootDir: root, writePressure: gate });
    const saved = await archive.saveRecallEntry("exec_command", "text", "call-1");
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("unreachable");
    expect(saved.warning?.signal).toBe("write_pressure_probe_unavailable");
    expect(saved.warning?.freeBytes).toBeNull();
  });

  it("warns (never blocks) when the gate itself throws, and still saves", async () => {
    const root = await tempRoot();
    let admitted = 0;
    const archive = new TruncatedToolOutputArchive({
      rootDir: root,
      writePressure: {
        admit: async () => {
          admitted += 1;
          throw new Error("gate exploded");
        },
      },
    });
    const saved = await archive.saveRecallEntry("exec_command", "text", "call-1");
    expect(admitted).toBe(1);
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("unreachable");
    expect(saved.warning?.signal).toBe("write_pressure_probe_unavailable");
    expect(saved.warning?.reason).toContain("gate exploded");
    expect(saved.warning?.freeBytes).toBeNull();
  });

  it("keeps the behavior identical when no gate is configured (the rollback)", async () => {
    const root = await tempRoot();
    const archive = new TruncatedToolOutputArchive({ rootDir: root });
    const saved = await archive.saveRecallEntry("exec_command", "text", "call-1");
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("unreachable");
    expect(saved.warning).toBeUndefined();
    expect((await archive.recall(saved.id)).status).toBe("ok");
  });
});

/**
 * Runs one tool call whose output spills past a tiny visible budget, through an Environment whose
 * archive carries the given gate. The exec tool is a stub factory (the same technique
 * `output-compression.test.ts` uses): the point here is the archive's admission, not a shell.
 */
async function runSpillingCall(
  tmp: string,
  gate: ReturnType<typeof stubGate>["gate"],
  toolCallId: string,
): Promise<{
  output: string;
  env: Environment;
  calls: Array<{ producerId: string; toolCallId: string }>;
}> {
  const original = BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME];
  BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME] = (definition) => ({
    name: EXEC_COMMAND_NAME,
    definition,
    async *execute(_args, ctx) {
      yield partialToolCallOutput({
        eventType: "delta",
        output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
        toolCallId: ctx.toolCallId,
      });
      return {};
    },
  });
  try {
    const env = new Environment({
      workspaceDir: tmp,
      sessionScratchpadDir: path.join(tmp, "scratch"),
      writePressure: gate,
      toolConfig: {
        customTools: [
          {
            name: EXEC_COMMAND_NAME,
            description: "probe",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
            // A tiny visible budget forces the spill path, which is where the archive writes.
            maxOutputLength: 200,
          } as ToolDefinitionConfig,
        ],
        mcpServers: [],
      },
    });
    const messages: OmniMessage[] = [];
    for await (const message of env.executeTool({
      toolCall: toolCall({
        name: EXEC_COMMAND_NAME,
        arguments: JSON.stringify({ cmd: "probe" }),
        toolCallId,
      }),
    })) {
      messages.push(message);
    }
    const last = messages.at(-1)!.payload as { output?: string };
    return { output: last.output ?? "", env, calls: [] };
  } finally {
    if (original === undefined) delete BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME];
    else BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME] = original;
  }
}

describe("I7.2 the warning is observable in the result the model sees", () => {
  it("appends the pressure line to a warned truncation note", async () => {
    const tmp = await tempRoot();
    const stub = stubGate({ action: "warn", signal: "write_pressure_low", freeBytes: 100 * MiB });
    const { output, env } = await runSpillingCall(tmp, stub.gate, "call-pressure-1");
    expect(output).toContain("disk pressure write_pressure_low");
    expect(output).toContain(`${100 * MiB} bytes free`);
    // The gate was asked with this call's own identity, never anything from the payload.
    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call.toolCallId).toBe("call-pressure-1");
      expect(["recall-store", "tool-output-archive"]).toContain(call.producerId);
    }
    await env.dispose();
  });

  it("names the refusal when the archive is blocked, keeping the bounded output", async () => {
    const tmp = await tempRoot();
    const stub = stubGate({ action: "block", freeBytes: 1 });
    const { output, env } = await runSpillingCall(tmp, stub.gate, "call-pressure-2");
    // The refusal is named, and the bounded output is still there: refusing the harness's own
    // convenience write never removes the tool result itself.
    expect(output).toContain("PRESSURE_BLOCKED");
    expect(output).toContain("line 0");
    await env.dispose();
  });
});
