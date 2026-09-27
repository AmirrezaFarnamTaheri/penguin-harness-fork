/**
 * Retention decisions for tool results, on two axes instead of one.
 *
 * The problem. Compaction here folds whole messages, so a tool call and its result live or die
 * together: keeping a 40 MB `cat` output means keeping the call that produced it, and dropping
 * the call means losing the fact that it ever happened. Both halves are wrong. The model
 * frequently still needs to know the call was made with those arguments, and can simply re-run
 * it; what it rarely needs verbatim is a result it could re-observe. Collapsing the two loses
 * information on the keep side and discards the useful half on the drop side.
 *
 * So each call is scored on two questions, and the second one folds re-runnability into itself:
 *
 *   keepCall   — knowing this call was made, with this input, still matters.
 *   keepResult — the output itself should stay verbatim: the assistant needs its contents AND
 *                re-running the tool would not reproduce them.
 *
 * The middle tier is the one that does not exist in a message-folding compactor: the CALL
 * stays (with its arguments) and the RESULT becomes a bounded head plus a re-run note. That is
 * the honest representation — "this was run, here is the start of what it said, run it again if
 * you need the rest" — and it is strictly more informative than either keeping everything or
 * dropping everything.
 *
 * What this module does NOT do: decide. It takes the scores, applies the tiers, and returns the
 * decisions plus the exact number of characters that must survive. Whoever calls it still owns
 * the budget and still has to refuse to compact rather than cut a diagnostic.
 */

export type RetentionAction = "keep" | "drop_result" | "drop_call";

/** A tool call offered for retention, with whatever the scorer knew about it. */
export interface RetentionCandidate {
  /** Identity of the call, so a decision can be traced back to it. */
  readonly id: string;
  /** The arguments, kept verbatim in the `drop_result` tier. */
  readonly callText: string;
  /** Bounded head of the result; the rest is reachable by re-running. */
  readonly resultHead: string;
  /** Full result length in characters, for the budget arithmetic. */
  readonly resultChars: number;
  /** 0..1: does knowing this call happened still matter? */
  readonly keepCall: number;
  /** 0..1: does the result need to survive verbatim? */
  readonly keepResult: number;
  /** Never dropped, whatever the scores say: a pending approval, an error the model must see. */
  readonly pinned?: boolean;
}

export interface RetentionOptions {
  /** At or above this, the whole result survives. */
  readonly keepResultThreshold: number;
  /** At or above this, the call survives even when the result does not. */
  readonly keepCallThreshold: number;
  /** Characters of result kept in the `drop_result` tier. */
  readonly resultHeadChars: number;
  /** Marker written where a result was dropped, so the gap is never silent. */
  readonly omissionNote?: (candidate: RetentionCandidate) => string;
}

export const DEFAULT_RETENTION: RetentionOptions = {
  keepResultThreshold: 0.5,
  keepCallThreshold: 0.5,
  resultHeadChars: 400,
  omissionNote: (candidate) =>
    `[output omitted: ${candidate.resultChars} characters — re-run ${candidate.id} to see it]`,
};

export interface RetentionDecision {
  readonly id: string;
  readonly action: RetentionAction;
  /** Characters this decision costs the budget: the whole thing, or call + head + note. */
  readonly charsKept: number;
}

export interface RetentionPlan {
  readonly decisions: ReadonlyArray<RetentionDecision>;
  /** Total characters the plan requires. Compare against the budget before acting on it. */
  readonly charsRequired: number;
  /** How many results were reduced to a head, and how many calls were dropped entirely. */
  readonly droppedResults: number;
  readonly droppedCalls: number;
}

/**
 * The one-sided floor, taken from the pruner's `MAX_DISPOSABLE_KEEP_PROBABILITY`: a score above
 * this is never "disposable" no matter which side of the threshold it falls on. It exists so a
 * scorer that is confidently wrong about a single item cannot talk the compactor out of keeping
 * something — the model may only ever ADD retention here, never remove it.
 */
export const MAX_DISPOSABLE_KEEP_PROBABILITY = 0.1;

/** The tier for one candidate. `pinned` short-circuits everything. */
export function retentionAction(
  candidate: RetentionCandidate,
  options: RetentionOptions,
): RetentionAction {
  if (candidate.pinned === true) return "keep";
  const keepResult = candidate.keepResult >= options.keepResultThreshold;
  if (keepResult) return "keep";
  const keepCall =
    candidate.keepCall >= options.keepCallThreshold ||
    candidate.keepCall > MAX_DISPOSABLE_KEEP_PROBABILITY;
  return keepCall ? "drop_result" : "drop_call";
}

export function planRetention(
  candidates: readonly RetentionCandidate[],
  options: RetentionOptions = DEFAULT_RETENTION,
): RetentionPlan {
  const note = options.omissionNote ?? DEFAULT_RETENTION.omissionNote!;
  const decisions: RetentionDecision[] = [];
  let charsRequired = 0;
  let droppedResults = 0;
  let droppedCalls = 0;

  for (const candidate of candidates) {
    const action = retentionAction(candidate, options);
    let chars: number;
    switch (action) {
      case "keep":
        chars = candidate.callText.length + candidate.resultChars;
        break;
      case "drop_result":
        chars =
          candidate.callText.length +
          Math.min(candidate.resultHead.length, options.resultHeadChars) +
          note(candidate).length;
        droppedResults += 1;
        break;
      case "drop_call":
        chars = 0;
        droppedCalls += 1;
        break;
    }
    charsRequired += chars;
    decisions.push({ id: candidate.id, action, charsKept: chars });
  }

  return { decisions, charsRequired, droppedResults, droppedCalls };
}

/**
 * Whether a plan fits a character budget, and by how much it misses when it does not.
 *
 * A plan that does not fit is not a plan to act on: the caller must compact something else, or
 * decline. Shrinking the protected floor to make it fit is how a diagnostic gets cut, which is
 * the one outcome worse than carrying more context than the budget allows.
 */
export function fitsBudget(
  plan: RetentionPlan,
  budgetChars: number,
): {
  fits: boolean;
  overBy: number;
} {
  const overBy = plan.charsRequired - budgetChars;
  return { fits: overBy <= 0, overBy: Math.max(0, overBy) };
}
