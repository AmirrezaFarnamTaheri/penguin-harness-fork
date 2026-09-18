/**
 * Python symbol extraction.
 *
 * Donor lineage: FastCode's `parser._parse_python` (stdlib `ast`) + `definition_extractor.py`.
 * Dependency-free restatement: an indentation-sensitive line scan. Definition bodies are ranged
 * by indentation, mirroring Python's own scoping rule, and methods are emitted with their
 * enclosing class name so cross-file symbol resolution can reach `ClassName.method`.
 */

import type { ImportRecord } from "../types.js";
import { clampComplexity, resolveIndentationRanges, type RawDefinition } from "../scope-tracker.js";
import {
  countLinesOfCode,
  detectLanguage,
  splitLines,
  stripLiteralsAndComments,
  type ExtractorOutput,
  type SymbolExtractor,
} from "./language-detect.js";
import { computeCyclomaticComplexity } from "./complexity.js";

const CLASS_RE = /^\s*(?:async\s+)?class\s+([A-Za-z0-9_]+)\s*(?:\(([^)]*)\))?\s*:/;
const DEF_RE = /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/;
const IMPORT_RE = /^\s*import\s+([A-Za-z0-9_.]+)/;
const FROM_IMPORT_RE = /^\s*from\s+([A-Za-z0-9_.]*)\s+import\s+(.*)/;
const DECORATOR_RE = /^\s*@([A-Za-z0-9_.]+)/;

function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

export const pythonExtractor: SymbolExtractor = {
  language: "python",

  extract(filePath: string, content: string): ExtractorOutput {
    const language = detectLanguage(filePath);
    const lines = splitLines(content);
    const defs: RawDefinition[] = [];
    const imports: ImportRecord[] = [];
    const exports: string[] = [];
    const pendingDecorators: string[] = [];
    /** Class name at (or nearest above) a given indent — used to attribute methods. */
    const classStack: Array<{ name: string; indent: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i]!;
      const clean = stripLiteralsAndComments(raw, { lineComment: "#" });
      if (clean.trim() === "") continue;

      const indent = indentWidth(raw);

      const deco = clean.match(DECORATOR_RE);
      if (deco?.[1]) {
        pendingDecorators.push(deco[1].split(".").pop() ?? deco[1]);
        continue;
      }

      // Pop classes whose body has ended (indentation returned to theirs or above).
      while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
        classStack.pop();
      }

      const classMatch = clean.match(CLASS_RE);
      if (classMatch?.[1]) {
        const bases = (classMatch[2] ?? "")
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        defs.push({
          name: classMatch[1],
          kind: "class",
          startLine: lineNo,
          startColumn: raw.indexOf(classMatch[1]) + 1,
          bases: bases.length ? bases : undefined,
          decorators: pendingDecorators.length ? [...pendingDecorators] : undefined,
        });
        classStack.push({ name: classMatch[1], indent });
        pendingDecorators.length = 0;
        continue;
      }

      const defMatch = clean.match(DEF_RE);
      if (defMatch?.[1]) {
        const enclosing = classStack[classStack.length - 1]?.name;
        const isMethod = enclosing !== undefined;
        const params = defMatch[2]
          ? defMatch[2]
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part.length > 0 && part !== "self" && part !== "cls")
          : [];
        defs.push({
          name: defMatch[1],
          kind: isMethod ? "method" : "function",
          startLine: lineNo,
          startColumn: raw.indexOf(defMatch[1]) + 1,
          className: enclosing,
          parameters: params,
          isAsync: /\basync\b/.test(clean),
          decorators: pendingDecorators.length ? [...pendingDecorators] : undefined,
        });
        pendingDecorators.length = 0;
        continue;
      }

      const importMatch = raw.match(IMPORT_RE);
      if (importMatch?.[1]) {
        imports.push({ module: importMatch[1], names: [importMatch[1]], level: 0, line: lineNo });
        continue;
      }
      const fromMatch = raw.match(FROM_IMPORT_RE);
      if (fromMatch?.[2]) {
        const moduleText = fromMatch[1] ?? "";
        let level = 0;
        let module = moduleText;
        if (moduleText.startsWith(".")) {
          let dots = 0;
          while (moduleText[dots] === ".") dots++;
          level = dots;
          module = moduleText.slice(dots);
        }
        const names = fromMatch[2]
          .replace(/[()]/g, "")
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/)[0]!)
          .filter((part) => part.length > 0 && part !== "*");
        imports.push({ module, names, level, line: lineNo });
        if (names.length) exports.push(...names);
        continue;
      }
    }

    const resolved = resolveIndentationRanges(lines, defs).map((def) => {
      const end = def.endLine ?? def.startLine;
      return {
        ...def,
        endLine: end,
        complexity: clampComplexity(
          computeCyclomaticComplexity(content, def.startLine, end, "python"),
        ),
      };
    });

    return {
      filePath,
      language,
      definitions: resolved,
      imports,
      exports,
      linesOfCode: countLinesOfCode(lines, "#"),
    };
  },
};
