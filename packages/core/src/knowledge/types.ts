/**
 * Findings & knowledge graph — the record of what agents LEARNED about a project.
 *
 * Why this exists: an agent session's conclusions die with its context window. A finding is
 * the durable unit — one claim about the codebase (a defect, a decision, a pattern), with its
 * evidence and provenance attached — and the FindingsGraph is where many agents' findings
 * accumulate, deduplicate, supersede one another, and stay queryable by whoever works next.
 *
 * Design rules:
 * - **Claims, not notes**: every finding names its subject (paths/modules/symbols) and carries
 *   evidence with a tier, so a later reader can re-verify instead of trusting.
 * - **Merge, never fork**: two agents reporting the same claim produce ONE finding (see
 *   `fingerprint` in findings-graph.ts) with both agents in `sources`.
 * - **Supersession over deletion**: a refuted or outdated claim is marked and linked to the
 *   claim that replaced it. The graph keeps its history; nothing is silently rewritten.
 * - **Local-first**: the engine is pure in-memory state with a JSON snapshot format, exactly
 *   like WikiEngine — the server persists the snapshot per project, no network anywhere.
 */

/** What kind of claim a finding makes. */
export type FindingKind = "defect" | "insight" | "decision" | "pattern" | "metric" | "hypothesis";

/** Lifecycle of a claim. `superseded` keeps history; `refuted` keeps the falsification. */
export type FindingStatus = "open" | "confirmed" | "refuted" | "superseded";

/** How sure the reporter is. Merging two reports keeps the higher of the two. */
export type FindingConfidence = "low" | "medium" | "high";

/** Impact of the claim if true. Merging keeps the higher of the two. */
export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

/**
 * Strength of one piece of evidence, deliberately mirroring an audit's evidence ladder:
 * runtime proof beats source reading beats history beats documentation beats hearsay.
 */
export type EvidenceTier = "runtime" | "implementation" | "history" | "documentation" | "anecdote";

/** One piece of backing evidence. `path` is workspace-relative so snapshots stay portable. */
export interface FindingEvidence {
  /** Workspace-relative file path (or a stable external identifier such as a URL). */
  path?: string;
  line?: number;
  /** Short quoted snippet — enough to re-find the claim, not a pasted file. */
  quote?: string;
  tier: EvidenceTier;
  note?: string;
}

/** Who reported the finding. Filled from ToolExecutionContext.attribution, never model claims. */
export interface FindingSource {
  agentId?: string;
  sessionId?: string;
  /** Free-form origin label, e.g. "cluster-C absorption report". */
  report?: string;
  at?: number;
}

/** One durable claim about the project. */
export interface Finding {
  /** Deterministic id (slug + fingerprint hash): re-reporting the same claim lands on it. */
  id: string;
  kind: FindingKind;
  title: string;
  body: string;
  status: FindingStatus;
  confidence: FindingConfidence;
  severity: FindingSeverity;
  /** What the claim is about: file paths, module names, symbols. Empty = project-level. */
  subjects: string[];
  evidence: FindingEvidence[];
  tags: string[];
  /** Every reporter of this claim, oldest first. */
  sources: FindingSource[];
  /** Ids of related findings (`relates` links, symmetric). */
  related: string[];
  /** Set when status is `superseded`: the finding that replaced this one. */
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
}

/** What a report hands to the graph. `title` is the only hard requirement. */
export interface ReportFindingInput {
  title: string;
  kind?: FindingKind;
  body?: string;
  confidence?: FindingConfidence;
  severity?: FindingSeverity;
  subjects?: readonly string[];
  evidence?: readonly FindingEvidence[];
  tags?: readonly string[];
  source?: FindingSource;
}

/** Result of reporting: `merged` true means an existing finding absorbed this report. */
export interface ReportFindingResult {
  finding: Finding;
  merged: boolean;
}

/** Query filter. All fields optional; `text` matches title/body/tags case-insensitively. */
export interface FindingQuery {
  text?: string;
  kind?: FindingKind;
  /** Default: every status except `refuted` and `superseded` (pass one to override). */
  status?: FindingStatus;
  /** Subject match: exact or path-prefix (a directory query reaches its files). */
  subject?: string;
  tag?: string;
  /** Every requested tag must be present. */
  tags?: readonly string[];
  limit?: number;
}

/** One event in the findings log. `seq` is monotonic within one graph instance. */
export interface FindingEvent {
  seq: number;
  type: "ingest" | "merge" | "supersede" | "refute" | "update";
  findingId: string;
  at: number;
  note?: string;
}

/** Snapshot wire format (what the server persists per project). */
export interface FindingsGraphSnapshot {
  version: 1;
  findings: Finding[];
  /**
   * The mutation log, so `events` can replay across process boundaries. Optional because the
   * first format shipped without it — a snapshot without events keeps whatever history the
   * importing graph already had.
   */
  events?: FindingEvent[];
}
