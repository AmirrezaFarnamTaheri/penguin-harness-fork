/**
 * Tool-output compression: per-type strategies, the per-call buffer, and the recall handle that
 * makes a compressed result recoverable rather than lossy.
 *
 * The four transforms are the ones borrowed from `rtk` (Apache-2.0) — smart filtering, grouping,
 * truncation, deduplication — applied per output type. The binary-and-hook architecture is not
 * borrowed: this runs in-process on the tool-result path, so it covers built-in tools as well as
 * shell, and there is nothing to install.
 *
 * Entry point for the caller: `classifyToolOutput` (which calls are candidates) and
 * `startCollector` (buffer one call's deltas), then `compressCollected` at finalization.
 */
export { classifyToolOutput } from "./detect.js";
export {
  startCollector,
  compressCollected,
  formatCompressionNote,
  ToolOutputCollector,
} from "./collector.js";
export { compressOutput } from "./strategies.js";
export type { CompressionRequest, CompressionResult, OutputKind } from "./strategies.js";
