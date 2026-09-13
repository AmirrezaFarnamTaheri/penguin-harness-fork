import { describe, expect, it } from "vitest";
import { QuorumConsensusEngine } from "../src/agent/quorum-consensus.js";

describe("QuorumConsensusEngine", () => {
  it("proposes, endorses with grounded evidence, and settles consensus", () => {
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

    const settled = engine.endorseTopic(
      topic.topicId,
      "peer-agent-2",
      "Verified locally: tests pass and pnpm install takes 4s instead of 18s",
    );

    expect(settled.status).toBe("settled");
    expect(settled.settledAt).toBeDefined();
    expect(settled.supporters.length).toBe(2);
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
});
