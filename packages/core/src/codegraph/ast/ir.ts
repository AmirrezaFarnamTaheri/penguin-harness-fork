/**
 * Normalized AST intermediate representation — the contract between per-language extractors
 * and the graph writer.
 *
 * Shape follows the two absorbed references (cluster-D report, items #6 and #8):
 * - Bikach/codeGraph `indexer/types.ts`: ParsedFile / ParsedFunction / ParsedCall /
 *   ParsedLocalVar with receiver + argument typing so the resolver ladder has what it needs;
 * - calldiff `src/languages/CONTRACT.md`: `CallStep = call | branch`, nested lambdas NOT
 *   attributed to the outer caller, computed callees ignored;
 * - ChrisRoyse: edge weight 1–10, `dangling` placeholder edges for unresolved references, and a
 *   `provenance` tag distinguishing resolved facts from heuristic ones.
 *
 * The IR is parser-agnostic on purpose: tree-sitter extracts into it, the regex fallback tier
 * extracts into it, and the resolver/index only ever sees this.
 */

export type SourceLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "kotlin"
  | "ruby"
  | "php"
  | "other";

/** Where a fact came from: a real resolution or a name-based heuristic. */
export type Provenance = "resolved" | "heuristic" | "fallback";

export interface SourceLocation {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column?: number;
  endLine?: number;
}

/** One call site inside a function body. */
export interface ParsedCall {
  /** Callee as written: bare name, `receiver.name`, `Type.method`, `pkg.Name`. */
  callee: string;
  /** Receiver expression when the call has one (`this`, `self`, a local, a module). */
  receiver?: string;
  /** Receiver type when known at parse time (annotations, `new X()`); the resolver may fill it. */
  receiverType?: string;
  argumentCount: number;
  argumentTypes?: readonly string[];
  isConstructorCall: boolean;
  location: SourceLocation;
  /** Callee computed at runtime (index/call through a variable): unresolvable by design. */
  computed?: boolean;
}

/** A local variable declaration, with the strongest type evidence the syntax offers. */
export interface ParsedLocalVar {
  name: string;
  /** Type from an annotation, `new X()`, `as T`, or an init-call return — in that order of strength. */
  type?: string;
  /** How the type was inferred; `initCall` is the weakest and may be wrong ("a missing edge beats a wrong one"). */
  typeSource?: "annotation" | "new" | "assertion" | "initCall";
  location: SourceLocation;
}

/**
 * One step of a function's control flow, per the calldiff contract: nested lambdas are NOT
 * attributed to the outer caller, and branch arms are recorded as `branch` steps so a call-stack
 * diff can align them.
 */
export type CallStep =
  | { kind: "call"; callee: string; location: SourceLocation }
  | { kind: "branch"; label: string; location: SourceLocation };

export interface ParsedFunction {
  /** Stable identity within its file (see fqn.ts for cross-file identity). */
  name: string;
  /** Fully-qualified identity — `filePath::Name` or `pkg.Name` (see fqn.ts). */
  fqn: string;
  /** Class/interface FQN when this is a method. */
  containerFqn?: string;
  isExported: boolean;
  isMethod: boolean;
  isConstructor: boolean;
  parameters: readonly ParsedLocalVar[];
  localVars: readonly ParsedLocalVar[];
  calls: readonly ParsedCall[];
  steps: readonly CallStep[];
  location: SourceLocation;
  complexity?: number;
}

export interface ParsedImport {
  /** Module specifier as written (`./helper`, `lib/util`, `java.util.List`). */
  source: string;
  /** Named bindings; empty = side-effect or wildcard import. */
  names: readonly string[];
  /** Alias map: imported name → local name. */
  aliases?: Readonly<Record<string, string>>;
  wildcard?: boolean;
}

export interface ParsedFile {
  filePath: string;
  language: SourceLanguage;
  /** Content hash of the parsed source — the incremental cache key. */
  contentHash: string;
  functions: readonly ParsedFunction[];
  /** Declared types (classes/interfaces/structs/traits) with their members' FQNs. */
  types: ReadonlyArray<{
    name: string;
    fqn: string;
    kind: "class" | "interface" | "struct" | "trait" | "enum";
    extends?: readonly string[];
    implements?: readonly string[];
  }>;
  imports: readonly ParsedImport[];
  /** Exported top-level names (module surface). */
  exports: readonly string[];
  /** Which tier produced this file: a grammar-backed AST or the regex fallback scanner. */
  provenance: Provenance;
}

/** An edge the graph writer may emit; `dangling` marks an unresolved reference placeholder. */
export interface ParsedEdge {
  sourceFqn: string;
  targetFqn: string;
  kind: "calls" | "contains" | "imports" | "extends" | "implements" | "uses";
  weight: number; // 1..10
  dangling: boolean;
  provenance: Provenance;
  location?: SourceLocation;
}

export function clampWeight(weight: number): number {
  return Math.max(1, Math.min(10, Math.round(weight)));
}
