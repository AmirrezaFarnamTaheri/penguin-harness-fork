/**
 * Review rule presets.
 *
 * Donor lineage (catalogs ported verbatim in intent from AsyncReview's checklists):
 *  - `security-checklist.md`  → SECURITY_PRESET (injection, XSS, secrets, path traversal, CORS,
 *    unbounded loops, weak crypto, eval).
 *  - `code-quality-checklist.md` → CODE_QUALITY_PRESET (swallowed/broad exceptions, magic numbers,
 *    long methods, deep nesting, TODO/FIXME leftovers, debug logging).
 *  - `solid-checklist.md` → ARCHITECTURE_PRESET (god objects, shotgun surgery, dead code), which
 *    the donor could only express as prose prompts; these versions use the symbol graph.
 *  - `removal-plan.md` → buildRemovalPlan(), the structured P0/P1/P2 removal record.
 *
 * Every rule is a deterministic scanner over diff-added lines, so findings are reproducible and
 * citable to a real hunk line.
 */

import type { ReviewRuleContext, ReviewRule, SymbolReviewStats } from "./review-engine.js";

/** Security audit preset (OWASP-flavoured, per the security checklist). */
export const SECURITY_PRESET: ReviewRule[] = [
  {
    id: "sec-hardcoded-secret",
    title: "Hardcoded secret in source",
    severity: "critical",
    category: "security",
    explanation:
      "A credential-looking literal is committed in source. Secrets must come from the vault or environment, never from a literal.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) =>
          /(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(
            content,
          ),
        )
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Move the secret to the agent vault or environment and reference it by name.",
          test: "Add a test asserting no secret literals appear in shipped sources.",
        })),
  },
  {
    id: "sec-eval-exec",
    title: "Dynamic code execution",
    severity: "critical",
    category: "security",
    explanation:
      "eval()/exec() executes attacker-controlled strings. Replace with a parser or a strict allow-list.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) => /\b(?:eval|exec)\s*\(/.test(content))
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Replace eval/exec with a dedicated parser or a validated dispatch table.",
          test: "Assert the module no longer references eval/exec.",
        })),
  },
  {
    id: "sec-sql-injection",
    title: "Potential SQL injection via string interpolation",
    severity: "high",
    category: "security",
    explanation:
      "A query is built by interpolation or concatenation instead of a parameterized statement.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) =>
          /(?:query|execute|sql|raw)\s*\(\s*[`'"][^'"]*(?:\$\{|\+\s*[A-Za-z_$])/i.test(content),
        )
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Use a parameterized query with placeholders for all user-supplied values.",
          test: "Fuzz the query path with quote payloads and assert no error surface.",
        })),
  },
  {
    id: "sec-xss-innerhtml",
    title: "Unsafe HTML injection (XSS)",
    severity: "high",
    category: "security",
    explanation:
      "innerHTML assignment or dangerouslySetInnerHTML renders unescaped markup, enabling script injection.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) => /(?:innerHTML\s*=|dangerouslySetInnerHTML)/.test(content))
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Render text content or escape the markup before insertion.",
          test: "Inject a <script> payload and assert it is not executed.",
        })),
  },
  {
    id: "sec-path-traversal",
    title: "Unsanitised path input (traversal risk)",
    severity: "high",
    category: "security",
    explanation:
      "User-influenced input reaches a filesystem path without normalization, permitting `../` escapes.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) =>
          /(?:readFile|writeFile|readFileSync|writeFileSync|open|createReadStream|path\.join)\s*\(\s*(?:`[^`]*\$\{|\.\.\?)/.test(
            content,
          ),
        )
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion:
            "Resolve and normalize the path, then assert it stays inside the allow-listed root.",
          test: "Pass `../../etc/passwd` and assert rejection.",
        })),
  },
  {
    id: "sec-permissive-cors",
    title: "Permissive CORS with credentials",
    severity: "medium",
    category: "security",
    explanation:
      "A wildcard origin combined with credentials widens the attack surface to any site.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) => /Access-Control-Allow-Origin['"]\s*,?\s*['"]\*['"]/.test(content))
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Enumerate allowed origins instead of using a wildcard.",
          test: "Assert a cross-origin request from an unknown origin is rejected.",
        })),
  },
];

/** Code quality preset (from the code-quality checklist). */
export const CODE_QUALITY_PRESET: ReviewRule[] = [
  {
    id: "q-swallowed-exception",
    title: "Swallowed exception",
    severity: "high",
    category: "bug",
    explanation:
      "An empty catch block (or one that only logs) hides failures from the caller. Catch at an appropriate boundary and propagate or recover.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) => /catch\s*\([^)]*\)\s*\{\s*\}/.test(content))
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Handle the error, rethrow with context, or define fallback behaviour.",
          test: "Inject a failure and assert the caller observes it.",
        })),
  },
  {
    id: "q-broad-catch",
    title: "Overly broad catch",
    severity: "medium",
    category: "bug",
    explanation:
      "Catching a base Exception/Error swallows unrelated failures. Catch the specific expected type.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) =>
          /catch\s*\(\s*(?:\w+\s+)?(Exception|Error|Throwable|BaseException)\b/.test(content),
        )
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Narrow the catch clause to the specific error type this boundary expects.",
          test: "Throw an unrelated error type and assert it is not swallowed.",
        })),
  },
  {
    id: "q-magic-number",
    title: "Magic number literal",
    severity: "low",
    category: "style",
    explanation:
      "A 4+ digit literal is hard to interpret. Bind it to a named constant that expresses intent.",
    match: (ctx) =>
      ctx.addedLines
        .filter(
          ({ content }) =>
            /(?:=|return|:)\s*\d{4,}\b/.test(content) && !/^[A-Z0-9_]+\s*=/.test(content.trim()),
        )
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion:
            "Extract the value into an UPPER_SNAKE_CASE constant with a documenting name.",
        })),
  },
  {
    id: "q-todo-fixme",
    title: "Unresolved TODO/FIXME marker",
    severity: "medium",
    category: "informational",
    explanation:
      "A TODO/FIXME/HACK marker ships without resolution. Convert it to a tracked issue or remove it.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) => /\b(?:TODO|FIXME|HACK|XXX)\b/.test(content))
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Resolve the marker, or file it as a tracked issue with an owner and date.",
          test: "Assert the shipped change set contains no TODO/FIXME markers.",
        })),
  },
  {
    id: "q-deep-nesting",
    title: "Deeply nested control flow",
    severity: "medium",
    category: "style",
    explanation:
      "Nesting beyond four levels is hard to reason about. Extract a helper or invert a guard.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) => {
          const indent = content.length - content.trimStart().length;
          const opens = (content.match(/\{/g) ?? []).length;
          return indent / 2 >= 4 && opens >= 1;
        })
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Extract the inner block into a named helper or convert to guard clauses.",
        })),
  },
  {
    id: "q-debug-logging",
    title: "Debug logging left in production path",
    severity: "low",
    category: "informational",
    explanation:
      "Console logging in a shipped path leaks internals and costs I/O. Route through the logger or remove.",
    match: (ctx) =>
      ctx.addedLines
        .filter(({ content }) => /console\.(log|debug|info)\s*\(/.test(content))
        .map(({ line, content }) => ({
          line,
          excerpt: content,
          suggestion: "Replace with the structured logger at an appropriate level, or delete.",
        })),
  },
];

/** Architecture preset (SOLID smells, implemented against the symbol graph). */
export const ARCHITECTURE_PRESET: ReviewRule[] = [
  {
    id: "a-long-method",
    title: "Long method / high cyclomatic complexity",
    severity: "medium",
    category: "informational",
    explanation:
      "A changed symbol scores high on cyclomatic complexity or spans many lines. Split by responsibility, not by size.",
    match: (ctx) => {
      if (!ctx.symbolStats) return [];
      return [...ctx.symbolStats.values()]
        .filter(
          (stats) =>
            overlapsHunk(stats, ctx) &&
            (stats.complexity >= 10 || stats.endLine - stats.startLine > 40),
        )
        .map((stats) => ({
          line: stats.startLine,
          excerpt: `${stats.qualifiedName} (complexity ${stats.complexity}, ${stats.endLine - stats.startLine + 1} lines)`,
          suggestion:
            "Split the symbol by responsibility; each successor should own a single reason to change.",
          test: "Add unit tests per extracted responsibility before and after the split.",
        }));
    },
  },
  {
    id: "a-god-object",
    title: "God object / architectural coupling hot-spot",
    severity: "medium",
    category: "informational",
    explanation:
      "A class sits at a centrality hot-spot and fans out widely; it has more than one reason to change.",
    match: (ctx) => {
      if (!ctx.symbolStats) return [];
      return [...ctx.symbolStats.values()]
        .filter(
          (stats) =>
            (stats.kind === "class" || stats.kind === "struct" || stats.kind === "trait") &&
            overlapsHunk(stats, ctx) &&
            (stats.centrality > 0.05 || stats.outDegree > 15),
        )
        .map((stats) => ({
          line: stats.startLine,
          excerpt: `${stats.qualifiedName} (centrality ${stats.centrality.toFixed(3)}, out-degree ${stats.outDegree})`,
          suggestion:
            "Segregate the interface and inject collaborators rather than depending on concretes.",
          test: "Assert each new collaborator interface is consumed by only its own callers.",
        }));
    },
  },
  {
    id: "a-dead-code-suspect",
    title: "Dead code suspect (no inbound callers)",
    severity: "low",
    category: "informational",
    explanation:
      "An exported symbol has no inbound calls or references in the graph. Verify, then remove per the removal plan.",
    match: (ctx) => {
      if (!ctx.symbolStats) return [];
      return [...ctx.symbolStats.values()]
        .filter(
          (stats) =>
            stats.isExported &&
            stats.inDegree === 0 &&
            (stats.kind === "function" || stats.kind === "method") &&
            overlapsHunk(stats, ctx),
        )
        .map((stats) => ({
          line: stats.startLine,
          excerpt: `${stats.qualifiedName} has ${stats.inDegree} inbound references`,
          suggestion:
            "Search for dynamic/reflective usage; if none, remove the symbol and its tests.",
          test: "Assert the package still builds and its public surface is unchanged otherwise.",
        }));
    },
  },
  {
    id: "a-shotgun-surgery",
    title: "Shotgun surgery hot-spot",
    severity: "high",
    category: "bug",
    explanation:
      "A highly central symbol with wide out-degree means one change forces edits across many files.",
    match: (ctx) => {
      if (!ctx.symbolStats) return [];
      return [...ctx.symbolStats.values()]
        .filter(
          (stats) =>
            stats.centrality > 0.03 &&
            stats.outDegree > 8 &&
            (stats.kind === "function" || stats.kind === "method") &&
            overlapsHunk(stats, ctx),
        )
        .map((stats) => ({
          line: stats.startLine,
          excerpt: `${stats.qualifiedName} (centrality ${stats.centrality.toFixed(3)}, out-degree ${stats.outDegree})`,
          suggestion:
            "Stabilise the symbol's contract behind an interface so dependants do not all need editing.",
          test: "Add a regression test covering the contract each dependent relies on.",
        }));
    },
  },
];

/** A symbol's line range touches the diff under review *in the same file*. */
function overlapsHunk(stats: SymbolReviewStats, ctx: ReviewRuleContext): boolean {
  // The stats map is global, but a hunk line number only means anything for its own file: without
  // this filter a symbol on lines 10-30 of A numerically overlaps a hunk at line 20 of B.
  if (stats.filePath !== ctx.filePath) return false;
  const touched = new Set(ctx.addedLines.map((entry) => entry.line));
  for (let line = stats.startLine; line <= stats.endLine; line++) {
    if (touched.has(line)) return true;
  }
  return false;
}

/** Strict security review: every security rule plus the highest-severity quality rules. */
export const STRICT_SECURITY_PRESET: ReviewRule[] = [
  ...SECURITY_PRESET,
  ...CODE_QUALITY_PRESET.filter((rule) => rule.severity === "high"),
];

/** Everything the engine knows how to check. */
export const ALL_REVIEW_RULES: ReviewRule[] = [
  ...SECURITY_PRESET,
  ...CODE_QUALITY_PRESET,
  ...ARCHITECTURE_PRESET,
];

/** A completed removal plan record, from the removal-plan checklist. */
export interface RemovalPlan {
  priority: "P0" | "P1" | "P2";
  location: string;
  rationale: string;
  evidence: string;
  impact: string;
  deletionSteps: string[];
  verification: string[];
  rollbackPlan: string;
}

/**
 * Build a structured removal plan for a dead-code finding. Ports the removal-plan checklist's
 * field set (priority levels, evidence, deletion steps, verification, rollback).
 */
export function buildRemovalPlan(params: {
  symbolName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  inboundReferences: number;
  severity?: "P0" | "P1" | "P2";
}): RemovalPlan {
  const priority = params.severity ?? (params.inboundReferences === 0 ? "P1" : "P2");
  return {
    priority,
    location: `${params.filePath}:${params.startLine}-${params.endLine}`,
    rationale: `${params.symbolName} has ${params.inboundReferences} inbound references and no active consumers.`,
    evidence: `Graph analysis reports in-degree ${params.inboundReferences}; grep for dynamic/reflective usage before removing.`,
    impact:
      params.inboundReferences === 0
        ? "None/Low — no active consumers."
        : "Low — verify each reference is stale.",
    deletionSteps: [
      "Remove the symbol definition.",
      "Remove its unit tests.",
      "Remove now-unused imports and config.",
    ],
    verification: [
      "Run the affected package tests.",
      "Typecheck the workspace.",
      "Confirm no runtime errors in dependent paths.",
    ],
    rollbackPlan: "Revert the removal commit; the symbol and its tests restore atomically.",
  };
}
