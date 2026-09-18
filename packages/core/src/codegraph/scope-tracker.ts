/**
 * Scope tracking without a native AST dependency.
 *
 * Donor lineage: FastCode's `CallExtractor._extract_scopes` / `_find_scope_for_call` used
 * tree-sitter byte ranges to assign each call to its innermost containing function or class.
 * The range/containment algorithm is independent of the parser; this module reproduces it over
 * line ranges, computing those ranges with brace-depth tracking (C-family) or indentation
 * tracking (Python), which is what makes call-hierarchy and variable-lifecycle extraction work
 * with zero native dependencies.
 *
 * Recursion is bounded by MAX_AST_RECURSION_DEPTH per the plan's Tier-5 depth guard.
 */

import { MAX_AST_RECURSION_DEPTH, type SymbolScope } from "./types.js";

/** A definition start emitted by a per-language extractor, before its range is resolved. */
export interface RawDefinition {
  name: string;
  kind: "class" | "struct" | "interface" | "trait" | "enum" | "type" | "function" | "method";
  startLine: number;
  startColumn: number;
  /** End line (1-indexed, inclusive) when the extractor already resolved the range. */
  endLine?: number;
  className?: string;
  parameters?: string[];
  returnType?: string;
  bases?: string[];
  decorators?: string[];
  isAsync?: boolean;
  isExported?: boolean;
  complexity?: number;
}

/** Locate the end line of a definition whose body opens on `openLine`. */
function findBlockEnd(lines: string[], openLine: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let i = openLine; i < lines.length; i++) {
    if (i - openLine > MAX_AST_RECURSION_DEPTH * 4) break;
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        seenOpen = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (seenOpen && depth <= 0) return i + 1;
  }
  return openLine + 1;
}

/** Count braces on a line, respecting string/char literals and line comments. */
function braceDelta(line: string): { open: number; close: number; firstOpen: number } {
  let open = 0;
  let close = 0;
  let firstOpen = -1;
  let i = 0;
  let quote: string | null = null;
  while (i < line.length) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "{") {
      if (firstOpen < 0) firstOpen = i;
      open++;
    } else if (ch === "}") {
      close++;
    }
    i++;
  }
  return { open, close, firstOpen };
}

/**
 * Resolve definition end lines for brace-delimited languages (TypeScript, Rust, Go).
 * The definition header may span several lines before the body opens, so the scan starts at the
 * definition line and walks forward until the enclosing brace pair closes.
 */
export function resolveBraceDelimitedRanges(
  lines: string[],
  defs: RawDefinition[],
): RawDefinition[] {
  return defs.map((def) => {
    let depth = 0;
    let seenOpen = false;
    let endLine = def.startLine;
    for (let i = def.startLine - 1; i < lines.length; i++) {
      const { open, close } = braceDelta(lines[i]!);
      depth += open - close;
      if (open > 0) seenOpen = true;
      if (seenOpen && depth <= 0) {
        endLine = i + 1;
        break;
      }
      endLine = i + 1;
    }
    return { ...def, startColumn: def.startColumn, endLine };
  });
}

/**
 * Resolve definition end lines for indentation-sensitive languages (Python).
 * A definition owns its header line plus every following line whose indentation is strictly
 * greater than the definition's own indentation; blank lines and comments do not terminate it.
 */
export function resolveIndentationRanges(lines: string[], defs: RawDefinition[]): RawDefinition[] {
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  return defs.map((def) => {
    const baseIndent = indentOf(lines[def.startLine - 1] ?? "");
    let endLine = def.startLine;
    for (let i = def.startLine; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      if (indentOf(line) <= baseIndent) break;
      endLine = i + 1;
    }
    return { ...def, endLine };
  });
}

/** Build `SymbolScope` records from resolved definitions. */
export function buildScopes(filePath: string, defs: RawDefinition[]): SymbolScope[] {
  return defs.map((def) => {
    const isMethod = def.kind === "method" || (def.className && def.kind === "function");
    const scopeKind =
      def.kind === "class" || def.kind === "struct" || def.kind === "trait"
        ? "class"
        : isMethod
          ? "method"
          : "function";
    const scopeName = isMethod && def.className ? `${def.className}.${def.name}` : def.name;
    return {
      id: `${scopeKind}::${scopeName}`,
      kind: scopeKind,
      name: scopeName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine ?? def.startLine,
      className: def.className,
    };
  });
}

/**
 * Find the innermost scope containing a 1-indexed line, mirroring the donor's reverse-order
 * containment scan (innermost scope first). Returns undefined for module-level positions.
 */
export function findScopeForLine(scopes: SymbolScope[], line: number): SymbolScope | undefined {
  let best: SymbolScope | undefined;
  for (const scope of scopes) {
    if (line >= scope.startLine && line <= scope.endLine) {
      if (!best || scope.endLine - scope.startLine < best.endLine - best.startLine) {
        best = scope;
      }
    }
  }
  return best;
}

/** Build a stable symbol id matching the format used by the topology engine. */
export function buildSymbolId(filePath: string, def: RawDefinition): string {
  const scope = def.className ? `${def.className}.` : "";
  return `${filePath}::${scope}${def.name}`;
}

/** Normalize a complexity score, floor at 1 (cyclomatic complexity base). */
export function clampComplexity(value: number): number {
  return Math.max(1, Math.round(value));
}
