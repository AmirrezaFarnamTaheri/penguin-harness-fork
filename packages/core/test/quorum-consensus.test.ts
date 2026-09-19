import { describe, expect, it } from "vitest";
import { QuorumConsensusEngine } from "../src/agent/quorum-consensus.js";

describe("QuorumConsensusEngine", () => {
  it("proposes, endorses with grounded evidence, and settles consensus upon reaching peer threshold", () => {
    const engine = new QuorumConsensusEngine({ threshold: 2, requireGrounded: true });

    const topic = engine.proposeTopic({
      topic: "Adopt Bun for Fast Package Installs",
      proposerId: "architect-1",
      initialGrounds: "Benchmark shows 3x speedup in CI build timings (see benchmarks/ci.log)",
    });

    expect(topic.status).toBe("debating");
    expect(topic.supporters.length).toBe(1);

    expect(() => engine.endorseTopic(topic.topicId, "peer-agent-2", "")).toThrow(
      /explicit grounds/,
    );

    // Proposer cannot peer-endorse own topic
    expect(() =>
      engine.endorseTopic(topic.topicId, "architect-1", "I reiterate my grounds"),
    ).toThrow(/cannot peer-endorse/);

    // First peer endorsement -> status is still debating (1 / 2 required peers)
    const debating = engine.endorseTopic(
      topic.topicId,
      "peer-agent-2",
      "Verified locally: tests pass and pnpm install takes 4s instead of 18s",
    );
    expect(debating.status).toBe("debating");
    expect(debating.settledAt).toBeUndefined();
    expect(debating.supporters.length).toBe(2);

    // Second peer endorsement -> reaches threshold of 2 peers -> settled
    const settled = engine.endorseTopic(
      topic.topicId,
      "peer-agent-3",
      "Benchmark independently reproduced in staging environment",
    );

    expect(settled.status).toBe("settled");
    expect(settled.settledAt).toBeDefined();
    expect(settled.supporters.length).toBe(3);
  });

  it("refutes topic when contradictory evidence threshold is met", () => {
    const engine = new QuorumConsensusEngine({ threshold: 3, refutationCap: 1 });

    const topic = engine.proposeTopic({
      topic: "Remove TypeScript Strict Mode",
      proposerId: "junior-dev",
      initialGrounds: "Speeds up build compilation by 15%",
    });

    expect(topic.status).toBe("debating");

    const refuted = engine.refuteTopic(
      topic.topicId,
      "security-lead",
      "Violates repository rule: strict null checks prevent runtime undefined crashes",
    );

    expect(refuted.status).toBe("refuted");
    expect(refuted.refutedAt).toBeDefined();

    expect(() => engine.endorseTopic(topic.topicId, "dev-3", "valid reason")).toThrow(
      /Cannot endorse refuted topic/,
    );
  });

  it("rejects invalid quorum policy values", () => {
    expect(() => new QuorumConsensusEngine({ threshold: 0 })).toThrow(/positive integer/);
    expect(() => new QuorumConsensusEngine({ threshold: Number.NaN })).toThrow(/positive integer/);
    expect(() => new QuorumConsensusEngine({ refutationCap: -1 })).toThrow(/positive integer/);

    const engine = new QuorumConsensusEngine();
    expect(() =>
      engine.proposeTopic({
        topic: "Bad local policy",
        proposerId: "agent-1",
        policy: { threshold: 1.5 },
      }),
    ).toThrow(/positive integer/);
  });

  it("does not expose mutable consensus state through returned standings", () => {
    const engine = new QuorumConsensusEngine({ threshold: 2 });
    const proposed = engine.proposeTopic({
      topicId: "immutable-topic",
      topic: "Keep consensus state encapsulated",
      proposerId: "agent-1",
      initialGrounds: "Evidence A",
    });

    proposed.policy.threshold = 1;
    proposed.supporters.push({ agentId: "injected", grounds: "fake", timestamp: Date.now() });

    const stored = engine.getStanding("immutable-topic")!;
    expect(stored.policy.threshold).toBe(2);
    expect(stored.supporters.map((supporter) => supporter.agentId)).toEqual(["agent-1"]);

    const listed = engine.listStandings()[0]!;
    listed.refuters.push({ agentId: "injected", grounds: "fake", timestamp: Date.now() });
    expect(engine.getStanding("immutable-topic")?.refuters).toEqual([]);
  });

  it("rejects duplicate topic identities instead of overwriting history", () => {
    const engine = new QuorumConsensusEngine();
    engine.proposeTopic({ topicId: "stable-id", topic: "First", proposerId: "agent-1" });
    expect(() =>
      engine.proposeTopic({ topicId: "stable-id", topic: "Second", proposerId: "agent-2" }),
    ).toThrow(/already exists/);
    expect(engine.getStanding("stable-id")?.topic).toBe("First");
  });

  it("treats settle and refute as mutually exclusive terminal states", () => {
    const engine = new QuorumConsensusEngine({ threshold: 2 });

    const topic = engine.proposeTopic({
      topicId: "settled-topic",
      topic: "Ship the feature flag rollout",
      proposerId: "agent-1",
      initialGrounds: "Gate data attached",
    });
    engine.endorseTopic(topic.topicId, "agent-2", "Metrics confirm 0.01% error rate");
    const settled = engine.endorseTopic(topic.topicId, "agent-3", "Canary held for 72h");
    expect(settled.status).toBe("settled");

    // A settled topic can no longer be flipped: refuting it would leave both settledAt and
    // refutedAt set, and peers reading either field would disagree about the outcome.
    expect(() => engine.refuteTopic(topic.topicId, "agent-4", "Rollout regressed latency")).toThrow(
      /Cannot refute settled topic/,
    );
    expect(() => engine.endorseTopic(topic.topicId, "agent-5", "Late support")).toThrow(
      /Cannot endorse settled topic/,
    );

    const after = engine.getStanding(topic.topicId)!;
    expect(after.status).toBe("settled");
    expect(after.refutedAt).toBeUndefined();
    expect(after.refuters).toEqual([]);
  });

  it("refuses re-refutation and proposer self-refutation", () => {
    const engine = new QuorumConsensusEngine({ refutationCap: 1 });

    const topic = engine.proposeTopic({
      topicId: "weak-topic",
      topic: "Delete all integration tests",
      proposerId: "agent-1",
      initialGrounds: "They are slow",
    });

    // The proposer retracting its own proposal needs no peer evidence — that is exactly the
    // echo-chamber escape hatch this engine exists to close.
    expect(() => engine.refuteTopic(topic.topicId, "agent-1", "I changed my mind")).toThrow(
      /cannot refute their own topic/,
    );

    engine.refuteTopic(topic.topicId, "agent-2", "They catch real regressions");
    expect(engine.getStanding(topic.topicId)?.status).toBe("refuted");

    expect(() => engine.refuteTopic(topic.topicId, "agent-3", "Second thoughts")).toThrow(
      /Cannot refute refuted topic/,
    );
  });
});
