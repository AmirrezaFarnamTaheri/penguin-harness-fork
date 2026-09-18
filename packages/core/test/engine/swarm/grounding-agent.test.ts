import { describe, expect, it } from "vitest";

import {
  GroundingAgent,
  type EvidenceCitation,
} from "../../../src/engine/swarm/grounding-agent.js";

const SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export function subtract(a: number, b: number): number {",
  "  return a - b;",
  "}",
].join("\n");

function citation(
  id: string,
  path: string,
  start: number,
  end: number,
  excerpt: string,
): EvidenceCitation {
  return { id, artifactPath: path, startLine: start, endLine: end, excerpt };
}

describe("GroundingAgent artifact registration", () => {
  it("registers an artifact and normalizes path separators", () => {
    const agent = new GroundingAgent();
    const artifact = agent.registerArtifact("src\\math.ts", SOURCE);
    expect(artifact.path).toBe("src/math.ts");
    expect(agent.getArtifact("src/math.ts")?.lines).toHaveLength(7);
  });

  it("refuses an artifact over the byte limit", () => {
    const agent = new GroundingAgent({ maxArtifactBytes: 10 });
    expect(() => agent.registerArtifact("big.ts", SOURCE)).toThrow(/over the .* grounding limit/);
  });

  it("re-registration clears cached verdicts", () => {
    const agent = new GroundingAgent();
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "c1",
      text: "add returns the sum",
      proposerId: "reviewer",
      citations: [
        citation(
          "e1",
          "src/math.ts",
          1,
          3,
          "export function add(a: number, b: number): number {\n  return a + b;\n}",
        ),
      ],
      raisedAt: Date.now(),
    });
    expect(agent.assess("c1").grounded).toBe(true);

    agent.registerArtifact("src/math.ts", SOURCE.replace("a + b", "a * b"));
    const recheck = agent.assess("c1");
    // The cached verdict was invalidated by the re-registration.
    expect(recheck.grounded).toBe(false);
  });
});

describe("GroundingAgent citation verification", () => {
  it("verifies a citation whose excerpt matches the artifact exactly", () => {
    const agent = new GroundingAgent();
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "ok",
      text: "add returns the sum of its inputs",
      proposerId: "reviewer",
      citations: [
        citation(
          "e1",
          "src/math.ts",
          1,
          3,
          "export function add(a: number, b: number): number {\n  return a + b;\n}",
        ),
      ],
      raisedAt: Date.now(),
    });
    const verdict = agent.assess("ok");
    expect(verdict.grounded).toBe(true);
    expect(verdict.citationCoverage).toBe(1);
    expect(verdict.unverified).toHaveLength(0);
  });

  it("rejects a paraphrased excerpt", () => {
    const agent = new GroundingAgent();
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "paraphrase",
      text: "add returns the sum",
      proposerId: "reviewer",
      citations: [citation("e1", "src/math.ts", 1, 3, "function add(a, b) returns a plus b")],
      raisedAt: Date.now(),
    });
    const verdict = agent.assess("paraphrase");
    expect(verdict.grounded).toBe(false);
    expect(verdict.unverified).toEqual(["e1"]);
    expect(verdict.reasons[0]?.reason).toMatch(/digest does not match/);
  });

  it("rejects a line range outside the artifact", () => {
    const agent = new GroundingAgent();
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "oor",
      text: "something",
      proposerId: "reviewer",
      citations: [citation("e1", "src/math.ts", 5, 99, "anything")],
      raisedAt: Date.now(),
    });
    const verdict = agent.assess("oor");
    expect(verdict.grounded).toBe(false);
    expect(verdict.reasons[0]?.reason).toMatch(/outside artifact/);
  });

  it("rejects a citation of an unregistered artifact", () => {
    const agent = new GroundingAgent();
    agent.registerClaim({
      id: "missing",
      text: "something",
      proposerId: "reviewer",
      citations: [citation("e1", "src/ghost.ts", 1, 2, "x")],
      raisedAt: Date.now(),
    });
    const verdict = agent.assess("missing");
    expect(verdict.grounded).toBe(false);
    expect(verdict.reasons[0]?.reason).toMatch(/not registered/);
  });

  it("rejects an uncited claim outright", () => {
    const agent = new GroundingAgent();
    agent.registerClaim({
      id: "uncited",
      text: "the patch is correct",
      proposerId: "reviewer",
      citations: [],
      raisedAt: Date.now(),
    });
    const verdict = agent.assess("uncited");
    expect(verdict.grounded).toBe(false);
    expect(verdict.citationCoverage).toBe(0);
  });

  it("is robust to trailing whitespace in the excerpt", () => {
    const agent = new GroundingAgent();
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "ws",
      text: "add returns the sum",
      proposerId: "reviewer",
      citations: [
        // The excerpt must quote every line in the cited 1-3 range, including
        // the closing brace; only its trailing whitespace may differ.
        citation(
          "e1",
          "src/math.ts",
          1,
          3,
          "export function add(a: number, b: number): number {   \n  return a + b;\t\n}   \n",
        ),
      ],
      raisedAt: Date.now(),
    });
    expect(agent.assess("ws").grounded).toBe(true);
  });

  it("reports partial coverage when some citations fail", () => {
    const agent = new GroundingAgent({ groundedThreshold: 0.5 });
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "partial",
      text: "both functions behave",
      proposerId: "reviewer",
      citations: [
        citation(
          "good",
          "src/math.ts",
          1,
          3,
          "export function add(a: number, b: number): number {\n  return a + b;\n}",
        ),
        citation("bad", "src/math.ts", 5, 7, "wrong text"),
      ],
      raisedAt: Date.now(),
    });
    const verdict = agent.assess("partial");
    expect(verdict.citationCoverage).toBeCloseTo(0.5, 5);
    expect(verdict.grounded).toBe(true);
  });
});

describe("GroundingAgent summary and gates", () => {
  it("summarizes grounded fraction across the claim set", () => {
    const agent = new GroundingAgent();
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "good",
      text: "add returns the sum",
      proposerId: "r",
      citations: [
        citation(
          "e1",
          "src/math.ts",
          1,
          3,
          "export function add(a: number, b: number): number {\n  return a + b;\n}",
        ),
      ],
      raisedAt: Date.now(),
    });
    agent.registerClaim({
      id: "bad",
      text: "uncited assertion",
      proposerId: "r",
      citations: [],
      raisedAt: Date.now(),
    });

    const summary = agent.summarize();
    expect(summary.totalClaims).toBe(2);
    expect(summary.groundedClaims).toBe(1);
    expect(summary.groundedFraction).toBeCloseTo(0.5, 5);
    expect(summary.verifiedCitations).toBe(1);
    expect(summary.citationFree).toBe(false);
  });

  it("flags a claim set as citation-free when nothing cites anything", () => {
    const agent = new GroundingAgent();
    agent.registerClaim({
      id: "a",
      text: "x",
      proposerId: "r",
      citations: [],
      raisedAt: Date.now(),
    });
    agent.registerClaim({
      id: "b",
      text: "y",
      proposerId: "r",
      citations: [],
      raisedAt: Date.now(),
    });
    expect(agent.summarize().citationFree).toBe(true);
  });

  it("lists the claims a threshold gate would reject", () => {
    const agent = new GroundingAgent();
    agent.registerArtifact("src/math.ts", SOURCE);
    agent.registerClaim({
      id: "good",
      text: "add returns the sum",
      proposerId: "r",
      citations: [
        citation(
          "e1",
          "src/math.ts",
          1,
          3,
          "export function add(a: number, b: number): number {\n  return a + b;\n}",
        ),
      ],
      raisedAt: Date.now(),
    });
    agent.registerClaim({
      id: "bad",
      text: "y",
      proposerId: "r",
      citations: [],
      raisedAt: Date.now(),
    });

    const ungrounded = agent.ungroundedClaims(1);
    expect(ungrounded.map((claim) => claim.id)).toEqual(["bad"]);
  });

  it("refuses duplicate claim ids and empty text", () => {
    const agent = new GroundingAgent();
    agent.registerClaim({
      id: "c",
      text: "x",
      proposerId: "r",
      citations: [],
      raisedAt: Date.now(),
    });
    expect(() =>
      agent.registerClaim({
        id: "c",
        text: "x",
        proposerId: "r",
        citations: [],
        raisedAt: Date.now(),
      }),
    ).toThrow(/already registered/);
    expect(() =>
      agent.registerClaim({
        id: "d",
        text: "",
        proposerId: "r",
        citations: [],
        raisedAt: Date.now(),
      }),
    ).toThrow(/cannot be empty/);
  });

  it("refuses a claim citing more than the citation limit", () => {
    const agent = new GroundingAgent({ maxCitationsPerClaim: 2 });
    expect(() =>
      agent.registerClaim({
        id: "c",
        text: "x",
        proposerId: "r",
        citations: [
          citation("a", "p", 1, 1, "x"),
          citation("b", "p", 1, 1, "x"),
          citation("c", "p", 1, 1, "x"),
        ],
        raisedAt: Date.now(),
      }),
    ).toThrow(/over the .* limit/);
  });

  it("throws on assessing an unknown claim", () => {
    const agent = new GroundingAgent();
    expect(() => agent.assess("nope")).toThrow(/unknown claim/);
  });
});
