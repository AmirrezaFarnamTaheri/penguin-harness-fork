/**
 * Autonomous deep-research engine.
 *
 * Composes a paper parser, claim extractor, citation network, hypothesis planner,
 * evidence verifier and research budget into a single loop driven by injected search,
 * fetch and model seams. The speculative-decoding subsystem
 * (`packages/core/src/llm/speculative`) doubles the token throughput of the loop's
 * own generation calls; see `research-loop.ts` for the seam contract.
 *
 * Every algorithm here is deterministic and dependency-free: no model weights, no
 * network, no filesystem. What is real is the document structure, the citation graph,
 * the acceptance math and the budget arithmetic.
 */

export {
  parsePaper,
  parseBibTeX,
  toBibTeX,
  splitSections,
  splitReferenceList,
  extractEquations,
  extractCitationMarkers,
  extractIdentifiers,
  normalizeDoi,
  looksLikePaper,
  DOI_PATTERN,
  ARXIV_ID_PATTERN,
} from "./paper-parser.js";
export type {
  ParsedPaper,
  PaperSection,
  PaperSectionKind,
  EquationBlock,
  RawReference,
  ParsedIdentifiers,
  BibTeXEntry,
  PaperParseOptions,
} from "./paper-parser.js";

export {
  ClaimExtractor,
  BackgroundLanguageModel,
  tokenize,
  splitSentences,
  extractQuantities,
  extractInlineCitations,
  aggregateSpecificity,
  DEFAULT_BACKGROUND_CORPUS,
} from "./claim-extractor.js";
export type { Claim, ClaimKind, Quantity, ClaimExtractorOptions } from "./claim-extractor.js";

export { CitationNetwork, buildNetworkFromPapers } from "./citation-network.js";
export type {
  CitationNode,
  CitationEdge,
  EdgeRelation,
  CitationReport,
  UnresolvedMarker,
} from "./citation-network.js";

export {
  HypothesisPlanner,
  decomposeQuestion,
  draftHypotheses,
  evidenceFor,
  generateSearchTerms,
} from "./hypothesis-planner.js";
export type {
  HypothesisPlan,
  ResearchQuestion,
  Hypothesis,
  HypothesisStatus,
  EvidenceRequirement,
  QuestionOrigin,
  HypothesisPlannerOptions,
  EvidenceAssessment,
} from "./hypothesis-planner.js";

export {
  EvidenceVerifier,
  contentCoverage,
  findNumeric,
  detectPolarityConflict,
} from "./evidence-verifier.js";
export type {
  VerificationEvidence,
  VerificationSummary,
  Verdict,
  NumericMatch,
  NumericMismatch,
  EvidenceVerifierOptions,
} from "./evidence-verifier.js";

export {
  ResearchBudget,
  withRetry,
  defaultTokenEstimate,
  trimCitations,
} from "./research-budget.js";
export type {
  BudgetReport,
  PhaseSpend,
  ResearchPhase,
  ResearchBudgetOptions,
} from "./research-budget.js";

export { ResearchLoop } from "./research-loop.js";
export type {
  ResearchResult,
  ResearchState,
  ResearchEvent,
  SearchProvider,
  FetchProvider,
  ModelProvider,
  SearchHit,
  SourceRecord,
  ResearchLoopOptions,
} from "./research-loop.js";

export {
  ResearchEvalHarness,
  buildEvalSteps,
  scoreScaleInstruction,
  CoverageEvaluator,
  CitationHallucinationEvaluator,
  VerificationAccuracyEvaluator,
  LatencyEvaluator,
  SpecificityEvaluator,
} from "./eval-harness.js";
export type {
  EvalCase,
  EvalFixtures,
  CaseExpectations,
  EvalResult,
  EvaluatorResult,
  EvalReport,
  ResearchOutputEvaluator,
  EvaluationContext,
  JudgeSeam,
  RatingType,
  RatingOutcome,
} from "./eval-harness.js";
