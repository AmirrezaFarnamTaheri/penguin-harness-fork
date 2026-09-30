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
 * 2. **Nothing is deleted.** A refuted or outdated claim is marked and chained to its
 *    replacement (`supersededBy`). History is the point.
 * 3. **Strength is a read-only display score.** `strength(finding, now)` combines a
 *    confidence-weighted base decayed since `updatedAt` with an additive term decayed by age
 *    since `createdAt`. That second term is a creation-age heuristic, not access tracking. The
 *    score does not control query order or eviction, and storing it would rewrite history.
 * 4. **Accounting is replace-by-source.** Each reporter's evidence and note are kept under its
 *    own source slot; a second report from the same source replaces it instead of appending.
 * 5. **Every mutation appends to the event log** (bounded), so a consumer can ask "what
 *    changed since seq N" — the findings plane's own replay story.
 */
import {
  type Finding,
  type FindingConfidence,
  type FindingEvidence,
  type FindingEvent,
  type FindingKind,
  type FindingQuery,
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
  /** Finding bound; oldest *superseded* findings go first, then oldest refuted. */
  maxFindings?: number;
}

const DEFAULTS = {
  decayPerDay: 0.01,
  accessReinforcement: 0.3,
  mergeJaccard: 0.7,
  relateJaccard: 0.4,
  maxEvents: 2000,
  maxFindings: 5000,
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
const FINDING_KINDS: readonly FindingKind[] = [
  "defect",
  "insight",
  "decision",
  "pattern",
  "metric",
  "hypothesis",
];
const FINDING_STATUSES: readonly FindingStatus[] = ["open", "confirmed", "refuted", "superseded"];
const FINDING_CONFIDENCE: readonly FindingConfidence[] = ["low", "medium", "high"];
const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];
const EVIDENCE_TIERS = [
  "runtime",
  "implementation",
  "history",
  "documentation",
  "anecdote",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  return `${e.path ?? ""}:${e.line ?? ""}#${(e.quote ?? e.note ?? "").slice(0, 80)}`;
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
  private readonly events: FindingEvent[] = [];
  private seq = 0;
  private readonly now: () => number;
  private readonly decayPerDay: number;
  private readonly accessReinforcement: number;
  private readonly mergeJaccard: number;
  private readonly relateJaccard: number;
  private readonly maxEvents: number;
  private readonly maxFindings: number;

  constructor(options: FindingsGraphOptions = {}) {
    this.now = options.now ?? Date.now;
    this.decayPerDay = options.decayPerDay ?? DEFAULTS.decayPerDay;
    this.accessReinforcement = options.accessReinforcement ?? DEFAULTS.accessReinforcement;
    this.mergeJaccard = options.mergeJaccard ?? DEFAULTS.mergeJaccard;
    this.relateJaccard = options.relateJaccard ?? DEFAULTS.relateJaccard;
    this.maxEvents = options.maxEvents ?? DEFAULTS.maxEvents;
    this.maxFindings = options.maxFindings ?? DEFAULTS.maxFindings;
  }

  /** Deterministic id for a claim: slug of the title + a fingerprint of its normalized text. */
  private makeId(title: string, body: string): string {
    const fingerprint = fnv1a(`${title.trim().toLowerCase()}\u0000${body.trim().toLowerCase()}`);
    return `${slugify(title)}-${fingerprint}`;
  }

  private pushEvent(type: FindingEvent["type"], findingId: string, note?: string): void {
    this.events.push({ seq: ++this.seq, type, findingId, at: this.now(), note });
    while (this.events.length > this.maxEvents) this.events.shift();
  }

  /**
   * Report a finding. Merges into an existing claim when one matches (same id, exact title, or
   * Jaccard at or above `mergeJaccard` over title+body); otherwise creates one and links near-misses.
   */
  report(input: ReportFindingInput): ReportFindingResult {
    const title = input.title.trim();
    if (title === "") throw new Error("Finding title must not be empty.");
    const body = (input.body ?? "").trim();
    const now = this.now();

    // Line 1 of dedupe: the deterministic id. Re-reporting the same claim lands here.
    const id = this.makeId(title, body);
    const existing = this.findings.get(id);
    if (existing) return { finding: this.mergeInto(existing, input, now), merged: true };

    // Line 2: wording-level duplicate of an existing claim.
    const claimed = tokens(`${title} ${body}`);
    let best: { finding: InternalFinding; score: number } | null = null;
    for (const candidate of this.findings.values()) {
      if (candidate.status === "refuted") continue;
      if (candidate.title.trim().toLowerCase() === title.toLowerCase()) {
        return { finding: this.mergeInto(candidate, input, now), merged: true };
      }
      const score = jaccard(claimed, tokens(`${candidate.title} ${candidate.body}`));
      if (score >= this.mergeJaccard && (best === null || score > best.score)) {
        best = { finding: candidate, score };
      }
    }
    if (best) return { finding: this.mergeInto(best.finding, input, now), merged: true };

    const finding: InternalFinding = {
      id,
      kind: input.kind ?? "insight",
      title,
      body,
      status: "open",
      confidence: input.confidence ?? "medium",
      severity: input.severity ?? "info",
      subjects: [...(input.subjects ?? [])].map((s) => s.trim()).filter((s) => s !== ""),
      evidence: [...(input.evidence ?? [])],
      tags: [...(input.tags ?? [])].map((t) => t.trim().toLowerCase()).filter((t) => t !== ""),
      sources: input.source ? [input.source] : [],
      related: [],
      createdAt: now,
      updatedAt: now,
      sourceNotes: {},
    };
    if (input.source) finding.sourceNotes[sourceKey(input.source)] = input.source.report ?? "";
    this.findings.set(id, finding);

    // Near-misses become `related` links (symmetric), never merges.
    for (const candidate of this.findings.values()) {
      if (candidate.id === id) continue;
      const score = jaccard(claimed, tokens(`${candidate.title} ${candidate.body}`));
      if (score >= this.relateJaccard) {
        finding.related = unionSorted(finding.related, [candidate.id]);
        candidate.related = unionSorted(candidate.related, [id]);
      }
    }

    this.pushEvent("ingest", id);
    this.evictIfNeeded();
    return { finding: this.clone(finding), merged: false };
  }

  /** Absorb one more report into an existing claim (evidence union, source accounting). */
  private mergeInto(target: InternalFinding, input: ReportFindingInput, now: number): Finding {
    const evidenceKeys = new Set(target.evidence.map(evidenceKey));
    for (const e of input.evidence ?? []) {
      const key = evidenceKey(e);
      if (!evidenceKeys.has(key)) {
        target.evidence.push(e);
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
        target.sources.push(input.source);
      }
      target.sourceNotes[key] = input.source.report ?? target.sourceNotes[key] ?? "";
    }
    target.updatedAt = now;
    this.pushEvent("merge", target.id);
    return this.clone(target);
  }

  /** Confirm a claim (an agent verified it). */
  confirm(id: string, note?: string): Finding {
    const finding = this.require(id);
    finding.status = "confirmed";
    finding.updatedAt = this.now();
    this.pushEvent("update", id, note);
    return this.clone(finding);
  }

  /** Refute a claim. Kept in the graph — the falsification is knowledge too. */
  refute(id: string, note?: string): Finding {
    const finding = this.require(id);
    finding.status = "refuted";
    finding.updatedAt = this.now();
    this.pushEvent("refute", id, note);
    return this.clone(finding);
  }

  /** Supersede `id` with a replacement claim (usually freshly reported). */
  supersede(id: string, replacementId: string, note?: string): Finding {
    const finding = this.require(id);
    const replacement = this.require(replacementId);
    if (id === replacementId) throw new Error("A finding cannot supersede itself.");
    finding.status = "superseded";
    finding.supersededBy = replacementId;
    finding.updatedAt = this.now();
    replacement.related = unionSorted(replacement.related, [id]);
    finding.related = unionSorted(finding.related, [replacementId]);
    this.pushEvent("supersede", id, note ?? replacementId);
    return this.clone(finding);
  }

  /** Add a symmetric relation between two findings. */
  link(aId: string, bId: string): void {
    const a = this.require(aId);
    const b = this.require(bId);
    a.related = unionSorted(a.related, [bId]);
    b.related = unionSorted(b.related, [aId]);
    this.pushEvent("update", aId, `link:${bId}`);
  }

  get(id: string): Finding | null {
    const finding = this.findings.get(id);
    return finding ? this.clone(finding) : null;
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
    return this.events.filter((e) => e.seq > seq).map((e) => ({ ...e }));
  }

  exportSnapshot(): FindingsGraphSnapshot {
    return {
      version: 1,
      findings: [...this.findings.values()].map((f) => this.clone(f)),
      events: this.events.map((e) => ({ ...e })),
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
          typeof f.createdAt !== "number" ||
          !Number.isFinite(f.createdAt) ||
          typeof f.updatedAt !== "number" ||
          !Number.isFinite(f.updatedAt) ||
          (f.supersededBy !== undefined && typeof f.supersededBy !== "string")
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
          related: [...f.related],
          ...(f.supersededBy === undefined ? {} : { supersededBy: f.supersededBy }),
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
        (e.type === "ingest" ||
          e.type === "merge" ||
          e.type === "supersede" ||
          e.type === "refute" ||
          e.type === "update"),
    );
    if (importedEvents.length > 0) {
      this.events.length = 0;
      for (const event of importedEvents) this.events.push({ ...event });
      this.seq = importedEvents.reduce((max, e) => Math.max(max, e.seq), 0);
    }
    return { imported, skipped };
  }

  private require(id: string): InternalFinding {
    const finding = this.findings.get(id);
    if (!finding) throw new Error(`Unknown finding: ${id}`);
    return finding;
  }

  private clone(finding: InternalFinding): Finding {
    const { sourceNotes: _sourceNotes, ...wire } = finding;
    return {
      ...wire,
      subjects: [...wire.subjects],
      evidence: wire.evidence.map((e) => ({ ...e })),
      tags: [...wire.tags],
      sources: wire.sources.map((s) => ({ ...s })),
      related: [...wire.related],
    };
  }

  /** Bounded store: evict superseded-then-refuted-then-oldest once past `maxFindings`. */
  private evictIfNeeded(): void {
    if (this.findings.size <= this.maxFindings) return;
    const ordered = [...this.findings.values()].sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rank !== 0) return rank;
      return a.updatedAt - b.updatedAt;
    });
    while (this.findings.size > this.maxFindings && ordered.length > 0) {
      const victim = ordered.shift();
      if (victim) this.findings.delete(victim.id);
    }
  }
}
