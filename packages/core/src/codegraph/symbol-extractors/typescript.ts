/**
 * TypeScript / JavaScript symbol extraction.
 *
 * Supersedes the existing line-regex SymbolIndexer (names only) with line ranges, parameters,
 * base classes, decorators, export flags and cyclomatic complexity, plus structurally-aware
 * method discovery inside class bodies. Dependency-free: a line-oriented scan over
 * literal/comment-stripped source.
 */

import type { ImportRecord } from "../types.js";
import {
  buildSymbolId,
  clampComplexity,
  resolveBraceDelimitedRanges,
  type RawDefinition,
} from "../scope-tracker.js";
import {
  countLinesOfCode,
  detectLanguage,
  splitLines,
  stripLiteralsAndComments,
  type ExtractorOutput,
  type SymbolExtractor,
} from "./language-detect.js";
import { computeCyclomaticComplexity } from "./complexity.js";

const CLASS_RE =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:\s*<[^>]*>)?(?:\s+extends\s+([A-Za-z0-9_$.]+))?(?:\s+implements\s+([A-Za-z0-9_$.]+))?/;
const INTERFACE_RE =
  /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z0-9_$]+)(?:\s*<[^>]*>)?(?:\s+extends\s+([A-Za-z0-9_$.]+))?/;
const TYPE_RE = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z0-9_$]+)\s*[<=]/;
const ENUM_RE = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/;
const FUNCTION_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const ARROW_RE =
  /^(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::\s*([^=]+?))?\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z0-9_$]+))\s*=>/;
const IMPORT_RE = /^import\s+([\s\S]*?)\s*from\s+['"]([^'"]+)['"]/;
const BARE_IMPORT_RE = /^import\s+['"]([^'"]+)['"]/;
const EXPORT_BIND_RE =
  /^export\s+(?:const|function|class|interface|type|enum|let|var)\s+([A-Za-z0-9_$]+)/;
const METHOD_RE =
  /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|\s)+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*[^{=;]+)?\s*(?:\{|=>)/;
const CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "constructor",
]);

function splitBaseList(raw?: string | null): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Collect method definitions inside a class body range. */
function collectMethods(lines: string[], classDef: RawDefinition): RawDefinition[] {
  const methods: RawDefinition[] = [];
  const end = classDef.endLine ?? classDef.startLine;
  for (let i = classDef.startLine; i < end && i <= lines.length; i++) {
    const raw = lines[i - 1]!;
    const clean = stripLiteralsAndComments(raw);
    if (clean.includes("=>") && !/^\s*(?:get|set|async)\s/.test(clean)) {
      // arrow-function class property: capture as method-shaped definition
      const arrowMatch = clean.match(
        /([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
      );
      if (arrowMatch?.[1]) {
        methods.push({
          name: arrowMatch[1],
          kind: "method",
          startLine: i,
          startColumn: raw.indexOf(arrowMatch[1]) + 1,
          className: classDef.name,
          parameters: arrowMatch[2]
            ? arrowMatch[2]
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean)
            : [],
          isAsync: /\basync\b/.test(clean),
        });
      }
      continue;
    }
    const match = clean.match(METHOD_RE);
    if (!match?.[1]) continue;
    if (CONTROL_WORDS.has(match[1])) continue;
    methods.push({
      name: match[1],
      kind: "method",
      startLine: i,
      startColumn: raw.indexOf(match[1]) + 1,
      className: classDef.name,
      parameters: match[2]
        ? match[2]
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
        : [],
      isAsync: /\basync\b/.test(clean),
    });
  }
  return methods;
}

export const typescriptExtractor: SymbolExtractor = {
  language: "typescript",

  extract(filePath: string, content: string): ExtractorOutput {
    const language = detectLanguage(filePath);
    const lines = splitLines(content);
    const defs: RawDefinition[] = [];
    const imports: ImportRecord[] = [];
    const exports: string[] = [];
    const pendingDecorators: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i]!;
      const clean = stripLiteralsAndComments(raw);

      // Decorators accumulate until the next definition.
      const deco = clean.match(/^\s*@([A-Za-z0-9_$]+)/);
      if (deco?.[1]) {
        pendingDecorators.push(deco[1]);
      }

      const classMatch = clean.match(CLASS_RE);
      if (classMatch?.[1]) {
        defs.push({
          name: classMatch[1],
          kind: "class",
          startLine: lineNo,
          startColumn: raw.indexOf(classMatch[1]) + 1,
          bases: splitBaseList(classMatch[2]) ?? splitBaseList(classMatch[3]),
          decorators: pendingDecorators.length ? [...pendingDecorators] : undefined,
          isExported: /^export/.test(clean),
        });
        pendingDecorators.length = 0;
        continue;
      }

      const ifaceMatch = clean.match(INTERFACE_RE);
      if (ifaceMatch?.[1]) {
        defs.push({
          name: ifaceMatch[1],
          kind: "interface",
          startLine: lineNo,
          startColumn: raw.indexOf(ifaceMatch[1]) + 1,
          bases: splitBaseList(ifaceMatch[2]),
          decorators: pendingDecorators.length ? [...pendingDecorators] : undefined,
          isExported: /^export/.test(clean),
        });
        pendingDecorators.length = 0;
        continue;
      }

      const enumMatch = clean.match(ENUM_RE);
      if (enumMatch?.[1]) {
        defs.push({
          name: enumMatch[1],
          kind: "enum",
          startLine: lineNo,
          startColumn: raw.indexOf(enumMatch[1]) + 1,
          isExported: /^export/.test(clean),
        });
        pendingDecorators.length = 0;
        continue;
      }

      const typeMatch = clean.match(TYPE_RE);
      if (typeMatch?.[1]) {
        defs.push({
          name: typeMatch[1],
          kind: "type",
          startLine: lineNo,
          startColumn: raw.indexOf(typeMatch[1]) + 1,
          isExported: /^export/.test(clean),
        });
        pendingDecorators.length = 0;
        continue;
      }

      const fnMatch = clean.match(FUNCTION_RE);
      if (fnMatch?.[1]) {
        defs.push({
          name: fnMatch[1],
          kind: "function",
          startLine: lineNo,
          startColumn: raw.indexOf(fnMatch[1]) + 1,
          parameters: fnMatch[2]
            ? fnMatch[2]
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean)
            : [],
          isAsync: /\basync\b/.test(clean),
          isExported: /^export/.test(clean),
          decorators: pendingDecorators.length ? [...pendingDecorators] : undefined,
        });
        pendingDecorators.length = 0;
        continue;
      }

      const arrowMatch = clean.match(ARROW_RE);
      if (arrowMatch?.[1]) {
        defs.push({
          name: arrowMatch[1],
          kind: "function",
          startLine: lineNo,
          startColumn: raw.indexOf(arrowMatch[1]) + 1,
          parameters: arrowMatch[3]
            ? arrowMatch[3]
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean)
            : arrowMatch[4]
              ? [arrowMatch[4]]
              : [],
          returnType: arrowMatch[2]?.trim() || undefined,
          isAsync: /\basync\b/.test(clean),
          isExported: /^export/.test(clean),
          decorators: pendingDecorators.length ? [...pendingDecorators] : undefined,
        });
        pendingDecorators.length = 0;
        continue;
      }

      const importMatch = raw.match(IMPORT_RE);
      if (importMatch?.[2]) {
        const named = importMatch[1] ?? "";
        // `import { a as x }` binds the local name x to the exported name a; both spellings are
        // kept because the module's exports are keyed by the source name, not the local one.
        const aliasMap: Record<string, string> = {};
        const names: string[] = [];
        for (const part of named.replace(/[{}]/g, "").split(",")) {
          const cleaned = part.trim().replace(/^type\s+/, "");
          const [source, local] = cleaned.split(/\s+as\s+/);
          const src = source?.trim() ?? "";
          if (!src || src === "*") continue;
          names.push(src);
          const renamed = local?.trim();
          if (renamed && renamed !== src) aliasMap[renamed] = src;
        }
        const alias = Object.keys(aliasMap).length === 1 ? Object.keys(aliasMap)[0] : undefined;
        imports.push({
          module: importMatch[2],
          names,
          alias,
          aliasMap: Object.keys(aliasMap).length ? aliasMap : undefined,
          level: 0,
          line: lineNo,
        });
        continue;
      }
      const bareImport = raw.match(BARE_IMPORT_RE);
      if (bareImport?.[1]) {
        imports.push({ module: bareImport[1], names: [], level: 0, line: lineNo });
        continue;
      }

      const reExport = clean.match(/^export\s*\{([^}]*)\}/);
      if (reExport?.[1]) {
        for (const name of reExport[1].split(",")) {
          const trimmed = name.trim().split(/\s+as\s+/)[0]!;
          if (trimmed) exports.push(trimmed);
        }
      }
    }

    const resolved = resolveBraceDelimitedRanges(lines, defs);
    const classes = resolved.filter((def) => def.kind === "class");
    // Methods are collected from the RESOLVED class ranges (the collector needs each class's end
    // line to bound its scan), then ranged themselves: a method that never gets its braces resolved
    // ends on its declaration line, and the body's calls and variables fall back to the enclosing
    // class scope.
    const methods = resolveBraceDelimitedRanges(
      lines,
      classes.flatMap((classDef) => collectMethods(lines, classDef)),
    );
    const all = [...resolved, ...methods].map((def) => {
      const end = def.endLine ?? def.startLine;
      return {
        ...def,
        endLine: end,
        complexity: clampComplexity(
          computeCyclomaticComplexity(content, def.startLine, end, "typescript"),
        ),
      };
    });

    // Exported definitions are reachable by name; record them in the export list.
    for (const def of all) {
      if (def.isExported) exports.push(def.name);
    }

    return {
      filePath,
      language,
      definitions: all,
      imports,
      exports,
      linesOfCode: countLinesOfCode(lines, "//"),
    };
  },
};

/** Build the stable id for a definition (also used by the topology engine). */
export function typescriptSymbolId(filePath: string, def: RawDefinition): string {
  return buildSymbolId(filePath, def);
}
