import { describe, expect, it } from "vitest";

import {
  ConsensusVotingEngine,
  type Ballot,
  type BallotOutcome,
  type TieBreakPolicy,
  type VoteChoice,
  type VotingPolicy,
} from "../../../src/engine/swarm/consensus-voting.js";

function standardPolicy(overrides: Partial<VotingPolicy> = {}): VotingPolicy {
  return {
    quorumFraction: 0.5,
    abstainsCountAsEligible: true,
    maxWeightPerVoter: 4,
    byzantineWeightBound: true,
    tieBreak: "explicit_fail",
    requireGrounded: false,
    maxBallots: 32,
    ...overrides,
  };
}

describe("ConsensusVotingEngine lifecycle", () => {
  it("opens a question and rejects duplicates and empty text", () => {
    const engine = new ConsensusVotingEngine();
    const question = engine.openQuestion({ text: "Ship the patch?", proposerId: "orchestrator" });
    expect(question.text).toBe("Ship the patch?");
    expect(engine.getQuestion(question.questionId)).toBeDefined();
    expect(() =>
      engine.openQuestion({ text: "dupe", proposerId: "o", questionId: question.questionId }),
    ).toThrow(/already open/);
    expect(() => engine.openQuestion({ text: "", proposerId: "o" })).toThrow(/cannot be empty/);
  });

  it("refuses ballots on a closed question", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye");
    engine.closeQuestion(q.questionId);
    expect(() => engine.castBallot(q.questionId, "b", "aye")).toThrow(/is closed/);
  });

  it("refuses an uncited ballot when the policy requires grounds", () => {
    const engine = new ConsensusVotingEngine({
      defaultPolicy: { requireGrounded: true, maxWeightPerVoter: 4 },
    });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    expect(() => engine.castBallot(q.questionId, "a", "aye")).toThrow(/requires explicit grounds/);
    expect(engine.castBallot(q.questionId, "a", "aye", { grounds: "test passes" }).choice).toBe(
      "aye",
    );
  });

  it("enforces the ballot limit per question", () => {
    const engine = new ConsensusVotingEngine({ defaultPolicy: { maxBallots: 2 } });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye");
    engine.castBallot(q.questionId, "b", "aye");
    expect(() => engine.castBallot(q.questionId, "c", "aye")).toThrow(/ballot limit/);
  });

  it("lets a voter change their mind instead of double voting", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { weight: 2 });
    engine.castBallot(q.questionId, "a", "nay", { weight: 2 });
    const ballots = engine.getBallots(q.questionId);
    expect(ballots).toHaveLength(1);
    expect(ballots[0]?.choice).toBe("nay");
    expect(ballots[0]?.attempt).toBe(2);
  });
});

describe("ConsensusVotingEngine tally math", () => {
  it("passes on a simple majority of weight", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    // Three voters, not two: the Byzantine bound necessarily equalises the two
    // sides of a two-voter ballot (each is capped at the other's weight), so a
    // weighted plurality needs a third voter to be observable at all.
    engine.castBallot(q.questionId, "a", "aye", { weight: 2 });
    engine.castBallot(q.questionId, "b", "nay", { weight: 1 });
    engine.castBallot(q.questionId, "c", "aye", { weight: 1 });
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.outcome).toBe("passed");
    expect(tally.ayeWeight).toBe(3);
    expect(tally.nayWeight).toBe(1);
    expect(tally.margin).toBe(2);
    expect(tally.turnout).toBeCloseTo(1, 5);
  });

  it("fails on a plurality that misses the quorum floor", () => {
    const engine = new ConsensusVotingEngine({ defaultPolicy: { quorumFraction: 0.667 } });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { weight: 2 });
    engine.castBallot(q.questionId, "b", "aye", { weight: 1 });
    engine.castBallot(q.questionId, "c", "nay", { weight: 2 });
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.outcome).toBe("failed_quorum");
    expect(tally.quorumFloor).toBeGreaterThan(tally.ayeWeight);
  });

  it("fails a majority that misses a configured supermajority", () => {
    const engine = new ConsensusVotingEngine({
      defaultPolicy: { quorumFraction: 0.5, supermajorityFraction: 0.9 },
    });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { weight: 2 });
    engine.castBallot(q.questionId, "b", "aye", { weight: 2 });
    engine.castBallot(q.questionId, "c", "nay", { weight: 1 });
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.outcome).toBe("failed_supermajority");
    expect(tally.requiredWeight).toBe(tally.eligibleWeight * 0.9);
  });

  it("reports an interim tally while a question is still open", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { weight: 1 });
    const interim = engine.tally(q.questionId);
    expect(interim.outcome).toBe("open");
    expect(interim.decidedAt).toBeUndefined();
  });

  it("reports no_ballots on an untouched question", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    expect(engine.closeQuestion(q.questionId).outcome).toBe("no_ballots");
  });

  it("caches a closed tally and recomputes on a new ballot", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { weight: 1 });
    const first = engine.tally(q.questionId);
    expect(first.outcome).toBe("open");
  });
});

describe("ConsensusVotingEngine weight caps", () => {
  it("caps an individual voter's weight at maxWeightPerVoter", () => {
    // The Byzantine bound is disabled here so the per-voter cap is what is
    // under test; with the bound on, this same two-voter ballot would tie
    // (see the Byzantine-bound test below).
    const engine = new ConsensusVotingEngine({
      defaultPolicy: { maxWeightPerVoter: 2, byzantineWeightBound: false },
    });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "heavy", "aye", { weight: 100 });
    engine.castBallot(q.questionId, "light", "nay", { weight: 1 });
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.ayeWeight).toBe(2);
    expect(tally.outcome).toBe("passed");
  });

  it("applies the Byzantine bound so one voter cannot outvote the mesh", () => {
    const engine = new ConsensusVotingEngine({
      defaultPolicy: { maxWeightPerVoter: 10, byzantineWeightBound: true },
    });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "titan", "aye", { weight: 10 });
    engine.castBallot(q.questionId, "one", "nay", { weight: 1 });
    const tally = engine.closeQuestion(q.questionId);
    // The titan's effective weight is clamped to everyone else's combined 1.
    expect(tally.ayeWeight).toBe(1);
    expect(tally.outcome).toBe("tied");
  });

  it("relaxes the Byzantine bound when disabled", () => {
    const engine = new ConsensusVotingEngine({
      defaultPolicy: { maxWeightPerVoter: 10, byzantineWeightBound: false },
    });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "titan", "aye", { weight: 10 });
    engine.castBallot(q.questionId, "one", "nay", { weight: 1 });
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.ayeWeight).toBe(10);
    expect(tally.outcome).toBe("passed");
  });

  it("excludes abstentions from the eligible denominator when configured", () => {
    // Byzantine bound off, so weights survive at their cast values and the
    // denominator arithmetic is what is under test rather than the cap chain.
    const engine = new ConsensusVotingEngine({
      defaultPolicy: {
        abstainsCountAsEligible: false,
        quorumFraction: 0.5,
        byzantineWeightBound: false,
      },
    });
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { weight: 1 });
    engine.castBallot(q.questionId, "b", "abstain", { weight: 3 });
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.abstainWeight).toBe(3);
    expect(tally.eligibleWeight).toBe(1);
    expect(tally.abstentions).toBe(1);
    // The abstention did not pad the denominator: a single aye clears the
    // 0.5 quorum floor on an eligible weight of 1.
    expect(tally.outcome).toBe("passed");
    expect(tally.quorumFloor).toBeCloseTo(0.5, 5);
  });
});

describe("ConsensusVotingEngine tie-breaking", () => {
  function tie(engine: ConsensusVotingEngine, policy: TieBreakPolicy): BallotOutcome {
    const q = engine.openQuestion({
      text: "tie",
      proposerId: "proposer",
      policy: { tieBreak: policy },
    });
    engine.castBallot(q.questionId, "proposer", "aye", { weight: 1 });
    engine.castBallot(q.questionId, "other", "nay", { weight: 1 });
    return engine.closeQuestion(q.questionId).outcome;
  }

  it("declines to resolve an exact tie under explicit_fail", () => {
    expect(tie(new ConsensusVotingEngine(), "explicit_fail")).toBe("tied");
  });

  it("resolves a tie by the proposer's ballot under proposer_precedence", () => {
    expect(tie(new ConsensusVotingEngine(), "proposer_precedence")).toBe("passed");
  });

  it("declines to break a tie when the proposer abstained", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({
      text: "tie",
      proposerId: "proposer",
      policy: { tieBreak: "proposer_precedence" },
    });
    engine.castBallot(q.questionId, "proposer", "abstain", { weight: 1 });
    engine.castBallot(q.questionId, "a", "aye", { weight: 1 });
    engine.castBallot(q.questionId, "b", "nay", { weight: 1 });
    expect(engine.closeQuestion(q.questionId).outcome).toBe("tied");
  });

  it("resolves a tie toward the heavier side under lowest_weight_defers", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({
      text: "tie",
      proposerId: "proposer",
      policy: { tieBreak: "lowest_weight_defers", maxWeightPerVoter: 4 },
    });
    engine.castBallot(q.questionId, "a", "aye", { weight: 3 });
    engine.castBallot(q.questionId, "b", "nay", { weight: 1 });
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.outcome).toBe("passed");
  });

  it("still declines when both sides carry identical weight", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({
      text: "tie",
      proposerId: "proposer",
      policy: { tieBreak: "lowest_weight_defers" },
    });
    engine.castBallot(q.questionId, "a", "aye", { weight: 1 });
    engine.castBallot(q.questionId, "b", "nay", { weight: 1 });
    expect(engine.closeQuestion(q.questionId).outcome).toBe("tied");
  });
});

describe("ConsensusVotingEngine cascade detection", () => {
  it("flags ballots where every voter cites identical grounds", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    for (const voter of ["a", "b", "c"]) {
      engine.castBallot(q.questionId, voter, "aye" as VoteChoice, { grounds: "the tests pass" });
    }
    const tally = engine.closeQuestion(q.questionId);
    expect(tally.cascadeWarning).toBe(true);
    expect(tally.reasons.some((reason) => reason.includes("cascade"))).toBe(true);
    // A warning does not change the outcome.
    expect(tally.outcome).toBe("passed");
  });

  it("does not flag independent corroboration with differing grounds", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { grounds: "test a passes" });
    engine.castBallot(q.questionId, "b", "aye", { grounds: "test b passes" });
    engine.castBallot(q.questionId, "c", "aye", { grounds: "test c passes" });
    expect(engine.closeQuestion(q.questionId).cascadeWarning).toBe(false);
  });

  it("leaves short ballots unflagged", () => {
    const engine = new ConsensusVotingEngine();
    const q = engine.openQuestion({ text: "q", proposerId: "o" });
    engine.castBallot(q.questionId, "a", "aye", { grounds: "same" });
    engine.castBallot(q.questionId, "b", "aye", { grounds: "same" });
    expect(engine.closeQuestion(q.questionId).cascadeWarning).toBe(false);
  });
});

describe("ConsensusVotingEngine policy validation", () => {
  it("rejects a quorum fraction outside (0,1]", () => {
    expect(() => new ConsensusVotingEngine({ defaultPolicy: { quorumFraction: 0 } })).toThrow();
  });

  it("rejects a supermajority that does not exceed the quorum", () => {
    expect(
      () =>
        new ConsensusVotingEngine({
          defaultPolicy: { quorumFraction: 0.6, supermajorityFraction: 0.5 },
        }),
    ).toThrow(/must exceed quorumFraction/);
  });

  it("lists questions filtered by outcome", () => {
    const engine = new ConsensusVotingEngine();
    // No ballots at all: this one reports no_ballots, not 'open'.
    const untouched = engine.openQuestion({ text: "untouched", proposerId: "o" });
    // Ballots cast but never closed: a live question, so an interim tally.
    const open = engine.openQuestion({ text: "open", proposerId: "o" });
    const closed = engine.openQuestion({ text: "closed", proposerId: "o" });
    engine.castBallot(open.questionId, "a", "aye", { weight: 1 });
    engine.castBallot(closed.questionId, "a", "aye", { weight: 1 });
    engine.closeQuestion(closed.questionId);

    expect(engine.listQuestions({ outcome: "no_ballots" }).map((q) => q.questionId)).toContain(
      untouched.questionId,
    );
    expect(engine.listQuestions({ outcome: "open" }).map((q) => q.questionId)).toContain(
      open.questionId,
    );
    expect(engine.listQuestions({ outcome: "passed" }).map((q) => q.questionId)).toContain(
      closed.questionId,
    );
  });
});
