import { describe, it, expect } from "vitest";
import {
  EvidenceVerifier,
  findNumeric,
  contentCoverage,
  detectPolarityConflict,
} from "../../../src/agent/research/evidence-verifier.js";
import type { Claim } from "../../../src/agent/research/claim-extractor.js";
import { CitationNetwork } from "../../../src/agent/research/citation-network.js";

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "claim_0",
    kind: "quantitative",
    text: "The method improves throughput by 31.4%.",
    quantities: [],
    citations: [],
    informationContent: 40,
    specificity: 0.7,
    ...overrides,
  };
}

const SOURCE = [
  "Our photonic tensor core improves throughput by 31.4% on the standard benchmark suite.",
  "Latency drops to 29 ms per token under full load.",
  "The output distribution matches the target within a total variation of 0.003.",
].join("\n");

describe("findNumeric", () => {
  it("locates a value and its unit in the source", () => {
    const found = findNumeric("latency of 31.4 ms was measured", {
      value: 31.4,
      unit: "ms",
      raw: "31.4 ms",
    });
    expect(found?.value).toBe(31.4);
    expect(found?.unit).toBe("ms");
  });

  it("returns undefined when the value is absent", () => {
    expect(
      findNumeric("nothing here", { value: 31.4, unit: "ms", raw: "31.4 ms" }),
    ).toBeUndefined();
  });

  it("returns undefined for a quantity with neither value nor bounds", () => {
    expect(findNumeric(SOURCE, { raw: "unbounded" })).toBeUndefined();
  });

  it("locates the nearest source number for a range using its midpoint", () => {
    // A range has no single value to search for, so the midpoint is the search target and
    // the interval test itself happens later, in `numericDistance`.
    const found = findNumeric(SOURCE, {
      lower: 1,
      upper: 5,
      unit: "ms",
      raw: "between 1 and 5 ms",
    });
    expect(found?.value).toBe(0.003);
  });
});

describe("contentCoverage", () => {
  it("weights claim terms by inverse document frequency", () => {
    const idf = new Map([
      ["photonic", 4],
      ["tensor", 4],
      ["core", 4],
      ["throughput", 1],
      ["method", 0.5],
    ]);
    const source = "photonic tensor core throughput";
    // The rare terms dominate: covering photonic/tensor/core/throughput but missing
    // nothing weights far above a source that only supplies the common term.
    expect(contentCoverage("photonic tensor core throughput method", source, idf)).toBeGreaterThan(
      contentCoverage("photonic tensor core throughput method", "method", idf),
    );
  });

  it("is zero when either side has no tokens", () => {
    expect(contentCoverage("", SOURCE, new Map())).toBe(0);
    expect(contentCoverage("some claim", "", new Map())).toBe(0);
  });
});

describe("detectPolarityConflict", () => {
  it("reports no conflict for a supporting source", () => {
    expect(detectPolarityConflict("photonic throughput improves", SOURCE)).toBe(false);
  });

  it("detects a negated contradiction around the claim's key terms", () => {
    const source = "Contrary to the claim, the photonic throughput does not improve; it degrades.";
    expect(detectPolarityConflict("photonic throughput improves measurably", source)).toBe(true);
  });

  it("is false for empty input", () => {
    expect(detectPolarityConflict("", SOURCE)).toBe(false);
    expect(detectPolarityConflict("photonic", "")).toBe(false);
  });
});

describe("EvidenceVerifier", () => {
  it("supports a claim whose numbers the source states", () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify(
      claim({
        text: "The photonic tensor core improves throughput by 31.4% on the benchmark suite.",
        quantities: [{ value: 31.4, unit: "%", direction: "increase", raw: "31.4%" }],
      }),
      SOURCE,
    );
    expect(result.verdict).toBe("supported");
    expect(result.numericMatches).toHaveLength(1);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("contradicts a claim whose value is out of tolerance", () => {
    const verifier = new EvidenceVerifier({ numericTolerance: 0.02 });
    const result = verifier.verify(
      claim({
        text: "The method improves throughput by 99.9%.",
        quantities: [{ value: 99.9, unit: "%", direction: "increase", raw: "99.9%" }],
      }),
      SOURCE,
    );
    expect(result.verdict).toBe("contradicted");
    expect(result.numericMismatches[0]!.reason).toBe("value-out-of-tolerance");
  });

  it("contradicts a claim whose direction is flipped", () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify(
      claim({
        text: "The method reduces throughput by 31.4%.",
        quantities: [{ value: 31.4, unit: "%", direction: "decrease", raw: "31.4%" }],
      }),
      SOURCE,
    );
    expect(result.verdict).toBe("contradicted");
    expect(result.numericMismatches[0]!.reason).toBe("direction-flipped");
  });

  it("marks a quantitative claim unsupported when the source states no number at all", () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify(
      claim({
        text: "The method improves throughput by 77.7%.",
        quantities: [{ value: 77.7, unit: "%", direction: "increase", raw: "77.7%" }],
      }),
      "The output distribution matches the target within a total variation.",
    );
    expect(result.verdict).toBe("unsupported");
    expect(result.numericMismatches[0]!.reason).toBe("not-found");
  });

  it("contradicts a claim whose stated value differs from the source's measurement", () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify(
      claim({
        text: "The method improves throughput by 77.7%.",
        quantities: [{ value: 77.7, unit: "%", direction: "increase", raw: "77.7%" }],
      }),
      SOURCE,
    );
    expect(result.verdict).toBe("contradicted");
  });

  it("supports a claim inside a range", () => {
    const verifier = new EvidenceVerifier({ coverageThreshold: 0.3 });
    const result = verifier.verify(
      claim({
        text: "Latency sits between 20 and 40 ms per token.",
        quantities: [{ lower: 20, upper: 40, unit: "ms", raw: "between 20 and 40 ms" }],
      }),
      SOURCE,
    );
    expect(result.verdict).toBe("supported");
  });

  it("contradicts a range claim whose source value lies outside it", () => {
    const verifier = new EvidenceVerifier({ coverageThreshold: 0.3 });
    const result = verifier.verify(
      claim({
        text: "Latency sits between 1 and 5 ms per token.",
        quantities: [{ lower: 1, upper: 5, unit: "ms", raw: "between 1 and 5 ms" }],
      }),
      SOURCE,
    );
    expect(result.verdict).toBe("contradicted");
  });

  it("supports a non-quantitative claim when its terms are covered", () => {
    const verifier = new EvidenceVerifier({ coverageThreshold: 0.6 });
    const result = verifier.verify(
      claim({ text: "photonic tensor core throughput", quantities: [] }),
      SOURCE,
    );
    expect(result.verdict).toBe("supported");
  });

  it("downgrades to unverifiable when a citation marker does not resolve", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "src1", title: "Source One", marker: "[1]", text: SOURCE });
    const verifier = new EvidenceVerifier();
    const result = verifier.verify(claim({ citations: ["[42]"] }), SOURCE, network, "src1");
    expect(result.verdict).toBe("unverifiable");
  });

  it("honours a wider numeric tolerance", () => {
    const verifier = new EvidenceVerifier({ numericTolerance: 2.0 });
    const result = verifier.verify(
      claim({
        text: "The method improves throughput by 32%.",
        quantities: [{ value: 32, unit: "%", direction: "increase", raw: "32%" }],
      }),
      SOURCE,
    );
    expect(result.verdict).toBe("supported");
  });

  it("extracts a source excerpt around the claim's terms", () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify(claim({ text: "photonic tensor core throughput" }), SOURCE);
    expect(result.sourceExcerpt).toContain("photonic");
  });

  it("verifies a batch and summarises the verdicts", () => {
    const verifier = new EvidenceVerifier();
    const { results, summary } = verifier.verifyBatch(
      [
        claim({
          id: "c1",
          text: "The photonic tensor core improves throughput by 31.4%.",
          quantities: [{ value: 31.4, unit: "%", direction: "increase", raw: "31.4%" }],
        }),
        claim({ id: "c2", text: "quark confinement holds in the plasma chamber", quantities: [] }),
        claim({
          id: "c3",
          text: "The method improves throughput by 99.9%.",
          quantities: [{ value: 99.9, unit: "%", direction: "increase", raw: "99.9%" }],
        }),
      ],
      () => ({ sourceId: "src1", text: SOURCE }),
    );
    expect(results).toHaveLength(3);
    expect(summary.supported).toBe(1);
    expect(summary.contradicted).toBe(1);
    expect(summary.unsupported).toBe(1);
    expect(summary.agreementRate).toBeCloseTo(2 / 3);
    expect(summary.meanCoverage).toBeGreaterThan(0);
    expect(summary.meanLatencyNs).toBeGreaterThanOrEqual(0);
  });

  it("reports a claim as unverifiable when no source resolves it", () => {
    const verifier = new EvidenceVerifier();
    const { results } = verifier.verifyBatch([claim()], () => undefined);
    expect(results[0]!.verdict).toBe("unverifiable");
    expect(results[0]!.elapsedNs).toBe(0);
  });

  it("downgrades a whole batch to unverifiable when markers are unresolved", () => {
    const network = new CitationNetwork();
    const verifier = new EvidenceVerifier();
    const { results, summary } = verifier.verifyBatch(
      [claim({ citations: ["[42]"], id: "c1" }), claim({ citations: ["[43]"], id: "c2" })],
      () => ({ sourceId: "src1", text: SOURCE }),
      network,
    );
    expect(results.every((result) => result.verdict === "unverifiable")).toBe(true);
    expect(summary.unresolvedCitations).toBe(2);
  });
});
