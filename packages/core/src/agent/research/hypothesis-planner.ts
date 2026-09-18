/**
 * Hypothesis planner.
 *
 * Recursive query expansion for research questions. A research question is decomposed
 * into sub-questions, each sub-question into falsifiable hypotheses, and each
 * hypothesis into the evidence that would confirm or refute it. The result is a DAG,
 * not a tree: two hypotheses may share an evidence requirement, and the planner
 * records the shared dependencies so the research loop fetches each source once.
 *
 * Deliberately distinct from `query-partitioner.ts`, which decomposes a *task* into
 * specialist roles. That module decides who does the work; this one decides what
 * would have to be true for an answer to stand.
 */

export type QuestionOrigin = "root" | "expansion" | "contradiction" | "gap";

export interface ResearchQuestion {
  readonly id: string;
  readonly text: string;
  readonly depth: number;
  readonly origin: QuestionOrigin;
  readonly parentId?: string;
  /** Sub-question ids. */
  readonly children: string[];
  /** Hypothesis ids attached to this question. */
  readonly hypotheses: string[];
  /** Terms to search to answer this question. */
  readonly searchTerms: string[];
  readonly createdAt: number;
}

export type HypothesisStatus = "untested" | "supported" | "refuted" | "partial" | "unverifiable";

export interface Hypothesis {
  readonly id: string;
  readonly questionId: string;
  /** The claim, phrased so that evidence can contradict it. */
  readonly statement: string;
  /** What would have to be observed for the hypothesis to hold. */
  readonly prediction: string;
  /** What would refute it. */
  readonly falsifier: string;
  /** Evidence requirement ids that bear on this hypothesis. */
  readonly evidenceIds: string[];
  readonly status: HypothesisStatus;
  /** Confidence in [0, 1] after evidence was assessed. */
  readonly confidence: number;
  readonly priority: number;
}

export interface EvidenceRequirement {
  readonly id: string;
  /** Short name of the needed artefact. */
  readonly description: string;
  /** Paper titles, DOIs or queries that could supply it. */
  readonly candidateSources: string[];
  /** Hypothesis ids that depend on this evidence. */
  readonly dependantHypotheses: string[];
  readonly fetched: boolean;
  readonly sourceId?: string;
}

export interface HypothesisPlan {
  readonly root: ResearchQuestion;
  readonly questions: ReadonlyMap<string, ResearchQuestion>;
  readonly hypotheses: ReadonlyMap<string, Hypothesis>;
  readonly evidence: ReadonlyMap<string, EvidenceRequirement>;
  /** Questions with no remaining untested hypotheses. */
  readonly settled: string[];
  /** Questions that still need evidence. */
  readonly open: string[];
  /** Depth of the deepest expansion chain. */
  readonly depth: number;
  /** Shared evidence requirements — fetched once, used many times. */
  readonly sharedEvidence: string[];
}

export interface HypothesisPlannerOptions {
  /** Maximum recursion depth for question expansion. */
  readonly maxDepth?: number;
  /** Maximum sub-questions per question. */
  readonly maxBranching?: number;
  /** Maximum hypotheses per question. */
  readonly maxHypothesesPerQuestion?: number;
  /** Number of search terms generated per question. */
  readonly searchTermsPerQuestion?: number;
  /** Terminates expansion when a question is narrower than this (in tokens). */
  readonly minQuestionTokens?: number;
}

export class HypothesisPlanner {
  private questions = new Map<string, ResearchQuestion>();
  private hypotheses = new Map<string, Hypothesis>();
  private evidence = new Map<string, EvidenceRequirement>();
  private counter = 0;
  private rootId?: string;

  private readonly maxDepth: number;
  private readonly maxBranching: number;
  private readonly maxHypotheses: number;
  private readonly searchTermsPerQuestion: number;

  constructor(options: HypothesisPlannerOptions = {}) {
    this.maxDepth = options.maxDepth ?? 3;
    this.maxBranching = options.maxBranching ?? 4;
    this.maxHypotheses = options.maxHypothesesPerQuestion ?? 3;
    this.searchTermsPerQuestion = options.searchTermsPerQuestion ?? 3;
  }

  /** Seeds the plan with the root research question and returns its id. */
  plant(rootQuestion: string): string {
    const id = this.allocateId("q");
    const terms = generateSearchTerms(rootQuestion, this.searchTermsPerQuestion);
    this.rootId = id;
    this.questions.set(id, {
      id,
      text: rootQuestion.trim(),
      depth: 0,
      origin: "root",
      children: [],
      hypotheses: [],
      searchTerms: terms,
      createdAt: this.counter,
    });
    return id;
  }

  /**
   * Recursively expands a question into sub-questions, hypotheses and evidence
   * requirements. Deterministic: the same input yields the same plan, so a plan can
   * be diffed against an earlier one to see what an expansion pass changed.
   */
  expand(questionId: string, subQuestions?: string[]): HypothesisPlan {
    const question = this.questions.get(questionId);
    if (!question) throw new Error(`Unknown question: ${questionId}`);

    const hypotheses = this.attachHypotheses(question);
    for (const hypothesis of hypotheses) this.linkEvidence(hypothesis);

    if (question.depth >= this.maxDepth) return this.plan();

    const expansion = subQuestions ?? decomposeQuestion(question.text);
    let added = 0;
    for (const subText of expansion) {
      if (added >= this.maxBranching) break;
      const trimmed = subText.trim();
      if (trimmed.length < 8) continue;
      if (this.existsEquivalent(trimmed)) continue;

      const id = this.allocateId("q");
      const child: ResearchQuestion = {
        id,
        text: trimmed,
        depth: question.depth + 1,
        origin: "expansion",
        parentId: questionId,
        children: [],
        hypotheses: [],
        searchTerms: generateSearchTerms(trimmed, this.searchTermsPerQuestion),
        createdAt: this.counter,
      };
      this.questions.set(id, child);
      // Re-read the question: attachHypotheses above may already have updated it, and
      // writing from the stale snapshot would wipe that update.
      const current = this.questions.get(questionId);
      if (current)
        this.questions.set(questionId, { ...current, children: [...current.children, id] });
      added += 1;
    }

    return this.plan();
  }

  /** Expands the whole plan to the configured depth in one pass. */
  expandAll(rootQuestion: string, overrides?: ReadonlyMap<string, string[]>): HypothesisPlan {
    const root = this.rootId ?? this.plant(rootQuestion);
    let frontier = [root];
    for (let depth = 0; depth <= this.maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const question = this.questions.get(id);
        if (!question) continue;
        if (question.hypotheses.length === 0) this.expand(id, overrides?.get(id));
        next.push(...(this.questions.get(id)?.children ?? []));
      }
      frontier = next;
    }
    return this.plan();
  }

  private attachHypotheses(question: ResearchQuestion): Hypothesis[] {
    if (question.hypotheses.length > 0) {
      return question.hypotheses.map((id) => this.hypotheses.get(id)!).filter(Boolean);
    }

    const candidates = draftHypotheses(question.text).slice(0, this.maxHypotheses);
    const created: Hypothesis[] = [];
    for (const candidate of candidates) {
      const id = this.allocateId("h");
      const hypothesis: Hypothesis = {
        id,
        questionId: question.id,
        statement: candidate.statement,
        prediction: candidate.prediction,
        falsifier: candidate.falsifier,
        evidenceIds: [],
        status: "untested",
        confidence: 0,
        priority: candidate.priority,
      };
      this.hypotheses.set(id, hypothesis);
      created.push(hypothesis);
    }
    this.questions.set(question.id, { ...question, hypotheses: created.map((h) => h.id) });
    return created;
  }

  private linkEvidence(hypothesis: Hypothesis): void {
    // Evidence is described in terms of the *question's* subject rather than each
    // hypothesis's own statement: sibling hypotheses answer the same question, so the
    // primary source that bears on one bears on the others, and sharing the requirement
    // is what makes the loop fetch that source once.
    const question = this.questions.get(hypothesis.questionId);
    const subject = question ? extractSubject(question.text) : extractSubject(hypothesis.statement);
    const requirements = evidenceFor(hypothesis, subject);
    const ids: string[] = [];
    for (const requirement of requirements) {
      const existing = this.findEvidence(requirement.description);
      if (existing) {
        ids.push(existing.id);
        this.evidence.set(existing.id, {
          ...existing,
          dependantHypotheses: [...new Set([...existing.dependantHypotheses, hypothesis.id])],
        });
        continue;
      }
      const id = this.allocateId("e");
      this.evidence.set(id, {
        id,
        description: requirement.description,
        candidateSources: requirement.candidateSources,
        dependantHypotheses: [hypothesis.id],
        fetched: false,
      });
      ids.push(id);
    }
    this.hypotheses.set(hypothesis.id, { ...hypothesis, evidenceIds: ids });
  }

  private findEvidence(description: string): EvidenceRequirement | undefined {
    const key = normalise(description);
    for (const requirement of this.evidence.values()) {
      if (normalise(requirement.description) === key) return requirement;
    }
    return undefined;
  }

  private existsEquivalent(text: string): boolean {
    const key = normalise(text);
    for (const question of this.questions.values()) {
      if (normalise(question.text) === key) return true;
    }
    return false;
  }

  private allocateId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString(36)}`;
  }

  /** Records an evidence fetch result and updates hypothesis statuses. */
  recordEvidence(evidenceId: string, sourceId: string, assessment: EvidenceAssessment): void {
    const requirement = this.evidence.get(evidenceId);
    if (!requirement) return;
    this.evidence.set(evidenceId, { ...requirement, fetched: true, sourceId });

    for (const hypothesisId of requirement.dependantHypotheses) {
      const hypothesis = this.hypotheses.get(hypothesisId);
      if (!hypothesis) continue;
      const status: HypothesisStatus =
        assessment === "supports"
          ? "supported"
          : assessment === "contradicts"
            ? "refuted"
            : "partial";
      const confidence =
        assessment === "supports"
          ? Math.min(1, hypothesis.confidence + 0.34)
          : assessment === "contradicts"
            ? Math.max(0, hypothesis.confidence - 0.5)
            : hypothesis.confidence;
      this.hypotheses.set(hypothesisId, { ...hypothesis, status, confidence });
    }
  }

  plan(): HypothesisPlan {
    const root = this.questions.get(this.rootId ?? "");
    const settled: string[] = [];
    const open: string[] = [];
    let depth = 0;

    for (const question of this.questions.values()) {
      depth = Math.max(depth, question.depth);
      const statuses = question.hypotheses.map(
        (id) => this.hypotheses.get(id)?.status ?? "untested",
      );
      const tested = statuses.filter((status) => status !== "untested");
      if (statuses.length > 0 && tested.length === statuses.length) settled.push(question.id);
      else if (question.hypotheses.length > 0) open.push(question.id);
    }

    const counts = new Map<string, number>();
    for (const requirement of this.evidence.values()) {
      if (requirement.dependantHypotheses.length > 1)
        counts.set(requirement.id, requirement.dependantHypotheses.length);
    }

    return {
      root: root ?? {
        id: "",
        text: "",
        depth: 0,
        origin: "root",
        children: [],
        hypotheses: [],
        searchTerms: [],
        createdAt: 0,
      },
      questions: this.questions,
      hypotheses: this.hypotheses,
      evidence: this.evidence,
      settled,
      open,
      depth,
      sharedEvidence: [...counts.keys()],
    };
  }
}

export type EvidenceAssessment = "supports" | "contradicts" | "partial";

/**
 * Decomposes a research question into sub-questions. Split on the question's own
 * conjunctions and comparison axes, and always add a "what is known / what is
 * unknown / what is contested" triple, because a research loop that only asks the
 * first never finds the gaps.
 */
export function decomposeQuestion(question: string): string[] {
  const trimmed = question.trim().replace(/\?+$/, "");
  if (!trimmed) return [];

  const out: string[] = [];
  const clauses = trimmed
    .split(/;|\b(?:and also|as well as|versus|vs\.?|compared to|relative to)\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).length >= 2);

  for (const clause of clauses) out.push(`${clause}?`);

  const subject = extractSubject(trimmed);
  out.push(`What is established about ${subject}?`);
  out.push(`What is unknown or unmeasured about ${subject}?`);
  out.push(`What claims about ${subject} are contested or contradictory?`);

  return [...new Set(out)].slice(0, 6);
}

function extractSubject(question: string): string {
  const match =
    /^(?:how|what|why|when|where|which|does|do|is|are|can|could|should|would)\s+([^?]+)/i.exec(
      question,
    );
  const subject = match?.[1] ?? question;
  return subject.trim().replace(/\s+/g, " ").slice(0, 120);
}

interface DraftHypothesis {
  readonly statement: string;
  readonly prediction: string;
  readonly falsifier: string;
  readonly priority: number;
}

/**
 * Drafts falsifiable hypotheses from a question. These are structural — the planner
 * is deterministic and has no model access — so it formulates the hypothesis shapes a
 * question admits (existence, monotonic effect, threshold, comparative) and leaves the
 * substantive claim text to the research loop's synthesis step.
 */
export function draftHypotheses(question: string): DraftHypothesis[] {
  const subject = extractSubject(question);
  const lower = question.toLowerCase();

  const hypotheses: DraftHypothesis[] = [
    {
      statement: `A method addressing ${subject} exists and is reported in the literature.`,
      prediction: `At least one primary source describes a method for ${subject} with measurable outcomes.`,
      falsifier: `No primary source describes a method for ${subject} with measurable outcomes.`,
      priority: 3,
    },
    {
      statement: `${capitalize(subject)} admits a measurable improvement over the prevailing baseline.`,
      prediction: `A primary source reports a quantitative improvement over a named baseline.`,
      falsifier: `Primary sources report no improvement, or report improvements that do not survive verification.`,
      priority: 2,
    },
  ];

  if (/(trade-?off|versus|vs\.?|balance|cost|efficiency)/i.test(lower)) {
    hypotheses.push({
      statement: `${capitalize(subject)} exhibits a trade-off rather than a dominant option.`,
      prediction: `Primary sources disagree on the ranking, or each side wins on a different metric.`,
      falsifier: `Primary sources agree on a single dominant option across every reported metric.`,
      priority: 2,
    });
  }

  if (/(scale|scaling|size|large|bigger|more data)/i.test(lower)) {
    hypotheses.push({
      statement: `${capitalize(subject)} behaves monotonically as scale increases.`,
      prediction: `A primary source reports the effect at multiple scales with a consistent direction.`,
      falsifier: `The reported effect reverses or vanishes at some scale.`,
      priority: 1,
    });
  }

  return hypotheses;
}

interface EvidenceDraft {
  readonly description: string;
  readonly candidateSources: string[];
}

/**
 * Evidence that would bear on a hypothesis, with where it could come from.
 *
 * @param subjectOverride the subject the evidence is about. Defaults to the subject of the
 * hypothesis's own statement; the planner overrides it with the question's subject so that
 * sibling hypotheses — which answer the same question — share evidence requirements.
 */
export function evidenceFor(hypothesis: Hypothesis, subjectOverride?: string): EvidenceDraft[] {
  const subject = subjectOverride ?? extractSubject(hypothesis.statement);
  return [
    {
      description: `Primary source stating whether ${subject}`,
      candidateSources: [hypothesis.statement.slice(0, 80), `primary source: ${subject}`],
    },
    {
      description: `Measured outcome for ${subject} with units and a named baseline`,
      candidateSources: [`results section: ${subject}`, `benchmark table: ${subject}`],
    },
    {
      description: `Counter-evidence or failure case for ${subject}`,
      candidateSources: [`limitation: ${subject}`, `reproduction: ${subject}`],
    },
  ];
}

/** Generates deterministic search terms for a question. */
export function generateSearchTerms(question: string, count: number): string[] {
  const subject = extractSubject(question);
  const words = subject.split(/\s+/).filter((word) => word.length > 3);
  const keyphrase = words.slice(0, 5).join(" ");
  const terms = [
    subject.slice(0, 100),
    `${keyphrase} benchmark`,
    `${keyphrase} survey`,
    `${words[0] ?? keyphrase} arxiv`,
    `${keyphrase} empirical comparison`,
  ];
  return [...new Set(terms)].slice(0, Math.max(1, count));
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
