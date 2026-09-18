/**
 * Evidence grounding for the swarm: does a claim actually rest on something
 * real in the workspace, or is it asserted?
 *
 * Why this exists as a module: the mesh can reach consensus on an artifact
 * that is *wrong* if every voter reasons from the same plausible-sounding
 * assumption — the cascade risk `consensus-voting.ts` detects and the quorum
 * engine's `requireGrounded` policy tries to fence. Detection is not
 * prevention. This module is the verification step: it holds the artifacts
 * the mesh actually produced, and it checks each citation against them.
 *
 * Concretely, an evidence citation is only grounded when ALL of these hold:
 *  - the artifact it names is registered here;
 *  - the line range it names falls inside the artifact's content;
 *  - the excerpt it quotes hashes to the same digest as the content at that
 *    range — so a paraphrase, a stale line number, or a fabricated quote all
 *    fail, and they fail with a specific reason rather than a boolean.
 *
 * Hashing is SHA-256 over the normalized excerpt (trailing whitespace
 * collapsed), which makes the check robust to editor reflow while still
 * rejecting any change to the characters themselves.
 */

import { createHash } from "node:crypto";

export interface GroundedArtifact {
  path: string;
  content: string;
  lines: string[];
  registeredAt: number;
  byteLength: number;
}

export interface EvidenceCitation {
  id: string;
  artifactPath: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface SwarmClaim {
  id: string;
  text: string;
  proposerId: string;
  citations: EvidenceCitation[];
  raisedAt: number;
}

export interface GroundingVerdict {
  claimId: string;
  grounded: boolean;
  /** Fraction of citations that verified, in [0, 1]. */
  citationCoverage: number;
  verified: string[];
  unverified: string[];
  reasons: Array<{ citationId: string; reason: string }>;
}

export interface GroundingSummary {
  totalClaims: number;
  groundedClaims: number;
  groundedFraction: number;
  totalCitations: number;
  verifiedCitations: number;
  artifacts: number;
  /** True when no claim cites anything at all — the whole mesh is asserting. */
  citationFree: boolean;
}

export interface GroundingAgentOptions {
  /** Byte cap on a registered artifact. */
  maxArtifactBytes?: number;
  /** Max citations on one claim before registration is refused. */
  maxCitationsPerClaim?: number;
  /** Coverage at or above which a claim counts as grounded. */
  groundedThreshold?: number;
}

function normalizeExcerpt(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function digest(text: string): string {
  return createHash("sha256").update(normalizeExcerpt(text), "utf8").digest("hex");
}

function lineRange(lines: string[], startLine: number, endLine: number): string | null {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine) return null;
  const start = startLine - 1;
  const end = endLine; // exclusive
  if (end > lines.length) return null;
  return lines.slice(start, end).join("\n");
}

export class GroundingAgent {
  private readonly artifacts = new Map<string, GroundedArtifact>();
  private readonly claims = new Map<string, SwarmClaim>();
  private readonly verdicts = new Map<string, GroundingVerdict>();
  private readonly options: Required<GroundingAgentOptions>;

  constructor(options: GroundingAgentOptions = {}) {
    this.options = {
      maxArtifactBytes: Math.max(1, options.maxArtifactBytes ?? 2 * 1024 * 1024),
      maxCitationsPerClaim: Math.max(1, options.maxCitationsPerClaim ?? 16),
      groundedThreshold: Math.min(1, Math.max(0, options.groundedThreshold ?? 1)),
    };
  }

  public registerArtifact(path: string, content: string): GroundedArtifact {
    const normalized = path.trim().replace(/\\/g, "/");
    if (!normalized) throw new Error("Artifact path cannot be empty");
    if (content.length > this.options.maxArtifactBytes) {
      throw new Error(
        `Artifact '${normalized}' is ${content.length} bytes, over the ${this.options.maxArtifactBytes} grounding limit`,
      );
    }

    const artifact: GroundedArtifact = {
      path: normalized,
      content,
      lines: content.replace(/\r\n/g, "\n").split("\n"),
      registeredAt: Date.now(),
      byteLength: Buffer.byteLength(content, "utf8"),
    };
    this.artifacts.set(normalized, artifact);
    // A re-registration may invalidate previously-verified citations.
    this.verdicts.clear();
    return { ...artifact, lines: [...artifact.lines] };
  }

  public getArtifact(path: string): GroundedArtifact | undefined {
    const artifact = this.artifacts.get(path.trim().replace(/\\/g, "/"));
    return artifact ? { ...artifact, lines: [...artifact.lines] } : undefined;
  }

  public listArtifacts(): GroundedArtifact[] {
    return Array.from(this.artifacts.values()).map((artifact) => ({
      ...artifact,
      lines: [...artifact.lines],
    }));
  }

  public registerClaim(claim: SwarmClaim): SwarmClaim {
    const id = claim.id.trim();
    if (!id) throw new Error("Claim id cannot be empty");
    if (!claim.text.trim()) throw new Error("Claim text cannot be empty");
    if (this.claims.has(id)) {
      throw new Error(`Claim '${id}' is already registered with the grounding agent`);
    }
    if (claim.citations.length > this.options.maxCitationsPerClaim) {
      throw new Error(
        `Claim '${id}' cites ${claim.citations.length} sources, over the ${this.options.maxCitationsPerClaim} limit`,
      );
    }
    const stored: SwarmClaim = {
      ...claim,
      id,
      citations: claim.citations.map((citation) => ({ ...citation })),
    };
    this.claims.set(id, stored);
    return { ...stored, citations: stored.citations.map((citation) => ({ ...citation })) };
  }

  public getClaim(id: string): SwarmClaim | undefined {
    const claim = this.claims.get(id.trim());
    return claim
      ? { ...claim, citations: claim.citations.map((citation) => ({ ...citation })) }
      : undefined;
  }

  /**
   * Verifies every citation of a claim against the registered artifacts.
   * Returns the verdict; grounded iff citation coverage meets the threshold
   * and the claim cites at least one source.
   */
  public assess(claimId: string): GroundingVerdict {
    const claim = this.claims.get(claimId.trim());
    if (!claim) throw new Error(`Cannot ground unknown claim '${claimId}'`);

    const cached = this.verdicts.get(claim.id);
    if (cached) {
      return { ...cached, reasons: cached.reasons.map((reason) => ({ ...reason })) };
    }

    const verified: string[] = [];
    const unverified: string[] = [];
    const reasons: Array<{ citationId: string; reason: string }> = [];

    if (claim.citations.length === 0) {
      reasons.push({
        citationId: "-",
        reason: "claim cites no evidence; an uncited claim cannot be grounded",
      });
    }

    for (const citation of claim.citations) {
      const artifact = this.artifacts.get(citation.artifactPath.trim().replace(/\\/g, "/"));
      if (!artifact) {
        unverified.push(citation.id);
        reasons.push({
          citationId: citation.id,
          reason: `artifact '${citation.artifactPath}' is not registered with the grounding agent`,
        });
        continue;
      }

      const expected = lineRange(artifact.lines, citation.startLine, citation.endLine);
      if (expected === null) {
        unverified.push(citation.id);
        reasons.push({
          citationId: citation.id,
          reason: `line range ${citation.startLine}-${citation.endLine} is outside artifact '${artifact.path}' (${artifact.lines.length} line(s))`,
        });
        continue;
      }

      if (digest(expected) !== digest(citation.excerpt)) {
        unverified.push(citation.id);
        reasons.push({
          citationId: citation.id,
          reason: `excerpt digest does not match '${artifact.path}' at lines ${citation.startLine}-${citation.endLine}; the quote is stale, paraphrased, or fabricated`,
        });
        continue;
      }

      verified.push(citation.id);
    }

    const citationCoverage =
      claim.citations.length > 0 ? verified.length / claim.citations.length : 0;

    const verdict: GroundingVerdict = {
      claimId: claim.id,
      grounded:
        claim.citations.length > 0 &&
        citationCoverage >= this.options.groundedThreshold &&
        verified.length > 0,
      citationCoverage,
      verified: [...verified],
      unverified: [...unverified],
      reasons,
    };
    this.verdicts.set(claim.id, verdict);
    return { ...verdict, reasons: verdict.reasons.map((reason) => ({ ...reason })) };
  }

  /** Bulk assessment: the fraction of a claim set that is actually grounded. */
  public summarize(): GroundingSummary {
    let totalCitations = 0;
    let verifiedCitations = 0;
    let groundedClaims = 0;
    let citedClaims = 0;

    for (const claim of this.claims.values()) {
      const verdict = this.assess(claim.id);
      totalCitations += claim.citations.length;
      verifiedCitations += verdict.verified.length;
      if (claim.citations.length > 0) citedClaims++;
      if (verdict.grounded) groundedClaims++;
    }

    const totalClaims = this.claims.size;
    return {
      totalClaims,
      groundedClaims,
      groundedFraction: totalClaims > 0 ? groundedClaims / totalClaims : 0,
      totalCitations,
      verifiedCitations,
      artifacts: this.artifacts.size,
      citationFree: citedClaims === 0 && totalClaims > 0,
    };
  }

  /**
   * Gate for the consensus layer: a claim set is fit to settle only when the
   * grounded fraction clears `threshold`. Returns the claims that could not
   * be grounded, so the mesh can rework or drop them instead of voting on
   * assertions.
   */
  public ungroundedClaims(threshold = 1): SwarmClaim[] {
    return Array.from(this.claims.values())
      .filter((claim) => {
        const verdict = this.assess(claim.id);
        return !verdict.grounded || verdict.citationCoverage < threshold;
      })
      .map((claim) => ({
        ...claim,
        citations: claim.citations.map((citation) => ({ ...citation })),
      }));
  }
}
