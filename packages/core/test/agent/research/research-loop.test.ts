import { describe, it, expect } from "vitest";
import { ResearchLoop } from "../../../src/agent/research/research-loop.js";
import type { ResearchEvent, SearchHit } from "../../../src/agent/research/research-loop.js";

/**
 * Fixture corpus: three short papers that cite one another by numbered marker, plus one
 * reference that none of them fetched. The corpus is deliberately small but structurally
 * complete — title, abstract, methods, results, references, and a display equation — so
 * every phase of the loop has real work to do.
 */
const PAPERS: ReadonlyArray<{
  id: string;
  title: string;
  year: number;
  doi: string;
  text: string;
}> = [
  {
    id: "p1",
    title: "Photonic Tensor Cores for Autoregressive Inference",
    year: 2024,
    doi: "10.1000/photonic-tensor",
    text: [
      "# Photonic Tensor Cores for Autoregressive Inference",
      "",
      "## Abstract",
      "We present a photonic tensor core that accelerates autoregressive inference by coherently interleaving matrix multiplications on a nanophotonic mesh. The prototype improves throughput by 31.4% relative to an electronic baseline on the standard benchmark suite.",
      "",
      "## Methods",
      "The nanophotonic mesh performs interference computation in the optical domain without digital quantisation. We calibrate the phase shifters with a stochastic gradient procedure on a held-out photonic wafer:",
      "",
      "$$\\mathcal{L}(\\theta) = -\\frac{1}{N}\\sum_{i=1}^{N} \\log p_\\theta(x_i) \\label{eq:photonic_loss}$$",
      "",
      "## Results",
      "Under full load the measured latency drops to 29 ms per generated token. The output distribution matches the target transformer within a total variation of 0.003 across eleven language pairs.",
      "",
      "## References",
      "[2] Nanophotonic interferometric computing for deep neural networks.",
      "[3] Wafer-scale calibration of optical phase shifters in photonic accelerators.",
    ].join("\n"),
  },
  {
    id: "p2",
    title: "Nanophotonic Interferometric Computing for Deep Neural Networks",
    year: 2023,
    doi: "10.1000/nanophotonic-mesh",
    text: [
      "# Nanophotonic Interferometric Computing for Deep Neural Networks",
      "",
      "## Abstract",
      "Nanophotonic interferometric computing arranges meshes of Mach-Zehnder interferometers to evaluate matrix products at the speed of light. Our 64-by-64 mesh achieves a matrix multiplication fidelity of 98.2% against a digital reference.",
      "",
      "## Methods",
      "Light propagates through a programmable interferometer ladder whose phase shifts encode the weight matrix. We train the mesh in situ with a gradient-based photonic backpropagation rule.",
      "",
      "## Results",
      "The evaluated network reaches an accuracy of 96.7% on a handwritten digit classification task. Inference consumes 0.41 nanojoules per multiply-accumulate operation.",
      "",
      "## References",
      "[3] Wafer-scale calibration of optical phase shifters in photonic accelerators.",
    ].join("\n"),
  },
  {
    id: "p3",
    title: "Wafer-Scale Calibration of Optical Phase Shifters in Photonic Accelerators",
    year: 2025,
    doi: "10.1000/wafer-calibration",
    text: [
      "# Wafer-Scale Calibration of Optical Phase Shifters in Photonic Accelerators",
      "",
      "## Abstract",
      "Photonic accelerators require thousands of optical phase shifters to be calibrated simultaneously. We introduce a wafer-scale calibration procedure that converges in 420 gradient steps.",
      "",
      "## Methods",
      "A scanning laser measures the transfer matrix of every interferometer column in parallel. The procedure compensates thermal drift using an on-chip reference arm.",
      "",
      "## Results",
      "Calibration error falls to 0.008 radians per phase shifter across the full wafer. The procedure recovers 99.5% of the designed transfer functions after a thermal transient.",
      "",
      "## References",
      "[7] Nonlinear optical phase change materials for reconfigurable photonics.",
    ].join("\n"),
  },
];

const QUESTION =
  "Do photonic tensor cores outperform electronic baselines for autoregressive inference?";

function fixtureSearch(query: string, maxResults: number): SearchHit[] {
  return PAPERS.slice(0, Math.max(1, maxResults)).map((paper) => ({
    id: paper.id,
    title: paper.title,
    year: paper.year,
    doi: paper.doi,
    url: `https://example.org/${paper.id}`,
  }));
}

function fixtureFetch(hit: SearchHit): string {
  const paper = PAPERS.find((entry) => entry.id === hit.id);
  if (!paper) throw new Error(`unknown source: ${hit.id}`);
  return paper.text;
}

describe("ResearchLoop", () => {
  it("runs the full pipeline over a fixture corpus", async () => {
    const events: ResearchEvent[] = [];
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: { fetch: fixtureFetch },
      onEvent: (event) => events.push(event),
    });

    const result = await loop.run(QUESTION);

    expect(result.state).toBe("completed");
    expect(result.question).toBe(QUESTION);
    expect(result.sources).toHaveLength(3);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.startedAtNs).toBeGreaterThan(0);
    expect(result.finishedAtNs).toBeGreaterThanOrEqual(result.startedAtNs);

    // Every claim carries at least one citation marker, inherited from its source when it
    // had none of its own.
    for (const claim of result.claims) {
      expect(claim.citations.length).toBeGreaterThan(0);
      expect(claim.section).toBeDefined();
    }
  });

  it("assigns globally unique claim ids across sections and sources", () => {
    // The extractor's ids are only unique within one section; the loop must re-stamp them
    // or verification would look claims up against the wrong paper.
    return Promise.resolve(
      new ResearchLoop({ search: { search: fixtureSearch }, fetch: { fetch: fixtureFetch } })
        .run(QUESTION)
        .then((result) => {
          const ids = result.claims.map((claim) => claim.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const claim of result.claims) {
            expect(claim.id).toContain("#");
          }
        }),
    );
  });

  it("resolves every citation marker so the synthesis carries zero hallucinations", async () => {
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: { fetch: fixtureFetch },
    });
    const result = await loop.run(QUESTION);

    expect(result.citationHallucinations).toBe(0);
    expect(result.citationReport.hallucinationRate).toBe(0);
    // Three fetched papers plus the one unfetched reference ([7]) as a placeholder.
    expect(result.citationReport.nodeCount).toBe(4);
    expect(result.network.size).toBe(4);
    // p1 cites [2] and [3]; p2 cites [3]; p3's [7] becomes a placeholder edge.
    expect(result.citationReport.edgeCount).toBe(4);
    expect(result.citationReport.coverage).toBeCloseTo(0.75);
  });

  it("verifies claims against the source they were extracted from", async () => {
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: { fetch: fixtureFetch },
    });
    const result = await loop.run(QUESTION);

    const sourceIds = new Set(result.sources.map((source) => source.hit.id));
    expect(result.verificationSummary.total).toBe(result.claims.length);
    expect(result.verification).toHaveLength(result.claims.length);

    for (const evidence of result.verification) {
      // A settled claim must be attributed to a source that actually exists — never to a
      // paper it was never extracted from.
      expect(result.claims.some((claim) => claim.id === evidence.claimId)).toBe(true);
      if (evidence.sourceId !== undefined) expect(sourceIds.has(evidence.sourceId)).toBe(true);
    }
    // The corpus states its own numbers, so the loop should settle a healthy share of them.
    expect(result.verificationSummary.supported).toBeGreaterThan(0);
    expect(result.verificationSummary.meanCoverage).toBeGreaterThan(0);
  });

  it("emits a deterministic synthesis and a BibTeX bibliography", async () => {
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: { fetch: fixtureFetch },
    });
    const result = await loop.run(QUESTION);

    expect(result.synthesis).toContain(QUESTION);
    expect(result.synthesis).toContain("## Findings");
    expect(result.synthesis).toContain("[1]");
    for (const paper of PAPERS) {
      expect(result.bibliography).toContain(`@article{${paper.id},`);
      expect(result.bibliography).toContain(paper.title);
    }
    expect(result.bibliography).toContain("doi = {10.1000/photonic-tensor}");
  });

  it("records per-phase budget spend and structured trace events", async () => {
    const events: ResearchEvent[] = [];
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: { fetch: fixtureFetch },
      onEvent: (event) => events.push(event),
    });
    const result = await loop.run(QUESTION);

    const phases = [...result.budget.phases.keys()];
    expect(phases).toEqual(
      expect.arrayContaining([
        "planning",
        "searching",
        "fetching",
        "parsing",
        "extracting",
        "verifying",
        "synthesizing",
      ]),
    );
    expect(result.budget.exhausted).toHaveLength(0);
    expect(result.budget.paperBudgetUsed).toBeLessThanOrEqual(1);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.state).toBe("planning");
    // `completed` is a state transition, not an emitted event, so the trace closes on the
    // reporting event that immediately precedes it.
    expect(events[events.length - 1]!.state).toBe("reporting");
    for (const event of events) {
      expect(event.timestampNs).toBeGreaterThan(0);
      expect(event.message.length).toBeGreaterThan(0);
    }
  });

  it("produces a plan with a root question, sub-questions and hypotheses", async () => {
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: { fetch: fixtureFetch },
    });
    const result = await loop.run(QUESTION);

    expect(result.plan.root.text).toBe(QUESTION);
    expect(result.plan.questions.size).toBeGreaterThanOrEqual(1);
    expect(result.plan.root.searchTerms.length).toBeGreaterThan(0);
    expect(result.specificity.totalInformation).toBeGreaterThan(0);
  });

  it("uses the model seam for synthesis when one is provided", async () => {
    const prompts: string[] = [];
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: { fetch: fixtureFetch },
      model: {
        generate: (prompt: string) => {
          prompts.push(prompt);
          return "## Model synthesis\nThe photonic core improves throughput [1].";
        },
      },
    });
    const result = await loop.run(QUESTION);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(QUESTION);
    expect(prompts[0]).toContain("## Sources (3)");
    expect(result.synthesis).toBe("## Model synthesis\nThe photonic core improves throughput [1].");
  });

  it("de-duplicates sources across repeated search queries", async () => {
    let queries = 0;
    const loop = new ResearchLoop({
      search: {
        search: (query: string, maxResults: number) => {
          queries += 1;
          return fixtureSearch(query, maxResults);
        },
      },
      fetch: { fetch: fixtureFetch },
    });
    const result = await loop.run(QUESTION);

    expect(queries).toBeGreaterThan(1);
    expect(result.sources).toHaveLength(3);
    const ids = result.sources.map((source) => source.hit.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("reports a failed run without retryable errors as failed", async () => {
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: {
        fetch: () => {
          throw new Error("malformed request: unsupported media type");
        },
      },
    });
    const result = await loop.run(QUESTION);

    expect(result.state).toBe("failed");
    expect(result.sources).toHaveLength(0);
    expect(result.claims).toHaveLength(0);
    expect(result.synthesis).toBe("");
  });

  it("reports a run that dies after the budget is exhausted as budget-exhausted", async () => {
    const loop = new ResearchLoop({
      search: { search: fixtureSearch },
      fetch: {
        fetch: () => {
          throw new Error("connection error: server disconnected");
        },
      },
      // A one-token budget is exhausted by the planning phase alone; the fetch failure then
      // propagates and the loop records the exhaustion rather than a bare failure.
      budget: { maxTokens: 1, maxRetries: 2, backoffBaseNs: 0, jitter: 0 },
    });
    const result = await loop.run(QUESTION);

    expect(result.state).toBe("budget-exhausted");
    expect(result.budget.exhausted).toContain("maxTokens");
  });
});
