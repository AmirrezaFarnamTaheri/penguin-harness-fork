/**
 * Core type definitions for the semantic code topology subsystem.
 *
 * Ported and unified from three donor lineages (algorithms only, no vendored code):
 *  - symbol-level graph + call/dependency/inheritance construction (FastCode graph_builder,
 *    call_extractor, symbol_resolver, module_resolver, global_index_builder, definition_extractor).
 *  - unified diff parsing, hunk staging and line anchoring (open-code-review internal/diff).
 *  - review issue / citation / annotation model and severity taxonomy (cr/diff_types).
 *
 * Naming note (§8): no upstream project names appear in any identifier below.
 */

/** Kinds of symbol nodes that can appear in the topology graph. */
export type SymbolKind =
  | "file"
  | "module"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "enum"
  | "type"
  | "function"
  | "method";

/** Edge kinds of the topology graph. `calls` edges are constructed by the call-hierarchy engine. */
export type TopologyEdgeKind =
  | "contains"
  | "calls"
  | "imports"
  | "exports"
  | "extends"
  | "implements"
  | "references"
  | "inherits"
  | "defines"
  | "uses";

/** How a call site is spelled in source. Drives callee resolution routing. */
export type CallType = "simple" | "attribute";

/** A symbol definition extracted from source. Line numbers are 1-indexed and inclusive. */
export interface GraphSymbol {
  /** Stable unique id: `${filePath}::${scopeId ?? ""}::${name}`. */
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  /** Enclosing class name when this symbol is a method. */
  className?: string;
  /** Qualified name used for resolution, e.g. `RepositoryLoader.load`. */
  qualifiedName: string;
  parameters?: string[];
  returnType?: string;
  bases?: string[];
  decorators?: string[];
  isAsync?: boolean;
  isExported?: boolean;
  /** Cyclomatic complexity (base 1). */
  complexity?: number;
}

/** A lexical scope (function/method/class body) used for containment assignment. */
export interface SymbolScope {
  /** `function::name` / `method::ClassName.name` / `class::name`, matching donor scope_id format. */
  id: string;
  kind: "function" | "method" | "class";
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  className?: string;
  /** Declared parameter spellings of a function/method scope, for def-use seeding. */
  parameters?: string[];
}

/** A single call occurrence, with enough context to resolve caller and callee. */
export interface CallSite {
  callName: string;
  baseObject?: string;
  callType: CallType;
  /** Innermost containing scope id; null/undefined for module-level calls. */
  scopeId?: string;
  filePath: string;
  line: number;
  column: number;
  /** Raw call text, retained for debugging and edge annotations. */
  nodeText?: string;
}

/** A variable definition / reassignment / use occurrence within a scope. */
export interface VariableBinding {
  name: string;
  scopeId: string;
  kind: "def" | "reassign" | "use" | "parameter";
  line: number;
  column: number;
  /** Inferred concrete type name when discoverable from constructor or annotation. */
  inferredType?: string;
}

/** An import statement normalised across languages. */
export interface ImportRecord {
  module: string;
  /** Names as spelled in the exporting module (`import { a }` / `from x import a`). */
  names: string[];
  /** Local rename when exactly one name is aliased (`from x import a as b`). */
  alias?: string;
  /**
   * Every local rename to its source name, covering imports that alias more than one name
   * (`import { a as x, b as y } from "m"`). A single `alias` can only carry one rename, so this map
   * is the general form; resolution consults it before falling back to `alias`.
   */
  aliasMap?: Record<string, string>;
  /** Relative-import depth: 0 absolute, 1 = `.` level, 2 = `..` level. */
  level: number;
  line: number;
}

/** Per-file extraction output consumed by the graph builders. */
export interface SymbolExtractionResult {
  filePath: string;
  language: string;
  symbols: GraphSymbol[];
  scopes: SymbolScope[];
  imports: ImportRecord[];
  callSites: CallSite[];
  variableBindings: VariableBinding[];
  /** Scoped inferred types for instance variables: scopeId -> varName -> candidate type names. */
  instanceTypes: Record<string, Record<string, string[]>>;
  exports: string[];
  linesOfCode: number;
}

/** An edge of the topology graph. */
export interface TopologyEdge {
  source: string;
  target: string;
  kind: TopologyEdgeKind;
  line?: number;
  /** Original call spelling for `calls` edges. */
  callName?: string;
  callType?: CallType;
}

/** A node of the topology graph. */
export interface TopologyNode {
  id: string;
  name: string;
  filePath: string;
  kind: SymbolKind;
  startLine?: number;
  endLine?: number;
  qualifiedName?: string;
  complexity?: number;
}

/** Result of an impact analysis for a failing or changed symbol. */
export interface ImpactReport {
  focal: TopologyNode;
  /** Nodes reachable from the focal symbol, nearest first. */
  impacted: Array<{ node: TopologyNode; depth: number; weight: number }>;
  edges: TopologyEdge[];
  /** PageRank-style centrality of the focal symbol (0..1). */
  centrality: number;
  /** Blame ranking: the symbols most likely to be the offending cause. */
  suspects: Array<{ node: TopologyNode; score: number; reason: string }>;
  /** Suggested patch focus for a targeted auto-fix. */
  fixGuidance: {
    symbol: TopologyNode;
    strategy: string;
    relatedFiles: string[];
  };
}

/** Severity ordering used by the review engine (index = rank). */
export const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export type ReviewCategory = "bug" | "investigation" | "informational" | "security" | "style";

/** A citation anchoring a review finding to a concrete diff location. */
export interface DiffCitation {
  path: string;
  side: "additions" | "deletions" | "unified";
  startLine: number;
  endLine: number;
  label?: string;
  reason?: string;
}

/** A review finding produced by the rule engine. */
export interface ReviewIssue {
  id: string;
  ruleId: string;
  title: string;
  severity: Severity;
  category: ReviewCategory;
  explanation: string;
  citations: DiffCitation[];
  fixSuggestions: string[];
  testsToAdd: string[];
}

/** A threaded inline annotation on a diff line. */
export interface LineAnnotation {
  id: string;
  path: string;
  side: "additions" | "deletions";
  lineNumber: number;
  status: "open" | "resolved";
}

/** A parsed unified-diff file section. */
export interface DiffFile {
  oldPath: string;
  newPath: string;
  patch: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

/** One `@@ ... @@` block within a DiffFile. */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ type: "context" | "added" | "deleted"; content: string }>;
}

/** AST recursion depth guard, matching the plan's Tier-5 ceiling. */
export const MAX_AST_RECURSION_DEPTH = 128;

/** Default graph budget knobs (plan §6 QoS targets). */
export const GRAPH_BUDGETS = {
  maxImpactDepth: 5,
  maxPageRankIterations: 100,
  pageRankDamping: 0.85,
  pageRankEpsilon: 1e-6,
  maxVisibleFiles: 50,
} as const;
