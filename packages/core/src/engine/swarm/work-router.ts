/**
 * Work-to-role routing — who *does* a job, decided from the allocation.
 *
 * `role-allocator.ts` answers "who should hold which role right now". It does
 * not answer "who should run the full test suite", and that gap is the whole
 * feature: a `test_engineer` can be allocated, scored, and never consulted
 * once, while whoever happens to be running does the suite themselves. This
 * module is the missing half — it turns an allocation into a dispatch
 * decision, so the allocation's output actually decides who does what.
 *
 * What it deliberately does *not* do, because the allocator already owns it:
 *  - it does not score agents, choose roles, reassign, or call `allocate()`.
 *    It reads the current allocation and picks among the holders the allocator
 *    already chose. A second staffing mechanism would be the third
 *    overlapping pool-style mechanism this tree has already paid for twice.
 *  - it does not restate the load ceiling. It asks the allocator, so the rule
 *    that refuses to staff a saturated agent is the same rule that refuses to
 *    hand that agent a job. Two copies of the threshold would drift.
 *  - it does not maintain a second in-flight count. The bounded ledger below
 *    is the only one, and it is scanned rather than mirrored.
 *  - it does not execute anything. It returns a decision; the host dispatches
 *    and reports back through `complete`/`fail`.
 *
 * The rule the product asked for, as a rule and not a preference: a *broad*
 * verification job (the full suite, e2e, a repo-wide gate) routes to the role
 * that owns it and owes a report back to the requester, while a *narrow* one
 * (the tests for the files just changed) runs where it is, without ceremony.
 * The classification is derived from the task the requester already has — its
 * words, and the role a planner already attached to it — so the common path
 * costs no new labelling; a caller may still name the class explicitly from a
 * closed vocabulary, which is recorded as such but buys no exemption from the
 * scope rule.
 *
 * The load-bearing invariant, matching the JEV advisory path: routing observes
 * and organises, it never gates. `route()` is total — every input returns a
 * decision, and no role allocated, no allocation at all, an exhausted ledger,
 * an unreadable request or a fault inside the router all end in "run it
 * locally", which is exactly what the swarm did before this module existed. A
 * swarm with one agent therefore behaves as it always has.
 */

import type { AgentAvailability, RoleAssignment, SwarmRoleId } from "./role-allocator.js";
import type { Subtask } from "./task-parallelizer.js";

/**
 * The closed work vocabulary. A class names *what kind of job this is*, and
 * each class has at most one owning role — the mapping is data, below, so
 * extending the roster never means inventing a new decision path.
 */
export type WorkClass =
  | "security_review"
  | "reproduction"
  | "architecture"
  | "polish"
  | "research"
  | "planning"
  | "verification"
  | "general";

/**
 * How wide the job is. `unclear` is a real value and not an error: breadth that
 * cannot be established is treated as insufficient, so the job runs locally.
 */
export type WorkScope = "broad" | "narrow" | "unclear";

/** Every way a job can end up somewhere. `routed` is the only cross-agent one. */
export type RouteOutcome =
  /** Handed to an already-allocated holder of the owning role. */
  | "routed"
  /** Narrowly scoped work: runs where it is, without ceremony. */
  | "local_scoped"
  /**
   * A role owns this class, but the work is *authored* — it changes files in
   * the requester's workspace, so it is done where the code is.
   */
  | "local_authored_in_place"
  /** No role owns this class (`general`); it is ordinary work. */
  | "local_unclassified"
  /** The owning role exists but nobody is allocated to it. */
  | "local_no_role"
  /** The requester already holds the owning role; routing to it is a no-op. */
  | "local_requester_owns"
  /** Every eligible holder is busy, or the ledger is full. Runs locally. */
  | "local_at_capacity";

/** What the caller knows about the job. Everything else is derived. */
export interface WorkRequest {
  /** Optional caller correlation id (a subagent id, a subtask id). */
  workId?: string;
  /** The job in the requester's own words — the primary classification signal. */
  task: string;
  /** The agent asking for the work; the routed result is reported back to it. */
  requesterAgentId?: string;
  /** Paths the requester just changed, when it knows them. A scoping signal. */
  touchedPaths?: readonly string[];
  /**
   * A role the planner already chose for this job (`Subtask.roleId`, a host's
   * own decision). Honoured when it names a class this module knows, and
   * ignored — never thrown on — when it names a role that owns no class.
   */
  roleId?: string;
  /**
   * Explicit class from the closed vocabulary above. Recorded as
   * `classSource: "caller"`, but it does not override the scope rule: naming
   * the class states who owns the work, never that this particular instance is
   * worth handing over. A value outside the vocabulary is ignored.
   */
  class?: WorkClass;
}

/**
 * The allocator surface this module depends on — three read-only methods, each
 * one a question the allocator already answers. Kept structural on purpose: it
 * is the proof that the router *consumes* staffing instead of redoing it, it
 * keeps the load ceiling in exactly one place, and it lets a test supply a
 * double without standing up a whole swarm. Note what is absent: there is no
 * `allocate`, no `scorePair`, no agent registration. The router cannot staff
 * the mesh even if it wanted to, which is the point.
 */
export interface AllocationSource {
  /** Current holders of a role, best score first. Empty when nobody holds it. */
  holdersOf(roleId: SwarmRoleId): RoleAssignment[];
  /** The allocator's own load-ceiling verdict for an agent it knows. */
  agentAvailability(agentId: string): AgentAvailability | undefined;
  /** Generation of the last allocation pass; 0 when none has run. */
  allocationGeneration(): number;
}

/** Where a routed job is owed a report. Absent when nothing was routed. */
export interface RouteReport {
  to: string | null;
  required: boolean;
}

/**
 * One holder that was passed over, and why. Recorded on every decision that
 * reaches the selection stage, so "why not the other test engineer" is
 * answerable from the decision itself and not only from a log line.
 */
export interface RoutingSkip {
  agentId: string;
  reason: string;
}

/**
 * What a specialist hands back when it closes a job. `summary` is required
 * because a report with nothing in it is not a report — the one-line outcome is
 * what a requester reads before deciding whether to open the detail.
 */
export interface RouteResult {
  ok: boolean;
  /** One line of human-readable outcome, e.g. "412 passed, 1 failed". */
  summary: string;
  /** Free-form structured result, e.g. per-suite counts. */
  detail?: Record<string, unknown>;
}

/**
 * A job's result, handed back to the requester that asked for it. This is the
 * report the routing decision promised, as a value a caller can read back by
 * job id, filter by requester, or receive on the observer hook.
 */
export interface RouteReportRecord {
  jobId: string;
  /** The agent the result is owed to; null when the requester named none. */
  to: string | null;
  workClass: WorkClass;
  roleId: SwarmRoleId;
  /** The specialist that ran it. */
  agentId: string;
  ok: boolean;
  summary: string;
  detail?: Record<string, unknown>;
  startedAt: number;
  reportedAt: number;
}

/**
 * The full, auditable answer to "who is doing this, and why". Every decision
 * is retained (bounded, see `retainDecisions`) precisely so that "why did my
 * test run over there" has an answer after the fact.
 */
export interface RouteDecision {
  /** Router-generated correlation id; pass to `complete`/`fail` when routed. */
  jobId: string;
  routed: boolean;
  outcome: RouteOutcome;
  workClass: WorkClass;
  /** Where the class came from: the caller's label, a declared role, or the text. */
  classSource: "caller" | "declaredRole" | "derived";
  scope: WorkScope;
  /** The role that owns the class, or null when no role does. */
  roleId: SwarmRoleId | null;
  /** Who will actually do the work: the specialist, or the requester if local. */
  agentId: string | null;
  requesterAgentId: string | null;
  /** Matched terms, lowercased, in match order. */
  evidence: string[];
  /** Holders that were considered and passed over. Empty when none were. */
  considered: RoutingSkip[];
  /** One line, human-readable — the answer to "why". */
  reason: string;
  /** The address a report is owed to; the report itself arrives via complete/fail. */
  report: RouteReport;
  decidedAt: number;
}

/**
 * What the bounded history holds. A routed job, its release and the report it
 * owed are separate moments with different shapes, so this is a union rather
 * than one over-stretched decision record.
 */
export type RouterEvent =
  | { kind: "decision"; decision: RouteDecision }
  | { kind: "released"; job: InFlightJob; at: number; reason: string }
  | { kind: "reported"; report: RouteReportRecord };

/** One routed job occupying one holder's single in-flight slot. */
export interface InFlightJob {
  jobId: string;
  workId: string | null;
  roleId: SwarmRoleId;
  agentId: string;
  requesterAgentId: string | null;
  workClass: WorkClass;
  scope: WorkScope;
  startedAt: number;
}

export interface WorkRouterOptions {
  /** Global cap on routed jobs. At the cap, work runs locally. */
  maxInFlight?: number;
  /**
   * Cap per holder, default 1. One job at a time is what keeps a routing
   * decision from becoming a backlog — a queue that never drains is the exact
   * failure this cap exists to prevent, so the default refuses to build one.
   */
  maxInFlightPerAgent?: number;
  /** A routed job older than this is swept on the next `route()`. */
  staleJobMs?: number;
  /** Bounded decision history kept for after-the-fact questions. */
  retainDecisions?: number;
  /** Called once per decision, for host logging. Failures are swallowed. */
  onDecision?: (decision: RouteDecision) => void;
  /** Called once per report, as it lands. Failures are swallowed. */
  onReport?: (report: RouteReportRecord) => void;
}

/** Which role owns which class. `null` means nobody — that work runs local. */
const CLASS_OWNER: Readonly<Record<WorkClass, SwarmRoleId | null>> = Object.freeze({
  security_review: "security_reviewer",
  reproduction: "bug_isolator",
  architecture: "architect_lead",
  polish: "code_polisher",
  research: "researcher",
  planning: "orchestrator",
  verification: "test_engineer",
  general: null,
});

/**
 * The classes that may ever leave the requester, and the reason the list is
 * three long rather than eight.
 *
 * A class is routable when its work is *observed and reported*: the specialist
 * runs it, reads the result, and hands back a finding, leaving the workspace as
 * it found it. A full suite, a security review and a reproduction are all that
 * shape, and all of them are wide or expensive enough that doing them well is a
 * specialisation.
 *
 * The other four are authored work — they change files. Handing "simplify the
 * allocator and add tests for it" to a `code_polisher` because the word
 * `simplify` is in it does not organise the work, it misassigns it: the tests
 * in that sentence are the part that matters, and they belong to whoever is
 * editing. So those classes are still *classified* — knowing a job is a
 * refactor is what lets the router say why it stayed put — but they are never
 * dispatched, and the decision records that as its own outcome rather than
 * pretending nobody owns them.
 *
 * The filter is also what makes the classifier's ordering safe. Class patterns
 * are checked most-specific-first, so a wide `polish` or `planning` net wins
 * over the wide `verification` net. That is only acceptable because neither can
 * trigger a handover; were `polish` routable, an incidental `style` or `plan`
 * in a request about tests would divert it to the wrong agent.
 */
const ROUTABLE_CLASSES: ReadonlySet<WorkClass> = new Set<WorkClass>([
  "verification",
  "reproduction",
  "security_review",
]);

/** Whether a class may be handed to a peer at all. Closed, and the whole list. */
export function isRoutableClass(workClass: WorkClass): boolean {
  return ROUTABLE_CLASSES.has(workClass);
}

/** The class a named role owns, or null when that role owns no class. */
export function workClassForRole(roleId: string | undefined): WorkClass | null {
  if (typeof roleId !== "string") return null;
  const wanted = roleId.trim();
  for (const [workClass, owner] of Object.entries(CLASS_OWNER)) {
    if (owner === wanted) return workClass as WorkClass;
  }
  return null;
}

/**
 * Classification patterns, most specific class first.
 *
 * Order is the design, not an accident: `security_review` and `reproduction`
 * name a *purpose* that outranks the activity ("review the auth diff and its
 * test coverage" is a security review, not a test run), and `verification`
 * sits last because it is by far the widest net — it would otherwise swallow
 * every security and bug phrase above it. `general` has no patterns: it is the
 * fallback for "nobody owns this", and it always runs where it is.
 */
const CLASS_PATTERNS: ReadonlyArray<{
  workClass: WorkClass;
  patterns: readonly RegExp[];
}> = Object.freeze([
  {
    workClass: "security_review",
    patterns: [
      /security/,
      /vulnerab/,
      /\bvuln\b/,
      /threat[\s-]?model/,
      /\bowasp\b/,
      /\bxss\b/,
      /\bcsrf\b/,
      /\bsql[\s-]?injection\b/,
      /injection/,
      /privilege[\s-]?escalat/,
      /secret[\s-]?(leak|exposure|rotation|handling)/,
      /\bauth(?:entication|orization|orisation)\b/,
      /\baccess[\s-]?control\b/,
      /sanitiz/,
      /sanitis/,
      /hardening/,
    ],
  },
  {
    workClass: "reproduction",
    patterns: [
      /reproduc/,
      /\brepro\b/,
      /bisect/,
      /minimi[sz]/,
      /root[\s-]?cause/,
      /\bstack[\s-]?trace\b/,
      /why (?:does|do|is|are|it)/,
      /\bflaky\b/,
      /intermittent/,
      /pin (?:it|the failure|the bug)/,
    ],
  },
  {
    workClass: "architecture",
    patterns: [
      /architectur/,
      /module[\s-]?boundar/,
      /\bboundar(?:y|ies)\b/,
      /interface[\s-]?contract/,
      /\bapi[\s-]?shape\b/,
      /\bcontract\b/,
      /decompos/,
      /\bseam\b/,
      /\bcoupling\b/,
    ],
  },
  {
    workClass: "polish",
    patterns: [
      /\bpolish/,
      /de-?slop/,
      /\btidy\b/,
      /clean[\s-]?up/,
      /simplif/,
      /readab/,
      /\brefactor/,
      /\bstyle\b/,
      /\bnaming\b/,
      /\bdead[\s-]?code\b/,
    ],
  },
  {
    workClass: "research",
    patterns: [
      /research/,
      /investigat/,
      /gather[\s-]?(?:evidence|context)/,
      /\bsurvey\b/,
      /find out/,
      /look into/,
      /which (?:library|approach|option|package)/,
      /\bevidence\b/,
      /\bcompare\b/,
      /\bdocs?\s+(?:say|claim|recommend)/,
    ],
  },
  {
    workClass: "planning",
    patterns: [
      /\bplan\b/,
      /\broadmap\b/,
      // "break this down", "break it down" and "break the work down" are the
      // same request, so the words between are not fixed.
      /break\b[\w\s]{0,12}?\bdown/,
      /task[\s-]?breakdown/,
      /what order/,
      /\bsequence\b/,
      /\bstages?\b/,
      /\bpriorit(?:y|ies|ise|ize|isation|ization)\b/,
    ],
  },
  {
    workClass: "verification",
    patterns: [
      /\btests?\b/,
      /vitest/,
      /jest/,
      /pytest/,
      /playwright/,
      /cypress/,
      /\be2e\b/,
      /end[\s-]to[\s-]end/,
      /\bsuite\b/,
      /\bregression\b/,
      /\bcoverage\b/,
      /\bassertions?\b/,
      /\bci\b/,
    ],
  },
]);

/**
 * Whole-repo / whole-suite language. A match here means the job is *broad*
 * unless a scoping clause says otherwise.
 */
const BROAD_PATTERNS: readonly RegExp[] = [
  /full[\s-]?(?:test[\s-]?)?suite/,
  /full[\s-]?repo/,
  /full[\s-]?workspace/,
  /(?:entire|whole|complete)[\s-]?(?:test[\s-]?)?(?:suite|run|repo(?:sitory)?|workspace|project)/,
  /whole[\s-]?repo/,
  /repo(?:sitory)?[\s-]?wide/,
  /all (?:the )?(?:tests?|suites?)/,
  /every test/,
  /test everything/,
  /end[\s-]to[\s-]?end/,
  /\be2e\b/,
  /integration suite/,
];

/**
 * Scoping language — the narrow markers. These outrank the broad markers
 * because "run all the tests for the files I changed" contains both, and
 * means the narrow one: a request scoped to a set of paths is scoped whatever
 * adjective it was phrased with.
 */
const NARROW_PATTERNS: readonly RegExp[] = [
  /\b(?:only|just)\b/,
  /(?:changed|modified|touched|edited|new|recent) (?:files?|paths?|modules?)/,
  // Postposed scoping — "the files I changed" is the common English order, and
  // it is the adjective-last form, which an adjective-first pattern misses
  // entirely. This is the narrow case the product rule is really about.
  /(?:files?|paths?|modules?|tests?|specs?|suites?)\s+(?:i|we)\s+(?:just\s+|only\s+|recently\s+)?(?:changed?|modified|touched|edited|added|wrote|updated)/,
  /for the (?:changed|modified|touched|edited)/,
  /specific (?:test|tests|file|files|path|paths|suite)/,
  /this (?:test|tests|file|suite|spec)/,
  /the failing test/,
  /re-?run/,
  /(?:single|one) test/,
  /\bquarantined\b/,
  /\bisolated\b/,
  /\btargeted\b/,
  /scope[ds]? to/,
];

const ALL_CLASSES: readonly WorkClass[] = Object.freeze([
  "security_review",
  "reproduction",
  "architecture",
  "polish",
  "research",
  "planning",
  "verification",
  "general",
]);

/** Narrows an untrusted value (JSON, a model, a stale caller) to the vocabulary. */
export function isWorkClass(value: unknown): value is WorkClass {
  return typeof value === "string" && ALL_CLASSES.includes(value as WorkClass);
}

/** First matching term across a pattern set, lowercased. `null` when none match. */
function firstTerm(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    // Non-global regexes only, so `.match` never carries `lastIndex` between calls.
    const found = text.match(pattern)?.[0];
    if (found) return found.toLowerCase();
  }
  return null;
}

function firstTerms(text: string, patterns: readonly RegExp[], limit: number): string[] {
  const terms: string[] = [];
  for (const pattern of patterns) {
    const found = text.match(pattern)?.[0];
    if (found && !terms.includes(found.toLowerCase())) terms.push(found.toLowerCase());
    if (terms.length >= limit) break;
  }
  return terms;
}

/**
 * A `TaskParallelizer` subtask as a routing request.
 *
 * The parallelizer already carries the two fields that decide most of this:
 * `goal` is the task in the requester's words, and `roleId` is a role a planner
 * already chose. Neither is a new labelling burden, which is the point — the
 * common path costs the caller nothing extra.
 *
 * Note what the adapter deliberately does not do: it does not read
 * `estimatedCost` into a scope. That field has no defined unit anywhere in the
 * model, so any threshold read off it would be an invented number deciding
 * whether a test run gets handed to a specialist.
 *
 * `roleId` is forwarded verbatim rather than translated into a class here,
 * because the router records provenance: a class that came from a role is
 * reported as `declaredRole`, and one that came from an explicit `class` field
 * as `caller`. Converting it in the adapter would make a planner's decision
 * look like a caller assertion in the audit trail.
 */
export function workRequestFromSubtask(subtask: Subtask, requesterAgentId?: string): WorkRequest {
  return {
    workId: subtask.id,
    task: subtask.goal,
    requesterAgentId,
    ...(subtask.roleId === undefined ? {} : { roleId: subtask.roleId }),
  };
}

export class WorkRouter {
  private readonly source: AllocationSource;
  private readonly options: Required<Omit<WorkRouterOptions, "onDecision" | "onReport">> &
    Pick<WorkRouterOptions, "onDecision" | "onReport">;
  /**
   * Bounded by `maxInFlight`; the only mutable job state the router keeps, and
   * the only in-flight count anywhere. `inFlightFor` scans it rather than
   * mirroring it, so there is no second structure that can drift.
   */
  private readonly inFlight = new Map<string, InFlightJob>();
  /** Bounded ring of decisions, releases and reports, oldest evicted first. */
  private readonly events: RouterEvent[] = [];
  private sequence = 0;
  private allocationGeneration = 0;

  constructor(source: AllocationSource, options: WorkRouterOptions = {}) {
    this.source = source;
    this.options = {
      maxInFlight: Math.max(1, Math.floor(options.maxInFlight ?? 32)),
      maxInFlightPerAgent: Math.max(1, Math.floor(options.maxInFlightPerAgent ?? 1)),
      staleJobMs: Math.max(1_000, Math.floor(options.staleJobMs ?? 15 * 60_000)),
      retainDecisions: Math.max(1, Math.floor(options.retainDecisions ?? 50)),
      onDecision: options.onDecision,
      onReport: options.onReport,
    };
  }

  /**
   * Decides who does a job. Total by construction: every branch ends in a
   * decision, and the outermost catch turns an internal fault into a local
   * decision rather than a thrown error, because a routing bug must never be
   * the reason a test suite does not run.
   */
  public route(request: WorkRequest): RouteDecision {
    try {
      return this.decide(request ?? { task: "" });
    } catch (error) {
      return this.decideLocal({
        workClass: "general",
        scope: "unclear",
        roleId: null,
        outcome: "local_unclassified",
        reason: `routing faulted, running locally: ${describeError(error)}`,
        requesterAgentId: trimmed(request?.requesterAgentId) ?? null,
        evidence: [],
        classSource: "derived",
        jobId: this.nextJobId(),
      });
    }
  }

  // ------------------------------------------------------------------ public

  /**
   * Closes out a routed job and hands its result to the requester that asked
   * for it. This is the report the routing decision promised, and it is a value
   * the caller can read back — `getReport`, `reportsFor`, the `onReport` hook —
   * not a flag saying one is due.
   *
   * Failure bookkeeping stays with the allocator (`RoleAllocator.fail`); the
   * router records that a job failed and releases its slot, and writes no
   * allocator state behind the caller's back. Returns null for an unknown or
   * already-closed job id, so a double `complete()` is inert rather than a
   * second release.
   */
  public complete(
    jobId: string,
    result: RouteResult = { ok: true, summary: "completed" },
  ): RouteReportRecord | null {
    return this.report(jobId, result);
  }

  public fail(
    jobId: string,
    summary: string,
    detail?: Record<string, unknown>,
  ): RouteReportRecord | null {
    return this.report(jobId, { ok: false, summary, detail });
  }

  /** The report for a job, or null when it was never routed or never closed. */
  public getReport(jobId: string): RouteReportRecord | null {
    const wanted = jobId.trim();
    for (const event of this.events) {
      if (event.kind === "reported" && event.report.jobId === wanted) {
        return { ...event.report };
      }
    }
    return null;
  }

  /**
   * Everything reported back to `requesterAgentId`, oldest first, bounded by
   * the same `retainDecisions` ring as everything else. A job appears here only
   * once it has been closed out, so this reads as "what has landed" rather than
   * as a mailbox that could grow.
   */
  public reportsFor(requesterAgentId: string): RouteReportRecord[] {
    const target = trimmed(requesterAgentId);
    if (target === undefined) return [];
    return this.events
      .filter((event) => event.kind === "reported" && event.report.to === target)
      .map((event) => (event.kind === "reported" ? { ...event.report } : null))
      .filter((report): report is RouteReportRecord => report !== null);
  }

  /** Number of jobs currently occupying a slot; per-holder, for admission. */
  public inFlightFor(agentId: string): number {
    let count = 0;
    for (const job of this.inFlight.values()) if (job.agentId === agentId) count++;
    return count;
  }

  public listInFlight(): InFlightJob[] {
    return Array.from(this.inFlight.values(), (job) => ({ ...job }));
  }

  /** Most recent decisions, newest first. Bounded by `retainDecisions`. */
  public recentDecisions(limit = 10): RouteDecision[] {
    const bounded = Math.max(0, Math.floor(limit));
    if (bounded === 0) return [];
    return this.events
      .filter((event) => event.kind === "decision")
      .slice(-bounded)
      .reverse()
      .map((event) => (event.kind === "decision" ? copyDecision(event.decision) : null))
      .filter((decision): decision is RouteDecision => decision !== null);
  }

  /** The full bounded history, newest first, decisions and closures alike. */
  public recentEvents(limit = 10): RouterEvent[] {
    const bounded = Math.max(0, Math.floor(limit));
    if (bounded === 0) return [];
    return this.events.slice(-bounded).reverse().map(copyEvent);
  }

  /**
   * Sweeps jobs whose holder never reported back, so a forgotten `complete()`
   * cannot wedge a role into permanent `local_at_capacity`. Called on every
   * `route()` as well, which is what makes it effective without a timer.
   *
   * A swept job is closed out with a *failed* report rather than silently
   * dropped: the requester is still owed an answer, and "nobody reported back"
   * is the truthful one.
   */
  public reapStale(now: number = Date.now()): number {
    const cutoff = now - this.options.staleJobMs;
    let reaped = 0;
    for (const [jobId, job] of Array.from(this.inFlight)) {
      if (job.startedAt <= cutoff) {
        this.inFlight.delete(jobId);
        this.close(job, {
          ok: false,
          summary: `no result reported within ${this.options.staleJobMs}ms; the slot was released`,
        });
        reaped++;
      }
    }
    return reaped;
  }

  public stats(): {
    inFlight: number;
    eventsRetained: number;
    allocationGeneration: number;
    maxInFlight: number;
  } {
    return {
      inFlight: this.inFlight.size,
      eventsRetained: this.events.length,
      allocationGeneration: this.allocationGeneration,
      maxInFlight: this.options.maxInFlight,
    };
  }

  /** One log line for a decision — the "why did my test run over there" answer. */
  public describe(decision: RouteDecision): string {
    const where =
      decision.routed && decision.agentId !== null
        ? `routed to ${decision.agentId} (${decision.roleId})`
        : `local (${decision.outcome})`;
    const evidence = decision.evidence.length > 0 ? ` [${decision.evidence.join(", ")}]` : "";
    return `work-router: ${where} — ${decision.reason}${evidence}`;
  }

  // ---------------------------------------------------------------- decision

  private decide(request: WorkRequest): RouteDecision {
    this.reapStale();

    // Untrusted boundary: a request may come from a model or a JSON payload, so
    // no field is read before its type is checked. `route()` also catches, so
    // a null request here degrades rather than throws.
    const task = typeof request?.task === "string" ? request.task : "";
    const text = task.toLowerCase();
    const requester = trimmed(request?.requesterAgentId) ?? null;
    const jobId = this.nextJobId();

    const callerClass = isWorkClass(request?.class) ? request.class : null;
    const declaredClass = callerClass === null ? workClassForRole(request?.roleId) : null;
    const derived = classify(text);
    const workClass = callerClass ?? declaredClass ?? derived.workClass;
    const classSource: RouteDecision["classSource"] =
      callerClass !== null ? "caller" : declaredClass !== null ? "declaredRole" : "derived";
    const scope = classifyScope(text, request?.touchedPaths);
    const evidence =
      classSource === "derived"
        ? derived.evidence
        : [`${classSource}:${workClass}`, ...derived.evidence];
    const roleId = CLASS_OWNER[workClass];

    // No role owns this class at all — ordinary work, run where it is.
    if (roleId === null) {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId: null,
        outcome: "local_unclassified",
        reason: `no role owns '${workClass}'; ordinary work runs where it is`,
        requesterAgentId: requester,
        evidence,
        classSource,
      });
    }

    // A role owns this class, but the work is authored rather than observed:
    // it changes files in the requester's workspace, so it is done where the
    // code is. Checked before the scope rule because it is the stronger
    // statement — a narrowly scoped refactor is both.
    if (!isRoutableClass(workClass)) {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId,
        outcome: "local_authored_in_place",
        reason: `${roleId} owns '${workClass}', but it authors changes in the requester's workspace; not handed over`,
        requesterAgentId: requester,
        evidence,
        classSource,
      });
    }

    // THE RULE. A verification job only leaves the requester when it is
    // affirmatively broad: the full suite, e2e, a repo-wide gate. A narrow one
    // ("the tests for the files I just changed") runs where it is, without
    // ceremony, and an unclear one runs there too — breadth that cannot be
    // established is not evidence of breadth, and running locally is exactly
    // what the swarm did before this module existed. The other two routable
    // classes are not breadth-gated: a security review and a reproduction *are*
    // the job, with no useful local-fast variant.
    //
    // This is a rule and not a preference, so no caller-supplied class buys an
    // exemption. Naming the class states who owns the work, never that this
    // particular instance is worth handing over.
    if (workClass === "verification" && scope !== "broad") {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId,
        outcome: "local_scoped",
        reason:
          scope === "narrow"
            ? `narrowly scoped verification stays with the requester instead of being handed to ${roleId}`
            : `the scope of this test run is unclear, so it runs with the requester rather than risking a ${roleId} handoff`,
        requesterAgentId: requester,
        evidence,
        classSource,
      });
    }

    const generation = this.source.allocationGeneration();
    this.allocationGeneration = generation;

    // The allocator already decided who holds the role; this only re-uses it.
    const holders = this.source.holdersOf(roleId);
    if (holders.length === 0) {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId,
        outcome: "local_no_role",
        reason:
          generation === 0
            ? `no allocation has been computed yet; ${roleId} is not staffed`
            : `no agent is allocated to ${roleId} (allocation gen ${generation})`,
        requesterAgentId: requester,
        evidence,
        classSource,
      });
    }

    const holderIds = holders.map((holder) => holder.agentId);
    if (requester !== null && holderIds.includes(requester)) {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId,
        outcome: "local_requester_owns",
        reason: `requester already holds ${roleId}; routing to it would be a no-op`,
        requesterAgentId: requester,
        evidence,
        classSource,
      });
    }

    const pendingWorkId = trimmed(request?.workId);
    if (pendingWorkId !== undefined && this.hasWorkIdInFlight(pendingWorkId)) {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId,
        outcome: "local_at_capacity",
        reason: `work id '${pendingWorkId}' is already in flight; not queued twice`,
        requesterAgentId: requester,
        evidence,
        classSource,
      });
    }

    // Never hand a job to a holder that is already at its ceiling. Two
    // ceilings apply, and the second is the allocator's, not a copy of it: the
    // in-flight ledger here, and the load ceiling that `scorePair` gates on.
    // A holder past either is skipped and the next eligible one is tried; when
    // none is left the job runs locally rather than joining a backlog.
    const considered: RoutingSkip[] = [];
    const available = this.pickHolder(holders, considered);
    if (available === null) {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId,
        outcome: "local_at_capacity",
        reason: `no ${roleId} holder is free (${described(considered)})`,
        requesterAgentId: requester,
        evidence,
        classSource,
        considered,
      });
    }
    if (this.inFlight.size >= this.options.maxInFlight) {
      return this.decideLocal({
        jobId,
        workClass,
        scope,
        roleId,
        outcome: "local_at_capacity",
        reason: `routing ledger is full at ${this.options.maxInFlight} in-flight job(s); refusing to queue`,
        requesterAgentId: requester,
        evidence,
        classSource,
      });
    }

    // Routed. The report addressee is the whole point of a broad job being
    // handed over: the specialist owes the result back to the requester.
    const decision: RouteDecision = {
      jobId,
      routed: true,
      outcome: "routed",
      workClass,
      classSource,
      scope,
      roleId,
      agentId: available,
      requesterAgentId: requester,
      evidence,
      considered,
      reason:
        requester === null
          ? `broad ${workClass} routed to ${available} (${roleId})`
          : `broad ${workClass} routed to ${available} (${roleId}), reported back to ${requester}`,
      report: { to: requester, required: requester !== null },
      decidedAt: Date.now(),
    };

    this.inFlight.set(jobId, {
      jobId,
      workId: pendingWorkId ?? null,
      roleId,
      agentId: available,
      requesterAgentId: requester,
      workClass,
      scope,
      startedAt: decision.decidedAt,
    });
    return this.record(decision);
  }

  /**
   * Chooses among the allocator's holders: least busy first, then the higher
   * allocation score the allocator already computed, then id for determinism.
   *
   * `holders` arrives in score rank from the allocator, and each entry carries
   * the score it was assigned, so the ordering is re-used rather than
   * recomputed — rescoring here would be a second allocation pass. A holder the
   * allocator no longer knows is skipped, because the allocation can be older
   * than the agent registry.
   */
  private pickHolder(holders: readonly RoleAssignment[], considered: RoutingSkip[]): string | null {
    let best: { agentId: string; busy: number; score: number } | null = null;
    for (const holder of holders) {
      const availability = this.source.agentAvailability(holder.agentId);
      if (availability === undefined) {
        considered.push({
          agentId: holder.agentId,
          reason: "no longer known to the allocator",
        });
        continue;
      }
      if (!availability.available) {
        considered.push({
          agentId: holder.agentId,
          reason: `load ${availability.load.toFixed(2)} at or above ceiling ${availability.loadCeiling.toFixed(2)}`,
        });
        continue;
      }
      const busy = this.inFlightFor(holder.agentId);
      if (busy >= this.options.maxInFlightPerAgent) {
        considered.push({
          agentId: holder.agentId,
          reason: `already running ${busy} of ${this.options.maxInFlightPerAgent} allowed job(s)`,
        });
        continue;
      }
      if (
        best === null ||
        busy < best.busy ||
        (busy === best.busy && holder.score > best.score) ||
        (busy === best.busy && holder.score === best.score && holder.agentId < best.agentId)
      ) {
        best = { agentId: holder.agentId, busy, score: holder.score };
      }
    }
    return best?.agentId ?? null;
  }

  private decideLocal(params: {
    jobId: string;
    workClass: WorkClass;
    scope: WorkScope;
    roleId: SwarmRoleId | null;
    outcome: RouteOutcome;
    reason: string;
    requesterAgentId: string | null;
    evidence: string[];
    classSource: RouteDecision["classSource"];
    considered?: RoutingSkip[];
  }): RouteDecision {
    return this.record({
      jobId: params.jobId,
      routed: false,
      outcome: params.outcome,
      workClass: params.workClass,
      classSource: params.classSource,
      scope: params.scope,
      roleId: params.roleId,
      // Local work is done by whoever asked, which is the point: the swarm's
      // behaviour is unchanged for every job that does not get handed over.
      agentId: params.requesterAgentId,
      requesterAgentId: params.requesterAgentId,
      evidence: params.evidence,
      considered: params.considered ? params.considered.map((skip) => ({ ...skip })) : [],
      reason: params.reason,
      report: { to: params.requesterAgentId, required: false },
      decidedAt: Date.now(),
    });
  }

  /** Retains the decision in a bounded ring and notifies the host hook. */
  private record(decision: RouteDecision): RouteDecision {
    this.events.push({ kind: "decision", decision: copyDecision(decision) });
    this.trim();
    try {
      this.options.onDecision?.(copyDecision(decision));
    } catch {
      // A logging sink that throws is not allowed to fail a routing decision.
    }
    return decision;
  }

  /** The public close-out: find the job, then close it. Null when unknown. */
  private report(jobId: string, result: RouteResult): RouteReportRecord | null {
    const job = this.inFlight.get(jobId.trim());
    if (!job) return null;
    return this.close(job, result);
  }

  /**
   * Frees the slot and records the result as a report the requester can read.
   * The failure reason is history only: `RoleAllocator.fail` owns failure
   * bookkeeping, and the router writes no allocator state behind the caller's
   * back.
   */
  private close(job: InFlightJob, result: RouteResult): RouteReportRecord {
    this.inFlight.delete(job.jobId);
    const at = Date.now();
    const report: RouteReportRecord = {
      jobId: job.jobId,
      to: job.requesterAgentId,
      workClass: job.workClass,
      roleId: job.roleId,
      agentId: job.agentId,
      ok: result.ok,
      summary: result.summary,
      detail: result.detail,
      startedAt: job.startedAt,
      reportedAt: at,
    };
    this.events.push({ kind: "released", job: { ...job }, at, reason: result.summary });
    this.events.push({ kind: "reported", report: { ...report } });
    this.trim();
    try {
      this.options.onReport?.({ ...report });
    } catch {
      // Same rule as the decision hook: the sink cannot fail the close-out.
    }
    return report;
  }

  /** The one place the history ring is bounded. */
  private trim(): void {
    while (this.events.length > this.options.retainDecisions) this.events.shift();
  }

  /** True when a caller work id is already being handled; blocks double-queue. */
  private hasWorkIdInFlight(workId: string): boolean {
    for (const job of this.inFlight.values()) if (job.workId === workId) return true;
    return false;
  }

  private nextJobId(): string {
    this.sequence += 1;
    return `work-${this.sequence}`;
  }
}

function copyDecision(decision: RouteDecision): RouteDecision {
  return {
    ...decision,
    evidence: [...decision.evidence],
    considered: decision.considered.map((skip) => ({ ...skip })),
    report: { ...decision.report },
  };
}

function copyEvent(event: RouterEvent): RouterEvent {
  if (event.kind === "decision") {
    return { kind: "decision", decision: copyDecision(event.decision) };
  }
  if (event.kind === "released") {
    return { kind: "released", job: { ...event.job }, at: event.at, reason: event.reason };
  }
  return { kind: "reported", report: { ...event.report } };
}

function trimmed(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "a: busy, b: at its load ceiling" — the skip list as one readable clause. */
function described(skips: readonly RoutingSkip[]): string {
  return skips.length === 0
    ? "no holders to choose from"
    : skips.map((skip) => `${skip.agentId}: ${skip.reason}`).join(", ");
}

/** The class of a job, from the requester's own words. */
function classify(text: string): { workClass: WorkClass; evidence: string[] } {
  for (const entry of CLASS_PATTERNS) {
    const terms = firstTerms(text, entry.patterns, 2);
    if (terms.length > 0) return { workClass: entry.workClass, evidence: terms };
  }
  return { workClass: "general", evidence: [] };
}

/**
 * Whether a job is broad or narrow, by rule:
 *   1. an explicit scoping clause wins — "all the tests for the files I
 *      changed" contains both vocabularies and means the narrow one;
 *   2. otherwise whole-repo language means broad;
 *   3. otherwise paths in hand mean narrow (a run scoped to known paths is
 *      scoped, whatever it was called);
 *   4. otherwise `unclear`, which routes nowhere — an ambiguous scope runs
 *      locally, i.e. exactly as it did before this module existed.
 */
function classifyScope(text: string, touchedPaths: readonly string[] | undefined): WorkScope {
  const narrowText = firstTerm(text, NARROW_PATTERNS);
  if (narrowText !== null) return "narrow";
  if (firstTerm(text, BROAD_PATTERNS) !== null) return "broad";
  if (Array.isArray(touchedPaths) && touchedPaths.length > 0) return "narrow";
  return "unclear";
}
