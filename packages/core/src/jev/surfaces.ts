/**
 * Advisory observation of the surfaces a tool call does not cover.
 *
 * The tool advisor (advisor.ts) answers "is this proposed call the right next move, and how
 * big is its blast radius". It says nothing about the turn that contains it: a turn can be
 * slow because of the model, expensive because it fanned out into subagents, and it can end
 * in a retry ladder that no individual tool call ever looks expensive for. An operator
 * watching tool-call fragments cannot see any of that, so the picture is assembled from
 * pieces that do not add up to a turn.
 *
 * What this adds is the rest of that picture — turn boundaries, session lifecycle, context
 * pressure — and nothing else. The constraints that make the tool advisor safe are the
 * constraints that make this safe, and they are load-bearing rather than stylistic:
 *
 * - **Event-only.** Nothing here returns, sets, or implies a control-flow input. There is no
 *   `decision` field on any answer, and {@link JevSurfaceAdvisory} has no field a caller
 *   could branch on. The questions are phrased as descriptions of the recorded facts, and the
 *   answer vocabulary is a closed enum of observations ("this turn looks routine"), never a
 *   recommendation ("you should retry this turn").
 * - **Not on the critical path.** {@link JevSurfaceAdvisor.notify} is synchronous, returns
 *   void, and starts no awaited work. A turn boundary that fires an observation costs a Map
 *   insert and a microtask; it does not cost the caller one millisecond of provider latency.
 *   {@link observe} exists for tests and for hosts that genuinely want to await a result.
 * - **Fail-soft.** Every failure — timeout, open circuit, malformed response, a facts object
 *   that could not be serialized — becomes an `unavailable` observation carrying a bucket
 *   from a closed vocabulary. Nothing is thrown at a caller mid-turn.
 * - **Bounded.** Observations in flight are coalesced per key and hard-capped; see
 *   {@link JEV_MAX_PENDING_SURFACE_OBSERVATIONS}. Nothing here accumulates per session, per
 *   turn, or per call without a cap.
 *
 * Privacy. The state sent to the provider is a fixed set of counts, durations and enums
 * about a turn. It carries no message text, no tool arguments, no file paths, no user
 * content, and no prompt. That is a different discipline from the tool advisor's, which
 * sends bounded tool metadata: here the fact set is drawn from a closed shape at the type
 * level, so there is no free-form field to bound in the first place.
 */
import { choice, noul, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import { redactCredentials } from "../internal/credential-redactor.js";
import type { AdvisoryActivityRecorder, AdvisorySurface } from "./activity.js";
import { JevClient } from "./client.js";
import { safeDiagnostic } from "./diagnostics.js";

/** One turn, as the host already measured it. Counts and durations only, by construction. */
export interface JevTurnFacts {
  /** Wall-clock milliseconds from run start to run end, measured by the host. */
  durationMs: number;
  /** How the host classified the run's end. It is the host's word, not the provider's. */
  outcome: "completed" | "aborted" | "errored";
  /** Messages published on the Session's stream during the run. */
  messageCount: number;
  /** Subagent sessions registered during the run. Each is a fresh context and fresh spend. */
  subagentsSpawned: number;
  /** The host's own compactability verdict at the end of the turn (see ContextEngine). */
  contextAvailability: "ok" | "unsupported" | "empty" | "just_compacted";
  /** Provider grouping for the model reference that ran the turn. */
  provider: string;
  /** Upstream model id; paired with `provider`, never inferred. */
  modelId: string;
}

/** A point in a Session's life, as the host's active table already tracks it. */
export interface JevSessionFacts {
  event: "resumed" | "long_silence" | "abnormal_end";
  /** For `long_silence`: how long the entry sat idle before the host released it. */
  idleMs?: number;
  /** Background command processes still running in the Session at the time of the event. */
  backgroundProcesses: number;
  /** Background subagents still running at the time of the event. */
  backgroundSubagents: number;
}

/** Context-window pressure, read from the host's own compactability state. */
export interface JevContextFacts {
  trigger: "turn_end" | "compaction_requested";
  availability: "ok" | "unsupported" | "empty" | "just_compacted";
}

export type JevSurfaceFacts =
  | ({ surface: "turn" } & JevTurnFacts)
  | ({ surface: "session" } & JevSessionFacts)
  | ({ surface: "context" } & JevContextFacts);

/**
 * The closed answer vocabulary per surface. A reader can map any value here to a sentence on
 * a screen; none of them can be mapped to an action, because no action takes this type.
 */
export type JevTurnRead = "routine" | "slow_or_costly" | "stalled_or_failing";
export type JevSessionRead = "ordinary" | "unusually_quiet" | "ended_unexpectedly";
export type JevContextRead = "comfortable" | "nearing_pressure" | "under_pressure";

/**
 * One surface observation.
 *
 * Note what is absent. There is no `decision`, no `verdict`, no `shouldRetry`, no `severity`.
 * `worthReview` is a probability that a human might want to look — a number on a chart — and
 * the harness has no code path that reads it. That absence is the contract, and
 * jev-surfaces-invariants.test.ts asserts it rather than trusting this comment.
 */
export interface JevSurfaceAdvisory {
  surface: AdvisorySurface;
  status: "advised" | "unavailable";
  /** The provider's description, or "unknown" when it did not answer. */
  read: JevTurnRead | JevSessionRead | JevContextRead | "unknown";
  /** Probability that a human operator would want to see this surface. Never consulted. */
  worthReviewProbability: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  model?: string;
  /** An allowlisted diagnostic code for an unavailable result; never raw provider text. */
  reason?: string;
}

/**
 * Hard cap on observations in flight. This is the bound that makes "fire one per turn"
 * safe: a fleet of sessions all ending turns at once cannot turn into an unbounded queue of
 * provider calls, because the 129th concurrent observation is dropped and counted rather
 * than queued. 128 comfortably covers a busy single-host server (each concurrent turn holds
 * one slot for the length of one sub-second advisory call).
 */
export const JEV_MAX_PENDING_SURFACE_OBSERVATIONS = 128;

/** Hard wait per surface observation. Same reasoning as the tool advisor's 750ms. */
export const JEV_SURFACE_DEADLINE_MS = 750;

const WORTH_REVIEW = noul(
  "Judging only the recorded facts in `state`, is this event unusual enough that a human operator would want to look at it?",
  {
    true: "A human operator would probably want to see this.",
    false: "This looks ordinary for the harness.",
  },
);

export const JEV_SURFACE_QUESTIONS = {
  turn: {
    turn_read: choice(
      "Read only the recorded facts of the completed turn in `state`. Do not propose any action.",
      {
        routine: "The turn's shape looks ordinary.",
        slow_or_costly: "The turn took unusual time, or fanned out unusually wide.",
        stalled_or_failing: "The turn's shape suggests it stalled or was failing.",
      },
    ),
    worth_review: WORTH_REVIEW,
  },
  session: {
    session_read: choice(
      "Read only the recorded facts of the Session lifecycle event in `state`. Do not propose any action.",
      {
        ordinary: "Nothing unusual about this point in the Session's life.",
        unusually_quiet: "The Session was silent for an unusually long time.",
        ended_unexpectedly: "The Session ended in a way that was not a normal completion.",
      },
    ),
    worth_review: WORTH_REVIEW,
  },
  context: {
    context_read: choice(
      "Read only the recorded context-availability fact in `state`. Do not propose any action.",
      {
        comfortable: "Context availability looks normal for this point in the run.",
        nearing_pressure: "Context looks like it is approaching a limit.",
        under_pressure: "Context looks like it is already at a limit.",
      },
    ),
    worth_review: WORTH_REVIEW,
  },
} as const;

const READS: Readonly<Record<AdvisorySurface, ReadonlySet<string>>> = {
  turn: new Set<JevTurnRead>(["routine", "slow_or_costly", "stalled_or_failing"]),
  session: new Set<JevSessionRead>(["ordinary", "unusually_quiet", "ended_unexpectedly"]),
  context: new Set<JevContextRead>(["comfortable", "nearing_pressure", "under_pressure"]),
};

class SurfaceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevProtocolError";
  }
}

function probability(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new SurfaceProtocolError(`invalid ${name} probability`);
  }
  return value;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function boundedText(value: string): string {
  return redactCredentials(value).slice(0, 128);
}

/**
 * Validates a provider response against the CLOSED vocabulary for its surface. An answer
 * outside the set is a protocol error, not a value to pass through — the same rule the tool
 * advisor applies, and the reason a hostile or confused provider cannot widen this type.
 */
function validateResponse(surface: AdvisorySurface) {
  return (result: SystemOneResult<Questions>): void => {
    const answers = result.answers as Record<string, unknown>;
    const read = answers[READ_QUESTION[surface]];
    if (
      read === null ||
      typeof read !== "object" ||
      (read as { type?: unknown }).type !== "choice" ||
      typeof (read as { choice?: unknown }).choice !== "string" ||
      !READS[surface].has((read as { choice: string }).choice)
    ) {
      throw new SurfaceProtocolError(`Jev returned an invalid ${surface} read`);
    }
    const worth = answers["worth_review"];
    if (
      worth === null ||
      typeof worth !== "object" ||
      (worth as { type?: unknown }).type !== "noul"
    ) {
      throw new SurfaceProtocolError("invalid worth_review answer");
    }
    probability((worth as { noul?: unknown }).noul, "worth_review");
    const usage = result.usage as { input_tokens?: unknown; output_tokens?: unknown } | null;
    if (
      usage === null ||
      typeof usage !== "object" ||
      !Number.isSafeInteger(usage.input_tokens) ||
      (usage.input_tokens as number) < 0 ||
      !Number.isSafeInteger(usage.output_tokens) ||
      (usage.output_tokens as number) < 0
    ) {
      throw new SurfaceProtocolError("invalid usage");
    }
  };
}

const READ_QUESTION: Readonly<Record<AdvisorySurface, string>> = {
  turn: "turn_read",
  session: "session_read",
  context: "context_read",
};

/**
 * Builds the provider state for a surface.
 *
 * `advisory_only` and the `authorization` line are the same two fields the tool advisor
 * sends, kept verbatim so a provider reading either request sees the same rule stated the
 * same way. The state is assembled per surface from a closed set of scalars, so there is no
 * key here that a caller can use to smuggle free-form content — that is a stronger property
 * than the tool advisor's bounded-redaction approach, and it is why these surfaces need no
 * `includeArguments` opt-in.
 */
export function buildJevSurfaceState(input: JevSurfaceFacts): string {
  const base = {
    advisory_only: true,
    authorization:
      "This is a description of recorded facts. The harness's own control flow does not read it.",
    surface: input.surface,
  };
  const state =
    input.surface === "turn"
      ? {
          ...base,
          turn: {
            duration_ms: nonNegativeInt(input.durationMs, 0),
            outcome: input.outcome,
            messages_published: nonNegativeInt(input.messageCount, 0),
            subagents_spawned: nonNegativeInt(input.subagentsSpawned, 0),
            context_availability: input.contextAvailability,
          },
          model: {
            provider: boundedText(input.provider),
            model_id: boundedText(input.modelId),
          },
        }
      : input.surface === "session"
        ? {
            ...base,
            session: {
              event: input.event,
              idle_ms: nonNegativeInt(input.idleMs ?? 0, 0),
              background_processes_running: nonNegativeInt(input.backgroundProcesses, 0),
              background_subagents_running: nonNegativeInt(input.backgroundSubagents, 0),
            },
          }
        : {
            ...base,
            context: {
              trigger: input.trigger,
              availability: input.availability,
            },
          };
  return JSON.stringify(state);
}

export interface JevSurfaceAdvisorOptions {
  /** The client is injected, exactly as for the tool advisor: hosts share one circuit. */
  client: JevClient;
  /** Hard wall-clock budget per observation; defaults to {@link JEV_SURFACE_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Optional operator counters. The advisor behaves identically without one. */
  activity?: AdvisoryActivityRecorder;
  /**
   * Optional sink for a completed observation. It receives a value with no actionable field
   * on it, which is the point: a host can render it, log it, or count it, and none of those
   * can feed a control-flow decision back. A sink that throws is swallowed and counted.
   */
  onObservation?: (advisory: JevSurfaceAdvisory) => void;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

/**
 * Observes turn, session and context surfaces. See the module comment for the invariants
 * this class exists to preserve.
 */
export class JevSurfaceAdvisor {
  private readonly activity?: AdvisoryActivityRecorder;
  private readonly deadlineMs: number;
  private readonly onObservation?: (advisory: JevSurfaceAdvisory) => void;
  private readonly now: () => number;
  /**
   * In-flight observation keys. Bounded by JEV_MAX_PENDING_SURFACE_OBSERVATIONS at all
   * times: an entry is added only when there is room, and removed in a `finally`, so a key
   * cannot outlive its request. A second observation for a key already in flight is
   * coalesced away — the newest wins conceptually, but nothing is queued, because a queued
   * observation is a provider call whose latency outlives the fact that produced it.
   */
  private readonly pending = new Set<string>();

  constructor(private readonly options: JevSurfaceAdvisorOptions) {
    this.deadlineMs = Math.min(
      5000,
      Math.max(50, Math.floor(options.deadlineMs ?? JEV_SURFACE_DEADLINE_MS)),
    );
    this.activity = options.activity;
    this.onObservation = options.onObservation;
    this.now = options.now ?? Date.now;
  }

  /** Observations currently in flight. Exposed for the bound assertion in the tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Records that a surface observation was never attempted, and why — the counterpart to a
   * tool call that was already decided before the advisory seam. Without it the counters
   * could only ever show what happened, never what was skipped, and "how much did the cap
   * throw away" is the number that says whether the cap is set right.
   */
  recordSkipped(surface: AdvisorySurface, reason: "at_capacity" | "coalesced"): void {
    this.activity?.recordSurfaceDropped(surface, reason);
  }

  /**
   * Fire-and-forget observation. Synchronous, returns void, and cannot throw: this is the
   * call a turn boundary, an idle sweep or a compaction request makes, and none of those may
   * wait on — or be broken by — a provider.
   */
  notify(input: JevSurfaceFacts & { key: string; signal?: AbortSignal }): void {
    const key = `${input.surface}\0${input.key}`;
    if (this.pending.has(key)) {
      this.activity?.recordSurfaceDropped(input.surface, "coalesced");
      return;
    }
    if (this.pending.size >= JEV_MAX_PENDING_SURFACE_OBSERVATIONS) {
      // Dropped, not queued. Queueing here would convert a burst of surfaces into a burst
      // of provider calls, which is the exact unbounded growth this class refuses.
      this.activity?.recordSurfaceDropped(input.surface, "at_capacity");
      return;
    }
    this.pending.add(key);
    // The trailing catch is belt and braces, not ceremony: `observe` is written to convert
    // every failure into an unavailable result, so the only way this chain could reject is a
    // bug in that conversion — and a bug there must not become an unhandled rejection in a
    // host that never asked for the result.
    void this.observe({ ...input, key })
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(key);
      });
  }

  /**
   * Awaits one observation. Provided for tests and for a host that observes from a place
   * where awaiting is correct (an offline report, a test). Production call sites use
   * {@link notify}, which is the one that cannot add latency to anything.
   */
  async observe(
    input: JevSurfaceFacts & { key: string; signal?: AbortSignal },
  ): Promise<JevSurfaceAdvisory> {
    const startedAt = this.now();
    const finish = (advisory: JevSurfaceAdvisory): JevSurfaceAdvisory => {
      this.activity?.recordSurface({
        surface: input.surface,
        advised: advisory.status === "advised",
      });
      try {
        this.onObservation?.(advisory);
      } catch {
        // A host sink that throws is the host's bug, not a reason to fail the turn that
        // produced the observation. It is swallowed deliberately and only that.
      }
      return advisory;
    };
    try {
      const result = await this.options.client.ask<Questions>(
        {
          state: buildJevSurfaceState(input),
          questions: JEV_SURFACE_QUESTIONS[input.surface],
        },
        input.signal,
        { deadlineMs: this.deadlineMs, validate: validateResponse(input.surface) },
      );
      const answers = result.answers as Record<string, unknown>;
      const read = answers[READ_QUESTION[input.surface]] as { choice: string; confidence: number };
      const worth = answers["worth_review"] as { noul: number };
      const usage = result.usage;
      return finish({
        surface: input.surface,
        status: "advised",
        read: read.choice as JevSurfaceAdvisory["read"],
        worthReviewProbability: probability(worth.noul, "worth_review"),
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        latencyMs: Math.max(0, Math.round(this.now() - startedAt)),
        ...(typeof result.model === "string" && result.model.length > 0
          ? { model: result.model.slice(0, 128) }
          : {}),
      });
    } catch (error) {
      return finish({
        surface: input.surface,
        status: "unavailable",
        read: "unknown",
        worthReviewProbability: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Math.max(0, Math.round(this.now() - startedAt)),
        reason: safeDiagnostic(error),
      });
    }
  }
}
