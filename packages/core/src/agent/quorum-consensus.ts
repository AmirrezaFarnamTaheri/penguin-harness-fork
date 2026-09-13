/**
 * Multi-Agent Quorum Consensus & Anti-Cascade Engine.
 *
 * Prevents echo-chamber information cascades and hallucination loops in multi-agent swarms
 * by requiring evidence-grounded peer endorsements, consensus thresholds, and refutation caps.
 *
 * Synthesized from tinyhivemind quorum consensus architectures.
 */

export type TopicConsensusStatus = "proposed" | "debating" | "settled" | "refuted";

export interface QuorumPolicy {
  /** Distinct peer endorsements required to settle a proposal (default: 2). */
  threshold: number;
  /** Whether endorsements must cite explicit grounded evidence/files to count (default: true). */
  requireGrounded: boolean;
  /** Number of grounded refutations that invalidate the proposal (default: 1). */
  refutationCap?: number;
}

export interface Endorsement {
  agentId: string;
  grounds?: string;
  timestamp: number;
}

export interface Refutation {
  agentId: string;
  grounds: string;
  timestamp: number;
}

export interface TopicStanding {
  topicId: string;
  topic: string;
  status: TopicConsensusStatus;
  policy: QuorumPolicy;
  proposerId: string;
  supporters: Endorsement[];
  refuters: Refutation[];
  createdAt: number;
  settledAt?: number;
  refutedAt?: number;
}

function validatePolicy(policy: QuorumPolicy): void {
  if (!Number.isInteger(policy.threshold) || policy.threshold < 1) {
    throw new Error("Quorum threshold must be a positive integer");
  }
  if (
    policy.refutationCap !== undefined &&
    (!Number.isInteger(policy.refutationCap) || policy.refutationCap < 1)
  ) {
    throw new Error("Quorum refutationCap must be a positive integer");
  }
  if (typeof policy.requireGrounded !== "boolean") {
    throw new Error("Quorum requireGrounded must be a boolean");
  }
}

function cloneStanding(standing: TopicStanding): TopicStanding {
  return {
    ...standing,
    policy: { ...standing.policy },
    supporters: standing.supporters.map((supporter) => ({ ...supporter })),
    refuters: standing.refuters.map((refuter) => ({ ...refuter })),
  };
}

export class QuorumConsensusEngine {
  private standings = new Map<string, TopicStanding>();
  private readonly defaultPolicy: QuorumPolicy;

  constructor(defaultPolicy?: Partial<QuorumPolicy>) {
    this.defaultPolicy = {
      threshold: defaultPolicy?.threshold ?? 2,
      requireGrounded: defaultPolicy?.requireGrounded ?? true,
      refutationCap: defaultPolicy?.refutationCap ?? 1,
    };
    validatePolicy(this.defaultPolicy);
  }

  public proposeTopic(input: {
    topicId?: string;
    topic: string;
    proposerId: string;
    initialGrounds?: string;
    policy?: Partial<QuorumPolicy>;
  }): TopicStanding {
    const topic = input.topic.trim();
    const proposerId = input.proposerId.trim();
    if (!topic) throw new Error("Consensus topic cannot be empty");
    if (!proposerId) throw new Error("Consensus proposerId cannot be empty");

    const topicId =
      input.topicId ?? `topic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!topicId.trim()) throw new Error("Consensus topicId cannot be empty");
    if (this.standings.has(topicId)) {
      throw new Error(`Topic with id '${topicId}' already exists`);
    }

    const policy: QuorumPolicy = {
      threshold: input.policy?.threshold ?? this.defaultPolicy.threshold,
      requireGrounded: input.policy?.requireGrounded ?? this.defaultPolicy.requireGrounded,
      refutationCap: input.policy?.refutationCap ?? this.defaultPolicy.refutationCap,
    };
    validatePolicy(policy);

    const now = Date.now();
    const supporters: Endorsement[] = [];

    // Proposer can be initial supporter if grounds are supplied (or if not required)
    if (!policy.requireGrounded || (input.initialGrounds && input.initialGrounds.trim())) {
      supporters.push({
        agentId: proposerId,
        grounds: input.initialGrounds,
        timestamp: now,
      });
    }

    const standing: TopicStanding = {
      topicId,
      topic,
      status: supporters.length >= policy.threshold ? "settled" : "debating",
      policy,
      proposerId,
      supporters,
      refuters: [],
      createdAt: now,
      settledAt: supporters.length >= policy.threshold ? now : undefined,
    };

    this.standings.set(topicId, standing);
    return cloneStanding(standing);
  }

  public endorseTopic(topicId: string, agentId: string, grounds?: string): TopicStanding {
    const standing = this.standings.get(topicId);
    if (!standing) {
      throw new Error(`Topic with id '${topicId}' not found`);
    }

    if (standing.status === "refuted") {
      throw new Error(`Cannot endorse refuted topic '${topicId}'`);
    }

    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) throw new Error("Endorser agentId cannot be empty");

    // Check if grounded evidence is required
    if (standing.policy.requireGrounded && (!grounds || !grounds.trim())) {
      throw new Error(
        `Endorsement requires explicit grounds/evidence citations under current quorum policy`,
      );
    }

    // Prevent duplicate endorsements from the same agent
    if (!standing.supporters.some((s) => s.agentId === normalizedAgentId)) {
      standing.supporters.push({
        agentId: normalizedAgentId,
        grounds,
        timestamp: Date.now(),
      });
    }

    // Check if threshold reached
    if (standing.supporters.length >= standing.policy.threshold && standing.status !== "settled") {
      standing.status = "settled";
      standing.settledAt = Date.now();
    }

    return cloneStanding(standing);
  }

  public refuteTopic(topicId: string, agentId: string, grounds: string): TopicStanding {
    const standing = this.standings.get(topicId);
    if (!standing) {
      throw new Error(`Topic with id '${topicId}' not found`);
    }

    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) throw new Error("Refuter agentId cannot be empty");
    if (!grounds || !grounds.trim()) {
      throw new Error("Refutation must provide explicit grounds or contradicting evidence");
    }

    if (!standing.refuters.some((r) => r.agentId === normalizedAgentId)) {
      standing.refuters.push({
        agentId: normalizedAgentId,
        grounds,
        timestamp: Date.now(),
      });
    }

    const cap = standing.policy.refutationCap ?? 1;
    if (standing.refuters.length >= cap) {
      standing.status = "refuted";
      standing.refutedAt = Date.now();
    }

    return cloneStanding(standing);
  }

  public getStanding(topicId: string): TopicStanding | undefined {
    const standing = this.standings.get(topicId);
    return standing ? cloneStanding(standing) : undefined;
  }

  public listStandings(filter?: { status?: TopicConsensusStatus }): TopicStanding[] {
    const list: TopicStanding[] = [];
    for (const standing of this.standings.values()) {
      if (filter?.status && standing.status !== filter.status) continue;
      list.push(cloneStanding(standing));
    }
    return list;
  }
}
