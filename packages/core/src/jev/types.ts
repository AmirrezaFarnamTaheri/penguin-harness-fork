import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";

/** The three advisory answers used for a proposed tool call. */
export type JevToolChoice = "matches" | "different_tool" | "no_tool" | "unknown";
export type JevAdvisoryStatus = "advised" | "unavailable";

/**
 * A bounded, non-authorizing observation about one proposed tool call.
 *
 * This is deliberately not an approval decision. The harness's deterministic
 * permission, command policy, and approval callback remain authoritative.
 */
export interface JevToolAdvisory {
  status: JevAdvisoryStatus;
  choice: JevToolChoice;
  confidence: number | null;
  /** Normalized to the human-readable 1–5 range (the SDK score itself is 0-based). */
  riskScore: number | null;
  needsToolProbability: number | null;
  argumentsCompleteProbability: number | null;
  requiresApprovalProbability: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  model?: string;
  /** An allowlisted diagnostic code for an unavailable result; never raw provider text. */
  reason?: string;
}

/** The request shape accepted by the reusable TypeSafe client. */
export type JevRequest<Q extends Questions = Questions> = SystemOneRequest<Q>;

/** The response shape returned by the reusable TypeSafe client. */
export type JevResponse<Q extends Questions = Questions> = SystemOneResult<Q>;
