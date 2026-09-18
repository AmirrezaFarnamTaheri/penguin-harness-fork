/**
 * Adversarial review rule engine.
 *
 * Donor lineage (algorithms and rule catalogs only): AsyncReview's `FastAutoReview` — the
 * review-issue model (severity `low/medium/high/critical`, category
 * `bug/investigation/informational`), the diff-bounded citation rule that forbids citing lines
 * outside the visible hunks, and the four review checklists (code-quality, security, SOLID,
 * removal-plan). The donor drove review with an LLM; this engine ports the *deterministic* part —
 * the rule catalog and the anchoring/validating machinery — so review findings are exact and
 * reproducible, and adds graph-integrated rules that the donor could not express.
 */

import type {
  DiffCitation,
  DiffFile,
  DiffHunk,
  ReviewCategory,
  ReviewIssue,
  Severity,
} from "./types.js";
import { SEVERITY_ORDER } from "./types.js";
import { extractSideLines, parseHunks, validateCitations } from "./diff-graph.js";

/** Per-file context handed to each rule. */
export interface ReviewRuleContext {
  file: DiffFile;
  hunks: DiffHunk[];
  content: string;
  contentLines: string[];
  /** Added lines with their 1-indexed new-file line numbers. */
  addedLines: Array<{ line: number; content: string }>;
  /** Deleted lines with their old-file line numbers. */
  deletedLines: Array<{ line: number; content: string }>;
  /** Optional symbol-level graph statistics for graph-integrated rules. */
  symbolStats?: Map<string, SymbolReviewStats>;
  filePath: string;
}

/** Graph statistics a rule may consult. */
export interface SymbolReviewStats {
  kind: string;
  qualifiedName: string;
  complexity: number;
  startLine: number;
  endLine: number;
  inDegree: number;
  outDegree: number;
  centrality: number;
  isExported: boolean;
}

/** Context for a whole review run. */
export interface ReviewContext {
  diffs: DiffFile[];
  /** New-file contents keyed by new path. */
  fileContents: Map<string, string>;
  symbolStats?: Map<string, SymbolReviewStats>;
}

/** A deterministic review rule. */
export interface ReviewRule {
  id: string;
  title: string;
  severity: Severity;
  category: ReviewCategory;
  explanation: string;
  match: (ctx: ReviewRuleContext) => Array<{
    line: number;
    excerpt?: string;
    suggestion: string;
    test?: string;
  }>;
}

export interface ReviewEngineOptions {
  /** When true, citations failing the diff-bounds check are dropped instead of failing the issue. */
  dropUnboundedCitations?: boolean;
}

export class ReviewEngine {
  private readonly rules: ReviewRule[];
  private readonly options: ReviewEngineOptions;

  constructor(rules: ReviewRule[], options?: ReviewEngineOptions) {
    this.rules = rules;
    this.options = { dropUnboundedCitations: true, ...options };
  }

  /** Run every rule over every changed file and return severity-ranked issues. */
  run(context: ReviewContext): ReviewIssue[] {
    const issues: ReviewIssue[] = [];
    for (const file of context.diffs) {
      const hunks = parseHunks(file.patch);
      const content = context.fileContents.get(file.newPath) ?? "";
      const contentLines = content.split("\n");
      const addedLines: Array<{ line: number; content: string }> = [];
      const deletedLines: Array<{ line: number; content: string }> = [];
      for (const hunk of hunks) {
        let newLine = hunk.newStart;
        let oldLine = hunk.oldStart;
        for (const entry of hunk.lines) {
          if (entry.type === "added") addedLines.push({ line: newLine, content: entry.content });
          if (entry.type === "deleted")
            deletedLines.push({ line: oldLine, content: entry.content });
          if (entry.type === "context") {
            newLine++;
            oldLine++;
          } else if (entry.type === "added") newLine++;
          else oldLine++;
        }
      }
      const ruleContext: ReviewRuleContext = {
        file,
        hunks,
        content,
        contentLines,
        addedLines,
        deletedLines,
        symbolStats: context.symbolStats,
        filePath: file.newPath || file.oldPath,
      };
      for (const rule of this.rules) {
        const matches = rule.match(ruleContext);
        for (const match of matches) {
          const citation: DiffCitation = {
            path: ruleContext.filePath,
            side: "additions",
            startLine: match.line,
            endLine: match.line,
            label: rule.id,
            reason: rule.title,
          };
          const citations = this.options.dropUnboundedCitations
            ? validateCitations([citation], context.diffs)
            : [citation];
          if (citations.length === 0 && this.options.dropUnboundedCitations) continue;
          issues.push({
            id: `${rule.id}:${ruleContext.filePath}:${match.line}`,
            ruleId: rule.id,
            title: rule.title,
            severity: rule.severity,
            category: rule.category,
            explanation: match.excerpt
              ? `${rule.explanation} Offending line: ${match.excerpt.trim()}`
              : rule.explanation,
            citations,
            fixSuggestions: [match.suggestion],
            testsToAdd: match.test ? [match.test] : [],
          });
        }
      }
    }
    return this.rank(issues);
  }

  /** Rank issues by severity (critical first), then by file and line. */
  private rank(issues: ReviewIssue[]): ReviewIssue[] {
    return issues.sort((a, b) => {
      const rankA = SEVERITY_ORDER.indexOf(a.severity);
      const rankB = SEVERITY_ORDER.indexOf(b.severity);
      if (rankA !== rankB) return rankB - rankA;
      const pathA = a.citations[0]?.path ?? "";
      const pathB = b.citations[0]?.path ?? "";
      if (pathA !== pathB) return pathA.localeCompare(pathB);
      return (a.citations[0]?.startLine ?? 0) - (b.citations[0]?.startLine ?? 0);
    });
  }
}

/** Build the hunk-side line map used by rules that need surrounding context. */
export function hunkLineMap(hunks: DiffHunk[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const hunk of hunks) {
    for (const indexed of extractSideLines(hunk, true)) {
      map.set(indexed.lineNum, indexed.content);
    }
  }
  return map;
}
