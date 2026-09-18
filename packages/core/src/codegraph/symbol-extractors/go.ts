/**
 * Go symbol extraction.
 *
 * Donor lineage: the existing SymbolIndexer Go regexes, extended with line ranges, receiver
 * attribution (methods carry their receiver type as `className`), parameter lists and
 * cyclomatic complexity over brace-delimited bodies.
 */

import type { ImportRecord } from "../types.js";
import {
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

const STRUCT_RE = /^type\s+([A-Za-z0-9_]+)\s+struct\s*\{/;
const INTERFACE_RE = /^type\s+([A-Za-z0-9_]+)\s+interface\s*\{/;
const TYPE_RE = /^type\s+([A-Za-z0-9_]+)\s+([A-Za-z0-9_*\[\].]+)\s*(?:=|;)/;
const FUNC_RE =
  /^func\s+(?:\(\s*[A-Za-z0-9_]+\s+\*?([A-Za-z0-9_]+)\s*\)\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/;
const IMPORT_RE = /^import\s+"([^"]+)"/;
const IMPORT_BLOCK_RE = /^import\s*\(/;

/**
 * Reduce one Go parameter spelling to its name.
 *
 * Go spells a parameter `name Type` — including the variadic form `name ...T` — so the name is the
 * FIRST token, not the last (taking the last recorded the type: `func f(value int)` yielded `int`).
 * A lone token is an unnamed parameter (`func f(int)` / `func f(*Loader)`): it has no name, and the
 * token is a type, so it is dropped rather than recorded as though it were a name.
 */
function goParameterName(param: string): string | undefined {
  const tokens = param
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length < 2) return undefined;
  return tokens[0];
}

export const goExtractor: SymbolExtractor = {
  language: "go",

  extract(filePath: string, content: string): ExtractorOutput {
    const language = detectLanguage(filePath);
    const lines = splitLines(content);
    const defs: RawDefinition[] = [];
    const imports: ImportRecord[] = [];
    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i]!;
      const clean = stripLiteralsAndComments(raw);
      // Import-block handling must run before the blank-line skip and against the raw line:
      // import paths are quoted string literals that the literal-stripping pass erases, so a
      // `\t"fmt"` line would otherwise look blank.
      if (inImportBlock) {
        if (clean.includes(")")) {
          inImportBlock = false;
          continue;
        }
        const quoted = raw.match(/"([^"]+)"/);
        if (quoted?.[1]) imports.push({ module: quoted[1], names: [], level: 0, line: lineNo });
        continue;
      }

      if (clean.trim() === "") continue;

      const structMatch = clean.match(STRUCT_RE);
      if (structMatch?.[1]) {
        defs.push({
          name: structMatch[1],
          kind: "struct",
          startLine: lineNo,
          startColumn: raw.indexOf(structMatch[1]) + 1,
        });
        continue;
      }
      const ifaceMatch = clean.match(INTERFACE_RE);
      if (ifaceMatch?.[1]) {
        defs.push({
          name: ifaceMatch[1],
          kind: "interface",
          startLine: lineNo,
          startColumn: raw.indexOf(ifaceMatch[1]) + 1,
        });
        continue;
      }
      const typeMatch = clean.match(TYPE_RE);
      if (typeMatch?.[1] && typeMatch[2] !== "struct" && typeMatch[2] !== "interface") {
        defs.push({
          name: typeMatch[1],
          kind: "type",
          startLine: lineNo,
          startColumn: raw.indexOf(typeMatch[1]) + 1,
        });
        continue;
      }

      const fnMatch = clean.match(FUNC_RE);
      if (fnMatch?.[2]) {
        const params = fnMatch[3]
          ? fnMatch[3]
              .split(",")
              .map((part) => goParameterName(part))
              .filter((name): name is string => name !== undefined)
          : [];
        defs.push({
          name: fnMatch[2],
          kind: fnMatch[1] ? "method" : "function",
          startLine: lineNo,
          startColumn: raw.indexOf(fnMatch[2]) + 1,
          className: fnMatch[1] ?? undefined,
          parameters: params,
        });
        continue;
      }

      if (IMPORT_BLOCK_RE.test(clean)) {
        inImportBlock = true;
        continue;
      }
      const importMatch = raw.match(IMPORT_RE);
      if (importMatch?.[1]) {
        imports.push({ module: importMatch[1], names: [], level: 0, line: lineNo });
        continue;
      }
    }

    const resolved = resolveBraceDelimitedRanges(lines, defs).map((def) => {
      const end = def.endLine ?? def.startLine;
      return {
        ...def,
        endLine: end,
        complexity: clampComplexity(computeCyclomaticComplexity(content, def.startLine, end, "go")),
      };
    });

    return {
      filePath,
      language,
      definitions: resolved,
      imports,
      exports: [],
      linesOfCode: countLinesOfCode(lines, "//"),
    };
  },
};
