/**
 * Language detection and the extractor contract shared by every per-language scanner.
 *
 * Donor lineage: FastCode's `path_utils.get_language_from_extension` plus `parser.parse_file`'s
 * per-language dispatch. Detection is extension-driven and dependency-free.
 */

export type SupportedLanguage =
  "typescript" | "javascript" | "python" | "go" | "rust" | "java" | "c" | "cpp" | "unknown";

/** Output of a per-language definition/import scanner (parser-agnostic "AST walk"). */
export interface ExtractorOutput {
  filePath: string;
  language: SupportedLanguage;
  definitions: import("../scope-tracker.js").RawDefinition[];
  imports: import("../types.js").ImportRecord[];
  exports: string[];
  linesOfCode: number;
}

export interface SymbolExtractor {
  readonly language: SupportedLanguage;
  extract(filePath: string, content: string): ExtractorOutput;
}

const EXTENSION_LANGUAGE: Record<string, SupportedLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
};

/** Detect language from a file path's extension. */
export function detectLanguage(filePath: string): SupportedLanguage {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_LANGUAGE[ext] ?? "unknown";
}

/** Split content into lines, preserving a 1-indexed line universe. */
export function splitLines(content: string): string[] {
  return content.split("\n");
}

/** Count non-blank, comment-stripped lines of code. */
export function countLinesOfCode(lines: string[], commentPrefix: string): number {
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith(commentPrefix)) continue;
    count++;
  }
  return count;
}

/**
 * Strip string/char literals and comments from a line so structural regexes never match inside
 * a string. Ports the donor's AST-safe header extraction idea to a line-oriented scanner.
 */
export function stripLiteralsAndComments(line: string, options?: { lineComment?: string }): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  const lineComment = options?.lineComment ?? "//";
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
    if (lineComment.length === 2 && ch === lineComment[0] && line[i + 1] === lineComment[1]) break;
    if (lineComment === "#" && ch === "#") break;
    out += ch;
    i++;
  }
  // Removing a comment should swallow the whitespace that separated it from the
  // code, so `x = 1; // note` becomes `x = 1;` rather than `x = 1; `.
  return out.trimEnd();
}
