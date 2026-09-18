/**
 * Semantic code topology, AST diffing and automated review.
 *
 * Public surface of the subsystem. Compose `TopologyEngine` for the full capability, or use the
 * individual engines directly:
 *  - `parseDiffText` / `parseHunks` / `resolveExcerpt` — unified diff handling.
 *  - `ReviewEngine` + `ALL_REVIEW_RULES` — deterministic code review.
 *  - `ImpactRadiusEngine` — weighted impact analysis.
 *  - `IncrementalGraphCache` — content-hash incremental updates.
 *  - per-language `symbol-extractors` — dependency-free symbol extraction.
 */

export { TopologyEngine } from "./topology-engine.js";
export type { BuildStats, TopologyQueryOptions, TopologySnapshot } from "./topology-engine.js";

export { IncrementalGraphCache } from "./incremental-graph-cache.js";
export type { CachedFileEntry, UpdateResult } from "./incremental-graph-cache.js";

export { SymbolIndex } from "./symbol-index.js";
export {
  filePathToModulePath,
  isPackageRoot,
  normalizePath,
  resolvePathStyleImport,
  resolveRelativeModulePath,
  stripCodeExtension,
} from "./symbol-index.js";

export { ImpactRadiusEngine } from "./impact-radius.js";
export type { ImpactOptions } from "./impact-radius.ts";
export {
  buildDirectedAdjacency,
  buildWeightedAdjacency,
  levenshtein,
  levenshteinSimilarity,
  pageRank,
  propagateImpact,
  symmetricNormalize,
} from "./graph-algorithms.js";

export {
  extractCallSites,
  resolveCalleeIds,
  buildCallEdges,
  scopeToSymbolId,
} from "./call-hierarchy.js";
export type { CallSite } from "./types.js";

export {
  computeAllLifecycles,
  computeLifecycle,
  extractInstanceTypes,
  extractVariableBindings,
} from "./variable-lifecycle.js";
export type { VariableLifecycle } from "./variable-lifecycle.js";

export {
  buildScopes,
  findScopeForLine,
  resolveBraceDelimitedRanges,
  resolveIndentationRanges,
} from "./scope-tracker.js";
export type { RawDefinition } from "./scope-tracker.js";

export {
  parseAnswerBlocks,
  parseCitations,
  parseDiffText,
  parseHunks,
  relocateAcrossFiles,
  resolveExcerpt,
  resolveFromFileContent,
  extractSideLines,
  matchConsecutive,
  normalizeLine,
  splitAndNormalize,
  validateCitations,
} from "./diff-graph.js";

export { ReviewEngine } from "./review-engine.js";
export type {
  ReviewContext,
  ReviewRuleContext,
  ReviewRule,
  ReviewEngineOptions,
  SymbolReviewStats,
} from "./review-engine.js";
export {
  ALL_REVIEW_RULES,
  ARCHITECTURE_PRESET,
  CODE_QUALITY_PRESET,
  SECURITY_PRESET,
  STRICT_SECURITY_PRESET,
  buildRemovalPlan,
} from "./review-presets.js";
export type { RemovalPlan } from "./review-presets.js";

export { extractFile, getExtractor } from "./symbol-extractors/index.js";
export { computeCyclomaticComplexity } from "./symbol-extractors/index.js";
export { detectLanguage } from "./symbol-extractors/index.js";

export { GRAPH_BUDGETS, MAX_AST_RECURSION_DEPTH, SEVERITY_ORDER } from "./types.js";
export type {
  CallType,
  DiffCitation,
  DiffFile,
  DiffHunk,
  GraphSymbol,
  ImpactReport,
  ImportRecord,
  LineAnnotation,
  ReviewCategory,
  ReviewIssue,
  Severity,
  SymbolExtractionResult,
  SymbolKind,
  SymbolScope,
  TopologyEdge,
  TopologyEdgeKind,
  TopologyNode,
  VariableBinding,
} from "./types.js";
