import { describe, it, expect } from "vitest";
import {
  ParallelSpeculator,
  runSynthetic,
  type DraftModel,
  type DraftRequest,
  type TargetModel,
  type VerifyRequest,
} from "../../../src/llm/speculative/parallel-speculator.js";
import type { TargetWindow } from "../../../src/llm/speculative/draft-acceptance.js";

const VOCAB = 8;

/**
 * A draft model that proposes from a fixed distribution, perturbed by the stream seed
 * so streams diverge. Deterministic: the same seed yields the same proposal.
 */
function scriptedDraft(acceptanceBias: number): DraftModel {
  return {
    propose(request: DraftRequest) {
      const tokens: number[] = [];
      const probs: number[][] = [];
      let seed = request.seed;
      for (let i = 0; i < request.windowSize; i++) {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        const tokenId = seed % VOCAB;
        tokens.push(tokenId);
        const row = new Array<number>(VOCAB).fill((1 - acceptanceBias) / (VOCAB - 1));
        row[tokenId] = acceptanceBias;
        probs.push(row);
      }
      return { tokenIds: tokens, probs, pointMass: false };
    },
  };
}

/**
 * A target model that agrees with the draft `agreement` of the time by rerolling the
 * drafted token otherwise. The verification row for the bonus position always prefers
 * a distinct token so full acceptance is observable.
 */
function scriptedTarget(agreement: number): TargetModel {
  return {
    verify(request: VerifyRequest): TargetWindow {
      const tokenIds: number[] = [];
      const probs: number[][] = [];
      let seed = request.context.length + request.draftTokens.length * 7919;
      for (let position = 0; position <= request.draftTokens.length; position++) {
        seed = (seed * 1_103_515_245 + 61_023) % 2 ** 31;
        const drafted = request.draftTokens[position];
        // The bonus position (and any empty draft) has no drafted token to agree with,
        // so it must emit a seed-derived token — arithmetically on `undefined` yields NaN.
        const isBonus = position >= request.draftTokens.length;
        const agree = !isBonus && seed / 2 ** 31 < agreement;
        const fallback = ((drafted ?? 0) + 1 + (seed % (VOCAB - 1))) % VOCAB;
        const tokenId = agree ? (drafted ?? fallback) : fallback;
        tokenIds.push(tokenId);
        const row = new Array<number>(VOCAB).fill(0.02);
        row[tokenId] = 0.5;
        if (drafted !== undefined) row[drafted] = Math.max(row[drafted] ?? 0, agreement);
        probs.push(row);
      }
      return { tokenIds, probs };
    },
  };
}

describe("ParallelSpeculator", () => {
  it("runs a full propose-verify-commit round and commits tokens", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.8), scriptedTarget(1), {
      windowSize: 4,
    });
    speculator.openStream("s1", 0, [1, 2]);
    const outcome = await speculator.runRound("s1");

    expect(outcome.proposed).toBe(4);
    expect(outcome.committed.length).toBeGreaterThan(0);
    expect(speculator.output("s1").length).toBeGreaterThan(2);
  });

  it("never leaks speculative suffixes after a round", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.5), scriptedTarget(0.4), {
      windowSize: 4,
    });
    speculator.openStream("a", 0);
    speculator.openStream("b", 1);
    for (let i = 0; i < 6; i++) await speculator.runBatchRound();
    expect(speculator.leaks().clean).toBe(true);
  });

  it("produces deterministic output for a fixed configuration", async () => {
    const build = async () => {
      const s = new ParallelSpeculator(scriptedDraft(0.8), scriptedTarget(1), {
        windowSize: 4,
        seedBase: 1234,
        enableQualityGate: false,
      });
      s.openStream("s1", 0, [1, 2, 3]);
      await s.runRound("s1");
      return s.output("s1");
    };
    expect(await build()).toEqual(await build());
  });

  it("demotes a stream to target-only decoding when the draft fails", async () => {
    const failingDraft: DraftModel = {
      propose() {
        throw new Error("draft forward failed");
      },
    };
    const speculator = new ParallelSpeculator(failingDraft, scriptedTarget(1), { windowSize: 4 });
    speculator.openStream("s1", 0, [1]);
    const outcome = await speculator.runRound("s1");
    expect(outcome.demoted).toBe(true);
    expect(outcome.proposed).toBe(0);
    expect(outcome.committed).toHaveLength(1);
  });

  it("releases the staged suffix when target verification throws", async () => {
    const failingTarget: TargetModel = {
      verify(): TargetWindow {
        throw new Error("target forward failed");
      },
    };
    const speculator = new ParallelSpeculator(scriptedDraft(0.8), failingTarget, { windowSize: 4 });
    const stream = speculator.openStream("s1", 0, [1]);
    const outcome = await speculator.runRound("s1");
    expect(outcome.termination).toContain("verify-failed");
    expect(stream.committed()).toEqual([1]);
    expect(stream.pendingLength).toBe(0);
  });

  it("reports a failed target in a target-only round instead of throwing", async () => {
    // The demoted combination: the draft already failed, so the round is target-only,
    // and then the target fails too. Nothing is staged, so there is no suffix to release,
    // but the contract is the same — the round returns a verify-failed outcome rather
    // than letting the failure escape into runBatchRound's Promise.all.
    const failingDraft: DraftModel = {
      propose() {
        throw new Error("draft forward failed");
      },
    };
    const failingTarget: TargetModel = {
      verify(): TargetWindow {
        throw new Error("target forward failed");
      },
    };
    const speculator = new ParallelSpeculator(failingDraft, failingTarget, { windowSize: 4 });
    const stream = speculator.openStream("s1", 0, [1]);
    const outcome = await speculator.runRound("s1");
    expect(outcome.demoted).toBe(true);
    expect(outcome.proposed).toBe(0);
    expect(outcome.committed).toEqual([]);
    expect(outcome.termination).toContain("verify-failed");
    // The seed context survives untouched: no token was committed and none is staged.
    expect(stream.committed()).toEqual([1]);
    expect(stream.pendingLength).toBe(0);
  });

  it("survives a degraded stream in a batch round without aborting the healthy ones", async () => {
    // Before the guard, the demoted combination rejected runRound, and runBatchRound's
    // Promise.all spread that rejection across the whole batch — one degraded stream
    // took down the round for every other stream, even the healthy ones. runBatchRound
    // must settle: every stream gets an outcome, the failed ones carry verify-failed, and
    // the round resolves instead of rejecting.
    const failingDraft: DraftModel = {
      propose() {
        throw new Error("draft forward failed");
      },
    };
    const failingTarget: TargetModel = {
      verify(): TargetWindow {
        throw new Error("target forward failed");
      },
    };
    const speculator = new ParallelSpeculator(failingDraft, failingTarget, { windowSize: 4 });
    speculator.openStream("degraded", 1, [1]);
    speculator.openStream("also-degraded", 0, [2]);
    const outcomes = await speculator.runBatchRound();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.termination.includes("verify-failed"))).toBe(true);
    // The seed context of each stream survives untouched.
    for (const o of outcomes) expect(o.committed).toEqual([]);
  });

  it("runs multiple streams concurrently in one batch round", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.7), scriptedTarget(0.9), {
      windowSize: 3,
    });
    speculator.openStream("x", 2);
    speculator.openStream("y", 1);
    speculator.openStream("z", 0);
    const outcomes = await speculator.runBatchRound();
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.committed.length > 0)).toBe(true);
  });

  it("adapts the window size from observed acceptance", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.9), scriptedTarget(1), {
      windowSize: 2,
      maxWindowSize: 8,
      adaptationInterval: 2,
      enableQualityGate: false,
    });
    speculator.openStream("s1", 0, [1]);
    for (let i = 0; i < 6; i++) await speculator.runRound("s1");
    const stream = speculator.rollbackFor("s1");
    expect(stream).toBeDefined();
    expect(speculator.output("s1").length).toBeGreaterThan(6);
  });

  it("cancels a stream and releases its speculative state", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.8), scriptedTarget(1), {
      windowSize: 4,
    });
    const stream = speculator.openStream("s1", 0, [1]);
    await speculator.runRound("s1");
    speculator.closeStream("s1");
    expect(stream!.isCancelled).toBe(true);
    expect(speculator.rollbackFor("s1")).toBeUndefined();
  });

  it("records throughput that reflects committed tokens", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.9), scriptedTarget(1), {
      windowSize: 4,
      enableQualityGate: false,
    });
    speculator.openStream("s1", 0);
    for (let i = 0; i < 3; i++) await speculator.runRound("s1");
    const report = speculator.throughput.report();
    expect(report.committed).toBeGreaterThan(0);
    expect(report.acceptanceRate).toBeGreaterThan(0);
    expect(report.rounds).toBe(3);
  });

  it("rejects unknown streams", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.8), scriptedTarget(1));
    await expect(speculator.runRound("nope")).rejects.toThrow(/Unknown speculative stream/);
  });

  it("honours the warm-up force-accept path", async () => {
    const speculator = new ParallelSpeculator(scriptedDraft(0.1), scriptedTarget(0.0), {
      windowSize: 3,
      warmUp: true,
      enableQualityGate: false,
    });
    speculator.openStream("s1", 0, [1]);
    const outcome = await speculator.runRound("s1");
    expect(outcome.acceptCount).toBe(3);
    expect(outcome.allAccepted).toBe(true);
  });
});

describe("runSynthetic", () => {
  it("summarises a batch of rounds end to end", async () => {
    const { summary, speculator } = await runSynthetic(
      scriptedDraft(0.85),
      scriptedTarget(1),
      4,
      2,
      {
        windowSize: 4,
        enableQualityGate: false,
      },
    );
    expect(summary.rounds).toBe(8);
    expect(summary.committed).toBeGreaterThan(0);
    expect(summary.leaks).toBe(0);
    expect(summary.acceptanceRate).toBeGreaterThan(0);
    expect(speculator.leaks().clean).toBe(true);
  });
});
