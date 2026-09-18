/**
 * Claim extractor.
 *
 * Pulls falsifiable assertions out of scientific text and scores how *specific* each
 * one is. Specificity is the plan's Tier-5 "claim cross-entropy threshold": a claim's
 * information content in nats, measured as the negative log probability of its tokens
 * under a background unigram model. A claim that only uses the field's most frequent
 * vocabulary ("we propose a novel method that improves performance") carries almost
 * no information and is not worth verifying; a claim studded with rare tokens and
 * numbers is.
 *
 * The same measure decides whether a window of generated synthesis is worth
 * speculatively drafting, because the cost of a hallucinated specific claim is far
 * higher than the cost of a vague one.
 */

export type ClaimKind =
  "quantitative" | "comparative" | "causal" | "definitional" | "methodological" | "limitation";

export interface Claim {
  readonly id: string;
  readonly kind: ClaimKind;
  /** The sentence or display equation the claim is drawn from. */
  readonly text: string;
  /** Quantities appearing in the claim, normalised. */
  readonly quantities: Quantity[];
  /** Citation markers attached to the claim. */
  readonly citations: string[];
  /** Information content in nats. */
  readonly informationContent: number;
  /** Normalised specificity in [0, 1]. */
  readonly specificity: number;
  /** Section the claim came from, when known. */
  readonly section?: string;
  /** Equation label, for claims drawn from display math. */
  readonly equationLabel?: string;
}

export interface Quantity {
  /** Numeric value, or undefined for a bare range bound. */
  readonly value?: number;
  /** Lower bound of an interval, when the claim states a range. */
  readonly lower?: number;
  /** Upper bound of an interval. */
  readonly upper?: number;
  /** Unit as written (`%`, `ms`, `BLEU`, `F1`). */
  readonly unit?: string;
  /** Direction of the claim about this quantity, when stated. */
  readonly direction?: "increase" | "decrease";
  /** Statistical significance reported alongside it. */
  readonly significance?: string;
  /** Raw matched substring. */
  readonly raw: string;
}

export interface ClaimExtractorOptions {
  /** Cross-entropy threshold in nats; claims below it are dropped as non-specific. */
  readonly informationThreshold?: number;
  /** Minimum sentence length to be a claim candidate. */
  readonly minSentenceLength?: number;
  /** Background vocabulary frequencies to build the unigram model from. */
  readonly backgroundCorpus?: string;
  /** Smoothing added to every token count (Laplace). */
  readonly smoothing?: number;
  /** Cap on extracted claims per document. */
  readonly maxClaims?: number;
}

const NUMBER_WORD =
  /(?:\d+(?:[.,]\d+)?)|(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|fifty| hundred|thousand|million|billion)/gi;

const QUANTITY_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: Quantity["direction"] }> = [
  // "improves throughput by 12.4%", "accelerates decoding by 30 ms". The measured value is
  // usually separated from the verb by a noun phrase, so a bounded non-greedy scan covers
  // the intervening words instead of requiring the number to sit directly after "by".
  {
    pattern:
      /(?:improve[sd]?|increase[sd]?|boost[s]?|gain(?:ed|s)?|raise[sd]?|accelerat(?:e[sd]?|ion)|speedup)\b[^.\n;]{0,80}?\b((?:\d+(?:[.,]\d+)?)\s*(?:%|pp|milliseconds?|ms|seconds?|s\b|x\b)?)/gi,
    kind: "increase",
  },
  {
    pattern:
      /(?:reduce[sd]?|decrease[sd]?|lower[s]?|cut|drop[s]?|shrink[s]?|fall[s]?)\b[^.\n;]{0,80}?\b((?:\d+(?:[.,]\d+)?)\s*(?:%|pp|milliseconds?|ms|seconds?|s\b)?)/gi,
    kind: "decrease",
  },
  {
    pattern:
      /(?:achiev(?:e[sd]?|ing)|reach(?:es|ed)?|attain(?:s|ed)?|report(?:s|ed)?|obtain(?:s|ed)?|yields?)\s+(?:a\s+|an\s+|the\s+)?((?:\d+(?:[.,]\d+)?)\s*(%|pp|x\b|F1|BLEU|ROUGE|accuracy|points?|ms|tokens?\s*\/\s*s)?)/gi,
    kind: undefined,
  },
  // Confidence intervals and ranges: "3.2 ± 0.4", "between 80 and 90 %"
  { pattern: /((?:\d+(?:[.,]\d+)?)\s*±\s*(?:\d+(?:[.,]\d+)?))/g, kind: undefined },
  {
    pattern:
      /between\s+((?:\d+(?:[.,]\d+)?)\s*(?:%|ms|s\b|pp)?)\s+and\s+((?:\d+(?:[.,]\d+)?)\s*(?:%|ms|s\b|pp)?)/gi,
    kind: undefined,
  },
  // Bare measurements: "latency of 12 ms", "12.3% relative"
  {
    pattern: /((?:\d+(?:[.,]\d+)?)\s*(?:%|pp|ms|F1|BLEU|tokens?\/s|Hz|MB|GB|W\b|p\s*<\s*0\.0\d))/gi,
    kind: undefined,
  },
];

const COMPARATIVE_CUES = [
  "outperforms",
  "beats",
  "surpasses",
  "better than",
  "worse than",
  "superior",
  "inferior",
  "state-of-the-art",
  "state of the art",
  "best",
  "lowest",
  "highest",
  "fastest",
  "cheapest",
  "more efficient",
  "less efficient",
  "competitive with",
];

const CAUSAL_CUES = [
  "because",
  "therefore",
  "thus",
  "hence",
  "consequently",
  "as a result",
  "leads to",
  "causes",
  "due to",
  "results in",
  "driven by",
  "attributed to",
];

const LIMITATION_CUES = [
  "however",
  "limitation",
  "fails to",
  "cannot",
  "does not",
  "struggle",
  "degrades when",
];

const METHODOLOGY_CUES = [
  "we propose",
  "we present",
  "we introduce",
  "we design",
  "we train",
  "our method",
  "our approach",
];

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"$(\\])/;

const UNIT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["ms", "ms"],
  ["milliseconds", "ms"],
  ["s", "s"],
  ["seconds", "s"],
  ["%", "%"],
  ["pp", "pp"],
  ["x", "x"],
  ["f1", "F1"],
  ["bleu", "BLEU"],
]);

/**
 * Background unigram model. Frequencies are accumulated from a corpus string; a
 * token absent from the corpus falls back to the smoothing mass, which keeps the
 * information content finite while still being much larger than a frequent token's.
 */
export class BackgroundLanguageModel {
  private readonly counts = new Map<string, number>();
  private total = 0;
  private readonly smoothing: number;

  constructor(corpus = "", smoothing = 1) {
    this.smoothing = smoothing;
    if (corpus) this.ingest(corpus);
  }

  ingest(text: string): void {
    for (const token of tokenize(text)) {
      this.counts.set(token, (this.counts.get(token) ?? 0) + 1);
      this.total += 1;
    }
  }

  probability(token: string): number {
    const vocabularySize = this.counts.size;
    const numerator = (this.counts.get(token) ?? 0) + this.smoothing;
    const denominator = this.total + this.smoothing * (vocabularySize + 1);
    return denominator > 0 ? numerator / denominator : this.smoothing;
  }

  /** Information content of a span in nats. */
  informationContent(text: string): number {
    let nats = 0;
    for (const token of tokenize(text)) nats -= Math.log(this.probability(token));
    return nats;
  }

  /** Per-token mean information content — comparable across claim lengths. */
  meanInformationContent(text: string): number {
    const tokens = tokenize(text);
    if (tokens.length === 0) return 0;
    return this.informationContent(text) / tokens.length;
  }

  get vocabularySize(): number {
    return this.counts.size;
  }
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:[.\-][a-z0-9]+)*/g) ?? []) as string[];
}

/**
 * Extracts falsifiable claims from text. Sentences carrying a quantity, a comparison
 * or a causal connective become candidates; each is scored for specificity and only
 * those above the cross-entropy threshold survive.
 */
export class ClaimExtractor {
  private readonly model: BackgroundLanguageModel;
  private readonly informationThreshold: number;
  private readonly minSentenceLength: number;
  private readonly maxClaims: number;

  constructor(options: ClaimExtractorOptions = {}) {
    this.model = new BackgroundLanguageModel(
      options.backgroundCorpus ?? DEFAULT_BACKGROUND_CORPUS,
      options.smoothing ?? 1,
    );
    this.informationThreshold = options.informationThreshold ?? 22;
    this.minSentenceLength = options.minSentenceLength ?? 24;
    this.maxClaims = options.maxClaims ?? 64;
  }

  /** Extracts claims from prose. */
  extract(text: string, section?: string): Claim[] {
    const claims: Claim[] = [];
    const sentences = splitSentences(text);
    let counter = 0;

    for (const sentence of sentences) {
      const claim = this.toClaim(sentence, counter++, section);
      if (claim && claim.informationContent >= this.informationThreshold) claims.push(claim);
      if (claims.length >= this.maxClaims) break;
    }
    return claims;
  }

  /** Extracts claims from display equations by treating the math as a definitional claim. */
  extractFromEquations(
    equations: ReadonlyArray<{ content: string; label?: string }>,
    section?: string,
  ): Claim[] {
    return equations
      .map((equation, index) => {
        const text = equation.content.replace(/\\/g, " ").replace(/[{}]/g, "").trim();
        if (text.length < this.minSentenceLength) return null;
        const claim = this.toClaim(`Equation: ${text}`, index, section);
        return claim && equation.label ? { ...claim, equationLabel: equation.label } : claim;
      })
      .filter((claim): claim is Claim => claim !== null);
  }

  private toClaim(sentence: string, index: number, section?: string): Claim | null {
    const trimmed = sentence.trim();
    if (trimmed.length < this.minSentenceLength) return null;
    if (!containsLetter(trimmed)) return null;

    const quantities = extractQuantities(trimmed);
    const citations = extractInlineCitations(trimmed);
    const kind = classifyClaim(trimmed, quantities);

    const nats = this.model.informationContent(trimmed);
    const tokens = tokenize(trimmed).length;
    // Specificity: mean information per token, mapped through a saturating function so
    // a long sentence of rare words cannot score indefinitely.
    const mean = tokens > 0 ? nats / tokens : 0;
    const specificity = 1 - Math.exp(-mean / 4);

    return {
      id: `claim_${index}`,
      kind,
      text: trimmed,
      quantities,
      citations,
      informationContent: nats,
      specificity,
      section,
    };
  }
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(new RegExp(SENTENCE_SPLIT.source, "g"))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Extracts quantities with their units and stated direction. */
export function extractQuantities(text: string): Quantity[] {
  const quantities: Quantity[] = [];
  const consumed: Array<{ start: number; end: number }> = [];

  for (const { pattern, kind } of QUANTITY_PATTERNS) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (consumed.some((span) => span.start <= end && span.end >= start)) continue;
      consumed.push({ start, end });

      const raw = match[0];
      const groupOne = match[1] ?? "";
      const groupTwo = match[2] ?? "";
      const lowerGroup = groupOne.toLowerCase();

      // A range states its two bounds in the two capture groups; every other pattern
      // keeps its whole number list in the first group.
      const numericSource = pattern.source.includes("between")
        ? `${groupOne} ${groupTwo}`
        : groupOne;
      const numbers = [...numericSource.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((value) => value[0]);

      if (pattern.source.includes("between")) {
        const lower = parseNumber(numbers[0] ?? "");
        const upper = parseNumber(numbers[1] ?? "");
        const unit = normaliseUnit(groupOne.replace(/[\d.,\s]/g, "")) ?? normaliseUnit(groupTwo);
        quantities.push({ lower, upper, unit, raw });
        continue;
      }

      const value = parseNumber(numbers[0] ?? "");
      const unit = normaliseUnit(lowerGroup.replace(/[\d.,\s]/g, "")) ?? normaliseUnit(groupTwo);
      // Significance is reported alongside a measurement, usually a little after it, so
      // look forward from the match rather than only inside its raw text.
      const significance = readSignificance(text.slice(match.index, match.index + 200));
      quantities.push({ value, unit, direction: kind, significance, raw });
    }
  }

  return quantities.slice(0, 12);
}

function parseNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  const normalized = raw.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function normaliseUnit(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return undefined;
  return UNIT_ALIASES.get(cleaned) ?? cleaned;
}

function readSignificance(raw: string): string | undefined {
  const match = /p\s*<\s*0\.\d+|p\s*=\s*0\.\d+|(?:n\s*=\s*\d+)/i.exec(raw);
  return match?.[0];
}

export function extractInlineCitations(text: string): string[] {
  const markers: string[] = [];
  for (const pattern of [
    /\\cite[a-z]*\{([^}]+)\}/g,
    /\[(\d+(?:[,\s–-]+\d+)*)\]/g,
    /\(([A-Z][A-Za-z'`-]+(?:\s+(?:et al\.|and\s+[A-Z][A-Za-z'`-]+))?),\s*(?:19|20)\d{2}[a-z]?\)/g,
  ]) {
    const global = new RegExp(pattern.source, "g");
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) markers.push(match[0]);
  }
  return markers;
}

function classifyClaim(text: string, quantities: Quantity[]): ClaimKind {
  const lower = text.toLowerCase();
  if (LIMITATION_CUES.some((cue) => lower.includes(cue))) return "limitation";
  if (quantities.length > 0 && COMPARATIVE_CUES.some((cue) => lower.includes(cue)))
    return "comparative";
  if (quantities.length > 0) return "quantitative";
  if (COMPARATIVE_CUES.some((cue) => lower.includes(cue))) return "comparative";
  if (CAUSAL_CUES.some((cue) => lower.includes(cue))) return "causal";
  if (METHODOLOGY_CUES.some((cue) => lower.includes(cue))) return "methodological";
  if (text.includes("=") || text.includes("≈") || text.includes("≤") || text.includes("≥"))
    return "definitional";
  return "quantitative";
}

function containsLetter(text: string): boolean {
  return /[a-zA-Z]/.test(text);
}

/**
 * Aggregates the specificity of a set of claims into a document-level figure. Used by
 * the research loop to decide whether a synthesis is substantive enough to emit.
 */
export function aggregateSpecificity(claims: readonly Claim[]): {
  mean: number;
  max: number;
  totalInformation: number;
  specificShare: number;
} {
  if (claims.length === 0) return { mean: 0, max: 0, totalInformation: 0, specificShare: 0 };
  const specificities = claims.map((claim) => claim.specificity);
  const totalInformation = claims.reduce((sum, claim) => sum + claim.informationContent, 0);
  return {
    mean: specificities.reduce((a, b) => a + b, 0) / specificities.length,
    max: Math.max(...specificities),
    totalInformation,
    specificShare: specificities.filter((value) => value > 0.5).length / specificities.length,
  };
}

/** A general-purpose scientific corpus so a fresh extractor has a usable background model. */
export const DEFAULT_BACKGROUND_CORPUS = [
  "We propose a novel method for language model inference that improves throughput.",
  "Our approach achieves state of the art performance on standard benchmarks.",
  "The model is trained on a large corpus of text and evaluated on downstream tasks.",
  "Experimental results show that the proposed method reduces latency significantly.",
  "We analyze the theoretical properties of the algorithm and its complexity.",
  "The attention mechanism computes a weighted sum of value vectors for each query.",
  "Training stability depends on the learning rate schedule and initialization.",
  "We compare against strong baselines including transformer and recurrent models.",
  "The dataset contains millions of documents across several domains and languages.",
  "In this paper we present a comprehensive study of speculative decoding.",
  "The proposed architecture consists of an encoder and a decoder network.",
  "We report the average accuracy over five random seeds with standard deviation.",
  "Ablation studies confirm that each component contributes to the final result.",
  "The method generalizes to unseen distributions and larger input lengths.",
  "Future work includes scaling the model and improving the sampling efficiency.",
  "Theoretical analysis provides an upper bound on the approximation error.",
  "We release our code and pretrained weights to support reproducible research.",
  "The inference engine batches requests to maximize hardware utilization.",
  "Memory bandwidth is the primary bottleneck for autoregressive generation.",
  "The verification step compares draft probabilities against target probabilities.",
].join("\n");
