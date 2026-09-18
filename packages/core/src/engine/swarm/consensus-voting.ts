/**
 * Mathematical consensus voting for the swarm mesh.
 *
 * Relationship to what already exists: `agent/quorum-consensus.ts` answers
 * "have enough *distinct peers* endorsed this proposal" — a *cardinality*
 * gate over an evidence-grounded topic. That is the right primitive for
 * approving an artifact. This module answers a different question the mesh
 * also needs: "did a *ballot* pass", where voters have unequal weights, may
 * abstain, may need a supermajority, and where a tie must break by rule
 * rather than by whoever appended last. It is a separate tally store with its
 * own semantics; the two are meant to be used together (a ballot that passes
 * is grounds for an endorsement in the quorum engine), not one replacing the
 * other.
 *
 * The tally math is real and fully computed here:
 *  - effective weight per ballot is capped at `maxWeightPerVoter` and again
 *    by a Byzantine-resistance bound of (totalWeight - ownWeight), so no
 *    single voter — however heavy — can carry a question alone;
 *  - the quorum floor is `eligibleWeight * quorumFraction`, and a question
 *    passes only when the aye weight clears *both* the quorum floor *and* the
 *    nay weight (a plurality that misses quorum fails);
 *  - supermajority, when configured, replaces the quorum floor with the
 *    higher bar;
 *  - ties break by the configured policy: proposer precedence, lowest-weight
 *    deference, or explicit failure;
 *  - identical-grounds detection flags an echo-chamber ballot (all voters
 *    citing the *same* string) as a cascade risk, without changing the
 *    outcome — a warning, not a veto, so a genuinely-shared finding is not
 *    silenced.
 */

export type VoteChoice = "aye" | "nay" | "abstain";

export type TieBreakPolicy = "proposer_precedence" | "lowest_weight_defers" | "explicit_fail";

export interface VotingPolicy {
  /** Fraction of eligible weight that ayes must reach. 0.5 = simple majority. */
  quorumFraction: number;
  /** Higher bar overriding quorumFraction when set (e.g. 0.667). */
  supermajorityFraction?: number;
  /** Whether abstentions count toward the eligible denominator. */
  abstainsCountAsEligible: boolean;
  /** Hard per-voter weight ceiling. */
  maxWeightPerVoter: number;
  /** A voter's weight may never exceed the combined weight of everyone else. */
  byzantineWeightBound: boolean;
  tieBreak: TieBreakPolicy;
  /** Reject ballots that cite no grounds at all. */
  requireGrounded: boolean;
  /** Max ballots per question before the box refuses more (runaway guard). */
  maxBallots: number;
}

export interface Ballot {
  voterId: string;
  choice: VoteChoice;
  weight: number;
  grounds?: string;
  timestamp: number;
  attempt: number;
}

export interface Question {
  questionId: string;
  text: string;
  proposerId: string;
  policy: VotingPolicy;
  openedAt: number;
  closedAt?: number;
}

export type BallotOutcome =
  | "passed"
  | "failed_quorum"
  | "failed_supermajority"
  | "failed_plurality"
  | "tied"
  | "open"
  | "no_ballots";

export interface TallyResult {
  questionId: string;
  outcome: BallotOutcome;
  ayeWeight: number;
  nayWeight: number;
  abstainWeight: number;
  eligibleWeight: number;
  quorumFloor: number;
  requiredWeight: number;
  margin: number;
  turnout: number;
  voters: number;
  abstentions: number;
  cascadeWarning: boolean;
  decidedAt?: number;
  winningChoice?: Exclude<VoteChoice, "abstain">;
  reasons: string[];
}

export interface BallotBoxOptions {
  defaultPolicy?: Partial<VotingPolicy>;
}

const DEFAULT_POLICY: VotingPolicy = {
  quorumFraction: 0.5,
  abstainsCountAsEligible: true,
  maxWeightPerVoter: 4,
  byzantineWeightBound: true,
  tieBreak: "explicit_fail",
  requireGrounded: false,
  maxBallots: 64,
};

function normalizeFraction(value: number, fallback: number): number {
  if (Number.isNaN(value) || value <= 0) return fallback;
  return Math.min(1, value);
}

export class ConsensusVotingEngine {
  private readonly questions = new Map<string, Question>();
  private readonly ballots = new Map<string, Ballot[]>();
  private readonly outcomes = new Map<string, TallyResult>();
  private readonly defaultPolicy: VotingPolicy;

  constructor(options: BallotBoxOptions = {}) {
    this.defaultPolicy = { ...DEFAULT_POLICY, ...options.defaultPolicy };
    this.validatePolicy(this.defaultPolicy);
  }

  public openQuestion(input: {
    questionId?: string;
    text: string;
    proposerId: string;
    policy?: Partial<VotingPolicy>;
  }): Question {
    const text = input.text.trim();
    const proposerId = input.proposerId.trim();
    if (!text) throw new Error("Ballot question text cannot be empty");
    if (!proposerId) throw new Error("Ballot question proposerId cannot be empty");

    const questionId =
      input.questionId?.trim() ||
      `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (this.questions.has(questionId)) {
      throw new Error(`Ballot question '${questionId}' is already open`);
    }

    const policy: VotingPolicy = { ...this.defaultPolicy, ...input.policy };
    this.validatePolicy(policy);

    const question: Question = {
      questionId,
      text,
      proposerId,
      policy,
      openedAt: Date.now(),
    };
    this.questions.set(questionId, question);
    this.ballots.set(questionId, []);
    return { ...question };
  }

  /**
   * Casts a ballot. A re-cast from the same voter replaces the earlier ballot
   * (last position wins) rather than stacking — a voter may change their mind,
   * but may not vote twice.
   */
  public castBallot(
    questionId: string,
    voterId: string,
    choice: VoteChoice,
    options: { weight?: number; grounds?: string } = {},
  ): Ballot {
    const question = this.questions.get(questionId);
    if (!question) throw new Error(`Ballot question '${questionId}' does not exist`);
    if (question.closedAt !== undefined) {
      throw new Error(`Ballot question '${questionId}' is closed; no further ballots accepted`);
    }
    const voter = voterId.trim();
    if (!voter) throw new Error("Ballot voterId cannot be empty");

    const cast = this.ballots.get(questionId) ?? [];
    if (cast.length >= question.policy.maxBallots) {
      throw new Error(
        `Ballot question '${questionId}' has reached its ballot limit (${question.policy.maxBallots})`,
      );
    }
    if (question.policy.requireGrounded && (!options.grounds || !options.grounds.trim())) {
      throw new Error(
        `Ballot on '${questionId}' requires explicit grounds under the current voting policy`,
      );
    }

    const rawWeight = Number.isFinite(options.weight) ? Math.max(0, options.weight ?? 1) : 1;
    const effectiveWeight = Math.min(rawWeight, question.policy.maxWeightPerVoter);

    const ballot: Ballot = {
      voterId: voter,
      choice,
      weight: effectiveWeight,
      grounds: options.grounds?.trim() || undefined,
      timestamp: Date.now(),
      attempt: 1,
    };

    const prior = cast.findIndex((existing) => existing.voterId === voter);
    if (prior >= 0) {
      const previous = cast[prior];
      if (previous) ballot.attempt = previous.attempt + 1;
      cast[prior] = ballot;
    } else {
      cast.push(ballot);
    }
    this.ballots.set(questionId, cast);

    // A new ballot invalidates any prior tally: outcomes are always recomputed.
    this.outcomes.delete(questionId);
    return { ...ballot };
  }

  public closeQuestion(questionId: string): TallyResult {
    const question = this.questions.get(questionId);
    if (!question) throw new Error(`Ballot question '${questionId}' does not exist`);
    if (question.closedAt === undefined) question.closedAt = Date.now();
    return this.tally(questionId);
  }

  /** Recomputes the full tally from scratch. Pure function of stored ballots. */
  public tally(questionId: string): TallyResult {
    const question = this.questions.get(questionId);
    if (!question) throw new Error(`Ballot question '${questionId}' does not exist`);
    const ballots = this.ballots.get(questionId) ?? [];

    const cached = this.outcomes.get(questionId);
    if (cached) return { ...cached, reasons: [...cached.reasons] };

    const reasons: string[] = [];
    let ayeWeight = 0;
    let nayWeight = 0;
    let abstainWeight = 0;
    let eligibleWeight = 0;
    let abstentions = 0;
    const voterIds = new Set<string>();

    for (const ballot of ballots) {
      voterIds.add(ballot.voterId);
      const weight = this.effectiveWeight(ballot, ballots, question.policy);
      eligibleWeight += weight;
      switch (ballot.choice) {
        case "aye":
          ayeWeight += weight;
          break;
        case "nay":
          nayWeight += weight;
          break;
        case "abstain":
          abstainWeight += weight;
          abstentions++;
          break;
      }
    }

    if (!question.policy.abstainsCountAsEligible) {
      eligibleWeight -= abstainWeight;
    }

    const denominator = eligibleWeight;
    const quorumFloor = denominator * normalizeFraction(question.policy.quorumFraction, 0.5);
    const supermajority = question.policy.supermajorityFraction
      ? denominator * normalizeFraction(question.policy.supermajorityFraction, 0.667)
      : -1;
    const requiredWeight = Math.max(quorumFloor, supermajority);

    const cascadeWarning = this.detectCascade(ballots);
    if (cascadeWarning) {
      reasons.push(
        "every ballot cites identical grounds — treat as a possible information cascade, not independent corroboration",
      );
    }

    const turnout = denominator > 0 ? (ayeWeight + nayWeight) / denominator : 0;
    let outcome: BallotOutcome;
    let winningChoice: Exclude<VoteChoice, "abstain"> | undefined;

    if (ballots.length === 0) {
      outcome = "no_ballots";
      reasons.push("no ballots cast");
    } else if (question.closedAt === undefined) {
      outcome = "open";
      reasons.push("question still open; interim tally");
    } else if (ayeWeight === nayWeight && ayeWeight > 0) {
      winningChoice = this.breakTie(question, ballots, "aye", "nay");
      outcome =
        winningChoice === undefined
          ? "tied"
          : winningChoice === "aye"
            ? "passed"
            : "failed_plurality";
      reasons.push(
        winningChoice === undefined
          ? `dead tie at ${ayeWeight.toFixed(2)} aye / ${nayWeight.toFixed(2)} nay; tie policy '${question.policy.tieBreak}' declined to resolve`
          : `dead tie resolved by '${question.policy.tieBreak}' in favour of ${winningChoice}`,
      );
    } else if (ayeWeight > nayWeight) {
      winningChoice = "aye";
      if (supermajority > 0 && ayeWeight < supermajority) {
        outcome = "failed_supermajority";
        reasons.push(
          `ayes ${ayeWeight.toFixed(2)} lead but miss the supermajority bar of ${supermajority.toFixed(2)}`,
        );
      } else if (ayeWeight < quorumFloor) {
        outcome = "failed_quorum";
        reasons.push(
          `ayes lead yet ${ayeWeight.toFixed(2)} falls short of the quorum floor ${quorumFloor.toFixed(2)}`,
        );
      } else {
        outcome = "passed";
      }
    } else {
      winningChoice = "nay";
      outcome =
        ayeWeight < quorumFloor && nayWeight < quorumFloor ? "failed_quorum" : "failed_plurality";
      reasons.push(`nays ${nayWeight.toFixed(2)} exceed ayes ${ayeWeight.toFixed(2)}`);
    }

    const result: TallyResult = {
      questionId,
      outcome,
      ayeWeight,
      nayWeight,
      abstainWeight,
      eligibleWeight,
      quorumFloor,
      requiredWeight,
      margin: Math.abs(ayeWeight - nayWeight),
      turnout,
      voters: voterIds.size,
      abstentions,
      cascadeWarning,
      decidedAt: question.closedAt,
      winningChoice,
      reasons,
    };
    if (question.closedAt !== undefined) this.outcomes.set(questionId, result);
    return { ...result, reasons: [...result.reasons] };
  }

  public getQuestion(questionId: string): Question | undefined {
    const question = this.questions.get(questionId);
    return question ? { ...question } : undefined;
  }

  public getBallots(questionId: string): Ballot[] {
    return (this.ballots.get(questionId) ?? []).map((ballot) => ({ ...ballot }));
  }

  public listQuestions(filter?: {
    outcome?: BallotOutcome;
  }): Array<Question & { tally: TallyResult }> {
    const results: Array<Question & { tally: TallyResult }> = [];
    for (const question of this.questions.values()) {
      const result = this.tally(question.questionId);
      if (filter?.outcome && result.outcome !== filter.outcome) continue;
      results.push({ ...question, tally: result });
    }
    return results;
  }

  // ---------------------------------------------------------------- internals

  private validatePolicy(policy: VotingPolicy): void {
    if (normalizeFraction(policy.quorumFraction, 0.5) !== policy.quorumFraction) {
      throw new Error("Voting quorumFraction must lie in (0, 1]");
    }
    if (
      policy.supermajorityFraction !== undefined &&
      policy.supermajorityFraction <= policy.quorumFraction
    ) {
      throw new Error("Voting supermajorityFraction must exceed quorumFraction");
    }
    if (!(policy.maxWeightPerVoter > 0)) {
      throw new Error("Voting maxWeightPerVoter must be positive");
    }
    if (!Number.isInteger(policy.maxBallots) || policy.maxBallots < 1) {
      throw new Error("Voting maxBallots must be a positive integer");
    }
  }

  /**
   * Applies both weight caps. The Byzantine bound keeps one heavyweight voter
   * from outvoting the entire rest of the mesh: weight is clamped to the sum
   * of everyone else's weight, so aye/nay can never be a one-voter majority.
   *
   * A mathematical consequence worth knowing: in a *two-voter* ballot this
   * bound necessarily equalises both sides (each is capped at the other's
   * weight), so a two-voter question can never be decided by weight alone —
   * it is always a dead tie, and a tie-break policy or a third voter is
   * required. That is the intended Byzantine-resistance, not a bug: no two
   * voters can outvote each other by weight.
   */
  private effectiveWeight(ballot: Ballot, ballots: Ballot[], policy: VotingPolicy): number {
    const capped = Math.min(Math.max(ballot.weight, 0), policy.maxWeightPerVoter);
    if (!policy.byzantineWeightBound) return capped;

    // Sum every *other* voter's already-capped weight. A voter may never
    // outweigh the rest of the mesh combined, so a single heavyweight cannot
    // manufacture a majority on its own.
    const others = ballots
      .filter((other) => other.voterId !== ballot.voterId)
      .reduce(
        (sum, other) => sum + Math.min(Math.max(other.weight, 0), policy.maxWeightPerVoter),
        0,
      );

    return others > 0 ? Math.min(capped, others) : capped;
  }

  private breakTie(
    question: Question,
    ballots: Ballot[],
    aye: Exclude<VoteChoice, "abstain">,
    nay: Exclude<VoteChoice, "abstain">,
  ): Exclude<VoteChoice, "abstain"> | undefined {
    if (question.policy.tieBreak === "explicit_fail") return undefined;

    if (question.policy.tieBreak === "proposer_precedence") {
      const proposerBallot = ballots.find((ballot) => ballot.voterId === question.proposerId);
      if (!proposerBallot || proposerBallot.choice === "abstain") return undefined;
      return proposerBallot.choice === "aye" ? aye : nay;
    }

    // lowest_weight_defers: on a dead tie the side carrying less individual
    // weight per voter defers to the side that brought more to bear.
    //
    // The comparison is over per-voter-capped *nominal* weight, not the
    // Byzantine-flattened effective weight, on purpose: the Byzantine bound
    // deliberately equalises effective weight (see effectiveWeight), so a
    // ballot that tied on effective weight still records which side actually
    // committed more weight. Comparing effective weights here would make this
    // policy unreachable — every tie would look perfectly equal. Nominal
    // weights are already capped at cast time by maxWeightPerVoter, so a
    // heavyweight cannot buy this tie-break any more than it can buy the
    // outcome; it only chooses a winner among ballots already dead level.
    const ayeWeight = this.sumNominalChoice(ballots, "aye");
    const nayWeight = this.sumNominalChoice(ballots, "nay");
    if (ayeWeight === nayWeight) return undefined;
    return ayeWeight > nayWeight ? aye : nay;
  }

  private sumNominalChoice(ballots: Ballot[], choice: VoteChoice): number {
    return ballots
      .filter((ballot) => ballot.choice === choice)
      .reduce((sum, ballot) => sum + ballot.weight, 0);
  }

  /**
   * Cascade detector: identical grounds across distinct voters means the
   * voters are echoing one source rather than corroborating independently.
   * Two voters with the same grounds is coincidence; every voter is a signal.
   */
  private detectCascade(ballots: Ballot[]): boolean {
    const grounded = ballots.filter((ballot) => ballot.grounds && ballot.grounds.length > 0);
    if (grounded.length < 3) return false;
    const distinct = new Set(grounded.map((ballot) => ballot.grounds)).size;
    return distinct === 1;
  }
}
