import { describe, it, expect } from "vitest";
import {
  ClaimExtractor,
  BackgroundLanguageModel,
  splitSentences,
  extractQuantities,
  extractInlineCitations,
  aggregateSpecificity,
  tokenize,
  DEFAULT_BACKGROUND_CORPUS,
} from "../../../src/agent/research/claim-extractor.js";

describe("tokenize and splitSentences", () => {
  it("lowercases and splits on non-alphanumeric runs, keeping dotted compounds", () => {
    expect(tokenize("Speculative-decoding, 31.4%!")).toEqual(["speculative-decoding", "31.4"]);
  });

  it("splits on sentence boundaries without losing the following capital", () => {
    expect(splitSentences("First one. Second two! Third?")).toEqual([
      "First one.",
      "Second two!",
      "Third?",
    ]);
  });
});

describe("BackgroundLanguageModel", () => {
  it("assigns a seen token a higher probability than an unseen one", () => {
    const model = new BackgroundLanguageModel("throughput latency throughput tokens");
    expect(model.probability("throughput")).toBeGreaterThan(model.probability("quark"));
  });

  it("measures information content so rare text scores higher than common text", () => {
    const model = new BackgroundLanguageModel("the model the method the result the evaluation");
    const common = model.informationContent("the model the method");
    const rare = model.informationContent("quark gluon plasma confinement");
    expect(rare).toBeGreaterThan(common);
  });

  it("reports zero mean information for an empty span", () => {
    expect(new BackgroundLanguageModel().meanInformationContent("")).toBe(0);
  });

  it("grows its vocabulary as it ingests", () => {
    const model = new BackgroundLanguageModel();
    expect(model.vocabularySize).toBe(0);
    model.ingest("alpha beta");
    expect(model.vocabularySize).toBe(2);
  });
});

describe("extractQuantities", () => {
  it("reads a value, unit and direction from an improvement claim", () => {
    const quantities = extractQuantities(
      "The method improves throughput by 31.4% on the benchmark.",
    );
    expect(quantities).toHaveLength(1);
    expect(quantities[0]!.value).toBe(31.4);
    expect(quantities[0]!.unit).toBe("%");
    expect(quantities[0]!.direction).toBe("increase");
  });

  it("reads a decrease direction", () => {
    const quantities = extractQuantities("The change reduces latency by 30 ms per request.");
    expect(quantities[0]!.value).toBe(30);
    expect(quantities[0]!.unit).toBe("ms");
    expect(quantities[0]!.direction).toBe("decrease");
  });

  it("reads an achievement without a direction", () => {
    const quantities = extractQuantities("Our system achieves 98.2% accuracy on the suite.");
    expect(quantities[0]!.value).toBe(98.2);
    expect(quantities[0]!.unit).toBe("%");
    expect(quantities[0]!.direction).toBeUndefined();
  });

  it("reads an interval from a between-range", () => {
    const quantities = extractQuantities("Latency sits between 80 and 90 ms under load.");
    expect(quantities[0]!.lower).toBe(80);
    expect(quantities[0]!.upper).toBe(90);
  });

  it("records a confidence interval with the ± form", () => {
    const quantities = extractQuantities("The effect size is 3.2 ± 0.4 across seeds.");
    expect(quantities[0]!.value).toBe(3.2);
  });

  it("picks up a reported significance value", () => {
    const quantities = extractQuantities("The gap is 4.1% at p < 0.01 with n = 512.");
    expect(quantities[0]!.significance).toMatch(/p\s*<\s*0\.01/);
  });

  it("returns nothing for prose without measurements", () => {
    expect(extractQuantities("The method is broadly applicable to many tasks.")).toHaveLength(0);
  });
});

describe("extractInlineCitations", () => {
  it("collects latex, bracket and author-year markers", () => {
    expect(extractInlineCitations("A \\cite{a2020} and [3] and (Smith et al., 2021) too.")).toEqual(
      ["\\cite{a2020}", "[3]", "(Smith et al., 2021)"],
    );
  });
});

describe("ClaimExtractor", () => {
  const CORPUS = [
    "the method improves performance on the standard benchmarks",
    "our approach achieves strong results on the benchmark suite",
    "evaluation of the method shows consistent improvements across tasks",
  ].join("\n");

  it("classifies claims by kind", () => {
    const extractor = new ClaimExtractor({ backgroundCorpus: CORPUS, informationThreshold: 0 });
    const claims = extractor.extract(
      [
        "Our photonic tensor core sustains 4.2 petaflops at 99.1% peak utilisation.",
        "The approach outperforms the baseline by 12 points.",
        "Latency increases because the cache is cold at startup.",
        "We propose a two-stage verifier for draft acceptance.",
      ].join(" "),
    );
    const kinds = claims.map((claim) => claim.kind);
    expect(kinds).toContain("quantitative");
    expect(kinds).toContain("comparative");
    expect(kinds).toContain("causal");
    expect(kinds).toContain("methodological");
  });

  it("drops claims below the information threshold and keeps specific ones", () => {
    const model = new BackgroundLanguageModel(CORPUS);
    const vague = "The method improves performance on the standard benchmarks.";
    const specific = "Our photonic tensor core sustains 4.2 petaflops at 99.1% peak utilisation.";
    expect(model.informationContent(specific)).toBeGreaterThan(model.informationContent(vague));

    const extractor = new ClaimExtractor({ backgroundCorpus: CORPUS, informationThreshold: 30 });
    const texts = extractor.extract(`${vague} ${specific}`).map((claim) => claim.text);
    expect(texts).not.toContain(vague);
    expect(texts).toContain(specific);
  });

  it("skips fragments shorter than the minimum sentence length", () => {
    const extractor = new ClaimExtractor({
      backgroundCorpus: CORPUS,
      informationThreshold: 0,
      minSentenceLength: 40,
    });
    const claims = extractor.extract(
      "Short bit. This is a much longer sentence about quark confinement in plasma.",
    );
    expect(claims.every((claim) => claim.text.length >= 40)).toBe(true);
  });

  it("caps the number of claims extracted", () => {
    const extractor = new ClaimExtractor({
      backgroundCorpus: CORPUS,
      informationThreshold: 0,
      maxClaims: 2,
    });
    expect(
      extractor.extract(
        "Quark plasma confinement holds at 4.2 kelvin. " +
          "Gluon density rises by 11% per degree. " +
          "Hadron formation drops by 9% in the same range.",
      ),
    ).toHaveLength(2);
  });

  it("attaches the section and inline citations to each claim", () => {
    const extractor = new ClaimExtractor({ backgroundCorpus: CORPUS, informationThreshold: 0 });
    const claims = extractor.extract("Photonic throughput reaches 4.2 petaflops [7].", "Results");
    expect(claims[0]!.section).toBe("Results");
    expect(claims[0]!.citations).toEqual(["[7]"]);
  });

  it("scores specificity in [0, 1] and ranks specific claims higher", () => {
    const extractor = new ClaimExtractor({ backgroundCorpus: CORPUS, informationThreshold: 0 });
    const claims = extractor.extract(
      "The method improves performance on the standard benchmarks. " +
        "Photonic tensor cores sustain 4.2 petaflops at 99.1% utilisation.",
    );
    for (const claim of claims) expect(claim.specificity).toBeGreaterThanOrEqual(0);
    const byText = new Map(claims.map((claim) => [claim.text, claim.specificity]));
    expect(
      byText.get("Photonic tensor cores sustain 4.2 petaflops at 99.1% utilisation."),
    ).toBeGreaterThan(byText.get("The method improves performance on the standard benchmarks.")!);
  });

  it("extracts definitional claims from display equations and keeps their label", () => {
    const extractor = new ClaimExtractor({ backgroundCorpus: CORPUS, informationThreshold: 0 });
    const claims = extractor.extractFromEquations([
      { content: "y = \\alpha x^{2} + \\beta x + \\gamma", label: "eq:quad" },
      { content: "z = w \\cdot \\sum_{i} v_{i} q_{i} + b", label: undefined },
    ]);
    expect(claims).toHaveLength(2);
    expect(claims[0]!.equationLabel).toBe("eq:quad");
    expect(claims[0]!.text).toContain("alpha");
    expect(claims[1]!.equationLabel).toBeUndefined();
  });

  it("skips equations too short to carry a claim", () => {
    const extractor = new ClaimExtractor({ backgroundCorpus: CORPUS });
    expect(extractor.extractFromEquations([{ content: "z = w", label: "eq:tiny" }])).toHaveLength(
      0,
    );
  });
});

describe("aggregateSpecificity", () => {
  it("reports zeros for an empty claim set", () => {
    const aggregate = aggregateSpecificity([]);
    expect(aggregate).toEqual({ mean: 0, max: 0, totalInformation: 0, specificShare: 0 });
  });

  it("aggregates mean, max, total information and the specific share", () => {
    const extractor = new ClaimExtractor({ backgroundCorpus: DEFAULT_BACKGROUND_CORPUS });
    const claims = extractor.extract(
      "Photonic tensor cores sustain 4.2 petaflops at 99.1% utilisation. " +
        "The pipeline reduces wall-clock latency by 18 ms per request.",
    );
    expect(claims.length).toBeGreaterThan(0);
    const aggregate = aggregateSpecificity(claims);
    expect(aggregate.max).toBeGreaterThanOrEqual(aggregate.mean);
    expect(aggregate.totalInformation).toBeGreaterThan(0);
    expect(aggregate.specificShare).toBeGreaterThan(0);
    expect(aggregate.specificShare).toBeLessThanOrEqual(1);
  });
});
