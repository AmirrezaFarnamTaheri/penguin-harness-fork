/**
 * Rust symbol extraction.
 *
 * Donor lineage: the existing SymbolIndexer Rust regexes, extended with line ranges, parameters,
 * trait/struct/implements discrimination and cyclomatic complexity over brace-delimited bodies.
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

const STRUCT_RE =
  /^\s*(?:pub(?:\(crate\))?\s+)?struct\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*(?:\(|\{|;)/;
const ENUM_RE = /^\s*(?:pub(?:\(crate\))?\s+)?enum\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\{/;
const TRAIT_RE = /^\s*(?:pub(?:\(crate\))?\s+)?trait\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*(?:\{|:)/;
const TYPE_RE = /^\s*(?:pub(?:\(crate\))?\s+)?type\s+([A-Za-z0-9_]+)\s*=/;
const FN_RE =
  /^\s*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const USE_RE = /^\s*(?:pub(?:\(crate\))?\s+)?use\s+([A-Za-z0-9_:{}*,\s]+);/;
const IMPL_RE =
  /^\s*impl(?:<[^>]*>)?\s+(?:([A-Za-z0-9_]+)\s+for\s+)?([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\{/;

/** Net brace delta of a line, counted on literal/comment-stripped text so braces inside
 *  strings cannot move the depth. */
function braceDelta(cleanLine: string): number {
  let delta = 0;
  for (const ch of cleanLine) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

export const rustExtractor: SymbolExtractor = {
  language: "rust",

  extract(filePath: string, content: string): ExtractorOutput {
    const language = detectLanguage(filePath);
    const lines = splitLines(content);
    const defs: RawDefinition[] = [];
    const imports: ImportRecord[] = [];

    /**
     * Brace-delimited blocks are tracked with a running depth counted on every line, and each
     * `trait`/`impl` frame remembers the depth its opening brace sat at. A frame is live while
     * depth is at or above that level, which is what attributes `fn`s to the right type even
     * when a method's own body opens and closes nested blocks — counting braces only on
     * non-`fn` lines (the tempting shortcut) loses the context one block early.
     */
    let depth = 0;
    let implFrame: { name: string } | null = null;
    let implOpenDepth = 0;
    let traitFrame: { name: string } | null = null;
    let traitOpenDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i]!;
      const clean = stripLiteralsAndComments(raw);
      if (clean.trim() === "") continue;

      const implMatch = clean.match(IMPL_RE);
      if (implMatch) {
        depth += braceDelta(clean);
        // `impl Trait for Type` attributes methods to the implementing type; a bare
        // `impl Type` inherent block attributes them to Type as well.
        implFrame = { name: implMatch[2]! };
        implOpenDepth = depth;
        continue;
      }

      const structMatch = clean.match(STRUCT_RE);
      if (structMatch?.[1]) {
        depth += braceDelta(clean);
        defs.push({
          name: structMatch[1],
          kind: "struct",
          startLine: lineNo,
          startColumn: raw.indexOf(structMatch[1]) + 1,
        });
        continue;
      }
      const enumMatch = clean.match(ENUM_RE);
      if (enumMatch?.[1]) {
        depth += braceDelta(clean);
        defs.push({
          name: enumMatch[1],
          kind: "enum",
          startLine: lineNo,
          startColumn: raw.indexOf(enumMatch[1]) + 1,
        });
        continue;
      }
      const traitMatch = clean.match(TRAIT_RE);
      if (traitMatch?.[1]) {
        depth += braceDelta(clean);
        traitFrame = { name: traitMatch[1] };
        traitOpenDepth = depth;
        defs.push({
          name: traitMatch[1],
          kind: "trait",
          startLine: lineNo,
          startColumn: raw.indexOf(traitMatch[1]) + 1,
        });
        continue;
      }
      const typeMatch = clean.match(TYPE_RE);
      if (typeMatch?.[1]) {
        defs.push({
          name: typeMatch[1],
          kind: "type",
          startLine: lineNo,
          startColumn: raw.indexOf(typeMatch[1]) + 1,
        });
        continue;
      }

      const fnMatch = clean.match(FN_RE);
      if (fnMatch?.[1]) {
        depth += braceDelta(clean);
        const params = fnMatch[2]
          ? fnMatch[2]
              .split(",")
              .map((part) => part.trim().split(":")[0]!.trim())
              .filter(
                (part) =>
                  part.length > 0 && part !== "&self" && part !== "&mut self" && part !== "self",
              )
          : [];
        defs.push({
          name: fnMatch[1],
          kind: implFrame || traitFrame ? "method" : "function",
          startLine: lineNo,
          startColumn: raw.indexOf(fnMatch[1]) + 1,
          className: implFrame?.name ?? traitFrame?.name,
          parameters: params,
          isAsync: /\basync\b/.test(clean),
        });
        continue;
      }

      const useMatch = raw.match(USE_RE);
      if (useMatch?.[1]) {
        const path = useMatch[1].trim();
        const leaf =
          path
            .split(/[::{},]/)
            .filter((part) => part.trim().length > 0)
            .pop() ?? path;
        imports.push({
          module: path.replace(/[{}]/g, "").trim(),
          names: [leaf],
          level: 0,
          line: lineNo,
        });
        continue;
      }

      depth += braceDelta(clean);
      if (implFrame && depth < implOpenDepth) {
        implFrame = null;
        implOpenDepth = 0;
      }
      if (traitFrame && depth < traitOpenDepth) {
        traitFrame = null;
        traitOpenDepth = 0;
      }
    }

    const resolved = resolveBraceDelimitedRanges(lines, defs).map((def) => {
      const end = def.endLine ?? def.startLine;
      return {
        ...def,
        endLine: end,
        complexity: clampComplexity(
          computeCyclomaticComplexity(content, def.startLine, end, "rust"),
        ),
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
