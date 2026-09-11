import { describe, expect, it } from "vitest";
import { QuorumConsensusEngine } from "../src/agent/quorum-consensus.js";

describe("QuorumConsensusEngine", () => {
  it("proposes, endorses with grounded evidence, and settles consensus", () => {
    const engine = new QuorumConsensusEngine({ threshold: 2, requireGrounded: true });

    // Propose topic with evidence
    const topic = engine.proposeTopic({
      topic: "Adopt Bun for Fast Package Installs",
      proposerId: "architect-1",
      initialGrounds: "Benchmark shows 3x speedup in CI build timings (see benchmarks/ci.log)",
    });

    expect(topic.status).toBe("debating");
    expect(topic.supporters.length).toBe(1);

    // Attempt endorsement without grounds should fail
    expect(() => engine.endorseTopic(topic.topicId, "peer-agent-2", "")).toThrow(/explicit grounds/);

    // Valid endorsement with grounds
    const settled = engine.endorseTopic(
      topic.topicId,
      "peer-agent-2",
      "Verified locally: tests pass and pnpm install takes 4s instead of 18s"
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

    // Refutation
    const refuted = engine.refuteTopic(
      topic.topicId,
      "security-lead",
      "Violates repository rule: strict null checks prevent runtime undefined crashes"
    );

    expect(refuted.status).toBe("refuted");
    expect(refuted.refutedAt).toBeDefined();

    // Cannot endorse refuted topic
    expect(() => engine.endorseTopic(topic.topicId, "dev-3", "valid reason")).toThrow(/Cannot endorse refuted topic/);
  });
});
