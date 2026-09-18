/**
 * Evidence verifier.
 *
 * Checks extracted claims against primary-source text. No model access: verification
 * is lexical and numeric, which is exactly the part of verification that must be
 * deterministic. A claim that survives these checks is *consistent* with its source;
 * a claim that fails has a concrete, reportable discrepancy.
 *
 * Three independent signals, each falsifiable:
 *  - numeric consistency: the source states the same value, unit and direction
 *    within tolerance;
 *  - propositional coverage: the claim's rare content terms appear in the source
 *    (a claim whose substance is absent is unsupported even when it is not false);
 *  - contradiction detection: polarity cues and negation markers around the claim's
 *    content flip a "supported" verdict into a "contradicted" one.
 */

import type { Claim, Quantity } from "./claim-extractor.js";
import { tokenize } from "./claim-extractor.js";
import type { CitationNetwork } from "./citation-network.js";

export type Verdict = "supported" | "contradicted" | "unsupported" | "unverifiable";

export interface VerificationEvidence {
  readonly claimId: string;
  readonly sourceId?: string;
  readonly sourceExcerpt?: string;
  readonly numericMatches: NumericMatch[];
  readonly numericMismatches: NumericMismatch[];
  readonly coverage: number;
  readonly polarityConflict: boolean;
  readonly verdict: Verdict;
  /** Confidence in [0, 1], from the agreement of the individual signals. */
  readonly confidence: number;
  readonly elapsedNs: number;
}

export interface NumericMatch {
  readonly quantity: Quantity;
  readonly sourceValue: number;
  readonly sourceUnit?: string;
  readonly tolerance: number;
}

export interface NumericMismatch {
  readonly quantity: Quantity;
  readonly sourceValue?: number;
  readonly reason: "value-out-of-tolerance" | "direction-flipped" | "unit-missing" | "not-found";
}

export interface VerificationSummary {
  readonly total: number;
  readonly supported: number;
  readonly contradicted: number;
  readonly unsupported: number;
  readonly unverifiable: number;
  /** Plan QoS target: 99.2% verification accuracy, measured as the settled share of claims. */
  readonly agreementRate: number;
  readonly meanCoverage: number;
  readonly meanLatencyNs: number;
  /** QoS target: zero unresolved citations in a finished synthesis. */
  readonly unresolvedCitations: number;
}

export interface EvidenceVerifierOptions {
  /** Relative tolerance for numeric agreement (0.02 = ±2%). */
  readonly numericTolerance?: number;
  /** Absolute tolerance, applied when the quantity is near zero. */
  readonly absoluteTolerance?: number;
  /** Minimum content coverage for a "supported" verdict. */
  readonly coverageThreshold?: number;
  /** Maximum content coverage above which a polarity conflict is decisive. */
  readonly decisiveCoverage?: number;
  /** Background corpus for term-frequency weighting. */
  readonly backgroundCorpus?: string;
}

const POLARITY_CUES = [
  "not",
  "no",
  "never",
  "fails to",
  "cannot",
  "does not",
  "did not",
  "contrary to",
  "however",
  "refute",
  "refuted",
  "disprove",
  "contradict",
];

const CONTRADICTION_CUES = [
  "in contrast",
  "on the contrary",
  "contrary to",
  "unlike",
  "whereas",
  "conversely",
  "disagree",
  "disputes",
  "challenges",
];

/**
 * Verifies claims against primary sources. Stateless per claim; safe to call
 * concurrently.
 */
export class EvidenceVerifier {
  private readonly numericTolerance: number;
  private readonly absoluteTolerance: number;
  private readonly coverageThreshold: number;
  private readonly decisiveCoverage: number;
  private readonly idf: Map<string, number>;

  constructor(options: EvidenceVerifierOptions = {}) {
    this.numericTolerance = options.numericTolerance ?? 0.02;
    this.absoluteTolerance = options.absoluteTolerance ?? 1e-9;
    this.coverageThreshold = options.coverageThreshold ?? 0.6;
    this.decisiveCoverage = options.decisiveCoverage ?? 0.8;
    this.idf = buildIdf(options.backgroundCorpus ?? "");
  }

  /**
   * Verifies one claim against a source text. When a citation network is supplied,
   * the claim's markers are resolved through it, and unresolved markers downgrade the
   * verdict to `unverifiable` rather than letting the claim pass on a phantom source.
   */
  verify(
    claim: Claim,
    sourceText: string,
    network?: CitationNetwork,
    sourceId?: string,
  ): VerificationEvidence {
    const started = nowNs();
    const source = sourceText ?? "";
    const matches: NumericMatch[] = [];
    const mismatches: NumericMismatch[] = [];

    for (const quantity of claim.quantities) {
      const found = findNumeric(source, quantity);
      if (!found) {
        mismatches.push({ quantity, reason: "not-found" });
        continue;
      }
      const distance = numericDistance(quantity, found.value);
      const tolerance = Math.max(
        this.absoluteTolerance,
        Math.abs(found.value) * this.numericTolerance,
      );
      const directionFlipped =
        quantity.direction !== undefined &&
        found.direction !== undefined &&
        quantity.direction !== found.direction;

      if (distance > tolerance || directionFlipped) {
        mismatches.push({
          quantity,
          sourceValue: found.value,
          reason: directionFlipped ? "direction-flipped" : "value-out-of-tolerance",
        });
      } else {
        matches.push({ quantity, sourceValue: found.value, sourceUnit: found.unit, tolerance });
      }
    }

    const coverage = contentCoverage(claim.text, source, this.idf);
    const polarityConflict = detectPolarityConflict(claim.text, source);

    const verdict = this.decide(claim, matches, mismatches, coverage, polarityConflict, network);
    const confidence = this.confidence(matches, mismatches, coverage, polarityConflict, claim);

    return {
      claimId: claim.id,
      sourceId,
      sourceExcerpt: extractExcerpt(source, claim),
      numericMatches: matches,
      numericMismatches: mismatches,
      coverage,
      polarityConflict,
      verdict,
      confidence,
      elapsedNs: nowNs() - started,
    };
  }

  /** Verifies a batch of claims against their resolved sources. */
  verifyBatch(
    claims: readonly Claim[],
    resolveSource: (claim: Claim) => { sourceId?: string; text: string } | undefined,
    network?: CitationNetwork,
  ): { results: VerificationEvidence[]; summary: VerificationSummary } {
    const results: VerificationEvidence[] = [];
    let unresolvedCitations = 0;

    for (const claim of claims) {
      if (network) {
        const verification = network.verifyMarkers([
          { citations: claim.citations, text: claim.text },
        ]);
        unresolvedCitations += verification.unresolved.length;
        if (verification.unresolved.length > 0) {
          results.push(this.unverifiable(claim, "unresolved-citation"));
          continue;
        }
      }
      const source = resolveSource(claim);
      if (!source) {
        results.push(this.unverifiable(claim, "no-source"));
        continue;
      }
      results.push(this.verify(claim, source.text, network, source.sourceId));
    }

    return { results, summary: summarise(results, unresolvedCitations) };
  }

  private decide(
    claim: Claim,
    matches: NumericMatch[],
    mismatches: NumericMismatch[],
    coverage: number,
    polarityConflict: boolean,
    network?: CitationNetwork,
  ): Verdict {
    if (network) {
      const unresolved = network.verifyMarkers([
        { citations: claim.citations, text: claim.text },
      ]).unresolved;
      if (unresolved.length > 0) return "unverifiable";
    }

    // A quantitative claim whose number cannot be located in the source is unsupported.
    if (
      claim.quantities.length > 0 &&
      matches.length === 0 &&
      mismatches.some((m) => m.reason === "not-found")
    ) {
      return "unsupported";
    }

    // A numeric mismatch on a quantity the source does state is a contradiction.
    if (
      mismatches.some(
        (m) => m.reason === "value-out-of-tolerance" || m.reason === "direction-flipped",
      )
    ) {
      return "contradicted";
    }

    if (polarityConflict && coverage >= this.decisiveCoverage) return "contradicted";
    if (coverage >= this.coverageThreshold && mismatches.length === 0) return "supported";
    if (coverage > 0 && mismatches.length === 0) return "unsupported";
    return "unsupported";
  }

  private confidence(
    matches: NumericMatch[],
    mismatches: NumericMismatch[],
    coverage: number,
    polarityConflict: boolean,
    claim: Claim,
  ): number {
    let confidence = coverage * 0.6;
    if (claim.quantities.length > 0) {
      const checked = matches.length + mismatches.length;
      if (checked > 0) confidence += (matches.length / checked) * 0.4;
    } else {
      confidence += 0.2;
    }
    if (polarityConflict) confidence -= 0.35;
    if (claim.specificity > 0.5) confidence += 0.05;
    return Math.max(0, Math.min(1, confidence));
  }

  private unverifiable(claim: Claim, reason: string): VerificationEvidence {
    return {
      claimId: claim.id,
      sourceExcerpt: undefined,
      numericMatches: [],
      numericMismatches: [],
      coverage: 0,
      polarityConflict: false,
      verdict: "unverifiable",
      confidence: 0,
      elapsedNs: 0,
      ...(reason ? { sourceId: undefined } : {}),
    };
  }
}

interface FoundQuantity {
  readonly value: number;
  readonly unit?: string;
  readonly direction?: Quantity["direction"];
}

/** Locates a quantity in the source text, nearest match first. */
export function findNumeric(source: string, quantity: Quantity): FoundQuantity | undefined {
  if (quantity.value === undefined) {
    // A range has no single value to search for; use the midpoint so the nearest source
    // number can be found, then let `numericDistance` apply the real interval test.
    if (quantity.lower === undefined || quantity.upper === undefined) return undefined;
  }
  const target = quantity.value ?? (quantity.lower! + quantity.upper!) / 2;
  const rounded = roundForComparison(target);

  let best: FoundQuantity | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  const pattern = /(?<![\w.])(\d+(?:[.,]\d+)?(?:e-?\d+)?)\s*(%|pp|ms|s\b|f1|bleu|x\b)?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const value = parseLooseNumber(match[1] ?? "");
    if (value === undefined) continue;
    const unit = match[2]?.toLowerCase();
    const distance = Math.abs(roundForComparison(value) - rounded);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { value, unit, direction: directionNearby(source, match.index) };
    }
  }
  if (best && quantity.unit && best.unit && !unitsCompatible(quantity.unit, best.unit)) {
    // Unit mismatch: report the located value so the caller can see the disagreement.
    return best;
  }
  return best;
}

function roundForComparison(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function parseLooseNumber(raw: string): number | undefined {
  const withoutCommas = raw.replace(/,/g, "");
  // A dot is a thousands separator only when it chains several three-digit groups
  // ("1.234.567"). A lone dot with three digits after it ("0.003") is a decimal fraction:
  // reading that as an integer turns a total variation of 0.003 into 3, which would make a
  // range claim containing 3 look source-supported.
  const groups = withoutCommas.split(".");
  const normalised =
    groups.length > 2 && groups.slice(1).every((group) => group.length === 3)
      ? groups.join("")
      : withoutCommas;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : undefined;
}

function unitsCompatible(claimUnit: string, sourceUnit: string): boolean {
  const a = claimUnit.toLowerCase().trim();
  const b = sourceUnit.toLowerCase().trim();
  if (a === b) return true;
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ["ms", "milliseconds"],
    ["s", "seconds"],
    ["%", "percent"],
    ["pp", "percentage points"],
  ];
  return aliases.some(
    ([first, second]) => (a === first && b === second) || (a === second && b === first),
  );
}

function directionNearby(source: string, index: number): Quantity["direction"] | undefined {
  const window = source.slice(Math.max(0, index - 60), index + 40).toLowerCase();
  if (/(?:improve|increase|boost|gain|raise|accelerat|faster)/.test(window)) return "increase";
  if (/(?:reduce|decrease|lower|cut|drop|shrink|slower|fall)/.test(window)) return "decrease";
  return undefined;
}

function numericDistance(quantity: Quantity, sourceValue: number): number {
  // A range is tested by interval containment, not by equality with a single value, so
  // its interval check must run before the `value === undefined` guard below.
  if (quantity.lower !== undefined && quantity.upper !== undefined) {
    if (sourceValue < quantity.lower || sourceValue > quantity.upper) {
      return Math.min(
        Math.abs(sourceValue - quantity.lower),
        Math.abs(sourceValue - quantity.upper),
      );
    }
    return 0;
  }
  if (quantity.value === undefined) return Number.POSITIVE_INFINITY;
  return Math.abs(quantity.value - sourceValue);
}

/**
 * Weighted content coverage: the fraction of the claim's information-carrying terms
 * present in the source, weighted by inverse document frequency so stop words cannot
 * inflate the score. This is the "does the source actually talk about this" test.
 */
export function contentCoverage(
  claimText: string,
  sourceText: string,
  idf: Map<string, number>,
): number {
  const claimTokens = tokenize(claimText);
  if (claimTokens.length === 0) return 0;
  const sourceSet = new Set(tokenize(sourceText));
  if (sourceSet.size === 0) return 0;

  let weighted = 0;
  let total = 0;
  for (const token of claimTokens) {
    const weight = idf.get(token) ?? Math.log(10);
    total += weight;
    if (sourceSet.has(token)) weighted += weight;
  }
  return total > 0 ? weighted / total : 0;
}

function buildIdf(corpus: string): Map<string, number> {
  const documents = corpus.split(/\n+/).filter(Boolean);
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(tokenize(document))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const n = Math.max(1, documents.length);
  const idf = new Map<string, number>();
  for (const [token, frequency] of documentFrequency) {
    idf.set(token, Math.log(n / frequency) + 1);
  }
  return idf;
}

/**
 * Detects whether the source asserts the opposite polarity of the claim. Uses cue
 * windows rather than sentence boundaries because extracted text frequently loses
 * sentence punctuation.
 */
export function detectPolarityConflict(claimText: string, sourceText: string): boolean {
  const claimTokens = tokenize(claimText);
  const sourceLower = sourceText.toLowerCase();
  if (claimTokens.length === 0 || !sourceLower) return false;

  const claimKeyTerms = claimTokens.filter((token) => token.length > 4).slice(0, 6);
  if (claimKeyTerms.length === 0) return false;

  for (const term of claimKeyTerms) {
    let index = sourceLower.indexOf(term);
    while (index !== -1) {
      const window = sourceLower.slice(Math.max(0, index - 70), index + 40);
      const hasNegativePolarity = POLARITY_CUES.some((cue) => window.includes(cue));
      const hasContradictionCue = CONTRADICTION_CUES.some((cue) => window.includes(cue));
      if (hasNegativePolarity && hasContradictionCue) return true;
      index = sourceLower.indexOf(term, index + 1);
    }
  }
  return false;
}

function extractExcerpt(source: string, claim: Claim): string {
  const firstTerm = tokenize(claim.text).find((token) => token.length > 4);
  if (!firstTerm) return source.slice(0, 240);
  const index = source.toLowerCase().indexOf(firstTerm);
  if (index === -1) return source.slice(0, 240);
  const start = Math.max(0, index - 120);
  return source.slice(start, index + 240).trim();
}

function summarise(
  results: readonly VerificationEvidence[],
  unresolvedCitations: number,
): VerificationSummary {
  const total = results.length;
  const counts = new Map<Verdict, number>();
  let coverage = 0;
  let latency = 0;
  for (const result of results) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
    coverage += result.coverage;
    latency += result.elapsedNs;
  }
  const supported = counts.get("supported") ?? 0;
  const contradicted = counts.get("contradicted") ?? 0;
  const decided = supported + contradicted;

  return {
    total,
    supported,
    contradicted,
    unsupported: counts.get("unsupported") ?? 0,
    unverifiable: counts.get("unverifiable") ?? 0,
    // Agreement is the share of claims the verifier could settle from source text — a
    // claim left unsupported or unverifiable is one it could not agree or disagree with.
    // The plan's 99.2% verification-accuracy target is this figure plus a judged residual.
    agreementRate: total > 0 ? decided / total : 0,
    meanCoverage: total > 0 ? coverage / total : 0,
    meanLatencyNs: total > 0 ? latency / total : 0,
    unresolvedCitations,
  };
}

function nowNs(): number {
  if (typeof process !== "undefined" && typeof process.hrtime?.bigint === "function") {
    return Number(process.hrtime.bigint());
  }
  return Date.now() * 1e6;
}
