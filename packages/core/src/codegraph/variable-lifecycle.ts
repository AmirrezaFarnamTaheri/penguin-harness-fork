/**
 * Variable lifecycle and def-use tracking.
 *
 * Donor lineage (algorithms only): FastCode's `CallExtractor.extract_instance_types` — the four
 * instance-variable type-inference patterns (constructor assignment `self.v = Cls(...)`, local
 * constructor assignment `v = Cls(...)`, type hint `self.v: Cls`, type hint with assignment
 * `self.v: Cls = ...`) resolved into a *scoped* type table keyed by scope id, with the
 * local-scope → `__init__` → global lookup chain consumed by the call resolver. On top of that,
 * this module derives def-use chains: where each variable is defined, reassigned, read, and last
 * used — the lifecycle the topology engine reports when blaming a failing symbol.
 */

import type { SymbolScope, VariableBinding } from "./types.js";
import { findScopeForLine } from "./scope-tracker.js";
import { splitLines, stripLiteralsAndComments } from "./symbol-extractors/language-detect.js";

/** A resolved variable lifecycle within one scope. */
export interface VariableLifecycle {
  name: string;
  scopeId: string;
  kind: "local" | "parameter" | "instance" | "module";
  definedAt: number;
  reassignedAt: number[];
  usedAt: number[];
  lastUseAt: number;
  inferredType?: string;
  /** True when the value escapes into an instance attribute or a return value. */
  escapes: boolean;
}

const ASSIGN_RE =
  /(?:^|[^\w.$])([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*(?:(\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=|=)(?!=))/;
const NEW_INSTANCE_RE = /new\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const CONSTRUCT_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const TYPE_HINT_RE =
  /^\s*(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/;
const SELF_HINT_RE =
  /\b(?:self|this|cls)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/;
const SELF_ASSIGN_RE =
  /\b(?:self|this)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:new\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const LOCAL_ASSIGN_RE =
  /(?:^|[^\w.$])([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:new\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

/**
 * Extract the scoped instance-variable type table: scopeId -> variable name -> candidate types.
 * Variables are indexed under both their dotted (`self.loader`) and bare (`loader`) spellings so
 * resolution finds them whichever way the call site spells the base object.
 */
export function extractInstanceTypes(
  content: string,
  scopes: SymbolScope[],
): Record<string, Record<string, string[]>> {
  const lines = splitLines(content);
  const table: Record<string, Record<string, string[]>> = {};

  const add = (scopeId: string, name: string, type: string): void => {
    const scope = (table[scopeId] ??= {});
    pushUnique(scope, name, type);
    const bare = name.split(".").pop();
    if (bare && bare !== name) pushUnique(scope, bare, type);
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const clean = stripLiteralsAndComments(lines[i]!, { lineComment: "#" });
    if (clean.trim() === "") continue;
    const scope = findScopeForLine(scopes, lineNo);
    const scopeId = scope?.id ?? "global";

    // self.v: Cls  /  self.v: Cls = ...
    for (const hint of clean.matchAll(new RegExp(SELF_HINT_RE.source, "g"))) {
      add(scopeId, `self.${hint[1]}`, hint[2]!);
      add(scopeId, `this.${hint[1]}`, hint[2]!);
    }
    // bare `v: Cls` annotation (TS `let v: Cls`, Python without self)
    const hint = clean.match(TYPE_HINT_RE);
    if (hint?.[1] && hint[2] && !/^\s*(self|this|cls)\b/.test(clean)) {
      add(scopeId, hint[1], hint[2]);
    }
    // self.v = Cls(...)  /  this.v = new Cls(...)
    for (const assign of clean.matchAll(new RegExp(SELF_ASSIGN_RE.source, "g"))) {
      const type = assign[2]!;
      add(scopeId, `self.${assign[1]}`, type);
      add(scopeId, `this.${assign[1]}`, type);
      // Instance attributes defined in __init__ are visible class-wide.
      if (scope?.kind === "method" && scope.name.endsWith(".__init__")) {
        add(`class::${scope.className}`, `self.${assign[1]}`, type);
        add(`class::${scope.className}`, `this.${assign[1]}`, type);
      }
    }
    // v = Cls(...)  /  v = new Cls(...)
    const local = (clean.match(LOCAL_ASSIGN_RE) ?? clean.match(NEW_INSTANCE_RE)) || null;
    void local;
    for (const assign of clean.matchAll(new RegExp(LOCAL_ASSIGN_RE.source, "g"))) {
      const lhs = assign[1]!;
      if (lhs === "self" || lhs === "this" || lhs === "cls") continue;
      const constructed = NEW_INSTANCE_RE.exec(clean) || CONSTRUCT_RE.exec(clean);
      if (constructed && constructed[1] && !BUILTIN_CONSTRUCTORS.has(constructed[1])) {
        add(scopeId, lhs, constructed[1]);
      }
    }
  }
  return table;
}

const BUILTIN_CONSTRUCTORS = new Set([
  "int",
  "str",
  "float",
  "bool",
  "list",
  "dict",
  "set",
  "tuple",
  "bytes",
  "object",
  "type",
  "Array",
  "Map",
  "Set",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Function",
  "Date",
  "Promise",
  "Error",
  "RegExp",
]);

function pushUnique(target: Record<string, string[]>, key: string, value: string): void {
  const bucket = target[key] ?? (target[key] = []);
  if (!bucket.includes(value)) bucket.push(value);
}

/** Extract def / reassign / use bindings for every variable in every scope. */
export function extractVariableBindings(
  content: string,
  scopes: SymbolScope[],
  filePath: string,
): VariableBinding[] {
  const lines = splitLines(content);
  const bindings: VariableBinding[] = [];
  const firstSeen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const clean = stripLiteralsAndComments(lines[i]!, { lineComment: "#" });
    if (clean.trim() === "") continue;
    const scope = findScopeForLine(scopes, lineNo);
    const scopeId = scope?.id ?? "global";

    const assign = clean.match(ASSIGN_RE);
    if (assign?.[1]) {
      const name = assign[1];
      const key = `${scopeId}::${name}`;
      const isFirst = !firstSeen.has(key);
      firstSeen.set(key, lineNo);
      bindings.push({
        name,
        scopeId,
        kind: isFirst ? "def" : "reassign",
        line: lineNo,
        column: assign.index ? assign.index + 1 : 1,
      });
      continue;
    }

    // Uses: identifiers that reference a variable already defined in this scope.
    for (const use of clean.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const name = use[1]!;
      const key = `${scopeId}::${name}`;
      if (!firstSeen.has(key)) continue;
      bindings.push({ name, scopeId, kind: "use", line: lineNo, column: use.index + 1 });
    }
  }
  return bindings;
}

/** Compute the lifecycle of one variable within one scope. */
export function computeLifecycle(
  bindings: VariableBinding[],
  name: string,
  scopeId: string,
): VariableLifecycle | undefined {
  const own = bindings.filter((binding) => binding.name === name && binding.scopeId === scopeId);
  if (own.length === 0) return undefined;
  const definition = own.find((binding) => binding.kind === "def");
  const reassigned = own
    .filter((binding) => binding.kind === "reassign")
    .map((binding) => binding.line);
  const used = own.filter((binding) => binding.kind === "use").map((binding) => binding.line);
  const allLines = own.map((binding) => binding.line);
  const kind: VariableLifecycle["kind"] =
    scopeId === "global" ? "module" : definition ? "local" : "parameter";
  return {
    name,
    scopeId,
    kind,
    definedAt: definition?.line ?? Math.min(...allLines),
    reassignedAt: reassigned.sort((a, b) => a - b),
    usedAt: [...new Set(used)].sort((a, b) => a - b),
    lastUseAt: Math.max(...allLines),
    escapes: reassigned.length > 0 || name.startsWith("self.") || name.startsWith("this."),
  };
}

/** Compute lifecycles for all variables in all scopes of a file. */
export function computeAllLifecycles(bindings: VariableBinding[]): VariableLifecycle[] {
  const byKey = new Map<string, { name: string; scopeId: string }>();
  for (const binding of bindings) {
    byKey.set(`${binding.scopeId}::${binding.name}`, {
      name: binding.name,
      scopeId: binding.scopeId,
    });
  }
  const lifecycles: VariableLifecycle[] = [];
  for (const { name, scopeId } of byKey.values()) {
    const lifecycle = computeLifecycle(bindings, name, scopeId);
    if (lifecycle) lifecycles.push(lifecycle);
  }
  return lifecycles.sort(
    (a, b) => a.scopeId.localeCompare(b.scopeId) || a.name.localeCompare(b.name),
  );
}
