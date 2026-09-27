import { describe, it, expect } from "vitest";
import { ResourcePressureProbe } from "../../../src/agent/resource/pressure-probe.js";
import {
  createResourcePressureTool,
  formatPressureReport,
  RESOURCE_PRESSURE_NAME,
  RESOURCE_PRESSURE_PARAMETERS,
} from "../../../src/agent/resource/resource-pressure-tool.js";
import type { ToolDefinitionConfig } from "../../../src/interfaces/index.js";
import type { OmniMessage } from "../../../src/omnimessage/index.js";
import type { BuiltinTool, ToolExecutionContext } from "../../../src/environment/tools/types.js";

const GIB = 1024 * 1024 * 1024;

function definition(overrides: Partial<ToolDefinitionConfig> = {}): ToolDefinitionConfig {
  return {
    name: RESOURCE_PRESSURE_NAME,
    description:
      "Report free memory and free disk so the agent can weigh them against the work ahead.",
    parameters: RESOURCE_PRESSURE_PARAMETERS as unknown as Record<string, unknown>,
    ...overrides,
  };
}

function probeWith(
  overrides: {
    freeBytes?: number;
    totalBytes?: number;
    bavail?: number;
    blocks?: number;
    diskTtlMs?: number;
    paths?: string[];
  } = {},
) {
  return new ResourcePressureProbe({
    paths: overrides.paths ?? ["/data", "/workspace"],
    diskTtlMs: overrides.diskTtlMs ?? 5000,
    memory: {
      free: () => overrides.freeBytes ?? 2 * GIB,
      total: () => overrides.totalBytes ?? 8 * GIB,
    },
    statfs: (path) => {
      if (path === "/missing") return Promise.reject(new Error("ENOENT"));
      return Promise.resolve({
        bsize: 4096,
        blocks: overrides.blocks ?? 65_536, // 256 MiB
        bavail: overrides.bavail ?? 16_384, // 64 MiB free
        bfree: 16_384,
      });
    },
  });
}

/** Drives the tool to completion and returns the concatenated text output. */
async function run(
  tool: BuiltinTool,
  args: Record<string, unknown> = {},
): Promise<{ text: string; stopReason: string | undefined }> {
  const ctx: ToolExecutionContext = { workspaceDir: "/workspace", toolCallId: "call-1" };
  let text = "";
  const gen = tool.execute(args, ctx);
  let next = await gen.next();
  while (!next.done) {
    const msg: unknown = next.value;
    // The generator yields the envelope `{ type, payload }`; the text lives on
    // `payload.output`. Narrowing on the payload rather than asserting keeps a change to the
    // message shapes failing here instead of silently producing an empty string.
    if (typeof msg === "object" && msg !== null && "payload" in msg) {
      const payload = (msg as { payload: unknown }).payload;
      if (typeof payload === "object" && payload !== null && "output" in payload) {
        const output = (payload as { output: unknown }).output;
        if (typeof output === "string") text += output;
      }
    }
    next = await gen.next();
  }
  // The generator's return type is `ToolResult | void`; narrow rather than assert so a
  // change to the tool contract surfaces here.
  const returned: unknown = next.value;
  const stopReason: string | undefined =
    typeof returned === "object" && returned !== null && "stopReason" in returned
      ? ((returned as { stopReason: unknown }).stopReason as string | undefined)
      : undefined;
  return { text, stopReason };
}

describe("resource_pressure tool", () => {
  it("reports free memory and free disk", async () => {
    const tool = createResourcePressureTool(definition(), { probe: probeWith() });
    const { text } = await run(tool);
    expect(text).toContain("2.0GB free of 8.0GB");
    expect(text).toContain("/data");
    expect(text).toContain("/workspace");
  });

  it("labels memory as a page-cache counter, not an allocation budget", async () => {
    const tool = createResourcePressureTool(definition(), { probe: probeWith() });
    const { text } = await run(tool);
    // Presenting free memory as a budget is the single easiest way to make an agent treat
    // a meaningless number as a hard constraint.
    expect(text).toContain("instantaneous OS page-cache counter");
    expect(text).toContain("not an allocation budget");
  });

  it("states plainly that nothing here gates the agent", async () => {
    const tool = createResourcePressureTool(definition(), { probe: probeWith() });
    const { text } = await run(tool);
    expect(text).toContain("information, not a gate");
    expect(text).toContain("blocks, throttles or denies");
    expect(text).toContain("the decision is yours");
  });

  it("reports how stale each disk reading is", async () => {
    let t = 0;
    const probe = new ResourcePressureProbe({
      paths: ["/data"],
      diskTtlMs: 5000,
      now: () => t,
      statfs: () => Promise.resolve({ bsize: 4096, blocks: 65_536, bavail: 16_384, bfree: 16_384 }),
    });
    const tool = createResourcePressureTool(definition(), { probe });
    await run(tool);
    t = 3000;
    const { text } = await run(tool);
    expect(text).toMatch(/cached reading, 3\.0s old \(TTL 5\.0s\)/);
  });

  it("refresh forces a fresh reading", async () => {
    let sweeps = 0;
    const probe = new ResourcePressureProbe({
      paths: ["/data"],
      diskTtlMs: 60_000,
      statfs: () => {
        sweeps++;
        return Promise.resolve({ bsize: 4096, blocks: 65_536, bavail: 16_384, bfree: 16_384 });
      },
    });
    const tool = createResourcePressureTool(definition(), { probe });
    await run(tool);
    await run(tool, { refresh: true });
    expect(sweeps).toBe(2);
  });

  it("rejects a non-boolean refresh instead of coercing it", async () => {
    const tool = createResourcePressureTool(definition(), { probe: probeWith() });
    const { text, stopReason } = await run(tool, { refresh: "yes" });
    expect(stopReason).toBe("fatal");
    expect(text).toMatch(/refresh/);
    expect(text).not.toContain("free of");
  });

  it("degrades to an explanation when the probe throws", async () => {
    // A monitor that dies under disk pressure takes away the numbers exactly when the agent
    // needs them most, and takes the tool call with it.
    const probe = {
      probe: () => Promise.reject(new Error("EMFILE: too many open files")),
    } as unknown as ResourcePressureProbe;
    const tool = createResourcePressureTool(definition(), { probe });
    const { text, stopReason } = await run(tool);
    expect(stopReason).toBeUndefined();
    expect(text).toContain("EMFILE");
    expect(text).toContain("This blocks nothing");
  });

  it("reports a path that could not be read without failing the call", async () => {
    const tool = createResourcePressureTool(definition(), {
      probe: probeWith({ paths: ["/missing", "/data"] }),
    });
    const { text, stopReason } = await run(tool);
    expect(stopReason).toBeUndefined();
    expect(text).toContain("/missing");
    expect(text).toContain("ENOENT");
    // The healthy path is still reported: one bad mount must not blind the agent.
    expect(text).toContain("/data: 64.0MB free");
  });

  it("says so when no filesystem is being monitored", async () => {
    const tool = createResourcePressureTool(definition(), { probe: probeWith({ paths: [] }) });
    const { text } = await run(tool);
    expect(text).toContain("no filesystem paths are being monitored");
  });

  it("stops cleanly when the call is already aborted", async () => {
    const tool = createResourcePressureTool(definition(), { probe: probeWith() });
    const controller = new AbortController();
    controller.abort();
    const gen = tool.execute(
      {},
      { workspaceDir: "/w", toolCallId: "c", signal: controller.signal },
    );
    const result = await gen.next();
    expect(result.done).toBe(true);
    const returned: unknown = result.value;
    expect(
      typeof returned === "object" && returned !== null && "stopReason" in returned
        ? returned.stopReason
        : undefined,
    ).toBe("aborted");
  });

  it("trims to the configured budget without splitting a character", async () => {
    const tool = createResourcePressureTool(definition({ maxOutputLength: 40 }), {
      probe: probeWith(),
    });
    const { text } = await run(tool);
    expect(text.length).toBeLessThanOrEqual(40);
    // A trim must not end on a lone lead surrogate.
    const last = text.charCodeAt(text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("exposes the tool under the configured name", () => {
    const tool = createResourcePressureTool(definition({ name: "custom_name" }), {
      probe: probeWith(),
    });
    expect(tool.name).toBe("custom_name");
  });
});

describe("formatPressureReport", () => {
  it("mentions a near-full disk without turning it into a verdict", async () => {
    // 1 MiB free of 256 MiB: the reading is reported plainly, and the decision stays open.
    const report = await probeWith({ bavail: 256, blocks: 65_536 }).probe();
    const text = formatPressureReport(report);
    expect(text).toContain("99.6% used");
    expect(text).not.toMatch(/\b(blocked|denied|refused|too low|fail)\b/i);
    expect(text).toContain("the decision is yours");
  });

  it("notes paths the probe refused to stat rather than hiding them", async () => {
    const probe = new ResourcePressureProbe({
      paths: ["/a", "/b", "/c"],
      maxPaths: 1,
      statfs: () => Promise.resolve({ bsize: 4096, blocks: 1, bavail: 1, bfree: 1 }),
    });
    const text = formatPressureReport(await probe.probe());
    expect(text).toContain("2 additional path(s) were not monitored");
  });
});
