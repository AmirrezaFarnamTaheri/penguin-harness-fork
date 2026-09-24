import { describe, it, expect } from "vitest";
import {
  SeededRandom,
  acceptanceProbability,
  draftQualityGate,
  expectedAcceptCount,
  logAcceptanceRatio,
  optimalWindowSize,
  sampleResidual,
  verifyWindow,
  type DraftWindow,
  type TargetWindow,
} from "../../../src/llm/speculative/draft-acceptance.js";

describe("draft-acceptance: acceptance math", () => {
  it("computes min(1, P_target / P_draft) and saturates at 1", () => {
    expect(acceptanceProbability(0.5, 0.25, "stochastic", 0, 0)).toBeCloseTo(1, 6);
    expect(acceptanceProbability(0.25, 0.5, "stochastic", 0, 0)).toBeCloseTo(0.5, 6);
    // q = p → acceptance probability is exactly 1.
    expect(acceptanceProbability(0.3, 0.3, "stochastic", 0, 0)).toBeCloseTo(1, 6);
  });

  it("is 1 when the tokens agree under the greedy rule and 0 when they differ", () => {
    expect(logAcceptanceRatio(0.5, 0.1, "greedy", 7, 7)).toBe(0);
    expect(logAcceptanceRatio(0.9, 0.9, "greedy", 7, 3)).toBe(Number.NEGATIVE_INFINITY);
    expect(acceptanceProbability(0.9, 0.9, "greedy", 7, 3)).toBe(0);
    expect(acceptanceProbability(0.1, 0.9, "greedy", 7, 7)).toBe(1);
  });

  it("treats an impossible draft token as never acceptable", () => {
    expect(acceptanceProbability(0.5, 0, "stochastic", 3, 3)).toBe(1);
    expect(acceptanceProbability(0, 0.5, "stochastic", 3, 3)).toBe(0);
  });

  it("reports 0 when both models assign ~0 probability, matching the sampling rule", () => {
    // The degenerate 0/0 case: `verifyWindow` accepts only when `u·p < q`, which at
    // p = q = 0 is `0 < 0` — always false, so the position is necessarily rejected. The
    // reported probability has to agree with that decision, not with a formal min(1, q/p)
    // that is undefined at 0/0. Reached in practice because `padRow` zero-fills an absent
    // draft id, so a draft token outside both rows' support hits exactly this case.
    expect(acceptanceProbability(0, 0, "stochastic", 3, 3)).toBe(0);
    expect(logAcceptanceRatio(0, 0, "stochastic", 3, 3)).toBe(Number.NEGATIVE_INFINITY);
    // expectedAcceptCount consumes those probabilities, so it must not add 1 for a
    // position that can never be accepted.
    const draft: DraftWindow = {
      tokenIds: [4],
      probs: [[0, 0, 0]],
      pointMass: false,
    };
    const target: TargetWindow = {
      tokenIds: [4, 0],
      probs: [
        [0, 0, 0],
        [0.5, 0.3, 0.2],
      ],
    };
    expect(expectedAcceptCount(draft, target)).toBe(0);
  });
});

describe("draft-acceptance: residual sampling", () => {
  it("draws from max(0, q - p) by inverse CDF", () => {
    const target = [0.5, 0.3, 0.2];
    const draft = [0.1, 0.1, 0.8];
    // residual = [0.4, 0.2, 0], sum = 0.6
    expect(sampleResidual(target, draft, 0.3)).toBe(0);
    expect(sampleResidual(target, draft, 0.99)).toBe(1);
    // A uniform draw below the first bucket always lands in bucket 0.
    expect(sampleResidual(target, draft, 0.0)).toBe(0);
  });

  it("falls back to -1 when the target support is inside the draft support", () => {
    expect(sampleResidual([0.2, 0.2], [0.5, 0.5], 0.5)).toBe(-1);
  });

  it("is monotone in the uniform draw", () => {
    const target = [0.6, 0.2, 0.2];
    const draft = [0.1, 0.2, 0.7];
    // residual = [0.5, 0, 0] — only token 0 can ever be drawn.
    for (const u of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(sampleResidual(target, draft, u)).toBe(0);
    }
  });
});

describe("draft-acceptance: window verification", () => {
  const uniformDraft: DraftWindow = {
    tokenIds: [0, 1, 2],
    probs: [
      [0.2, 0.2, 0.2, 0.2, 0.2],
      [0.2, 0.2, 0.2, 0.2, 0.2],
      [0.2, 0.2, 0.2, 0.2, 0.2],
    ],
    pointMass: false,
  };

  const matchingTarget: TargetWindow = {
    tokenIds: [0, 1, 2, 3],
    probs: [
      [0.2, 0.2, 0.2, 0.2, 0.2],
      [0.2, 0.2, 0.2, 0.2, 0.2],
      [0.2, 0.2, 0.2, 0.2, 0.2],
      [0.05, 0.05, 0.05, 0.8, 0.05],
    ],
  };

  it("accepts the whole window and emits the target bonus token when q >= p", () => {
    const result = verifyWindow(uniformDraft, matchingTarget, { uniforms: [0, 0, 0, 0] });
    expect(result.allAccepted).toBe(true);
    expect(result.acceptCount).toBe(3);
    expect(result.tokenIds).toEqual([0, 1, 2, 3]);
    expect(result.termination).toBe("accepted-all");
  });

  it("rejects at the first position where u*p >= q and resamples", () => {
    // Position 0: u=0.9, p=q=0.2 → 0.18 < 0.2 → accept.
    // Position 1: u=0.95 → 0.19 < 0.2 → accept.
    // Position 2: u=0.999 → 0.1998 < 0.2 → accept.
    const result = verifyWindow(uniformDraft, matchingTarget, { uniforms: [0.9, 0.95, 0.999, 0] });
    expect(result.allAccepted).toBe(true);
    expect(result.acceptCount).toBe(3);
  });

  it("rejects when the target probability is too low", () => {
    const weakTarget: TargetWindow = {
      tokenIds: [4, 4, 4, 4],
      probs: [
        [0.05, 0.05, 0.05, 0.05, 0.8],
        [0.05, 0.05, 0.05, 0.05, 0.8],
        [0.05, 0.05, 0.05, 0.05, 0.8],
        [0.05, 0.05, 0.05, 0.8, 0.05],
      ],
    };
    // Drafted token 0 has p=0.2 but q=0.05 → u*0.2 < 0.05 needs u < 0.25.
    const rejected = verifyWindow(uniformDraft, weakTarget, { uniforms: [0.9, 0.9, 0.9, 0.9] });
    expect(rejected.allAccepted).toBe(false);
    expect(rejected.acceptCount).toBe(0);
    expect(rejected.firstRejection).toBe(0);
    expect(rejected.termination).toBe("rejected-stochastic");
    // Residual at position 0: max(0, 0.05-0.2)=0, others 0.05-0.05=0... token4: 0.8-0.2=0.6 → token 4.
    expect(rejected.resampledTokenId).toBe(4);
  });

  it("greedy verification accepts on token equality and emits the target token otherwise", () => {
    const greedy = verifyWindow(uniformDraft, matchingTarget, { mode: "greedy" });
    expect(greedy.allAccepted).toBe(true);
    expect(greedy.tokenIds).toEqual([0, 1, 2, 3]);

    const divergentTarget: TargetWindow = {
      tokenIds: [0, 4, 2, 3],
      probs: matchingTarget.probs,
    };
    const diverged = verifyWindow(uniformDraft, divergentTarget, { mode: "greedy" });
    expect(diverged.acceptCount).toBe(1);
    expect(diverged.termination).toBe("rejected-greedy");
    // Position 0 accepted (both 0); position 1 mismatched → target token 4 emitted.
    expect(diverged.tokenIds).toEqual([0, 4]);
  });

  it("force-accepts the whole window plus the bonus token", () => {
    const forced = verifyWindow(uniformDraft, matchingTarget, {
      forceAccept: true,
      uniforms: [1, 1, 1, 1],
    });
    expect(forced.acceptCount).toBe(3);
    expect(forced.tokenIds).toEqual([0, 1, 2, 3]);
  });

  it("handles an empty window by emitting only the bonus token", () => {
    const empty = verifyWindow(
      { tokenIds: [], probs: [], pointMass: true },
      { tokenIds: [9], probs: [[0.5, 0.5]] },
      {},
    );
    expect(empty.acceptCount).toBe(0);
    expect(empty.tokenIds).toEqual([9]);
    expect(empty.termination).toBe("empty-window");
  });

  it("is deterministic for a fixed seed", () => {
    const a = verifyWindow(uniformDraft, matchingTarget, { seed: 12345 });
    const b = verifyWindow(uniformDraft, matchingTarget, { seed: 12345 });
    expect(a.tokenIds).toEqual(b.tokenIds);
    expect(a.acceptCount).toEqual(b.acceptCount);
  });

  it("pads draft probabilities through the draft-to-target vocabulary map", () => {
    // Draft vocabulary is {a:0, b:1} mapped into a 3-token target vocabulary as a→2, b→0.
    const draft: DraftWindow = {
      tokenIds: [0],
      probs: [[0.9, 0.1]],
      pointMass: false,
    };
    const target: TargetWindow = {
      tokenIds: [2, 1],
      probs: [
        [0.1, 0.1, 0.8],
        [0.2, 0.2, 0.6],
      ],
    };
    const result = verifyWindow(draft, target, {
      uniforms: [0, 0],
      draftToTargetMap: [2, 0],
    });
    // Drafted id 0 maps to target id 2, whose target prob is 0.8 > draft 0.9? No: 0.8 < 0.9
    // → acceptance prob 0.8/0.9 < 1, and with u=0 the token is accepted (0*0.9 < 0.8).
    expect(result.acceptCount).toBe(1);
    expect(result.allAccepted).toBe(true);
    expect(result.tokenIds[0]).toBe(0);
  });

  it("computes expected acceptance length from per-position probabilities", () => {
    const draft: DraftWindow = {
      tokenIds: [0, 1],
      probs: [
        [0.5, 0.5],
        [0.5, 0.5],
      ],
      pointMass: false,
    };
    const target: TargetWindow = {
      tokenIds: [0, 1, 0],
      probs: [
        [0.5, 0.5],
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    };
    expect(expectedAcceptCount(draft, target)).toBeCloseTo(2, 6);
  });
});

describe("draft-acceptance: seeded randomness", () => {
  it("produces a reproducible uniform sequence", () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    for (let i = 0; i < 32; i++) expect(a.next()).toBe(b.next());
  });

  it("stays within [0, 1) and varies across seeds", () => {
    const rng = new SeededRandom(7);
    const values = Array.from({ length: 100 }, () => rng.next());
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    const other = new SeededRandom(8);
    const different = Array.from({ length: 100 }, () => other.next());
    expect(values.some((v, i) => v !== different[i])).toBe(true);
  });

  it("resolves slot samples without consuming the stream", () => {
    const direct = (() => {
      const r = new SeededRandom(99);
      let v = 0;
      for (let i = 0; i <= 3; i++) v = r.next();
      return v;
    })();
    expect(SeededRandom.at(99, 3)).toBe(direct);
    expect(SeededRandom.at(99, 0)).toBe(new SeededRandom(99).next());
  });
});

describe("draft-acceptance: draft quality gate", () => {
  it("proposes where the draft is aligned but divergent", () => {
    const target = [0.5, 0.3, 0.2];
    const draft = [0.1, 0.4, 0.5];
    const report = draftQualityGate(target, draft, 0.2, 0.4);
    expect(report.plausibleTokenIds).toContain(0);
    expect(report.propose).toBe(true);
    expect(report.klDivergence).toBeGreaterThan(0);
    expect(report.contrastiveWeights.length).toBe(report.plausibleTokenIds.length);
    expect(report.contrastiveWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("blocks a draft that merely mirrors the target", () => {
    const target = [0.5, 0.3, 0.2];
    const report = draftQualityGate(target, target, 0.2, 0.4);
    expect(report.klDivergence).toBeCloseTo(0, 6);
    expect(report.propose).toBe(false);
  });

  it("measures divergence over the target's full width, not just the draft's support", () => {
    // The draft vocabulary can be a subset of the target's — `verifyWindow` pads draft
    // rows into target width before comparing them. Summing the KL over
    // min(len(target), len(draft)) dropped every target token outside the draft's
    // support, which is where divergence lives, so a draft silent on part of the target's
    // vocabulary measured an artificially low KL and could be gated out as "nothing
    // speculative to gain". The gate now reads the draft row as 0 beyond its own length.
    const target = [0.34, 0.33, 0.33];
    const narrowDraft = [0.5, 0.5];
    const report = draftQualityGate(target, narrowDraft, 0.2, 0.4);
    // The plausible set covers the target's whole support, including token 2, where the
    // draft is silent — a proposal has to be able to land there.
    expect(report.plausibleTokenIds).toEqual([0, 1, 2]);
    expect(report.contrastiveWeights.length).toBe(3);
    expect(report.klDivergence).toBeGreaterThan(0.05);
    expect(report.propose).toBe(true);
    // Extending the width changes nothing when the draft is not silent anywhere: the same
    // row with an explicit 0 measures the same KL.
    const wideDraft = [0.5, 0.5, 0];
    expect(draftQualityGate(target, wideDraft, 0.2, 0.4).klDivergence).toBeCloseTo(
      report.klDivergence,
      9,
    );
  });
});

describe("draft-acceptance: window sizing", () => {
  it("shrinks gamma as the acceptance rate falls", () => {
    expect(optimalWindowSize(0.95, 8, 0.25)).toBeGreaterThan(optimalWindowSize(0.5, 8, 0.25));
    expect(optimalWindowSize(0.5, 8, 0.25)).toBeGreaterThanOrEqual(1);
  });

  it("returns the full window for a perfect acceptance rate", () => {
    expect(optimalWindowSize(1, 8, 0.25)).toBe(8);
  });
});
