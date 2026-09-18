/**
 * Cyclomatic complexity estimation.
 *
 * Donor lineage: FastCode's `_calculate_python_complexity` — base 1, +1 per decision point
 * (If/While/For/ExceptHandler/And/Or) walked over the function subtree. This is the
 * parser-independent restatement: decision tokens are counted over the resolved definition range
 * with literals and comments stripped, so keywords inside strings never inflate the score.
 */

import { splitLines, stripLiteralsAndComments } from "./language-detect.js";

/** Per-language decision-point token regexes. Each match adds 1 to complexity. */
const DECISION_TOKENS: Record<string, string[]> = {
  typescript: [
    "\\bif\\b",
    "\\bfor\\b",
    "\\bwhile\\b",
    "\\bdo\\b",
    "\\bcatch\\b",
    "\\bcase\\b",
    "&&",
    "\\|\\|",
    "\\?",
  ],
  javascript: [
    "\\bif\\b",
    "\\bfor\\b",
    "\\bwhile\\b",
    "\\bdo\\b",
    "\\bcatch\\b",
    "\\bcase\\b",
    "&&",
    "\\|\\|",
    "\\?",
  ],
  python: [
    "\\bif\\b",
    "\\belif\\b",
    "\\bfor\\b",
    "\\bwhile\\b",
    "\\bexcept\\b",
    "\\band\\b",
    "\\bor\\b",
  ],
  go: ["\\bif\\b", "\\bfor\\b", "\\bcase\\b", "\\bswitch\\b", "\\bselect\\b", "&&", "\\|\\|"],
  rust: [
    "\\bif\\b",
    "\\bfor\\b",
    "\\bwhile\\b",
    "\\bloop\\b",
    "\\bmatch\\b",
    "&&",
    "\\|\\|",
    "\\?",
  ],
  java: [
    "\\bif\\b",
    "\\bfor\\b",
    "\\bwhile\\b",
    "\\bdo\\b",
    "\\bcatch\\b",
    "\\bcase\\b",
    "&&",
    "\\|\\|",
    "\\?",
  ],
  c: [
    "\\bif\\b",
    "\\bfor\\b",
    "\\bwhile\\b",
    "\\bdo\\b",
    "\\bswitch\\b",
    "\\bcase\\b",
    "&&",
    "\\|\\|",
    "\\?",
  ],
  cpp: [
    "\\bif\\b",
    "\\bfor\\b",
    "\\bwhile\\b",
    "\\bdo\\b",
    "\\bswitch\\b",
    "\\bcase\\b",
    "\\bcatch\\b",
    "&&",
    "\\|\\|",
    "\\?",
  ],
};

/**
 * Compute cyclomatic complexity over a 1-indexed inclusive line range.
 * `else` alone is not a decision (it is the consequent of the preceding `if`); `else if` is, and
 * is matched by the `\\bif\\b` token on the same line.
 */
export function computeCyclomaticComplexity(
  content: string,
  startLine: number,
  endLine: number,
  language: string,
): number {
  const tokens = DECISION_TOKENS[language];
  if (!tokens) return 1;
  const lineComment = language === "python" ? "#" : "//";
  const lines = splitLines(content);
  let complexity = 1;
  for (let i = startLine; i <= endLine && i <= lines.length; i++) {
    const clean = stripLiteralsAndComments(lines[i - 1] ?? "", { lineComment });
    for (const token of tokens) {
      const re = new RegExp(token, "g");
      const matches = clean.match(re);
      if (matches) complexity += matches.length;
    }
  }
  return complexity;
}
