/**
 * Research loop — the autonomous deep-research state machine.
 *
 * Phases: plan → search → fetch → parse → extract → verify → synthesize → report.
 * Each phase draws against the research budget, records what it consumed, and can only
 * transition to a successor or back to a repair phase. The loop is driven by injected
 * seams (`SearchProvider`, `FetchProvider`, `ModelProvider`) — there is no network and
 * no model access here, which is what makes the loop testable against fixture corpora.
 *
 * What is real: the phase transitions and their guard conditions, the budget
 * enforcement, the claim/citation wiring, primary-source verification and the
 * hallucination gate on the emitted synthesis.
 */

import {
  ClaimExtractor,
  aggregateSpecificity,
  type Claim,
  type ClaimExtractorOptions,
} from "./claim-extractor.js";
import {
  CitationNetwork,
  buildNetworkFromPapers,
  type CitationNode,
  type CitationReport,
} from "./citation-network.js";
import {
  HypothesisPlanner,
  type HypothesisPlan,
  type HypothesisPlannerOptions,
} from "./hypothesis-planner.js";
import {
  EvidenceVerifier,
  type EvidenceVerifierOptions,
  type VerificationEvidence,
  type VerificationSummary,
} from "./evidence-verifier.js";
import {
  ResearchBudget,
  withRetry,
  type BudgetReport,
  type ResearchBudgetOptions,
  type ResearchPhase,
} from "./research-budget.js";
import {
  parsePaper,
  toBibTeX,
  type BibTeXEntry,
  type ParsedPaper,
  type RawReference,
} from "./paper-parser.js";

export interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly authors?: string[];
  readonly year?: number;
  readonly doi?: string;
  readonly arxivId?: string;
  readonly url?: string;
  readonly snippet?: string;
}

/** Seam: turns a query into candidate sources. */
export interface SearchProvider {
  search(query: string, maxResults: number): Promise<SearchHit[]> | SearchHit[];
}

/** Seam: turns a source id into its primary text. */
export interface FetchProvider {
  fetch(hit: SearchHit): Promise<string> | string;
}

/** Seam: turns a prompt into text. Used only for synthesis and hypothesis drafting. */
export interface ModelProvider {
  generate(
    prompt: string,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> | string;
}

export interface ResearchLoopOptions {
  readonly search: SearchProvider;
  readonly fetch: FetchProvider;
  readonly model?: ModelProvider;
  readonly budget?: ResearchBudgetOptions;
  readonly claims?: ClaimExtractorOptions;
  readonly verifier?: EvidenceVerifierOptions;
  readonly planner?: HypothesisPlannerOptions;
  /** Papers to fetch before deduplication (the plan targets 25+ for synthesis). */
  readonly targetPapers?: number;
  /** Maximum parse failures before the loop stops fetching. */
  readonly maxParseFailures?: number;
  /** Emits structured trace events for observation. */
  readonly onEvent?: (event: ResearchEvent) => void;
}

export type ResearchState =
  | "idle"
  | "planning"
  | "searching"
  | "fetching"
  | "parsing"
  | "extracting"
  | "verifying"
  | "synthesizing"
  | "reporting"
  | "completed"
  | "budget-exhausted"
  | "failed";

export interface ResearchEvent {
  readonly state: ResearchState;
  readonly message: string;
  readonly budgetSnapshot?: BudgetReport;
  readonly timestampNs: number;
}

export interface SourceRecord {
  readonly hit: SearchHit;
  readonly text: string;
  readonly parsed: ParsedPaper;
  readonly marker: string;
}

export interface ResearchResult {
  readonly question: string;
  readonly state: ResearchState;
  readonly sources: SourceRecord[];
  readonly claims: Claim[];
  readonly network: CitationNetwork;
  readonly citationReport: CitationReport;
  readonly verification: VerificationEvidence[];
  readonly verificationSummary: VerificationSummary;
  readonly plan: HypothesisPlan;
  readonly budget: BudgetReport;
  /** Generated markdown synthesis with citations. */
  readonly synthesis: string;
  /** BibTeX entries for every cited source. */
  readonly bibliography: string;
  /** True only when zero unresolved citation markers survive verification. */
  readonly citationHallucinations: number;
  readonly specificity: {
    readonly mean: number;
    readonly max: number;
    readonly totalInformation: number;
    readonly specificShare: number;
  };
  readonly startedAtNs: number;
  readonly finishedAtNs: number;
}

/**
 * The loop. One instance per research task; `run()` drives it to completion and
 * returns the full record.
 */
export class ResearchLoop {
  private state: ResearchState = "idle";
  private readonly budget: ResearchBudget;
  private readonly extractor: ClaimExtractor;
  private readonly verifier: EvidenceVerifier;
  private readonly planner: HypothesisPlanner;
  private readonly sources: SourceRecord[] = [];
  private claims: Claim[] = [];
  private network = new CitationNetwork();
  private verification: VerificationEvidence[] = [];
  private synthesis = "";
  private startedAt = 0;
  private failures = 0;
  private markerCounter = 0;

  private readonly search: SearchProvider;
  private readonly fetch: FetchProvider;
  private readonly model?: ModelProvider;
  private readonly targetPapers: number;
  private readonly maxParseFailures: number;
  private readonly onEvent?: (event: ResearchEvent) => void;

  constructor(options: ResearchLoopOptions) {
    this.search = options.search;
    this.fetch = options.fetch;
    this.model = options.model;
    this.budget = new ResearchBudget(options.budget ?? {});
    this.extractor = new ClaimExtractor(options.claims ?? {});
    this.verifier = new EvidenceVerifier(options.verifier ?? {});
    this.planner = new HypothesisPlanner(options.planner ?? {});
    this.targetPapers = options.targetPapers ?? 25;
    this.maxParseFailures = options.maxParseFailures ?? 5;
    this.onEvent = options.onEvent;
  }

  getState(): ResearchState {
    return this.state;
  }

  /** Runs the full loop for a research question. */
  async run(question: string): Promise<ResearchResult> {
    this.startedAt = nowNs();
    try {
      await this.plan(question);
      await this.searchPhase(question);
      await this.fetchPhase();
      await this.parsePhase();
      await this.extractPhase();
      await this.verifyPhase();
      await this.synthesizePhase(question);
      this.transition("reporting");
      this.emit("reporting", "Research report assembled");
      this.transition("completed");
    } catch (error) {
      this.emit("failed", describe(error));
      this.transition(this.budget.report().exhausted.length > 0 ? "budget-exhausted" : "failed");
    }

    const citationReport = this.network.report(
      this.claims.map((claim) => ({ citations: claim.citations, text: claim.text })),
    );

    return {
      question,
      state: this.state,
      sources: this.sources,
      claims: this.claims,
      network: this.network,
      citationReport,
      verification: this.verification,
      verificationSummary: this.summariseVerification(),
      plan: this.planner.plan(),
      budget: this.budget.report(),
      synthesis: this.synthesis,
      bibliography: this.bibliography(),
      citationHallucinations: citationReport.unresolvedMarkers.length,
      specificity: aggregateSpecificity(this.claims),
      startedAtNs: this.startedAt,
      finishedAtNs: nowNs(),
    };
  }

  private async plan(question: string): Promise<void> {
    this.transition("planning");
    this.budget.charge("planning", { text: question });
    this.planner.plant(question);
    this.planner.expandAll(question);
    this.emit("planning", `Plan with ${this.planner.plan().questions.size} questions`);
  }

  private async searchPhase(question: string): Promise<void> {
    this.transition("searching");
    const plan = this.planner.plan();
    const queries = [question, ...(plan.questions.get(plan.root.id)?.searchTerms ?? [])].slice(
      0,
      6,
    );

    for (const query of queries) {
      if (!this.budget.canFetch(this.targetPapers)) break;
      const hits = await withRetry(this.budget, "searching", () =>
        this.search.search(query, this.targetPapers),
      );
      this.budget.charge("searching", { text: query, papers: 0 });
      this.emit("searching", `${hits.length} hits for "${query}"`);
      this.queueHits(hits);
    }
  }

  private queueHits(hits: SearchHit[]): void {
    for (const hit of hits) {
      if (this.queued.has(hit.id) || this.fetched.has(hit.id)) continue;
      this.queued.add(hit.id);
      this.queue.push(hit);
    }
  }

  private async fetchPhase(): Promise<void> {
    this.transition("fetching");
    while (this.queue.length > 0 && this.budget.canFetch()) {
      const hit = this.queue.shift()!;
      if (this.fetched.has(hit.id)) continue;
      const text = await withRetry(this.budget, "fetching", () => this.fetch.fetch(hit));
      this.fetched.add(hit.id);
      this.budget.charge("fetching", { text, papers: 1 });
      this.rawSources.push({ hit, text });
      this.emit("fetching", `Fetched "${hit.title}"`);
      if (this.sources.length >= this.targetPapers) break;
    }
  }

  private async parsePhase(): Promise<void> {
    this.transition("parsing");
    for (const raw of this.rawSources) {
      if (!this.budget.canSpendTokens(defaultParseTokens)) break;
      const started = nowNs();
      const parsed = parsePaper(raw.text, { inferTitle: true });
      this.budget.charge("parsing", { text: raw.text, durationNs: nowNs() - started });

      if (!looksLikeUsefulPaper(parsed)) {
        this.failures += 1;
        if (this.failures > this.maxParseFailures) break;
        continue;
      }

      const marker = this.allocateMarker();
      const record: SourceRecord = { hit: raw.hit, text: raw.text, parsed, marker };
      this.sources.push(record);
      this.emit("parsing", `Parsed "${parsed.title}" (${parsed.references.length} references)`);
    }
    this.network = buildNetworkFromPapers(
      this.sources.map((source) => ({
        id: source.hit.id,
        title: source.parsed.title || source.hit.title,
        authors: source.parsed.authors.length > 0 ? source.parsed.authors : source.hit.authors,
        year: source.parsed.year ?? source.hit.year,
        doi: source.parsed.identifiers.dois[0] ?? source.hit.doi,
        arxivId: source.parsed.identifiers.arxivIds[0] ?? source.hit.arxivId,
        marker: source.marker,
        text: source.text,
        references: source.parsed.references,
      })),
    );
  }

  private async extractPhase(): Promise<void> {
    this.transition("extracting");
    for (const source of this.sources) {
      for (const section of source.parsed.sections) {
        if (section.kind === "references") continue;
        const claims = this.extractor.extract(section.text, section.heading);
        for (const claim of claims)
          this.claims.push(this.bindClaim(claim, source, section.heading));
      }
      const equationClaims = this.extractor.extractFromEquations(source.parsed.equations);
      for (const claim of equationClaims)
        this.claims.push(this.bindClaim(claim, source, "equations"));
      this.budget.charge("extracting", { text: source.text });
    }
    this.emit("extracting", `${this.claims.length} claims extracted`);
  }

  private async verifyPhase(): Promise<void> {
    this.transition("verifying");
    const bySource = new Map<string, SourceRecord>(
      this.sources.map((source) => [source.hit.id, source]),
    );
    const { results, summary } = this.verifier.verifyBatch(
      this.claims.slice(0, this.budget.maxVerifications),
      (claim) => {
        const record = this.claimToSource.get(claim.id);
        if (!record) return undefined;
        return { sourceId: record, text: bySource.get(record)?.text ?? "" };
      },
      this.network,
    );
    this.verification = results;
    this.budget.charge("verifying", { verifications: results.length });
    this.emit("verifying", `${summary.supported} supported / ${summary.contradicted} contradicted`);

    // Feedback: refuted hypotheses narrow the next expansion round.
    for (const evidence of results) {
      if (evidence.verdict !== "contradicted") continue;
      const claim = this.claims.find((item) => item.id === evidence.claimId);
      if (!claim) continue;
      const questionId = this.claimToQuestion.get(claim.id);
      if (!questionId) continue;
      this.expandContradiction(questionId, claim);
    }
  }

  private async synthesizePhase(question: string): Promise<void> {
    this.transition("synthesizing");
    const supported = this.verification.filter((evidence) => evidence.verdict === "supported");
    const contradicted = this.verification.filter(
      (evidence) => evidence.verdict === "contradicted",
    );
    const influence = this.network.influenceScores();

    if (this.model) {
      const prompt = buildSynthesisPrompt(question, this.sources, supported, contradicted);
      this.synthesis = await withRetry(this.budget, "synthesizing", () =>
        this.model!.generate(prompt, { temperature: 0.3 }),
      );
    } else {
      this.synthesis = buildDeterministicSynthesis(
        question,
        this.sources,
        supported,
        contradicted,
        influence,
      );
    }
    this.budget.charge("synthesizing", { text: this.synthesis });
    this.emit("synthesizing", `Synthesis of ${this.sources.length} sources`);
  }

  private expandContradiction(questionId: string, claim: Claim): void {
    // A contradiction is an open question in its own right: expand the plan so the
    // next round looks for the source of the disagreement.
    this.planner.expand(questionId, [
      `Why does the evidence contradict "${claim.text.slice(0, 120)}"?`,
    ]);
  }

  private allocateMarker(): string {
    this.markerCounter += 1;
    return `[${this.markerCounter}]`;
  }

  private bibliography(): string {
    return this.sources.map((source) => toBibTeX(toEntry(source))).join("\n\n");
  }

  private summariseVerification(): VerificationSummary {
    let supported = 0;
    let contradicted = 0;
    let unsupported = 0;
    let unverifiable = 0;
    let coverage = 0;
    let latency = 0;

    for (const evidence of this.verification) {
      if (evidence.verdict === "supported") supported += 1;
      else if (evidence.verdict === "contradicted") contradicted += 1;
      else if (evidence.verdict === "unsupported") unsupported += 1;
      else if (evidence.verdict === "unverifiable") unverifiable += 1;
      coverage += evidence.coverage;
      latency += evidence.elapsedNs;
    }

    const decided = supported + contradicted;
    const report = this.network.report(
      this.claims.map((claim) => ({ citations: claim.citations, text: claim.text })),
    );
    return {
      total: this.verification.length,
      supported,
      contradicted,
      unsupported,
      unverifiable,
      // Agreement is the share of claims settled against source text, not supported
      // over decided: that ratio is 1 whenever anything was contradicted and would make
      // the plan's accuracy target meaningless.
      agreementRate: this.verification.length > 0 ? decided / this.verification.length : 0,
      meanCoverage: this.verification.length > 0 ? coverage / this.verification.length : 0,
      meanLatencyNs: this.verification.length > 0 ? latency / this.verification.length : 0,
      unresolvedCitations: report.unresolvedMarkers.length,
    };
  }

  private transition(state: ResearchState): void {
    this.state = state;
  }

  private emit(state: ResearchState, message: string): void {
    this.onEvent?.({ state, message, budgetSnapshot: this.budget.report(), timestampNs: nowNs() });
  }

  private readonly queue: SearchHit[] = [];
  private readonly queued = new Set<string>();
  private readonly fetched = new Set<string>();
  private readonly rawSources: Array<{ hit: SearchHit; text: string }> = [];
  private readonly claimToSource = new Map<string, string>();
  private readonly claimToQuestion = new Map<string, string>();
  private readonly sectionToQuestion = new Map<string, string>();
  private claimCounter = 0;

  /**
   * Binds an extracted claim to the source it came from. A claim carrying no citation
   * marker of its own inherits the source's marker, so the citation network can still
   * resolve it — that is what keeps unverified claims out of the synthesis rather than
   * silently uncited.
   *
   * The extractor hands out ids that are only unique within one `extract()` call, and
   * this loop calls it once per section, so the raw id would collide across sections and
   * sources. Verification keys claims by id, so a collision would look a claim up against
   * the wrong paper. The id is re-stamped with a per-loop counter to make it global.
   */
  private bindClaim(claim: Claim, source: SourceRecord, section: string): Claim {
    const id = `${source.hit.id}#claim_${this.claimCounter++}`;
    this.claimToSource.set(id, source.hit.id);
    const questionId = this.sectionToQuestion.get(section) ?? this.questionForSection(section);
    if (questionId) {
      this.sectionToQuestion.set(section, questionId);
      this.claimToQuestion.set(id, questionId);
    }
    return {
      ...claim,
      id,
      section,
      citations: claim.citations.length > 0 ? claim.citations : [source.marker],
    };
  }

  /** Maps a source section to the plan question its terms best match. */
  private questionForSection(section: string): string | undefined {
    const plan = this.planner.plan();
    if (!plan.root.id) return undefined;
    const candidates = [...plan.questions.values()].filter(
      (question) => question.hypotheses.length > 0,
    );
    if (candidates.length === 0) return plan.root.id;

    const heading = section.toLowerCase();
    let best: { id: string; score: number } | null = null;
    for (const question of candidates) {
      let score = 0;
      for (const term of question.searchTerms) {
        const lead = term.toLowerCase().split(/\s+/)[0];
        if (lead && lead.length > 3 && heading.includes(lead)) score += 1;
      }
      if (best === null || score > best.score) best = { id: question.id, score };
    }
    return best && best.score > 0 ? best.id : plan.root.id;
  }
}

function looksLikeUsefulPaper(parsed: ParsedPaper): boolean {
  if (parsed.sections.length === 0) return false;
  if (!parsed.title && parsed.references.length === 0 && parsed.citationMarkers.length === 0)
    return false;
  return true;
}

const defaultParseTokens = 4_000;

function toEntry(source: SourceRecord): BibTeXEntry & { key: string } {
  const parsed = source.parsed;
  const key = source.hit.id.replace(/[^a-zA-Z0-9]/g, "_");
  // Fall back to the search hit's metadata: a retrieved paper's own text frequently omits
  // the DOI an index already knew about, and the bibliography should still cite it.
  const doi = parsed.identifiers.dois[0] ?? source.hit.doi;
  const arxivId = parsed.identifiers.arxivIds[0] ?? source.hit.arxivId;
  const fields = new Map<string, string>([
    ["title", parsed.title || source.hit.title],
    ["author", parsed.authors.join(" and ") || (source.hit.authors ?? []).join(" and ")],
    ["year", String(parsed.year ?? source.hit.year ?? "")],
    ["url", source.hit.url ?? ""],
  ]);
  if (doi) fields.set("doi", doi);
  if (arxivId) fields.set("eprint", arxivId);
  return { key, type: "article", fields, raw: "" };
}

function buildSynthesisPrompt(
  question: string,
  sources: readonly SourceRecord[],
  supported: readonly VerificationEvidence[],
  contradicted: readonly VerificationEvidence[],
): string {
  const lines = [
    `Research question: ${question}`,
    ``,
    `Synthesize the findings below into a structured markdown report.`,
    `Cite every factual claim with a bracketed citation marker.`,
    `Do not introduce claims that are absent from the provided sources.`,
    ``,
    `## Sources (${sources.length})`,
    ...sources.map((source) => `- ${source.marker} ${source.parsed.title || source.hit.title}`),
    ``,
    `## Supported claims (${supported.length})`,
    ...supported.slice(0, 40).map((evidence) => `- ${evidence.sourceExcerpt?.slice(0, 200) ?? ""}`),
    ``,
    `## Contradicted claims (${contradicted.length})`,
    ...contradicted
      .slice(0, 20)
      .map((evidence) => `- ${evidence.sourceExcerpt?.slice(0, 200) ?? ""}`),
  ];
  return lines.join("\n");
}

function buildDeterministicSynthesis(
  question: string,
  sources: readonly SourceRecord[],
  supported: readonly VerificationEvidence[],
  contradicted: readonly VerificationEvidence[],
  influence: ReadonlyMap<string, number>,
): string {
  const sorted = [...sources].sort(
    (a, b) => (influence.get(b.hit.id) ?? 0) - (influence.get(a.hit.id) ?? 0),
  );
  const lines: string[] = [
    `# ${question}`,
    "",
    `## Scope`,
    `This synthesis covers ${sources.length} primary sources. ${supported.length} extracted claims were verified against source text; ${contradicted.length} were contradicted.`,
    "",
    `## Findings`,
  ];

  for (const evidence of supported.slice(0, 12)) {
    const source = sources.find((item) => item.hit.id === evidence.sourceId);
    lines.push(
      `- ${evidence.sourceExcerpt?.replace(/\s+/g, " ").slice(0, 220) ?? ""} ${source?.marker ?? ""}`,
    );
  }

  if (contradicted.length > 0) {
    lines.push("", `## Contested findings`, "");
    for (const evidence of contradicted.slice(0, 8)) {
      const source = sources.find((item) => item.hit.id === evidence.sourceId);
      lines.push(
        `- The source ${source?.marker ?? "—"} reports values inconsistent with the claim: ${evidence.numericMismatches
          .map(
            (mismatch) => `${mismatch.quantity.raw} (found ${mismatch.sourceValue ?? "nothing"})`,
          )
          .join("; ")}`,
      );
    }
  }

  lines.push("", `## Sources`, "");
  for (const source of sorted) {
    lines.push(
      `- ${source.marker} ${source.parsed.title || source.hit.title}. ${source.parsed.year ?? ""}`,
    );
  }

  return lines.join("\n");
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

function nowNs(): number {
  if (typeof process !== "undefined" && typeof process.hrtime?.bigint === "function") {
    return Number(process.hrtime.bigint());
  }
  return Date.now() * 1e6;
}

export type { RawReference, CitationNode, ResearchPhase };
