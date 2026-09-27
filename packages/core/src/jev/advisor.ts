import { choice, noul, score, type SystemOneResult } from "@typesafe-ai/sdk";
import { redactCredentials, redactObject } from "../internal/credential-redactor.js";
import type { AdvisoryActivityRecorder } from "./activity.js";
import type { ToolPermission } from "../interfaces/index.js";
import type { PreToolUseHook } from "../hooks/tool-hook.js";
import { JevClient } from "./client.js";
import type { JevToolAdvisory, JevToolChoice } from "./types.js";

/** Keep one advisory request comfortably below common model state limits. */
export const JEV_MAX_STATE_CHARS = 16_000;
export const JEV_MAX_ARGUMENT_CHARS = 8_000;
/** The advisor is observability, not a gate: keep its hard wait short. */
export const JEV_DEFAULT_DEADLINE_MS = 750;

/**
 * The five score anchors are deliberately ordinary-language descriptions. TypeSafe's
 * score primitive is zero-based, so the adapter adds one when exposing the familiar
 * 1–5 risk scale to the harness.
 */
export const JEV_RISK_RUBRIC = [
  "Safe read-only lookup or static format conversion",
  "Non-destructive local write",
  "External read-write or remote network mutation",
  "Destructive disk or repository mutation",
  "Production infrastructure, billing, IAM, or teardown action",
] as const;

export const JEV_TOOL_QUESTIONS = {
  tool_fit: choice(
    "Assess only the proposed tool call in `state`. Does the proposed tool match the next action implied by the state?",
    {
      matches: "The proposed tool is the best next action.",
      different_tool: "A different tool would be a better next action.",
      no_tool: "No tool call is needed for this state.",
    },
  ),
  risk: score("Rate the likely risk and blast radius of the proposed tool call.", JEV_RISK_RUBRIC),
  needs_tool: noul("Does the proposed state need a tool call next?", {
    true: "A tool call is needed next.",
    false: "A plain response or existing result is sufficient.",
  }),
  arguments_complete: noul(
    "Are the proposed tool arguments complete and unambiguous enough to execute?",
    {
      true: "The proposed arguments are complete and unambiguous.",
      false: "Important arguments are missing or ambiguous.",
    },
  ),
  requires_approval: noul(
    "Does the proposed tool call appear to require human approval under a conservative policy? Treat this as advisory only; the harness policy decides.",
    {
      true: "Human approval is likely appropriate.",
      false: "Human approval is probably unnecessary, subject to harness policy.",
    },
  ),
} as const;

type JevToolQuestions = typeof JEV_TOOL_QUESTIONS;
type JevToolResponse = SystemOneResult<JevToolQuestions>;

const TOOL_CHOICES = new Set<JevToolChoice>(["matches", "different_tool", "no_tool"]);

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

class JevProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevProtocolError";
  }
}

function probability(value: unknown, name: string): number {
  if (!finite(value) || value < 0 || value > 1) {
    throw new JevProtocolError(`invalid ${name} probability`);
  }
  return value;
}

function validateUsage(usage: unknown): void {
  const record = usage as { input_tokens?: unknown; output_tokens?: unknown } | null;
  if (
    record === null ||
    typeof record !== "object" ||
    !Number.isSafeInteger(record.input_tokens) ||
    (record.input_tokens as number) < 0 ||
    !Number.isSafeInteger(record.output_tokens) ||
    (record.output_tokens as number) < 0
  ) {
    throw new JevProtocolError("invalid usage");
  }
}

function validateResponse(result: JevToolResponse): void {
  const answers = result.answers as Record<string, unknown>;
  const tool = answers["tool_fit"];
  if (
    tool === null ||
    typeof tool !== "object" ||
    (tool as { type?: unknown }).type !== "choice" ||
    typeof (tool as { choice?: unknown }).choice !== "string" ||
    !TOOL_CHOICES.has((tool as { choice: JevToolChoice }).choice)
  ) {
    throw new JevProtocolError("Jev returned an invalid tool_fit answer");
  }
  if (!finite((tool as { confidence?: unknown }).confidence)) {
    throw new JevProtocolError("Jev returned an invalid tool_fit confidence");
  }

  const risk = answers["risk"];
  if (
    risk === null ||
    typeof risk !== "object" ||
    (risk as { type?: unknown }).type !== "score" ||
    !finite((risk as { score?: unknown }).score) ||
    (risk as { score: number }).score < 0 ||
    (risk as { score: number }).score >= JEV_RISK_RUBRIC.length
  ) {
    throw new JevProtocolError("Jev returned an invalid risk answer");
  }

  for (const [name, answer] of [
    ["needs_tool", answers["needs_tool"]],
    ["arguments_complete", answers["arguments_complete"]],
    ["requires_approval", answers["requires_approval"]],
  ] as const) {
    if (
      answer === null ||
      typeof answer !== "object" ||
      (answer as { type?: unknown }).type !== "noul"
    ) {
      throw new JevProtocolError(`invalid ${name} answer`);
    }
    probability((answer as { noul?: unknown }).noul, name);
  }
  validateUsage(result.usage);
}

function safeDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "JevCircuitOpenError") return "circuit_open";
    if (error.name === "JevProtocolError") return "invalid_response";
    if (error.name === "APIUserAbortError") return "cancelled";
    if (error.name === "APITimeoutError") return "timeout";
    if (error.name === "APIConnectionError") return "connection_error";
  }
  const status =
    error !== null && typeof error === "object"
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    return `provider_http_${status}`;
  }
  return "provider_error";
}

function boundedToolName(value: string): string {
  return redactCredentials(value).slice(0, 256);
}

/**
 * One argument KEY, made safe to put on the wire. Keys are model-authored: the model picks them,
 * so a key can carry anything a value could — a pasted token, a home directory, a customer
 * name. Redaction covers the credential shapes; path-shaped content is a second leak that
 * survives redaction (a bare path holds no recognisable secret), so a key that names a location
 * is reduced to its last segment and a key that is left empty becomes a stable placeholder. The
 * shape the provider sees is unchanged — one short, opaque label per argument — which is all
 * the questions ask for.
 */
function safeArgumentKey(key: string): string {
  // Control characters out, as a Unicode property class rather than a literal range: a literal
  // control byte in a source regex is invisible in review, and a bare `-` inside a character
  // class is a RANGE rather than a hyphen — which is how an earlier version of this line
  // silently kept `A-Z[\]^` and deleted every lowercase letter of every key.
  const cleaned = redactCredentials(key)
    .replace(/\p{Cc}/gu, "")
    .trim();
  if (cleaned === "") return "(unnamed)";
  // A key that spells a path, in either separator: keep the last segment only.
  const lastSlash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  const tail = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
  const bounded = tail.length > 64 ? tail.slice(0, 64) : tail;
  return bounded === "" ? "(unnamed)" : bounded;
}

function argumentSummary(raw: string, includeArguments: boolean): unknown {
  if (raw.length > JEV_MAX_ARGUMENT_CHARS) {
    // Not "here is a summary of a call I did not read". An observation about a call whose
    // arguments were cut is reported as nothing rather than as an answer to a partial question.
    return { omitted: true, original_chars: raw.length, reason: "over_budget" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { valid_json: false, original_chars: raw.length };
  }
  if (includeArguments) return redactObject(parsed);

  // Metadata is the safe default: it lets Jev reason about shape and required
  // slots without receiving source, prompts, paths, or customer payloads.
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 64);
    return {
      valid_json: true,
      // Keys go through safeArgumentKey; the type column is the same slice in the same order, so
      // the two stay index-aligned whatever the key names were rewritten to.
      keys: entries.map(([key]) => safeArgumentKey(key)),
      value_types: entries.map(([, value]) => {
        if (value === null) return "null";
        if (Array.isArray(value)) return "array";
        return typeof value;
      }),
      key_count: Object.keys(parsed as Record<string, unknown>).length,
    };
  }
  return { valid_json: true, value_type: parsed === null ? "null" : typeof parsed };
}

/** State sent to Jev: bounded, credential-scrubbed, and explicitly non-authorizing. */
export function buildJevAdvisoryState(input: {
  toolName: string;
  argumentsJson: string;
  permission?: ToolPermission;
  /** Explicit host opt-in to argument-value egress; omitted means metadata-only. */
  includeArguments?: boolean;
}): string {
  const state = {
    advisory_only: true,
    authorization: "The harness permission and approval policy remain authoritative.",
    tool: {
      name: boundedToolName(input.toolName),
      arguments: argumentSummary(input.argumentsJson, input.includeArguments === true),
    },
    deterministic_permission: input.permission ?? "unknown",
  };
  const serialized = JSON.stringify(state);
  if (serialized.length <= JEV_MAX_STATE_CHARS) return serialized;
  return JSON.stringify({
    advisory_only: true,
    authorization: "The harness permission and approval policy remain authoritative.",
    tool: { name: state.tool.name, arguments: { omitted: true, state_chars: serialized.length } },
    deterministic_permission: state.deterministic_permission,
  });
}

export interface JevToolAdvisorOptions {
  /** The client is injected so hosts can share a circuit/client across advisors. */
  client: JevClient;
  /** Hard wall-clock budget for this advisory call; defaults to 750ms. */
  deadlineMs?: number;
  /**
   * Explicit host opt-in to argument-value egress. The built-in redactor removes
   * recognized credential shapes; it cannot prove an opaque value safe.
   */
  includeArguments?: boolean;
  /**
   * Operator counters. Optional, and the advisor behaves identically without one — observability
   * is never on the path a tool call depends on, so wiring it can never slow a tool call down.
   */
  activity?: AdvisoryActivityRecorder;
}

/**
 * Calls Jev for a bounded advisory observation. Every failure becomes an explicit
 * unavailable result; it never throws into the tool loop and never changes approval.
 */
export class JevToolAdvisor {
  /** Optional operator counters. Absent means "not wired", never a silent failure. */
  private readonly activity?: AdvisoryActivityRecorder;
  private readonly deadlineMs: number;
  private readonly includeArguments: boolean;

  constructor(private readonly options: JevToolAdvisorOptions) {
    this.deadlineMs = boundedInteger(options.deadlineMs, JEV_DEFAULT_DEADLINE_MS, 50, 5000);
    this.includeArguments = options.includeArguments === true;
    this.activity = options.activity;
  }

  /**
   * Records that the advisory seam was NOT reached, and why. Called by the session rather than
   * by this class, because the reasons — a decided call, a policy veto — are properties of the
   * seam above it, not of an advisor that never ran.
   */
  recordSkipped(reason: "disabled" | "decided" | "policy"): void {
    this.activity?.recordSkipped(reason);
  }

  async advise(input: {
    toolName: string;
    argumentsJson: string;
    permission?: ToolPermission;
    signal?: AbortSignal;
  }): Promise<JevToolAdvisory> {
    const startedAt = performance.now();
    try {
      const result = await this.options.client.ask(
        {
          state: buildJevAdvisoryState({
            ...input,
            includeArguments: this.includeArguments,
          }),
          questions: JEV_TOOL_QUESTIONS,
        },
        input.signal,
        { deadlineMs: this.deadlineMs, validate: validateResponse },
      );
      const answers = result.answers as Record<string, unknown>;
      const tool = answers["tool_fit"] as { choice: JevToolChoice; confidence: number };
      const risk = answers["risk"] as { score: number };
      const needsTool = answers["needs_tool"] as { noul: number };
      const argumentsComplete = answers["arguments_complete"] as { noul: number };
      const requiresApproval = answers["requires_approval"] as { noul: number };
      const usage = result.usage;
      const advisory: JevToolAdvisory = {
        status: "advised",
        choice: tool.choice,
        confidence: probability(tool.confidence, "tool_fit confidence"),
        // The SDK's score levels are 0-based; expose a bounded 1–5 scale.
        riskScore: Math.min(5, Math.max(1, risk.score + 1)),
        needsToolProbability: probability(needsTool.noul, "needs_tool"),
        argumentsCompleteProbability: probability(argumentsComplete.noul, "arguments_complete"),
        requiresApprovalProbability: probability(requiresApproval.noul, "requires_approval"),
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(typeof result.model === "string" && result.model.length > 0
          ? { model: result.model.slice(0, 128) }
          : {}),
      };
      this.activity?.record({ advised: true, reason: "advised", latencyMs: advisory.latencyMs });
      return advisory;
    } catch (error) {
      const reason = safeDiagnostic(error);
      // Counted, never narrated: the bucket is a closed word, so no provider string can reach a
      // log through this path.
      this.activity?.record({
        advised: false,
        reason,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      return {
        status: "unavailable",
        choice: "unknown",
        confidence: null,
        riskScore: null,
        needsToolProbability: null,
        argumentsCompleteProbability: null,
        requiresApprovalProbability: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        reason,
      };
    }
  }
}

function advisoryOutput(result: JevToolAdvisory): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {
    jev_status: result.status,
    jev_choice: result.choice,
    jev_latency_ms: result.latencyMs,
  };
  if (result.inputTokens !== null) output["jev_input_tokens"] = result.inputTokens;
  if (result.outputTokens !== null) output["jev_output_tokens"] = result.outputTokens;
  if (result.confidence !== null) output["jev_confidence"] = result.confidence;
  if (result.riskScore !== null) output["jev_risk_score"] = result.riskScore;
  if (result.needsToolProbability !== null) {
    output["jev_needs_tool"] = result.needsToolProbability;
  }
  if (result.argumentsCompleteProbability !== null) {
    output["jev_arguments_complete"] = result.argumentsCompleteProbability;
  }
  if (result.requiresApprovalProbability !== null) {
    output["jev_requires_approval"] = result.requiresApprovalProbability;
  }
  if (result.model !== undefined) output["jev_model"] = result.model;
  if (result.reason !== undefined) output["jev_reason"] = result.reason;
  return output;
}

/**
 * Exposes the advisor through the existing pre-tool-use seam as an event-only hook.
 * There is intentionally no `decision`: deterministic policy and human approval
 * cannot be overridden by a model-generated Jev answer.
 */
export function createJevAdvisoryHook(advisor: JevToolAdvisor): PreToolUseHook {
  return {
    name: "jev_advisory",
    // Lets the seam above report a call the advisor never saw. Without this the counters can
    // only ever show what happened, never what did not — and "how many calls were already
    // decided before the advisor" is the number that says whether it is earning its place.
    recordSkipped: (reason) => advisor.recordSkipped(reason),
    async run(input) {
      const result = await advisor.advise({
        toolName: input.toolName,
        argumentsJson: input.argumentsJson,
        permission: input.permission,
        signal: input.signal,
      });
      return { output: advisoryOutput(result) };
    },
  };
}
