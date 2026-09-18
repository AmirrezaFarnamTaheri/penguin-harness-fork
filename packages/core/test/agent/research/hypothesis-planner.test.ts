import { describe, it, expect } from "vitest";
import {
  HypothesisPlanner,
  decomposeQuestion,
  draftHypotheses,
  evidenceFor,
  generateSearchTerms,
  type EvidenceAssessment,
} from "../../../src/agent/research/hypothesis-planner.js";

describe("decomposeQuestion", () => {
  it("splits a compound question on its conjunctions", () => {
    const subs = decomposeQuestion("How does speculative decoding affect latency versus quality?");
    expect(subs.some((sub) => sub.includes("latency?"))).toBe(true);
    expect(subs.some((sub) => sub.includes("quality?"))).toBe(true);
  });

  it("always asks the established / unknown / contested triple", () => {
    const subs = decomposeQuestion("How does speculative decoding affect latency?");
    expect(subs.some((sub) => /established about/.test(sub))).toBe(true);
    expect(subs.some((sub) => /unknown or unmeasured/.test(sub))).toBe(true);
    expect(subs.some((sub) => /contested or contradictory/.test(sub))).toBe(true);
  });

  it("returns nothing for an empty question", () => {
    expect(decomposeQuestion("")).toEqual([]);
  });
});

describe("draftHypotheses and evidenceFor", () => {
  it("drafts an existence and an improvement hypothesis for any question", () => {
    const hypotheses = draftHypotheses("How does speculative decoding affect latency?");
    expect(hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(hypotheses.every((hypothesis) => hypothesis.prediction.length > 0)).toBe(true);
    expect(hypotheses.every((hypothesis) => hypothesis.falsifier.length > 0)).toBe(true);
  });

  it("adds a trade-off hypothesis when the question names a trade-off", () => {
    expect(draftHypotheses("What is the latency quality trade-off?")).toHaveLength(3);
    expect(draftHypotheses("How does it work?")).toHaveLength(2);
  });

  it("adds a scaling hypothesis when the question names scale", () => {
    expect(draftHypotheses("How does performance scale with model size?")).toHaveLength(3);
  });

  it("proposes evidence, counter-evidence and a measured outcome for a hypothesis", () => {
    const evidence = evidenceFor({
      id: "h1",
      questionId: "q1",
      statement: "A method addressing speculative decoding exists.",
      prediction: "p",
      falsifier: "f",
      evidenceIds: [],
      status: "untested",
      confidence: 0,
      priority: 1,
    });
    expect(evidence).toHaveLength(3);
    expect(everyCandidateSourceNonEmpty(evidence)).toBe(true);
  });
});

describe("generateSearchTerms", () => {
  it("is deterministic and honours the requested count", () => {
    const terms = generateSearchTerms("How does speculative decoding affect latency?", 3);
    expect(terms).toEqual(generateSearchTerms("How does speculative decoding affect latency?", 3));
    expect(terms.length).toBeLessThanOrEqual(3);
    expect(terms.length).toBeGreaterThan(0);
  });
});

describe("HypothesisPlanner", () => {
  it("plants a root question with search terms", () => {
    const planner = new HypothesisPlanner();
    const id = planner.plant("How does speculative decoding affect latency?");
    const plan = planner.plan();
    expect(plan.root.id).toBe(id);
    expect(plan.root.depth).toBe(0);
    expect(plan.root.origin).toBe("root");
    expect(plan.root.searchTerms.length).toBeGreaterThan(0);
  });

  it("attaches hypotheses and evidence requirements on expansion", () => {
    const planner = new HypothesisPlanner();
    const id = planner.plant("How does speculative decoding affect latency?");
    const plan = planner.expand(id);
    const root = plan.questions.get(id)!;
    expect(root.hypotheses.length).toBeGreaterThan(0);
    for (const hypothesisId of root.hypotheses) {
      const hypothesis = plan.hypotheses.get(hypothesisId)!;
      expect(hypothesis.status).toBe("untested");
      expect(hypothesis.evidenceIds.length).toBeGreaterThan(0);
    }
    expect(plan.evidence.size).toBeGreaterThan(0);
    expect(plan.open).toContain(id);
  });

  it("is deterministic: the same question yields the same plan", () => {
    const build = () => {
      const planner = new HypothesisPlanner({ maxDepth: 1 });
      planner.plant("How does speculative decoding affect latency?");
      return planner.expandAll("How does speculative decoding affect latency?").questions.size;
    };
    expect(build()).toBe(build());
  });

  it("does not duplicate an equivalent sub-question", () => {
    const planner = new HypothesisPlanner({ maxDepth: 2 });
    const id = planner.plant("How does speculative decoding affect latency?");
    planner.expand(id, [
      "How does speculative decoding affect latency?",
      "What is the throughput cost?",
    ]);
    const plan = planner.plan();
    expect(plan.questions.size).toBe(2);
  });

  it("respects the branching and hypothesis limits", () => {
    const planner = new HypothesisPlanner({
      maxDepth: 1,
      maxBranching: 2,
      maxHypothesesPerQuestion: 1,
    });
    const id = planner.plant("How does speculative decoding affect latency versus quality?");
    const plan = planner.expand(id, ["Sub one?", "Sub two?", "Sub three?"]);
    const root = plan.questions.get(id)!;
    expect(root.hypotheses).toHaveLength(1);
    expect(root.children).toHaveLength(2);
  });

  it("shares an evidence requirement between the hypotheses that need it", () => {
    const planner = new HypothesisPlanner({ maxDepth: 0 });
    const id = planner.plant("How does speculative decoding affect latency?");
    const plan = planner.expand(id);
    expect(plan.sharedEvidence.length).toBeGreaterThan(0);
    for (const sharedId of plan.sharedEvidence) {
      const requirement = plan.evidence.get(sharedId)!;
      expect(requirement.dependantHypotheses.length).toBeGreaterThan(1);
    }
  });

  it("records an evidence assessment and updates hypothesis status", () => {
    const planner = new HypothesisPlanner();
    const id = planner.plant("How does speculative decoding affect latency?");
    const plan = planner.expand(id);
    const hypothesisId = plan.questions.get(id)!.hypotheses[0]!;
    const evidenceId = plan.hypotheses.get(hypothesisId)!.evidenceIds[0]!;

    planner.recordEvidence(evidenceId, "src1", "contradicts" as EvidenceAssessment);
    const updated = planner.plan().hypotheses.get(hypothesisId)!;
    expect(updated.status).toBe("refuted");
    expect(updated.confidence).toBeLessThan(0.5);
    expect(planner.plan().evidence.get(evidenceId)!.fetched).toBe(true);

    planner.recordEvidence(evidenceId, "src1", "supports" as EvidenceAssessment);
    expect(planner.plan().hypotheses.get(hypothesisId)!.status).toBe("supported");
  });

  it("settles a question once all its hypotheses are tested", () => {
    const planner = new HypothesisPlanner();
    const id = planner.plant("How does speculative decoding affect latency?");
    const plan = planner.expand(id);
    const hypothesisId = plan.questions.get(id)!.hypotheses[0]!;
    const evidenceId = plan.hypotheses.get(hypothesisId)!.evidenceIds[0]!;
    expect(planner.plan().settled).not.toContain(id);

    planner.recordEvidence(evidenceId, "src1", "supports" as EvidenceAssessment);
    expect(planner.plan().settled).toContain(id);
  });

  it("expands to the configured depth and no further", () => {
    const planner = new HypothesisPlanner({ maxDepth: 2 });
    planner.plant("How does speculative decoding affect latency?");
    const plan = planner.expandAll("How does speculative decoding affect latency?");
    expect(plan.depth).toBe(2);
    expect(plan.questions.size).toBeGreaterThan(1);
  });

  it("throws when expanding an unknown question", () => {
    const planner = new HypothesisPlanner();
    expect(() => planner.expand("nope")).toThrow(/Unknown question/);
  });
});

function everyCandidateSourceNonEmpty(
  evidence: ReadonlyArray<{ candidateSources: string[] }>,
): boolean {
  return evidence.every((entry) => entry.candidateSources.length > 0);
}
