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
 * - **Merge live claims**: two agents reporting the same live claim produce ONE finding
 *   with both agents in `sources`. Refuted claims receive linked, deterministic revisions.
 * - **Supersession over deletion**: a refuted or outdated claim is marked and linked to the
 *   claim that replaced it. Live findings and event history are bounded collections.
 * - **Local-first**: the engine is pure in-memory state with a JSON snapshot format, exactly
 *   like WikiEngine — the server persists the snapshot per project, no network anywhere.
 */

/** What kind of claim a finding makes. */
export const FINDING_KINDS = [
  "defect",
  "insight",
  "decision",
  "pattern",
  "metric",
  "hypothesis",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Lifecycle of a claim. `superseded` keeps history; `refuted` keeps the falsification. */
export const FINDING_STATUSES = ["open", "confirmed", "refuted", "superseded"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** How sure the reporter is. Merging two reports keeps the higher of the two. */
export const FINDING_CONFIDENCE = ["low", "medium", "high"] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCE)[number];

/** Impact of the claim if true. Merging keeps the higher of the two. */
export const FINDING_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * Strength of one piece of evidence, deliberately mirroring an audit's evidence ladder:
 * runtime proof beats source reading beats history beats documentation beats hearsay.
 */
export const EVIDENCE_TIERS = [
  "runtime",
  "implementation",
  "history",
  "documentation",
  "anecdote",
] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

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
  /** Host-attested actor that first created the claim; absent only in legacy snapshots. */
  createdBy?: FindingActor;
  /** Ids of related findings (`relates` links, symmetric). */
  related: string[];
  /** Symmetric contradiction links, including a new report of a refuted claim. */
  contradicts?: string[];
  /** Set when status is `superseded`: the finding that replaced this one. */
  supersededBy?: string;
  /** Replacement retained as a tombstone after its live record is archived. */
  supersededByArchived?: string;
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
export interface FindingActor {
  kind: "user" | "agent" | "system" | "unknown";
  id: string;
}

/** Host-supplied mutation metadata; never populated from model or request-body identities. */
export interface FindingMutationContext {
  actor?: FindingActor;
  method?: "tool" | "route" | "engine";
  /** Only an authenticated human may bypass the confirmation evidence gate. */
  override?: boolean;
}

export type FindingAuthoredBy = "agent" | "user" | "system" | "legacy-unknown";

/** Read projection. Reporter labels in sources remain separate from attested authorship. */
export interface FindingReadback extends Omit<Finding, "createdBy"> {
  authoredBy: FindingAuthoredBy;
  author: FindingActor;
  evidenceTiers: EvidenceTier[];
}

export type FindingsPageAction = "query" | "snapshot" | "events" | "archive" | "recall";
export interface FindingsPageEnvelope {
  version: 2;
  action: FindingsPageAction;
  items: unknown[];
  scopeRevision: string;
  latestSequence: number;
  nextCursor: string | null;
  truncated: boolean;
  omittedCount: number;
  highWater: boolean;
  error?: {
    code: string;
    message: string;
    restart: boolean;
    earliestSequence?: number;
    latestSequence?: number;
  };
}

export interface FindingEvent {
  seq: number;
  type: "ingest" | "merge" | "supersede" | "refute" | "reopen" | "update";
  findingId: string;
  at: number;
  note?: string;
  /** Optional only for snapshots created before actor attribution was introduced. */
  actor?: FindingActor;
  method?: "tool" | "route" | "engine";
  override?: true;
}

/** Version-1 snapshot wire format shared by the workspace tool and project routes. */
export interface FindingsGraphSnapshot {
  version: 1;
  findings: Finding[];
  /**
   * The mutation log, so `events` can replay across process boundaries. Optional because the
   * first format shipped without it — a snapshot without events keeps whatever history the
   * importing graph already had.
   */
  events?: FindingEvent[];
  /** Finite eviction history committed atomically with the live graph. */
  archive?: FindingArchiveEntry[];
}

export interface FindingArchiveEntry {
  operationId: string;
  archivedAt: number;
  finding: Finding;
}
