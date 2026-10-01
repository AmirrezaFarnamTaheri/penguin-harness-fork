/**
 * FindingsGraph — the durable knowledge plane agents report findings into.
 *
 * Sources for this design (read before changing it):
 * - The unified absorption report's recommended schema (agentmemory + ruflo + dirac patterns):
 *   content-addressed ids first line of dedupe, Jaccard as the second, supersession chains,
 *   decay applied at READ time, replace-by-source accounting, never-delete demotion.
 * - `knowledge/types.ts` for the wire shapes this module stores.
 *
 * Invariants:
 * 1. **One claim, many reporters.** `report()` merges by id first (re-reporting the same claim
 *    lands on the same finding) and by Jaccard title+body similarity second (two wordings of
 *    one claim collapse); near-misses below the threshold are linked, never merged.
 * 2. **Terminal claims retain their lifecycle.** Re-reporting a refuted claim creates a
 *    contradiction revision; superseded claims cannot be reopened. Live findings, the event
 *    log, and the exportable eviction archive are bounded; filesystem durability belongs to
 *    the store that commits snapshots.
 * 3. **Strength is a read-only display score.** `strength(finding, now)` combines a
 *    confidence-weighted base decayed since `updatedAt` with an additive term decayed by age
 *    since `createdAt`. That second term is a creation-age heuristic, not access tracking. The
 *    score does not control query order or eviction, and storing it would rewrite history.
 * 4. **Accounting is replace-by-source.** Each reporter's evidence and note are kept under its
 *    own source slot; a second report from the same source replaces it instead of appending.
 * 5. **Every mutation appends to the event log** (bounded), so a consumer can ask "what
 *    changed since seq N" — the findings plane's own replay story.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  FINDING_KINDS,
  FINDING_STATUSES,
  FINDING_CONFIDENCE,
  FINDING_SEVERITIES,
  EVIDENCE_TIERS,
  type Finding,
  type FindingArchiveEntry,
  type FindingConfidence,
  type FindingEvidence,
  type FindingEvent,
  type FindingKind,
  type FindingMutationContext,
  type FindingQuery,
  type FindingReadback,
  type FindingSeverity,
  type FindingSource,
  type FindingStatus,
  type FindingsGraphSnapshot,
  type ReportFindingInput,
  type ReportFindingResult,
} from "./types.js";

export type { FindingEvent } from "./types.js";

interface InternalFinding extends Finding {
  /** Per-source notes, replace-by-source (keyed by agentId|sessionId|report). */
  sourceNotes: Record<string, string>;
}

export interface FindingsGraphOptions {
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Exponential decay rate per day (agentmemory used 0.01). */
  decayPerDay?: number;
  /** Weight of the legacy-named creation-age additive term in strength() (default 0.3). */
  accessReinforcement?: number;
  /** Jaccard threshold above which two reports are the same claim (agentmemory: 0.7). */
  mergeJaccard?: number;
  /** Jaccard threshold above which two findings are linked as related (agentmemory: 0.4). */
  relateJaccard?: number;
  /** Event log bound. */
  maxEvents?: number;
  /** Finding bound; refuted, superseded, open, then confirmed, oldest within each status. */
  maxFindings?: number;
  maxArchiveEntries?: number;
  maxArchiveBytes?: number;
  maxArchiveAgeMs?: number;
}

const DEFAULTS = {
  decayPerDay: 0.01,
  accessReinforcement: 0.3,
  mergeJaccard: 0.7,
  relateJaccard: 0.4,
  maxEvents: 2000,
  maxFindings: 5000,
  maxArchiveEntries: 1000,
  maxArchiveBytes: 4 * 1024 * 1024,
  maxArchiveAgeMs: 90 * 24 * 60 * 60 * 1000,
};

const CONFIDENCE_WEIGHT: Record<FindingConfidence, number> = { low: 0.5, medium: 0.75, high: 1 };
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  info: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1,
};
const STATUS_RANK: Record<FindingStatus, number> = {
  confirmed: 3,
  open: 2,
  superseded: 1,
  refuted: 0,
};
export class UnknownFindingError extends Error {
  constructor(readonly findingId: string) {
    super(`Unknown finding: ${findingId}`);
    this.name = "UnknownFindingError";
  }
}

export class FindingsArchiveCapacityError extends Error {
  constructor() {
    super("The finding cannot be archived within the configured retention limits.");
    this.name = "FindingsArchiveCapacityError";
  }
}

/** Expected lifecycle rejection; programming and persistence errors retain their own types. */
export class LifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 409,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export class SupersessionError extends LifecycleError {
  constructor(
    readonly code:
      | "replacement_not_live"
      | "supersession_cycle"
      | "supersession_depth"
      | "supersession_missing_target",
    message: string,
  ) {
    super(message);
    this.name = "SupersessionError";
  }
}

/** Same-state operations are rejected too: every accepted transition changes lifecycle. */
export function canTransition(from: FindingStatus, to: FindingStatus): boolean {
  return (
    (from === "open" && (to === "confirmed" || to === "refuted" || to === "superseded")) ||
    (from === "confirmed" && (to === "refuted" || to === "superseded"))
  );
}

function cloneEvent(event: FindingEvent): FindingEvent {
  return { ...event, actor: event.actor ? { ...event.actor } : { kind: "unknown", id: "unknown" } };
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "finding"
  );
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Word set over CJK-aware tokens: latin words plus CJK bigrams (agentmemory's approach). */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const runs = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const run of runs) {
    if (/^[\u4e00-\u9fff]+$/.test(run)) {
      if (run.length === 1) out.add(run);
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    } else {
      out.add(run);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

function evidenceKey(e: FindingEvidence): string {
  return JSON.stringify([e.tier, e.path, e.line, e.quote, e.note]);
}

function sourceKey(s: FindingSource): string {
  // The reporter's identity — NOT its report label. A second report from the same
  // agent/session replaces the first (replace-by-source); a different label is the same
  // reporter updating its account, not a new witness.
  return `${s.agentId ?? "-"}|${s.sessionId ?? "-"}`;
}

function unionSorted(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

/**
 * The findings knowledge graph. In-memory; persistence is a JSON snapshot
 * (`exportSnapshot`/`importSnapshot`) the server stores per project, mirroring WikiEngine.
 */
export class FindingsGraph {
  private readonly findings = new Map<string, InternalFinding>();
  private archive = new Map<string, FindingArchiveEntry>();
  private readonly events: FindingEvent[] = [];
  private seq = 0;
  private readonly now: () => number;
  private readonly decayPerDay: number;
  private readonly accessReinforcement: number;
  private readonly mergeJaccard: number;
  private readonly relateJaccard: number;
  private readonly maxEvents: number;
  private readonly maxFindings: number;
  private readonly maxArchiveEntries: number;
  private readonly maxArchiveBytes: number;
  private readonly maxArchiveAgeMs: number;

  constructor(options: FindingsGraphOptions = {}) {
    this.now = options.now ?? Date.now;
    this.decayPerDay = options.decayPerDay ?? DEFAULTS.decayPerDay;
    this.accessReinforcement = options.accessReinforcement ?? DEFAULTS.accessReinforcement;
    this.mergeJaccard = options.mergeJaccard ?? DEFAULTS.mergeJaccard;
    this.relateJaccard = options.relateJaccard ?? DEFAULTS.relateJaccard;
    this.maxEvents = options.maxEvents ?? DEFAULTS.maxEvents;
    this.maxFindings = options.maxFindings ?? DEFAULTS.maxFindings;
    this.maxArchiveEntries = options.maxArchiveEntries ?? DEFAULTS.maxArchiveEntries;
    this.maxArchiveBytes = options.maxArchiveBytes ?? DEFAULTS.maxArchiveBytes;
    this.maxArchiveAgeMs = options.maxArchiveAgeMs ?? DEFAULTS.maxArchiveAgeMs;
    if (
      ![
        this.maxEvents,
        this.maxFindings,
        this.maxArchiveEntries,
        this.maxArchiveBytes,
        this.maxArchiveAgeMs,
      ].every((value) => Number.isSafeInteger(value) && value > 0)
    ) {
      throw new RangeError("Findings and archive limits must be positive safe integers.");
    }
  }

  /** Deterministic id for a claim: slug of the title + a fingerprint of its normalized text. */
  private makeId(title: string, body: string): string {
    const fingerprint = fnv1a(`${title.trim().toLowerCase()}\u0000${body.trim().toLowerCase()}`);
    return `${slugify(title)}-${fingerprint}`;
  }

  private pushEvent(
    type: FindingEvent["type"],
    findingId: string,
    note?: string,
    context: FindingMutationContext = {},
  ): void {
    this.events.push({
      seq: ++this.seq,
      type,
      findingId,
      at: this.now(),
      note,
      actor: context.actor ? { ...context.actor } : { kind: "unknown", id: "unknown" },
      method: context.method ?? "engine",
      ...(context.override === true ? { override: true as const } : {}),
    });
    while (this.events.length > this.maxEvents) this.events.shift();
  }

  /**
   * Report a finding. Merges into an existing claim when one matches (same id, exact title, or
   * Jaccard at or above `mergeJaccard` over title+body); otherwise creates one and links near-misses.
   */
  report(input: ReportFindingInput, context: FindingMutationContext = {}): ReportFindingResult {
    const title = input.title.trim();
    if (title === "") throw new Error("Finding title must not be empty.");
    const body = (input.body ?? "").trim();
    const now = this.now();

    // Line 1 of dedupe: the deterministic id. Re-reporting the same claim lands here.
    let id = this.makeId(title, body);
    const existing = this.findings.get(id);
    let contradicted: InternalFinding | undefined;
    if (existing?.status === "superseded") return { finding: this.clone(existing), merged: true };
    if (existing?.status === "refuted") contradicted = existing;
    else if (existing)
      return { finding: this.mergeInto(existing, input, now, context), merged: true };

    // Line 2: wording-level duplicate of an existing claim.
    const claimed = tokens(`${title} ${body}`);
    let best: { finding: InternalFinding; score: number } | null = null;
    for (const candidate of this.findings.values()) {
      if (contradicted) break;
      if (candidate.status === "superseded") {
        if (candidate.title.trim().toLowerCase() === title.toLowerCase())
          return { finding: this.clone(candidate), merged: true };
        continue;
      }
      if (candidate.title.trim().toLowerCase() === title.toLowerCase()) {
        if (candidate.status === "refuted") {
          contradicted = candidate;
          break;
        }
        return { finding: this.mergeInto(candidate, input, now, context), merged: true };
      }
      const score = jaccard(claimed, tokens(`${candidate.title} ${candidate.body}`));
      if (score >= this.mergeJaccard && (best === null || score > best.score)) {
        best = { finding: candidate, score };
      }
    }
    if (!contradicted && best?.finding.status === "refuted") contradicted = best.finding;
    if (!contradicted && best)
      return { finding: this.mergeInto(best.finding, input, now, context), merged: true };

    if (contradicted) {
      const identity = JSON.stringify([
        contradicted.id,
        title.toLowerCase(),
        body.toLowerCase(),
        input.kind ?? "insight",
        [...new Set((input.subjects ?? []).map((s) => s.trim()))].sort(),
        [...new Set((input.evidence ?? []).map(evidenceKey))].sort(),
      ]);
      id = `${slugify(title)}-revision-${createHash("sha256").update(identity).digest("hex")}`;
      const revision = this.findings.get(id);
      // A replay never mutates the original falsification or a terminal revision.
      if (revision)
        return {
          finding:
            revision.status === "refuted" || revision.status === "superseded"
              ? this.clone(revision)
              : this.mergeInto(revision, input, now, context),
          merged: true,
        };
    }

    const finding: InternalFinding = {
      id,
      kind: input.kind ?? "insight",
      title,
      body,
      status: "open",
      confidence: input.confidence ?? "medium",
      severity: input.severity ?? "info",
      subjects: unionSorted(
        [],
        (input.subjects ?? []).map((s) => s.trim()).filter((s) => s !== ""),
      ),
      evidence: (input.evidence ?? []).map((e) => ({ ...e })),
      tags: unionSorted(
        [],
        (input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ""),
      ),
      sources: input.source ? [{ ...input.source, at: input.source.at ?? now }] : [],
      ...(context.actor ? { createdBy: { ...context.actor } } : {}),
      related: [],
      ...(contradicted ? { contradicts: [contradicted.id] } : {}),
      createdAt: now,
      updatedAt: now,
      sourceNotes: {},
    };
    if (input.source) finding.sourceNotes[sourceKey(input.source)] = input.source.report ?? "";
    const relatedTargets = new Set<string>();
    if (contradicted) {
      finding.related = [contradicted.id];
      relatedTargets.add(contradicted.id);
    }

    // Near-misses become `related` links (symmetric), never merges.
    for (const candidate of this.findings.values()) {
      if (candidate.id === id || candidate.status === "superseded") continue;
      const score = jaccard(claimed, tokens(`${candidate.title} ${candidate.body}`));
      if (score >= this.relateJaccard) {
        finding.related = unionSorted(finding.related, [candidate.id]);
        relatedTargets.add(candidate.id);
      }
    }

    // Check archive capacity before touching the graph. An oversized victim must not leave
    // behind a partially inserted finding or prune links when the archive cannot accept it.
    const evictionPlan = this.planEvictions(finding, [...relatedTargets], contradicted?.id);
    this.archive = evictionPlan.archive;
    for (const candidate of this.findings.values()) {
      if (candidate.supersededByArchived === id) {
        delete candidate.supersededByArchived;
        candidate.supersededBy = id;
      }
      if (relatedTargets.has(candidate.id))
        candidate.related = unionSorted(candidate.related, [id]);
    }
    if (contradicted) {
      contradicted.contradicts = unionSorted(contradicted.contradicts ?? [], [id]);
      contradicted.related = unionSorted(contradicted.related, [id]);
    }
    this.findings.set(id, finding);
    this.pushEvent("ingest", id, undefined, context);
    this.applyEvictionPlan(evictionPlan);
    return { finding: this.clone(finding), merged: false };
  }

  /** Absorb one more report into an existing claim (evidence union, source accounting). */
  private mergeInto(
    target: InternalFinding,
    input: ReportFindingInput,
    now: number,
    context: FindingMutationContext,
  ): Finding {
    const evidenceKeys = new Set(target.evidence.map(evidenceKey));
    for (const e of input.evidence ?? []) {
      const key = evidenceKey(e);
      if (!evidenceKeys.has(key)) {
        target.evidence.push({ ...e });
        evidenceKeys.add(key);
      }
    }
    target.subjects = unionSorted(target.subjects, input.subjects ?? []);
    target.tags = unionSorted(
      target.tags,
      (input.tags ?? []).map((t) => t.trim().toLowerCase()),
    );
    if (input.body && input.body.length > target.body.length) target.body = input.body.trim();
    // Confidence/severity merge upward: a stronger report never weakens the claim.
    if (
      input.confidence &&
      CONFIDENCE_WEIGHT[input.confidence] > CONFIDENCE_WEIGHT[target.confidence]
    )
      target.confidence = input.confidence;
    if (input.severity && SEVERITY_WEIGHT[input.severity] > SEVERITY_WEIGHT[target.severity])
      target.severity = input.severity;
    if (input.kind && target.kind === "insight") target.kind = input.kind;
    if (input.source) {
      const key = sourceKey(input.source);
      const existing = target.sources.find((s) => sourceKey(s) === key);
      if (existing) {
        // Replace-by-source: the same reporter's later account supersedes its earlier one.
        existing.at = input.source.at ?? now;
        existing.report = input.source.report ?? existing.report;
      } else {
        target.sources.push({ ...input.source, at: input.source.at ?? now });
      }
      target.sourceNotes[key] = input.source.report ?? target.sourceNotes[key] ?? "";
    }
    target.updatedAt = now;
    this.pushEvent("merge", target.id, undefined, context);
    return this.clone(target);
  }

  /** Confirm a claim (an agent verified it). */
  confirm(id: string, note?: string, context: FindingMutationContext = {}): Finding {
    const finding = this.require(id);
    this.requireTransition(finding, "confirmed");
    if (context.override === true) {
      if (
        context.actor?.kind !== "user" ||
        !context.actor.id.trim() ||
        context.method === "tool" ||
        !note?.trim()
      ) {
        throw new LifecycleError(
          "Confirmation override requires an authenticated user and a non-empty reason.",
          400,
        );
      }
    } else if (!finding.evidence.some((e) => e.tier === "runtime" || e.tier === "implementation")) {
      throw new LifecycleError(
        "Confirmation requires runtime or implementation evidence, or an authenticated human override with a reason.",
      );
    }
    finding.status = "confirmed";
    finding.updatedAt = this.now();
    this.pushEvent("update", id, note, context);
    return this.clone(finding);
  }

  /** Refute a claim. Kept in the graph — the falsification is knowledge too. */
  refute(id: string, note?: string, context: FindingMutationContext = {}): Finding {
    const finding = this.require(id);
    this.requireTransition(finding, "refuted");
    finding.status = "refuted";
    finding.updatedAt = this.now();
    this.pushEvent("refute", id, note, context);
    return this.clone(finding);
  }

  /** Supersede `id` with a replacement claim (usually freshly reported). */
  supersede(
    id: string,
    replacementId: string,
    note?: string,
    context: FindingMutationContext = {},
  ): Finding {
    const finding = this.require(id);
    const replacement = this.require(replacementId);
    if (id === replacementId) throw new LifecycleError("A finding cannot supersede itself.", 400);
    this.requireTransition(finding, "superseded");
    this.validateSupersessionChain(finding.id);
    this.validateSupersessionChain(replacementId, id);
    if (replacement.status !== "open" && replacement.status !== "confirmed") {
      throw new SupersessionError(
        "replacement_not_live",
        "A replacement finding must be open or confirmed.",
      );
    }
    finding.status = "superseded";
    finding.supersededBy = replacementId;
    finding.updatedAt = this.now();
    replacement.related = unionSorted(replacement.related, [id]);
    finding.related = unionSorted(finding.related, [replacementId]);
    this.pushEvent("supersede", id, note ?? replacementId, context);
    return this.clone(finding);
  }

  /** Reopening is a separate host-authorized human action; superseded claims stay terminal. */
  reopen(id: string, note: string, context: FindingMutationContext): Finding {
    const finding = this.require(id);
    if (
      context.actor?.kind !== "user" ||
      !context.actor.id.trim() ||
      context.method === "tool" ||
      !note.trim()
    ) {
      throw new LifecycleError(
        "Reopening requires an authenticated user and a non-empty reason.",
        400,
      );
    }
    if (finding.status !== "refuted")
      throw new LifecycleError("Only a refuted finding can be reopened.");
    finding.status = "open";
    finding.updatedAt = this.now();
    this.pushEvent("reopen", id, note, context);
    return this.clone(finding);
  }

  private validateSupersessionChain(startId: string, forbiddenId?: string): void {
    const visited = new Set<string>();
    let currentId: string | undefined = startId;
    let hops = 0;
    while (currentId !== undefined) {
      if (currentId === forbiddenId || visited.has(currentId)) {
        throw new SupersessionError("supersession_cycle", "Supersession chain contains a cycle.");
      }
      visited.add(currentId);
      const current = this.findings.get(currentId);
      if (!current)
        throw new SupersessionError(
          "supersession_missing_target",
          "Supersession chain references a missing finding.",
        );
      currentId = current.supersededBy;
      if (currentId !== undefined && ++hops > 64) {
        throw new SupersessionError("supersession_depth", "Supersession chain exceeds 64 hops.");
      }
    }
  }

  /** Add a symmetric relation between two findings. */
  link(aId: string, bId: string, context: FindingMutationContext = {}): void {
    const a = this.require(aId);
    const b = this.require(bId);
    a.related = unionSorted(a.related, [bId]);
    b.related = unionSorted(b.related, [aId]);
    this.pushEvent("update", aId, `link:${bId}`, context);
  }

  get(id: string): Finding | null {
    const finding = this.findings.get(id);
    return finding ? this.clone(finding) : null;
  }

  /** Prefer persisted host-attested authorship; use the ingest event for older snapshots. */
  readback(id: string): FindingReadback {
    const finding = this.clone(this.require(id));
    const { createdBy, ...readableFinding } = finding;
    const origin = this.events.find((event) => event.type === "ingest" && event.findingId === id);
    const author =
      createdBy ??
      (origin?.actor ? { ...origin.actor } : { kind: "unknown" as const, id: "unknown" });
    return {
      ...readableFinding,
      authoredBy: author.kind === "unknown" ? "legacy-unknown" : author.kind,
      author,
      evidenceTiers: [...new Set(finding.evidence.map((e) => e.tier))],
    };
  }

  exportReadbackSnapshot(): Omit<FindingsGraphSnapshot, "findings"> & {
    findings: FindingReadback[];
  } {
    const snapshot = this.exportSnapshot();
    return { ...snapshot, findings: snapshot.findings.map((finding) => this.readback(finding.id)) };
  }

  archived(id?: string): FindingArchiveEntry[] {
    const cutoff = this.now() - this.maxArchiveAgeMs;
    const entries = (
      id === undefined ? [...this.archive.values()] : [this.archive.get(id)].filter(Boolean)
    ).filter((entry) => entry!.archivedAt >= cutoff);
    return entries.map((entry) => this.cloneArchiveEntry(entry!));
  }

  archivedReadback(
    id: string,
  ): (Omit<FindingArchiveEntry, "finding"> & { finding: FindingReadback }) | null {
    const entry = this.archived(id)[0];
    if (!entry) return null;
    const { createdBy, ...readableFinding } = entry.finding;
    const origin = this.events.find((event) => event.type === "ingest" && event.findingId === id);
    const author =
      createdBy ??
      (origin?.actor ? { ...origin.actor } : { kind: "unknown" as const, id: "unknown" });
    return {
      operationId: entry.operationId,
      archivedAt: entry.archivedAt,
      finding: {
        ...readableFinding,
        authoredBy: author.kind === "unknown" ? "legacy-unknown" : author.kind,
        author,
        evidenceTiers: [...new Set(entry.finding.evidence.map((evidence) => evidence.tier))],
      },
    };
  }

  archiveStats(): {
    count: number;
    bytes: number;
    oldestAt: number | null;
    maxEntries: number;
    maxBytes: number;
    maxAgeMs: number;
  } {
    const entries = this.archived();
    return {
      count: entries.length,
      bytes: utf8Bytes(entries),
      oldestAt: entries.length ? Math.min(...entries.map((entry) => entry.archivedAt)) : null,
      maxEntries: this.maxArchiveEntries,
      maxBytes: this.maxArchiveBytes,
      maxAgeMs: this.maxArchiveAgeMs,
    };
  }

  /** All findings, newest first. */
  list(): Finding[] {
    return [...this.findings.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((f) => this.clone(f));
  }

  /**
   * Filtered, ranked query. Ranking: status (confirmed > open > superseded > refuted),
   * then severity·confidence strength, then recency. `subject` matches exact or path prefix,
   * so a directory query reaches its files.
   */
  query(q: FindingQuery = {}): Finding[] {
    const textTokens = q.text ? tokens(q.text) : null;
    const statusFilter = q.status;
    const results: Array<{ finding: InternalFinding; score: number }> = [];
    for (const finding of this.findings.values()) {
      if (statusFilter !== undefined) {
        if (finding.status !== statusFilter) continue;
      } else if (finding.status === "refuted" || finding.status === "superseded") {
        continue;
      }
      if (q.kind !== undefined && finding.kind !== q.kind) continue;
      if (q.tag !== undefined && !finding.tags.includes(q.tag.toLowerCase())) continue;
      if (q.tags?.some((tag) => !finding.tags.includes(tag.toLowerCase()))) continue;
      if (q.subject !== undefined) {
        const subject = q.subject.replace(/\\/g, "/");
        const hit = finding.subjects.some((s) => {
          const norm = s.replace(/\\/g, "/");
          return (
            norm === subject || norm.startsWith(`${subject}/`) || subject.startsWith(`${norm}/`)
          );
        });
        if (!hit) continue;
      }
      let score = 0;
      if (textTokens !== null) {
        const haystack = tokens(`${finding.title} ${finding.body} ${finding.tags.join(" ")}`);
        score = jaccard(textTokens, haystack);
        if (score === 0) continue;
      }
      results.push({ finding, score: score * 10 + STATUS_RANK[finding.status] });
    }
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const severity =
        SEVERITY_WEIGHT[b.finding.severity] * CONFIDENCE_WEIGHT[b.finding.confidence] -
        SEVERITY_WEIGHT[a.finding.severity] * CONFIDENCE_WEIGHT[a.finding.confidence];
      if (severity !== 0) return severity;
      return b.finding.updatedAt - a.finding.updatedAt;
    });
    const limit = q.limit !== undefined && q.limit > 0 ? q.limit : results.length;
    return results.slice(0, limit).map((r) => this.clone(r.finding));
  }

  /**
   * Read-only display score in [0, 1]: confidence-weighted base decayed exponentially since
   * `updatedAt`, plus `accessReinforcement / (1 + ageDaysSinceCreated)`. Despite the option's
   * legacy name, the additive term uses `createdAt`; this graph does not track access events.
   * The score is returned by the tool but does not affect query ordering or retention/eviction.
   */
  strength(id: string, at: number = this.now()): number {
    const finding = this.require(id);
    const ageDays = Math.max(0, (at - finding.updatedAt) / DAY_MS);
    const base = CONFIDENCE_WEIGHT[finding.confidence] * Math.exp(-this.decayPerDay * ageDays);
    const ageDaysSinceCreated = Math.max(0, (at - finding.createdAt) / DAY_MS);
    const creationAgeTerm = this.accessReinforcement / (1 + ageDaysSinceCreated);
    return Math.min(1, base + creationAgeTerm);
  }

  /** Events since a sequence number (0 = everything), for consumers that replay changes. */
  since(seq = 0): FindingEvent[] {
    return this.events.filter((e) => e.seq > seq).map(cloneEvent);
  }

  eventHighWater(): number {
    return this.seq;
  }

  exportSnapshot(): FindingsGraphSnapshot {
    this.rotateArchive();
    return {
      version: 1,
      findings: [...this.findings.values()].map((f) => this.clone(f)),
      events: this.events.map(cloneEvent),
      ...(this.archive.size === 0
        ? {}
        : { archive: [...this.archive.values()].map((entry) => this.cloneArchiveEntry(entry)) }),
    };
  }

  /**
   * Import a snapshot. Malformed records are skipped, not fatal — a hand-edited file degrades
   * one record instead of bricking the graph (the DurableRecordStore `revive` contract).
   */
  importSnapshot(raw: string | FindingsGraphSnapshot): { imported: number; skipped: number } {
    let parsed: unknown;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { imported: 0, skipped: 0 };
      }
    } else {
      parsed = raw;
    }
    const snapshot = parsed as FindingsGraphSnapshot;
    if (snapshot === null || typeof snapshot !== "object" || !Array.isArray(snapshot.findings)) {
      return { imported: 0, skipped: 0 };
    }
    let imported = 0;
    let skipped = 0;
    for (const record of snapshot.findings as unknown[]) {
      try {
        if (record === null || typeof record !== "object") throw new Error("invalid record");
        const f = record as Partial<Finding>;
        if (
          typeof f.id !== "string" ||
          f.id.trim() === "" ||
          typeof f.title !== "string" ||
          f.title.trim() === "" ||
          typeof f.body !== "string" ||
          !FINDING_KINDS.includes(f.kind as FindingKind) ||
          !FINDING_STATUSES.includes(f.status as FindingStatus) ||
          !FINDING_CONFIDENCE.includes(f.confidence as FindingConfidence) ||
          !FINDING_SEVERITIES.includes(f.severity as FindingSeverity) ||
          !Array.isArray(f.subjects) ||
          !f.subjects.every((value) => typeof value === "string") ||
          !Array.isArray(f.tags) ||
          !f.tags.every((value) => typeof value === "string") ||
          !Array.isArray(f.related) ||
          !f.related.every((value) => typeof value === "string") ||
          (f.contradicts !== undefined &&
            (!Array.isArray(f.contradicts) ||
              !f.contradicts.every((value) => typeof value === "string"))) ||
          !Array.isArray(f.evidence) ||
          !f.evidence.every(
            (value) =>
              value !== null &&
              typeof value === "object" &&
              EVIDENCE_TIERS.includes((value as FindingEvidence).tier),
          ) ||
          !Array.isArray(f.sources) ||
          !f.sources.every((value) => {
            if (value === null || typeof value !== "object") return false;
            const source = value as FindingSource;
            return (
              (source.agentId === undefined || typeof source.agentId === "string") &&
              (source.sessionId === undefined || typeof source.sessionId === "string") &&
              (source.report === undefined || typeof source.report === "string") &&
              (source.at === undefined ||
                (typeof source.at === "number" && Number.isFinite(source.at)))
            );
          }) ||
          (f.createdBy !== undefined &&
            (f.createdBy === null ||
              typeof f.createdBy !== "object" ||
              !["user", "agent", "system", "unknown"].includes(f.createdBy.kind) ||
              typeof f.createdBy.id !== "string")) ||
          typeof f.createdAt !== "number" ||
          !Number.isFinite(f.createdAt) ||
          typeof f.updatedAt !== "number" ||
          !Number.isFinite(f.updatedAt) ||
          (f.supersededBy !== undefined && typeof f.supersededBy !== "string") ||
          (f.supersededByArchived !== undefined && typeof f.supersededByArchived !== "string")
        )
          throw new Error("invalid record");

        const sources = f.sources.map((source) => ({ ...source }));
        const sourceNotes: Record<string, string> = {};
        for (const source of sources) sourceNotes[sourceKey(source)] = source.report ?? "";
        const restored: InternalFinding = {
          id: f.id,
          kind: f.kind as FindingKind,
          title: f.title,
          body: f.body,
          status: f.status as FindingStatus,
          confidence: f.confidence as FindingConfidence,
          severity: f.severity as FindingSeverity,
          subjects: [...f.subjects],
          evidence: f.evidence.map((evidence) => ({ ...evidence })),
          tags: [...f.tags],
          sources,
          ...(f.createdBy === undefined ? {} : { createdBy: { ...f.createdBy } }),
          related: [...f.related],
          ...(f.contradicts === undefined ? {} : { contradicts: [...f.contradicts] }),
          ...(f.supersededBy === undefined ? {} : { supersededBy: f.supersededBy }),
          ...(f.supersededByArchived === undefined
            ? {}
            : { supersededByArchived: f.supersededByArchived }),
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
          sourceNotes,
        };
        this.findings.set(restored.id, restored);
        imported++;
      } catch {
        skipped++;
      }
    }
    if (snapshot.archive !== undefined && !Array.isArray(snapshot.archive)) skipped++;
    const archivedOperations = new Set<string>();
    for (const candidate of (Array.isArray(snapshot.archive)
      ? snapshot.archive
      : []) as unknown[]) {
      try {
        if (candidate === null || typeof candidate !== "object")
          throw new Error("invalid archive entry");
        const entry = candidate as FindingArchiveEntry;
        if (
          typeof entry.operationId !== "string" ||
          !entry.operationId.trim() ||
          archivedOperations.has(entry.operationId) ||
          typeof entry.archivedAt !== "number" ||
          !Number.isFinite(entry.archivedAt)
        )
          throw new Error("invalid archive metadata");
        const restoredGraph = new FindingsGraph({ now: this.now });
        const restored = restoredGraph.importSnapshot({ version: 1, findings: [entry.finding] });
        const finding = restoredGraph.list()[0];
        if (
          restored.imported !== 1 ||
          restored.skipped !== 0 ||
          !finding ||
          this.archive.has(finding.id) ||
          this.findings.has(finding.id)
        )
          throw new Error("invalid or duplicate archive finding");
        this.archive.set(finding.id, {
          operationId: entry.operationId,
          archivedAt: entry.archivedAt,
          finding,
        });
        archivedOperations.add(entry.operationId);
      } catch {
        skipped++;
      }
    }
    for (const finding of this.findings.values()) {
      finding.related = finding.related.filter((id) => this.findings.has(id));
      if (finding.contradicts)
        finding.contradicts = finding.contradicts.filter((id) => this.findings.has(id));
      if (finding.supersededBy && !this.findings.has(finding.supersededBy)) {
        if (this.archive.has(finding.supersededBy))
          finding.supersededByArchived = finding.supersededBy;
        delete finding.supersededBy;
      }
      if (finding.supersededByArchived && !this.archive.has(finding.supersededByArchived))
        delete finding.supersededByArchived;
    }
    // Adopt the snapshot's log as the canonical history — AFTER the findings restore, so it
    // replaces the `ingest` events the `report()` calls above pushed. A snapshot without a log
    // (older format) keeps whatever the import produced.
    const importedEvents = (Array.isArray(snapshot.events) ? snapshot.events : []).filter(
      (e): e is FindingEvent =>
        e !== null &&
        typeof e === "object" &&
        typeof e.seq === "number" &&
        Number.isFinite(e.seq) &&
        typeof e.findingId === "string" &&
        typeof e.at === "number" &&
        Number.isFinite(e.at) &&
        (e.note === undefined || typeof e.note === "string") &&
        (e.actor === undefined ||
          (e.actor !== null &&
            typeof e.actor === "object" &&
            ["user", "agent", "system", "unknown"].includes(e.actor.kind) &&
            typeof e.actor.id === "string")) &&
        (e.method === undefined || ["tool", "route", "engine"].includes(e.method)) &&
        (e.override === undefined || e.override === true) &&
        (e.type === "ingest" ||
          e.type === "merge" ||
          e.type === "supersede" ||
          e.type === "refute" ||
          e.type === "reopen" ||
          e.type === "update"),
    );
    if (importedEvents.length > 0) {
      this.events.length = 0;
      for (const event of importedEvents.slice(-this.maxEvents))
        this.events.push(cloneEvent(event));
      this.seq = importedEvents.reduce((max, e) => Math.max(max, e.seq), 0);
    }
    this.rotateArchive();
    return { imported, skipped };
  }

  private require(id: string): InternalFinding {
    const finding = this.findings.get(id);
    if (!finding) throw new UnknownFindingError(id);
    return finding;
  }

  private requireTransition(finding: Finding, to: FindingStatus): void {
    if (!canTransition(finding.status, to)) {
      throw new LifecycleError(`Cannot transition a finding from ${finding.status} to ${to}.`);
    }
  }

  private clone(finding: InternalFinding): Finding {
    const { sourceNotes: _sourceNotes, ...wire } = finding;
    return {
      ...wire,
      ...(wire.createdBy === undefined ? {} : { createdBy: { ...wire.createdBy } }),
      subjects: [...wire.subjects],
      evidence: wire.evidence.map((e) => ({ ...e })),
      tags: [...wire.tags],
      sources: wire.sources.map((s) => ({ ...s })),
      related: [...wire.related],
      ...(wire.contradicts === undefined ? {} : { contradicts: [...wire.contradicts] }),
    };
  }

  private cloneArchiveEntry(entry: FindingArchiveEntry): FindingArchiveEntry {
    return {
      operationId: entry.operationId,
      archivedAt: entry.archivedAt,
      finding: {
        ...entry.finding,
        ...(entry.finding.createdBy === undefined
          ? {}
          : { createdBy: { ...entry.finding.createdBy } }),
        subjects: [...entry.finding.subjects],
        evidence: entry.finding.evidence.map((item) => ({ ...item })),
        tags: [...entry.finding.tags],
        sources: entry.finding.sources.map((item) => ({ ...item })),
        related: [...entry.finding.related],
        ...(entry.finding.contradicts === undefined
          ? {}
          : { contradicts: [...entry.finding.contradicts] }),
      },
    };
  }

  private rotateArchive(): void {
    this.rotateArchiveEntries(this.archive, this.now());
  }

  /** Plan and validate every archive write before any live graph mutation is committed. */
  private planEvictions(
    additional: InternalFinding,
    relatedTargets: readonly string[],
    contradictedId?: string,
  ): { victims: InternalFinding[]; archive: Map<string, FindingArchiveEntry> } {
    const ordered = [...this.findings.values(), additional].sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rank !== 0) return rank;
      return a.updatedAt - b.updatedAt;
    });
    const victimCount = Math.max(0, ordered.length - this.maxFindings);
    const victims = ordered.slice(0, victimCount);
    const archive = new Map(this.archive);
    archive.delete(additional.id);
    const archivedAt = this.now();
    this.rotateArchiveEntries(archive, archivedAt);
    for (const victim of victims) {
      const finding = this.clone(victim as InternalFinding);
      if (victim.id !== additional.id && relatedTargets.includes(victim.id)) {
        finding.related = unionSorted(finding.related, [additional.id]);
        if (victim.id === contradictedId)
          finding.contradicts = unionSorted(finding.contradicts ?? [], [additional.id]);
      }
      const entry: FindingArchiveEntry = {
        operationId: randomUUID(),
        archivedAt,
        finding,
      };
      archive.set(victim.id, entry);
      this.rotateArchiveEntries(archive, archivedAt);
      if (!archive.has(victim.id)) throw new FindingsArchiveCapacityError();
    }
    return { victims, archive };
  }

  /** Commit a preflighted eviction plan and remove links only from records that remain live. */
  private applyEvictionPlan(plan: {
    victims: readonly InternalFinding[];
    archive: Map<string, FindingArchiveEntry>;
  }): void {
    for (const victim of plan.victims) {
      this.findings.delete(victim.id);
      for (const finding of this.findings.values()) {
        finding.related = finding.related.filter((id) => id !== victim.id);
        if (finding.contradicts)
          finding.contradicts = finding.contradicts.filter((id) => id !== victim.id);
        if (finding.supersededBy === victim.id) {
          delete finding.supersededBy;
          finding.supersededByArchived = victim.id;
        }
      }
    }
    this.archive = plan.archive;
  }

  private rotateArchiveEntries(archive: Map<string, FindingArchiveEntry>, at: number): void {
    const cutoff = at - this.maxArchiveAgeMs;
    for (const [id, entry] of archive) if (entry.archivedAt < cutoff) archive.delete(id);
    const oldestFirst = [...archive.values()].sort((a, b) => a.archivedAt - b.archivedAt);
    let bytes = 2 + oldestFirst.reduce((sum, entry) => sum + utf8Bytes(entry), 0);
    bytes += Math.max(0, oldestFirst.length - 1);
    while (
      oldestFirst.length > this.maxArchiveEntries ||
      (oldestFirst.length > 0 && bytes > this.maxArchiveBytes)
    ) {
      const oldest = oldestFirst.shift();
      if (!oldest) break;
      archive.delete(oldest.finding.id);
      bytes -= utf8Bytes(oldest) + (oldestFirst.length > 0 ? 1 : 0);
    }
  }
}
