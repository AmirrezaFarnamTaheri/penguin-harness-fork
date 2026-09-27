/**
 * Judge robustness: does the verdict survive how the question was phrased?
 *
 * The problem. An LLM judge that only works on the exact wording you happened to ship is not a
 * judge, it is a lookup table — and nothing in the harness can tell the two apart, because both
 * produce a confident label and a pass rate. The same trap has a second door: present the same
 * options in a different ORDER and a judge that tracks position rather than content will follow
 * the position. Both failures are invisible in a single run and obvious across variants.
 *
 * What this module is: a measurement over RECORDED outcomes. The caller runs a question under
 * several wordings and orderings, hands back what the judge answered, and this turns that into
 * flip rate, per-variant calibration, and a verdict. It never calls a model, never edits an
 * artifact, and never repairs a disagreement — a check that can fix the thing it is checking
 * cannot be evidence about it.
 *
 * What this module is not: a way to improve the judge. It reports. Repairs (refitting per
 * wording, augmenting across wordings, test-time adaptation on unlabelled data) are the caller's
 * decision; the honest baseline it is measured against is here so the comparison means something.
 *
 * The subtlety most implementations get wrong, and which is why the bootstrap is here rather
 * than a mean: calibration error, AURC and coverage are NONLINEAR functionals. Averaging them
 * across resamples is not the same number as recomputing them on each resample, and the two
 * differ enough to change a conclusion. Every bootstrap draw below recomputes.
 */
import { createHash } from "node:crypto";
import {
  areaUnderRiskCoverage,
  expectedCalibrationError,
  riskCoverageCurve,
} from "../../llm/selective-prediction.js";

/** The variants a question is asked under. Order and keys are held constant by construction. */
export const DEFAULT_VARIANTS = [
  "original",
  "reworded-light",
  "reworded-restructured",
  "reworded-reframed",
  "options-reversed",
] as const;

export type JudgeVariant = (typeof DEFAULT_VARIANTS)[number] | (string & {});

export interface JudgeAnswer {
  /** The option the judge selected. */
  readonly choice: string;
  /** Its stated confidence, when the judge reports one. */
  readonly confidence?: number;
}

export interface RobustnessInput {
  /** Item id, stable across variants: the same question under each wording. */
  readonly id: string;
  /** The variant this answer came from. */
  readonly variant: JudgeVariant;
  readonly answer: JudgeAnswer;
  /** The option a trusted answer says is right, or null when the item is not scored. */
  readonly correctChoice: string | null;
}

export interface VariantReport {
  readonly variant: JudgeVariant;
  readonly items: number;
  /** Share of scored items answered correctly. Null when nothing was scored. */
  readonly accuracy: number | null;
  /** Expected calibration error over this variant's confidences. */
  readonly calibrationError: number | null;
  /** AURC over this variant's ranking. */
  readonly aurc: number | null;
}

export interface RobustnessVerdict {
  /** Share of scored items whose answer CHANGED between the original and another variant. */
  readonly flipRate: number;
  /** Items that flipped at least once, by id, so a disagreement can be looked at. */
  readonly flipped: string[];
  readonly variants: ReadonlyArray<VariantReport>;
  /**
   * How much of the accuracy difference between the original wording and the others a
   * paired resample can attribute to chance. Pairs are formed on the SAME item, which is the
   * only way to compare two wordings of one question without the item difficulty cancelling out.
   */
  readonly pairedConfidence: number;
  /**
   * The one number to act on: 1 is a judge that follows the content regardless of how it is
   * asked, 0 is one that follows the phrasing.
   */
  readonly robustness: number;
  /** Plain-language reading, for a report rather than a dashboard. */
  readonly summary: string;
}

/** Deterministic pseudo-random source, so a bootstrap here is reproducible. */
function seeded(seed: string): () => number {
  let state = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    // xorshift32: one multiply-free step per draw, stable across platforms.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function variantAccuracy(rows: ReadonlyArray<RobustnessInput>): number | null {
  const scored = rows.filter((row) => row.correctChoice !== null);
  if (scored.length === 0) return null;
  const correct = scored.filter((row) => row.answer.choice === row.correctChoice).length;
  return correct / scored.length;
}

function variantReport(variant: JudgeVariant, rows: ReadonlyArray<RobustnessInput>): VariantReport {
  const mine = rows.filter((row) => row.variant === variant);
  const decisions = mine
    .filter((row) => row.correctChoice !== null && row.answer.confidence !== undefined)
    .map((row) => ({
      id: row.id,
      confidence: row.answer.confidence!,
      correct: row.answer.choice === row.correctChoice,
    }));
  return {
    variant,
    items: mine.length,
    accuracy: variantAccuracy(mine),
    // Recomputed from per-item scores, never averaged from a per-variant number: ECE is a
    // nonlinear functional and the average of ECEs is not the ECE of the whole set.
    calibrationError: decisions.length === 0 ? null : expectedCalibrationError(decisions),
    aurc: decisions.length === 0 ? null : areaUnderRiskCoverage(riskCoverageCurve(decisions)),
  };
}

/**
 * Paired bootstrap over items: resample ITEMS (not answers) with replacement, so both wordings of
 * the same question move together and item difficulty cancels out. `samples` draws; the reported
 * figure is the share of draws in which the original wording came out at least as accurate as
 * the alternative, which is the probability that the observed advantage is not sampling noise.
 */
function pairedConfidence(
  baseline: ReadonlyArray<RobustnessInput>,
  alternative: ReadonlyArray<RobustnessInput>,
  samples: number,
): number {
  const baselineBy = new Map(baseline.map((row) => [row.id, row]));
  const pairs = alternative
    .filter((row) => row.correctChoice !== null && baselineBy.has(row.id))
    .map((row) => ({ base: baselineBy.get(row.id)!, other: row }));
  if (pairs.length === 0) return 1;
  const random = seeded(
    `${pairs.length}:${samples}:${baseline[0]?.variant ?? ""}:${alternative[0]?.variant ?? ""}`,
  );
  let baselineWins = 0;
  for (let draw = 0; draw < samples; draw += 1) {
    let baseCorrect = 0;
    let otherCorrect = 0;
    // A resample must reuse the SAME indices for both arms, or it stops being paired.
    const picks = Array.from({ length: pairs.length }, () => Math.floor(random() * pairs.length));
    for (const index of picks) {
      const pair = pairs[index]!;
      if (pair.base.answer.choice === pair.base.correctChoice) baseCorrect += 1;
      if (pair.other.answer.choice === pair.other.correctChoice) otherCorrect += 1;
    }
    if (baseCorrect >= otherCorrect) baselineWins += 1;
  }
  return baselineWins / samples;
}

export interface RobustnessOptions {
  /** Which variant is the reference the others are compared against. */
  readonly baseline?: JudgeVariant;
  /** Bootstrap draws. 1000 is enough for a decision; more only refines the last decimal. */
  readonly samples?: number;
  /** Variants to report, in order. Defaults to every variant present in the input. */
  readonly variants?: readonly JudgeVariant[];
}

/**
 * Measures one item's answers across variants: does the label hold, how far is calibration from
 * ideal, and is the baseline's edge over each alternative real or sampling noise.
 */
export function assessJudgeRobustness(
  input: readonly RobustnessInput[],
  options: RobustnessOptions = {},
): RobustnessVerdict {
  const variants = options.variants ?? [...new Set(input.map((row) => row.variant))];
  const baseline = options.baseline ?? variants[0] ?? "original";
  const samples = options.samples ?? 1000;
  const reports = variants.map((variant) => variantReport(variant, input));

  // Flip rate: an item whose answer differs from the baseline's on ANY variant. The comparison is
  // against the baseline rather than between variants pairwise, so a judge that answers the same
  // wrong thing every time is not counted as robust.
  const byItem = new Map<string, Map<JudgeVariant, string>>();
  for (const row of input) {
    const perItem = byItem.get(row.id) ?? new Map<JudgeVariant, string>();
    perItem.set(row.variant, row.answer.choice);
    byItem.set(row.id, perItem);
  }
  const flipped: string[] = [];
  let comparable = 0;
  for (const [id, perItem] of byItem) {
    const base = perItem.get(baseline);
    if (base === undefined) continue;
    comparable += 1;
    const differs = [...perItem.entries()].some(
      ([variant, choice]) => variant !== baseline && choice !== base,
    );
    if (differs) flipped.push(id);
  }
  const flipRate = comparable === 0 ? 0 : flipped.length / comparable;

  // Robustness is 1 - flip rate: the share of items whose answer held across every wording and
  // ordering. It is deliberately simple, because the number has to mean the same thing to
  // someone who has not read this file.
  const robustness = 1 - flipRate;

  const baselineRows = input.filter((row) => row.variant === baseline);
  const confidence = variants
    .filter((variant) => variant !== baseline)
    .reduce(
      (worst, variant) =>
        Math.min(
          worst,
          pairedConfidence(
            baselineRows,
            input.filter((row) => row.variant === variant),
            samples,
          ),
        ),
      1,
    );

  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const summary =
    flipRate === 0
      ? `Every item kept the same answer across all ${variants.length} variants (${pct(robustness)} robust).`
      : `${flipped.length} of ${comparable} items changed their answer when the question was reworded or the options reordered (${pct(flipRate)} flip rate, ${pct(robustness)} robust).`;

  return {
    flipRate,
    flipped,
    variants: reports,
    pairedConfidence: confidence,
    robustness,
    summary,
  };
}
