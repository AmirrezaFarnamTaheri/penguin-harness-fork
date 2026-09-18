/**
 * Call-hierarchy construction.
 *
 * Donor lineage (algorithms only): FastCode's `CallExtractor` (two-pass scope-tracked call
 * extraction, simple/attribute call classification, built-in filtering) and `CodeGraphBuilder`
 * callee resolution routing (`_resolve_callee_with_symbol_resolver` / `_resolve_instance_method_call`):
 * local-variable shadowing beats module-call resolution, `self`/`cls` methods resolve as
 * `Class.method`, and instance methods resolve through the scoped type table with a
 * local-scope → `__init__` → global fallback chain, one-to-many and order-preserving.
 *
 * Parsing is deliberately regex-and-scan rather than tree-sitter: the donor's tree-sitter queries
 * are the parser seam, while scope assignment, classification and resolution routing are
 * parser-independent and are what actually determines edge quality.
 */

import type { CallSite, CallType, SymbolScope, TopologyEdge } from "./types.js";
import type { SymbolIndex } from "./symbol-index.js";
import { findScopeForLine } from "./scope-tracker.js";
import { splitLines, stripLiteralsAndComments } from "./symbol-extractors/language-detect.js";

/** Names that must never become call-graph nodes. */
const BUILTINS = new Set([
  // Python built-ins.
  "abs",
  "all",
  "any",
  "bin",
  "bool",
  "bytearray",
  "bytes",
  "callable",
  "chr",
  "classmethod",
  "compile",
  "complex",
  "delattr",
  "dict",
  "dir",
  "divmod",
  "enumerate",
  "eval",
  "exec",
  "filter",
  "float",
  "format",
  "frozenset",
  "getattr",
  "globals",
  "hasattr",
  "hash",
  "hex",
  "id",
  "input",
  "int",
  "isinstance",
  "issubclass",
  "iter",
  "len",
  "list",
  "locals",
  "map",
  "max",
  "memoryview",
  "min",
  "next",
  "object",
  "oct",
  "open",
  "ord",
  "pow",
  "print",
  "property",
  "range",
  "repr",
  "reversed",
  "round",
  "set",
  "setattr",
  "slice",
  "sorted",
  "staticmethod",
  "str",
  "sum",
  "super",
  "tuple",
  "type",
  "vars",
  "zip",
  // Control keywords that a call regex can mistake for a callee.
  "if",
  "elif",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "catch",
  "finally",
  "return",
  "yield",
  "await",
  "new",
  "throw",
  "throws",
  "try",
  "except",
  "def",
  "class",
  "function",
  "func",
  "fn",
  "impl",
  "struct",
  "enum",
  "trait",
  "interface",
  "type",
  "import",
  "from",
  "export",
  "extends",
  "implements",
  "with",
  "as",
  "in",
  "is",
  "not",
  "and",
  "or",
  "lambda",
  "pass",
  "raise",
  "match",
  "select",
  "go",
  "defer",
  "package",
  "use",
  "let",
  "const",
  "var",
  "pub",
  "mod",
  "crate",
  "self",
  "cls",
  "this",
  "super",
  "void",
  "sizeof",
  "typeof",
  "delete",
  "instanceof",
  "void",
]);

/** Definition-leading keywords whose own name must not be counted as a call on that line. */
const DEFINITION_LEADERS = new Set([
  "def",
  "class",
  "func",
  "fn",
  "function",
  "struct",
  "enum",
  "trait",
  "interface",
  "type",
  "impl",
  "method",
  "sub",
  "constructor",
]);

const CALL_RE = /([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g;

/** Extract call sites from a file, assigning each to its innermost containing scope. */
export function extractCallSites(
  content: string,
  scopes: SymbolScope[],
  filePath: string,
): CallSite[] {
  const lines = splitLines(content);
  const sites: CallSite[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const clean = stripLiteralsAndComments(lines[i]!, { lineComment: "#" });
    if (clean.trim() === "") continue;

    // On a definition line, the defined name is not a call site.
    const leader = clean.match(
      /^\s*(?:pub\s+|export\s+|async\s+|static\s+|public\s+|private\s+|protected\s+)*(?:def|func|fn|function|class|struct|enum|trait|interface|type|impl)\s+([A-Za-z0-9_$]+)/,
    );
    const definedName = leader?.[1];

    const scope = findScopeForLine(scopes, lineNo);
    let match: RegExpExecArray | null;
    CALL_RE.lastIndex = 0;
    while ((match = CALL_RE.exec(clean)) !== null) {
      const full = match[1]!;
      const lastDot = full.lastIndexOf(".");
      const callName = lastDot < 0 ? full : full.slice(lastDot + 1);
      const baseObject = lastDot < 0 ? undefined : full.slice(0, lastDot);
      const callType: CallType = baseObject ? "attribute" : "simple";

      if (definedName && callName === definedName && !baseObject) continue;
      if (BUILTINS.has(callName)) continue;
      // Numeric-looking or empty names are not callees.
      if (!callName) continue;

      sites.push({
        callName,
        baseObject,
        callType,
        scopeId: scope?.id,
        filePath,
        line: lineNo,
        column: match.index + 1,
        nodeText: full,
      });
    }
  }
  return sites;
}

/** Map a scope id to the symbol id that owns calls made in that scope. */
export function scopeToSymbolId(
  scopes: SymbolScope[],
  symbolByScopeKey: Map<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const scope of scopes) {
    const target = symbolByScopeKey.get(`${scope.filePath}::${scope.id}`);
    if (target) map.set(scope.id, target);
  }
  return map;
}

/**
 * Resolve a call site to callee symbol ids, routing exactly as the donor graph builder does.
 * Returns zero, one or many ids (instance-method resolution is one-to-many).
 */
export function resolveCalleeIds(
  call: CallSite,
  index: SymbolIndex,
  imports: import("./types.js").ImportRecord[],
  instanceTypes: Record<string, Record<string, string[]>>,
  callerSymbolId?: string,
): string[] {
  const { callName, callType, baseObject } = call;

  // Case 1: simple call `func()`.
  if (callType === "simple") {
    const resolved = index.resolveSymbol(callName, call.filePath, imports);
    return resolved ? [resolved] : [];
  }

  if (callType === "attribute" && baseObject) {
    const scopeId = call.scopeId ?? "global";
    const isLocalVar =
      !!instanceTypes[scopeId]?.[baseObject] ||
      !!instanceTypes.global?.[baseObject] ||
      !!instanceTypes["function::__init__"]?.[baseObject];

    // A local variable shadows a same-named module: only treat as a module call when not local.
    if (!isLocalVar) {
      for (const imp of imports) {
        if (imp.module === baseObject || imp.names.includes(baseObject)) {
          const resolved = index.resolveSymbol(`${baseObject}.${callName}`, call.filePath, imports);
          if (resolved) return [resolved];
        }
      }
    }

    if (baseObject === "self" || baseObject === "cls" || baseObject === "this") {
      // Case 3: `self.method()` — resolve as `EnclosingClass.method`.
      const caller = callerSymbolId ? index.byId.get(callerSymbolId) : undefined;
      if (caller?.className) {
        const resolved = index.resolveSymbol(
          `${caller.className}.${callName}`,
          call.filePath,
          imports,
        );
        if (resolved) return [resolved];
      }
      const resolved = index.resolveSymbol(callName, call.filePath, imports);
      return resolved ? [resolved] : [];
    }

    // Case 4: instance method call `var.method()` — resolve via inferred types.
    return resolveInstanceMethodCall(
      baseObject,
      callName,
      call,
      index,
      imports,
      instanceTypes,
      scopeId,
    );
  }

  const resolved = index.resolveSymbol(callName, call.filePath, imports);
  return resolved ? [resolved] : [];
}

/** Scoped fallback chain: local scope → `__init__` → global, then class-then-method resolution. */
function resolveInstanceMethodCall(
  baseObject: string,
  callName: string,
  call: CallSite,
  index: SymbolIndex,
  imports: import("./types.js").ImportRecord[],
  instanceTypes: Record<string, Record<string, string[]>>,
  scopeId: string,
): string[] {
  const scopeIds = [scopeId, "function::__init__", "global"];
  let candidateClasses: string[] | undefined;
  for (const id of scopeIds) {
    const found = instanceTypes[id]?.[baseObject];
    if (found?.length) {
      candidateClasses = found;
      break;
    }
  }
  if (!candidateClasses) return [];

  const resolvedIds: string[] = [];
  const seen = new Set<string>();
  for (const className of candidateClasses) {
    const classId = index.resolveSymbol(className, call.filePath, imports);
    if (!classId) continue;
    const methodId = index.resolveSymbol(`${className}.${callName}`, call.filePath, imports);
    if (methodId) {
      if (!seen.has(methodId)) {
        seen.add(methodId);
        resolvedIds.push(methodId);
      }
      continue;
    }
    // Recall over precision: attribute the call to the class when the method is unresolved.
    if (!seen.has(classId)) {
      seen.add(classId);
      resolvedIds.push(classId);
    }
  }
  return resolvedIds;
}

/**
 * Build `calls` edges for one file. Callers with no enclosing scope attribute to the file node,
 * matching the donor's module-level caller behaviour.
 */
export function buildCallEdges(
  calls: CallSite[],
  index: SymbolIndex,
  imports: import("./types.js").ImportRecord[],
  instanceTypes: Record<string, Record<string, string[]>>,
  scopeSymbolMap: Map<string, string>,
  filePath: string,
): TopologyEdge[] {
  const edges: TopologyEdge[] = [];
  for (const call of calls) {
    const callerId = (call.scopeId && scopeSymbolMap.get(call.scopeId)) ?? filePath;
    const callerSymbolId = call.scopeId ? scopeSymbolMap.get(call.scopeId) : undefined;
    const calleeIds = resolveCalleeIds(call, index, imports, instanceTypes, callerSymbolId);
    for (const calleeId of calleeIds) {
      edges.push({
        source: callerId,
        target: calleeId,
        kind: "calls",
        line: call.line,
        callName: call.callName,
        callType: call.callType,
      });
    }
  }
  return edges;
}
