/**
 * Speculative decoding subsystem.
 *
 * Modified rejection sampling for draft acceptance, parallel speculative streams with
 * per-stream rollback bookkeeping, and the token-throughput accounting that turns
 * acceptance rates into a defensible speedup figure. No model weights: the draft and
 * target models are injected seams supplying probability rows.
 */

export {
  SeededRandom,
  logAcceptanceRatio,
  acceptanceProbability,
  sampleResidual,
  verifyWindow,
  expectedAcceptCount,
  draftQualityGate,
  optimalWindowSize,
} from "./draft-acceptance.js";
export type {
  ProbabilityRow,
  DraftWindow,
  TargetWindow,
  VerificationMode,
  VerifyOptions,
  VerificationResult,
  DraftQualityReport,
} from "./draft-acceptance.js";

export { SpeculativeRollback, BatchRollbackCoordinator } from "./speculative-rollback.js";
export type {
  RollbackSnapshot,
  TruncationRecord,
  CacheSlotLedger,
} from "./speculative-rollback.js";

export {
  TokenThroughputTracker,
  hrtimeToNs,
  predictedSpeedup,
} from "./token-throughput-tracker.js";
export type {
  RoundMetrics,
  ThroughputReport,
  ThroughputTrackerOptions,
} from "./token-throughput-tracker.js";

export { ParallelSpeculator, runSynthetic } from "./parallel-speculator.js";
export type {
  DraftModel,
  TargetModel,
  DraftRequest,
  VerifyRequest,
  SpeculationFlavour,
  ParallelSpeculatorOptions,
  StreamState,
  RoundOutcome,
  BatchSummary,
} from "./parallel-speculator.js";
