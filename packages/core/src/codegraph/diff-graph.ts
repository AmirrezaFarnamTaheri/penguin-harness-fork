/**
 * Unified-diff parsing, hunk staging and line anchoring.
 *
 * Donor lineage (ported algorithm-for-algorithm from Go, no vendored code):
 * `internal/diff/parser.go` — per-file sectioning with an `inHunk` state machine so that an added
 * line like `++i` inside a hunk still counts as an insertion while `+++ b/file` outside one is a
 * header; rename/new/deleted/binary detection via `rename from`/`rename to`, `new file mode`,
 * `deleted file mode`, `Binary files` and `/dev/null` markers.
 * `internal/diff/hunk.go` — hunk header regex `^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@` with a
 * count default of 1, `\ No newline at end of file` skipping, and termination at the next
 * `diff --git` header.
 * `internal/diff/resolver.go` — side line-number arithmetic (context lines advance both sides,
 * added lines advance the new side, deleted lines advance the old side), consecutive-match
 * excerpt location, blank-tolerant full-file fallback, and cross-file relocation that *declines*
 * on zero or ambiguous hits rather than guessing.
 * `cr/diff_rlm.py` — citation parsing (`path:line`, `path:start-end`) and the diff-bounded
 * citation rule (a citation may only point at lines visible in a hunk).
 */

import type { DiffCitation, DiffFile, DiffHunk } from "./types.js";

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const BINARY_RE = /^Binary files /;

/** A line paired with its absolute (1-indexed) line number on one side of a hunk. */
interface IndexedLine {
  lineNum: number;
  content: string;
}

/**
 * Split unified diff text into per-file sections. Faithful to the donor's state machine: counting
 * and binary detection are guarded by `inHunk` because only hunk content lines carry a leading
 * `+`/`-`/` ` marker.
 */
export function parseDiffText(diffText: string): DiffFile[] {
  const lines = diffText.split("\n");
  const diffs: DiffFile[] = [];
  let current: DiffFile | null = null;
  let buf: string[] = [];
  let inHunk = false;

  const flush = (): void => {
    if (!current) return;
    current.patch = buf.join("\n");
    diffs.push(current);
    buf = [];
  };

  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) {
      flush();
      const match = DIFF_HEADER_RE.exec(line)!;
      current = {
        oldPath: match[1]!,
        newPath: match[2]!,
        patch: "",
        insertions: 0,
        deletions: 0,
        isBinary: false,
        isNew: false,
        isDeleted: false,
        isRenamed: false,
      };
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk && line.startsWith("index ")) {
      continue;
    } else if (!inHunk && BINARY_RE.test(line)) {
      current.isBinary = true;
    } else if (line.startsWith("new file mode ")) {
      current.isNew = true;
    } else if (line.startsWith("deleted file mode ")) {
      current.isDeleted = true;
    } else if (line.startsWith("rename from ")) {
      // Authoritative for paths containing spaces, unlike the `diff --git` header.
      current.oldPath = line.slice("rename from ".length);
      current.isRenamed = true;
    } else if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      current.isRenamed = true;
    } else if (!inHunk && line === "--- /dev/null") {
      current.isNew = true;
    } else if (!inHunk && line === "+++ /dev/null") {
      current.isDeleted = true;
    } else if (inHunk && line.startsWith("+")) {
      current.insertions++;
    } else if (inHunk && line.startsWith("-")) {
      current.deletions++;
    }
    buf.push(line);
  }
  flush();
  return diffs;
}

/** Parse the `@@ ... @@` blocks of one file's patch into structured hunks. */
export function parseHunks(patch: string): DiffHunk[] {
  const lines = patch.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    const match = HUNK_HEADER_RE.exec(line);
    if (match) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(match[1]!),
        oldCount: match[2] ? Number(match[2]!) : 1,
        newStart: Number(match[3]!),
        newCount: match[4] ? Number(match[4]!) : 1,
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("diff --git ")) break;

    if (line.startsWith("+")) {
      current.lines.push({ type: "added", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "deleted", content: line.slice(1) });
    } else {
      current.lines.push({
        type: "context",
        content: line.length > 0 && line[0] === " " ? line.slice(1) : line,
      });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/** Extract one side of a hunk with absolute line numbers. `newSide` selects context+added or context+deleted. */
export function extractSideLines(hunk: DiffHunk, newSide: boolean): IndexedLine[] {
  const result: IndexedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const entry of hunk.lines) {
    switch (entry.type) {
      case "context":
        result.push({
          lineNum: newSide ? newLine : oldLine,
          content: normalizeLine(entry.content),
        });
        oldLine++;
        newLine++;
        break;
      case "added":
        if (newSide) result.push({ lineNum: newLine, content: normalizeLine(entry.content) });
        newLine++;
        break;
      case "deleted":
        if (!newSide) result.push({ lineNum: oldLine, content: normalizeLine(entry.content) });
        oldLine++;
        break;
    }
  }
  return result;
}

/**
 * Trim and collapse surrounding whitespace.
 *
 * The diff `+`/`-` marker is removed *exactly once*, by `parseHunks`, where the `inHunk` state
 * machine is the only place that can tell `+++ b/file` (header) from `++i` (inserted source).
 * Stripping a second time here mangled real sources whose first character is `+` or `-`: `++i;`
 * became `+i;` and never matched an excerpt again. Raw source passed to `splitAndNormalize` and
 * `resolveFromFileContent` never carried a marker in the first place.
 */
export function normalizeLine(line: string): string {
  return line.trim();
}

/** Split code text into normalized, non-blank lines. */
export function splitAndNormalize(code: string): string[] {
  return code
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0);
}

/** Sliding-window scan for a consecutive run of target lines within indexed side lines. */
export function matchConsecutive(
  sideLines: IndexedLine[],
  targetLines: string[],
): { start: number; end: number } | undefined {
  if (targetLines.length === 0 || sideLines.length < targetLines.length) return undefined;
  for (let i = 0; i <= sideLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (sideLines[i + j]!.content !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start: sideLines[i]!.lineNum, end: sideLines[i + targetLines.length - 1]!.lineNum };
    }
  }
  return undefined;
}

/** Locate an excerpt in a diff file: hunks first (new side, then old side), then the full new file. */
export function resolveExcerpt(
  file: DiffFile,
  excerpt: string,
  newFileContent?: string,
): { start: number; end: number } | undefined {
  const targetLines = splitAndNormalize(excerpt);
  if (targetLines.length === 0) return undefined;

  const hunks = parseHunks(file.patch);
  for (const hunk of hunks) {
    const found = matchConsecutive(extractSideLines(hunk, true), targetLines);
    if (found) return found;
  }
  for (const hunk of hunks) {
    const found = matchConsecutive(extractSideLines(hunk, false), targetLines);
    if (found) return found;
  }
  if (newFileContent !== undefined) return resolveFromFileContent(newFileContent, excerpt);
  return undefined;
}

/** Fallback: scan full file content, skipping blanks so "consecutive" means adjacent non-blank lines. */
export function resolveFromFileContent(
  content: string,
  excerpt: string,
): { start: number; end: number } | undefined {
  const targetLines = splitAndNormalize(excerpt);
  if (targetLines.length === 0) return undefined;
  const normalized: string[] = [];
  const lineNums: number[] = [];
  content.split("\n").forEach((line, index) => {
    const normalizedLine = normalizeLine(line.replace(/\r$/, ""));
    if (normalizedLine === "") return;
    normalized.push(normalizedLine);
    lineNums.push(index + 1);
  });
  if (normalized.length < targetLines.length) return undefined;
  for (let i = 0; i <= normalized.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (normalized[i + j] !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return { start: lineNums[i]!, end: lineNums[i + targetLines.length - 1]! };
  }
  return undefined;
}

/**
 * Re-file a citation whose excerpt lives in a different file. Declines on zero *and* ambiguous
 * hits — the donor's anti-hallucination rule: the same boilerplate legitimately appears in many
 * files, and guessing between them trades one wrong location for another.
 */
export function relocateAcrossFiles(
  citation: { path: string; excerpt: string },
  diffs: DiffFile[],
  newFileContents?: Map<string, string>,
): { path: string; start: number; end: number } | undefined {
  const hits: Array<{ path: string; start: number; end: number }> = [];
  for (const diff of diffs) {
    if (diff.newPath === citation.path || diff.oldPath === citation.path) continue;
    const probe = { path: citation.path, excerpt: citation.excerpt };
    const located = resolveExcerpt(
      diff,
      probe.excerpt,
      newFileContents?.get(diff.newPath ?? diff.oldPath),
    );
    if (!located) continue;
    const path = diff.newPath || diff.oldPath;
    hits.push({ path: path!, start: located.start, end: located.end });
    if (hits.length > 1) return undefined; // ambiguous
  }
  if (hits.length !== 1) return undefined;
  return hits[0];
}

/** Parse citations from `path:line`, `path:start-end`, or structured records. */
export function parseCitations(raw: string | string[] | unknown[]): DiffCitation[] {
  const items: unknown[] = Array.isArray(raw) ? raw : String(raw).split(",");
  const citations: DiffCitation[] = [];
  for (const item of items) {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      citations.push({
        path: String(record.path ?? ""),
        side: String(record.side ?? "unified") as DiffCitation["side"],
        startLine: Number(record.startLine ?? 1),
        endLine: Number(record.endLine ?? 1),
        label: record.label ? String(record.label) : undefined,
        reason: record.reason ? String(record.reason) : undefined,
      });
      continue;
    }
    const text = String(item).trim();
    if (!text.includes(":")) continue;
    const lastColon = text.lastIndexOf(":");
    const path = text.slice(0, lastColon);
    const linePart = text.slice(lastColon + 1);
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(linePart.trim());
    if (rangeMatch) {
      citations.push({
        path,
        side: "unified",
        startLine: Number(rangeMatch[1]),
        endLine: Number(rangeMatch[2]),
      });
      continue;
    }
    if (isPositiveInt(linePart)) {
      citations.push({
        path,
        side: "unified",
        startLine: Number(linePart),
        endLine: Number(linePart),
      });
    }
  }
  return citations;
}

function isPositiveInt(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number(value.trim()) > 0;
}

/**
 * Diff-bounded citation validation: a citation is only valid if its line range is visible inside a
 * hunk of the cited file. Ports the review engine's strict rule forbidding citations outside the
 * visible diff, which is what makes generated review comments trustworthy.
 *
 * "Visible" means *substantially* visible: the cited range must be at least half covered by one
 * hunk's lines. Accepting on a single shared line let `foo.ts:10-10000` pass because line 10 was
 * in a hunk, certifying lines the diff never shows.
 */
export const CITATION_MIN_COVERAGE = 0.5;

export function validateCitations(citations: DiffCitation[], diffs: DiffFile[]): DiffCitation[] {
  const byPath = new Map<string, DiffFile>();
  for (const diff of diffs) {
    if (diff.newPath) byPath.set(diff.newPath, diff);
    if (diff.oldPath) byPath.set(diff.oldPath, diff);
  }
  return citations.filter((citation) => {
    const diff = byPath.get(citation.path);
    if (!diff) return false;
    const cited = citation.endLine - citation.startLine + 1;
    // Lines of the cited range that must be visible for the citation to count as honest.
    const required = Math.max(1, Math.ceil(cited * CITATION_MIN_COVERAGE));
    return parseHunks(diff.patch).some((hunk) => {
      const side = extractSideLines(hunk, citation.side !== "deletions");
      let visible = 0;
      for (const indexed of side) {
        if (indexed.lineNum >= citation.startLine && indexed.lineNum <= citation.endLine) {
          if (++visible >= required) return true;
        }
      }
      return false;
    });
  });
}

/** Split a model answer into markdown and code blocks (donor `_parse_answer_blocks`). */
export function parseAnswerBlocks(
  answer: string,
): Array<{ type: "markdown" | "code"; content: string; language?: string }> {
  const blocks: Array<{ type: "markdown" | "code"; content: string; language?: string }> = [];
  const lines = answer.split("\n");
  let current: string[] = [];
  let inCode = false;
  let language: string | undefined;
  for (const line of lines) {
    if (line.startsWith("```") && !inCode) {
      if (current.length) {
        blocks.push({ type: "markdown", content: current.join("\n") });
        current = [];
      }
      inCode = true;
      language = line.slice(3).trim() || undefined;
    } else if (line.startsWith("```") && inCode) {
      blocks.push({ type: "code", content: current.join("\n"), language });
      current = [];
      inCode = false;
      language = undefined;
    } else {
      current.push(line);
    }
  }
  if (current.length) {
    blocks.push({ type: inCode ? "code" : "markdown", content: current.join("\n"), language });
  }
  return blocks;
}
