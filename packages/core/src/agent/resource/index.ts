/**
 * Idle release and resource pressure for a waiting agent.
 *
 * Read this first, because the module's name overstates what it does.
 *
 * ## "Hibernate" is not achievable, and this is what is built instead
 *
 * A Node process cannot be suspended in a way that returns memory. `SIGSTOP` freezes the
 * threads and every socket, timer, native handle and V8 page stays exactly where it was —
 * a frozen process holds its entire working set, and a frozen process cannot answer a
 * health check either. Any design claiming to "hibernate the agent" would report a saving
 * that never arrives.
 *
 * What is real, and what this directory implements, is **idle release**: an agent that has
 * declared itself waiting gives back the heavy things it acquired — a live MCP server
 * process, a loaded file index — and rebuilds them on demand. The memory is genuinely
 * returned to the machine and the return is measurable. Nothing is frozen, no stream is cut
 * mid-flight, and the conversation, history and JS heap are untouched.
 *
 * Measured on this repository (win32/x64, node v26.1.0), the cost of an idle agent's
 * holdings, and what happens to each:
 *
 * | holder                    | heap held | system memory | disposition                                  |
 * |---------------------------|-----------|----------------|----------------------------------------------|
 * | Chromium browser tree     | 0         | ~750–760 MB    | already released server-side — see below     |
 * | MCP stdio server          | +4.2 MB   | 51.2 MB        | **released here** while idle, respawns on use |
 * | background command        | 0         | 11.7 MB        | **never released** — not reconstructable     |
 * | file index (1969 files)   | +3.2 MB   | 3.2 MB         | **released here** while idle, rebuilt on use  |
 *
 * The browser is ~92% of an idle agent's footprint and needs nothing from this directory:
 * `SteerableBrowserCluster` already shuts its browser down after `idleShutdownMs` (120s) and
 * its CDP pool already evicts idle sessions past `maxIdleAgeMs` (300s). Two mechanisms
 * racing an existing one would be a regression, not a feature.
 *
 * Re-run the measurement yourself: `measure-idle-holdings.ts` in this directory.
 *
 * ## Observe, never gate
 *
 * Resource pressure is a tool the agent calls ({@link RESOURCE_PRESSURE_NAME}), not a
 * threshold applied to it. There is no `blocked`, no limit, and no path from a pressure
 * reading to a refusal anywhere in this directory. An agent that sees "1.2 GB free" and runs
 * a build anyway is deciding with full information; an agent prevented from running it is
 * being overruled by a number it never saw. The first is the product; the second is the
 * failure mode. The same discipline the harness's advisory hook already follows.
 *
 * ## Release is safe, bounded and reversible
 *
 * Two independent idle signals must agree before anything is let go, only reconstructable
 * resources are eligible at all, only processes this process spawned may be terminated, and
 * every release has a matching restore. See `idle-release.ts` for the four rules and why
 * each one exists.
 */
export { AgentIdleSignal, type IdleClock, type AgentIdleSignalOptions } from "./idle-signal.js";

export {
  defaultPressurePaths,
  ResourcePressureProbe,
  type DiskPressureSample,
  type MemoryCounters,
  type MemoryPressureSample,
  type PressureClock,
  type PressureSampleKind,
  type ResourcePressureProbeOptions,
  type ResourcePressureReport,
  type StatfsLike,
} from "./pressure-probe.js";

export {
  IdleResourceRegistry,
  OwnedProcessGuard,
  type IdleResourceRegistryOptions,
  type ReleasableKind,
  type ReleasableResource,
  type ReleaseOutcome,
  type ReleaseOutcomeKind,
  type SweepResult,
} from "./idle-release.js";

export {
  createBackgroundCommandReleasable,
  createFileIndexReleasable,
  createMcpConnectionReleasable,
  ownedProcessGuard,
  type BackgroundCommandState,
  type FileIndexReleasableOptions,
  type McpIdleCloseCapable,
  type McpReleasableOptions,
  type ReleasableIndex,
} from "./adapters.js";

export {
  createResourcePressureTool,
  formatPressureReport,
  RESOURCE_PRESSURE_NAME,
  RESOURCE_PRESSURE_PARAMETERS,
  type ResourcePressureToolOptions,
} from "./resource-pressure-tool.js";

export { runIdleHoldingsMeasurement } from "./measure-idle-holdings.js";
