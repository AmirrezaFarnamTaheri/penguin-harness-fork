/**
 * resource_pressure — a builtin tool that reports free memory and free disk so the agent can
 * decide what to do about them.
 *
 * ## Why a tool and not a threshold
 *
 * The request behind this module was "add a memory/disk monitor for agents to take better
 * decisions". A monitor that applies a threshold behind the agent's back is not a monitor,
 * it is a gate: the agent is stopped from running a build because a number crossed a line,
 * and the decision to stop was made for it, on information it never saw and could not
 * weigh. A threshold is also a bad guess in both directions — too tight and ordinary work
 * fails on a busy machine, too loose and it never fires.
 *
 * So pressure is exposed, and the decision stays with the agent. This tool is read-only, has
 * no threshold argument, and its output contains no verdict: it reports numbers, says how
 * old each number is, and says what each kind of number means. An agent that reads "1.2 GB
 * free on the data root, 4 minutes old" can decide to run the build anyway, clean up first,
 * or move its output elsewhere. All three are reasonable; only the agent knows which.
 *
 * This is the same discipline the harness's advisory hook already follows
 * (`agent/repeat-tool-guard.ts`): harness-authored input is advisory and rides alongside the
 * agent's own reasoning rather than replacing it.
 *
 * ## What it reports
 *
 * - `memory` — free/total/used, from an instantaneous OS counter (0.48 µs measured, never
 *   cached). Labelled as a page-cache counter rather than an allocation budget, because that
 *   is what it is.
 * - `disks[]` — free/total/used per path, from `statfs` (a real capacity number, TTL-cached
 *   at 5s by default). Each entry carries its `ageMs` and whether it was served from cache,
 *   so the agent is never reading a number whose freshness is hidden from it. `refresh: true`
 *   forces a re-read for the cases where the age actually matters.
 *
 * Division of responsibility with Environment (see environment.ts): non-streaming — one
 * final text delta. A probe failure degrades to an explanatory line rather than throwing,
 * because a monitor that throws under disk pressure is worse than no monitor.
 * Docs: /docs/tools § "Environment".
 */
import { partialToolCallOutput } from "../../omnimessage/index.js";
import type { OmniMessage } from "../../omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../interfaces/index.js";
import type {
  BuiltinTool,
  ToolExecutionContext,
  ToolResult,
} from "../../environment/tools/types.js";
import { describeArgumentError } from "../../environment/tools/tool-arguments.js";
import type { ResourcePressureProbe, ResourcePressureReport } from "./pressure-probe.js";

/** Tool name constant (used only within this tool module, never exposed to Environment). */
export const RESOURCE_PRESSURE_NAME = "resource_pressure";

/** Fallback output budget when the definition carries no maxOutputLength. */
const DEFAULT_OUTPUT_BUDGET = 2000;

export const RESOURCE_PRESSURE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    refresh: {
      type: "boolean",
      description:
        "Optional: re-read free disk now instead of reusing the cached reading (a few seconds old by default). Use when the age of the number actually matters to your decision.",
    },
  },
  required: [],
} as const;

/** Human-readable byte size, at the largest unit that keeps three significant figures. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Renders the report. Kept separate from `execute` so the exact wording the model reads is
 * unit-testable without going through the OmniMessage framing.
 *
 * The ordering is deliberate: what the numbers are, then how fresh they are, then what they
 * do not mean, then the explicit statement that nothing here blocks anything. A model that
 * reads only the first line still gets the facts; one that reads the last line knows it is
 * free to act.
 */
export function formatPressureReport(report: ResourcePressureReport): string {
  const lines: string[] = [];

  lines.push(
    `Memory: ${formatBytes(report.memory.freeBytes)} free of ${formatBytes(report.memory.totalBytes)} ` +
      `(${percent(report.memory.usedRatio)} used, ${formatBytes(report.memory.usedBytes)} in use).`,
  );
  lines.push(
    `  This is an instantaneous OS page-cache counter, not an allocation budget — it moves for ` +
      `reasons unrelated to how much more can be allocated. Read it as a rough signal only.`,
  );

  if (report.disks.length === 0) {
    lines.push("Disk: no filesystem paths are being monitored.");
  }
  for (const disk of report.disks) {
    if (disk.error !== undefined) {
      lines.push(`Disk ${disk.path}: unavailable (${disk.error}).`);
      continue;
    }
    const freshness =
      disk.ageMs <= 0
        ? "read just now"
        : disk.servedFromCache
          ? `cached reading, ${(disk.ageMs / 1000).toFixed(1)}s old (TTL ${(report.diskTtlMs / 1000).toFixed(1)}s)`
          : `${disk.ageMs}ms old`;
    lines.push(
      `Disk ${disk.path}: ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)} ` +
        `(${percent(disk.usedRatio)} used, ${formatBytes(disk.usedBytes)} in use, ${freshness}).`,
    );
  }
  if (report.droppedPathCount > 0) {
    lines.push(
      `  ${report.droppedPathCount} additional path(s) were not monitored: the probe caps how ` +
        `many it stats at once so a call cannot turn into an unbounded syscall sweep.`,
    );
  }

  lines.push(
    `This is information, not a gate: nothing here blocks, throttles or denies a tool call, and ` +
      `no threshold is applied on your behalf. Low free space is a fact to weigh against the work ` +
      `you are about to do — the decision is yours.`,
  );
  return lines.join("\n");
}

/** Slices at a UTF-16 boundary that never splits a surrogate pair. */
function safeSlice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, limit - 1);
  return text.slice(0, limit);
}

export interface ResourcePressureToolOptions {
  /** The probe to report from. Injected so the tool and its test share one implementation. */
  probe: ResourcePressureProbe;
}

/**
 * resource_pressure builtin tool. `definition` is overridden by Environment at construction
 * with the same-named entry from ToolConfig (description/arguments/permissions/limits).
 */
export function createResourcePressureTool(
  definition: ToolDefinitionConfig,
  options: ResourcePressureToolOptions,
): BuiltinTool {
  const budget =
    definition.maxOutputLength !== undefined && definition.maxOutputLength > 0
      ? definition.maxOutputLength
      : DEFAULT_OUTPUT_BUDGET;

  return {
    name: definition.name,
    definition,
    async *execute(
      args: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ): AsyncGenerator<OmniMessage, ToolResult | void> {
      const { toolCallId, signal } = ctx;
      const delta = (output: string): OmniMessage =>
        partialToolCallOutput({ eventType: "delta", output, toolCallId });

      const refresh = args["refresh"];
      if (refresh !== undefined && refresh !== null && typeof refresh !== "boolean") {
        yield delta(
          describeArgumentError(definition, args, {
            argument: "refresh",
            kind: "invalid",
            detail: `expected a boolean (got ${JSON.stringify(refresh)})`,
          }),
        );
        return { stopReason: "fatal" };
      }
      if (signal?.aborted) return { stopReason: "aborted" };

      let text: string;
      try {
        const report = await options.probe.probe(refresh === true);
        text = formatPressureReport(report);
      } catch (err) {
        // A monitor that throws under pressure is worse than no monitor: the agent loses the
        // numbers precisely when it most needs them. Degrade to an explanation instead.
        text =
          `Resource pressure is unavailable right now: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `This blocks nothing — carry on with the work you were doing.`;
      }
      yield delta(text.length > budget ? safeSlice(text, budget) : text);
      return;
    },
  };
}
