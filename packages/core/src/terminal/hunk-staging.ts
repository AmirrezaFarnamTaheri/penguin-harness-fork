/**
 * Git diff hunks and per-line staging.
 *
 * Ported from the Rust git TUI's diff layer (`asyncgit/src/sync/diff.rs`,
 * `sync/hunks.rs`, `sync/patches.rs` and `sync/staging/mod.rs`). That
 * project's `apply_selection` is the heart of the per-line stage, unstage
 * and discard flow — it rebuilds the working-copy contents from the old file
 * plus the user's per-line selection — and it is reproduced here because the
 * same rebuild is needed to stage git hunks from the cockpit UI.
 *
 * The data model mirrors the source types so the UI can stay shaped like the
 * upstream feature it replaces: `DiffLineType`, `DiffLinePosition`,
 * `HunkHeader` (with a stable `headerHash` so a hunk keeps its identity
 * across a re-diff), `Hunk` and `FileDiff`.
 */

/** Type of a single diff line. */
export enum DiffLineType {
  /** Context line, unchanged. */
  None = 0,
  /** The `@@ ... @@` hunk header. */
  Header = 1,
  /** Added line (`+`). */
  Add = 2,
  /** Deleted line (`-`). */
  Delete = 3,
}

/** 1-based line numbers of one diff line; one side is `null` for pure adds/deletes. */
export interface DiffLinePosition {
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
}

export interface DiffLine {
  /** Line content without the leading `+`/`-`/` ` origin marker or newline. */
  readonly content: string;
  readonly lineType: DiffLineType;
  readonly position: DiffLinePosition;
}

/** Stable identity of a hunk: the two ranges in the `@@` header. */
export interface HunkHeader {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface Hunk {
  /** 64-bit hash of `HunkHeader`, stable across re-diffs of the same file. */
  readonly headerHash: bigint;
  readonly header: HunkHeader;
  readonly lines: DiffLine[];
}

export interface FileDiff {
  readonly hunks: Hunk[];
  /** Total diff lines across hunks. */
  readonly lines: number;
  /** True when the file is untracked (no tracked baseline to diff against). */
  readonly untracked: boolean;
  /** Old and new file sizes in bytes. */
  readonly sizes: [number, number];
  /** Size delta in bytes. */
  readonly sizeDelta: number;
}

/** Regex for a unified-diff hunk header, capturing both ranges. */
export const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `diff --git a/x b/x` line, capturing the paths. */
export const DIFF_FILE_HEADER_RE = /^diff --git a\/(.*) b\/(.*)$/;

/**
 * FNV-1a over the header fields, widened to 64 bits so hunk identity survives
 * large diffs the way the source project's `hash(&HunkHeader)` does. The
 * exact algorithm is not part of the contract; only stability within one
 * process is.
 */
export function hashHunkHeader(header: HunkHeader): bigint {
  const text = `${header.oldStart}\u0000${header.oldLines}\u0000${header.newStart}\u0000${header.newLines}`;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

export function hunkLineCount(hunk: Hunk): number {
  return hunk.lines.length;
}

export function addedLineCount(hunk: Hunk): number {
  return hunk.lines.filter((l) => l.lineType === DiffLineType.Add).length;
}

export function deletedLineCount(hunk: Hunk): number {
  return hunk.lines.filter((l) => l.lineType === DiffLineType.Delete).length;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into a `FileDiff`. Accepts output from
 * `git diff` / `git diff --cached` / `git diff --no-index`; content that does
 * not parse as a diff yields an empty `FileDiff` rather than throwing, so a
 * bad patch never takes the staging UI down.
 */
export function parseUnifiedDiff(patch: string): FileDiff {
  const hunks: Hunk[] = [];
  let currentLines: DiffLine[] = [];
  let currentHeader: HunkHeader | null = null;
  let oldLine = 0;
  let newLine = 0;
  let totalLines = 0;
  let inHunk = false;
  let oldSize = 0;
  let newSize = 0;

  const pushHunk = (): void => {
    if (currentHeader) {
      hunks.push({
        headerHash: hashHunkHeader(currentHeader),
        header: currentHeader,
        lines: currentLines,
      });
    }
    currentLines = [];
    currentHeader = null;
  };

  for (const raw of patch.split("\n")) {
    // `git diff` prefixes an extra tab when the path contains spaces.
    const line = raw.replace(/^\t/, "");
    if (line.startsWith("diff --git")) continue;
    if (line.startsWith("index ") || line.startsWith("similarity ") || line.startsWith("rename ")) {
      continue;
    }
    if (line.startsWith("--- ")) {
      oldSize += 1;
      continue;
    }
    if (line.startsWith("+++ ")) {
      newSize += 1;
      continue;
    }
    if (line.startsWith("new file mode") || line.startsWith("deleted file mode")) continue;
    if (HUNK_HEADER_RE.test(line)) {
      if (inHunk) pushHunk();
      const match = HUNK_HEADER_RE.exec(line);
      const oldStart = match ? Number.parseInt(match[1]!, 10) : 0;
      const oldLines = match ? Number.parseInt(match[2] ?? "1", 10) : 0;
      const newStart = match ? Number.parseInt(match[3]!, 10) : 0;
      const newLines = match ? Number.parseInt(match[4] ?? "1", 10) : 0;
      currentHeader = { oldStart, oldLines, newStart, newLines };
      oldLine = oldStart;
      newLine = newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const origin = line[0];
    const content = line.slice(1);
    switch (origin) {
      case "+":
        currentLines.push({
          content,
          lineType: DiffLineType.Add,
          position: { oldLineNumber: null, newLineNumber: newLine++ },
        });
        totalLines += 1;
        newSize += content.length + 1;
        break;
      case "-":
        currentLines.push({
          content,
          lineType: DiffLineType.Delete,
          position: { oldLineNumber: oldLine++, newLineNumber: null },
        });
        totalLines += 1;
        oldSize += content.length + 1;
        break;
      case " ":
        currentLines.push({
          content,
          lineType: DiffLineType.None,
          position: { oldLineNumber: oldLine++, newLineNumber: newLine++ },
        });
        totalLines += 1;
        oldSize += content.length + 1;
        newSize += content.length + 1;
        break;
      case "\\":
        // "\ No newline at end of file" — attaches to the previous line, no
        // line number of its own.
        break;
      default:
        break;
    }
  }
  if (inHunk) pushHunk();

  return {
    hunks,
    lines: totalLines,
    untracked: false,
    sizes: [oldSize, newSize],
    sizeDelta: newSize - oldSize,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type SelectionMode = "stage" | "unstage" | "discard";

export interface LineSelection {
  readonly mode: SelectionMode;
  /** Positions of the lines the selection covers. */
  readonly positions: readonly DiffLinePosition[];
}

/** The lines a selection actually touches, bounded by the hunk they sit in. */
export function selectionPositions(lines: readonly DiffLine[]): DiffLinePosition[] {
  return lines
    .filter((l) => l.lineType === DiffLineType.Add || l.lineType === DiffLineType.Delete)
    .map((l) => l.position);
}

/**
 * Apply a per-line selection to a file's contents, rebuilding the working
 * copy. This is a direct port of `apply_selection` from the source project's
 * staging module, which documents itself as "the heart of the per line
 * discard, stage, unstage" and credits the same algorithm to nodegit.
 *
 * `oldLines` is the content of the side being rewritten, split into lines:
 * the index content for `stage` and `unstage`, the working-copy content for
 * `discard`. The diff must be the corresponding patch — index→worktree for
 * `stage`/`discard`, HEAD→index for `unstage`.
 *
 * The source project's two mode flags map onto `mode` as: `is_staged` is true
 * for `unstage` (the index is being rewritten back toward HEAD, and its
 * caller `stage_lines` passes `is_stage=true` for an un-stage), and `reverse`
 * is true for `discard`. For `stage`/`unstage`, added lines are kept only when
 * selected and deleted lines are kept only when not selected; for `discard`
 * the sense of added/deleted is swapped, because discarding reverts the
 * working copy toward the index rather than the index toward the working copy.
 *
 * Returns the rebuilt file content as a single string.
 */
export function applySelection(
  diff: FileDiff,
  selection: LineSelection,
  oldLines: readonly string[],
): string {
  const selected = new Set(selection.positions.map(positionKey));
  const reverse = selection.mode === "discard";
  const isStaged = selection.mode === "unstage";
  const added = reverse ? DiffLineType.Delete : DiffLineType.Add;
  const deleted = reverse ? DiffLineType.Add : DiffLineType.Delete;
  // `hunk_start = if is_staged || reverse { new_start } else { old_start }`.
  const useNewRange = isStaged || reverse;

  const out: string[] = [];
  let oldIndex = 0;

  const addOldLine = (): void => {
    if (oldIndex < oldLines.length) {
      out.push(oldLines[oldIndex]!);
      oldIndex += 1;
    }
  };

  const addHunkLine = (content: string): void => {
    out.push(content);
  };

  const catchUpTo = (hunkStart: number): void => {
    while (hunkStart > oldIndex + 1 && oldIndex < oldLines.length) addOldLine();
  };

  let firstHunkEncountered = false;
  for (const hunk of diff.hunks) {
    const hunkStart = useNewRange ? hunk.header.newStart : hunk.header.oldStart;

    if (!firstHunkEncountered) {
      firstHunkEncountered = hunk.lines.some((l) => selected.has(positionKey(l.position)));
    }
    if (!firstHunkEncountered) continue;

    catchUpTo(hunkStart);

    for (const hunkLine of hunk.lines) {
      const isSelected = selected.has(positionKey(hunkLine.position));
      const type = hunkLine.lineType;

      // The source project stops a hunk at the end-of-file-newline markers.
      if (type === DiffLineType.Header) break;

      // `(is_staged && !selected) || (!is_staged && selected)` — the line's
      // change is NOT being applied, so it survives as-is on the rewritten
      // side.
      const notApplied = isStaged !== isSelected;
      if (notApplied) {
        if (type === added) {
          addHunkLine(hunkLine.content);
          if (isStaged) oldIndex += 1;
        } else if (type === deleted) {
          if (!isStaged) oldIndex += 1;
        } else {
          addOldLine();
        }
      } else {
        if (type !== added) addHunkLine(hunkLine.content);
        if ((isStaged && type !== deleted) || (!isStaged && type !== added)) {
          oldIndex += 1;
        }
      }
    }
  }

  while (oldIndex < oldLines.length) {
    out.push(oldLines[oldIndex]!);
    oldIndex += 1;
  }
  return joinLines(out);
}

/** Stable string key for a line position; both sides participate. */
export function positionKey(position: DiffLinePosition): string {
  return `${position.oldLineNumber ?? "-"}:${position.newLineNumber ?? "-"}`;
}

function joinLines(lines: readonly string[]): string {
  const joined = lines.join("\n");
  return joined.length === 0 ? "" : `${joined}\n`;
}

/**
 * Stage/unstage/discard whole hunks, addressed by their stable header hash —
 * the same addressing the source project's `stage_hunk` / `unstage_hunk` /
 * `reset_hunk` use, so a re-diff cannot address the wrong hunk.
 */
export function hunkByHash(diff: FileDiff, headerHash: bigint): Hunk | null {
  return diff.hunks.find((h) => h.headerHash === headerHash) ?? null;
}

export function hunkIndexByHash(diff: FileDiff, headerHash: bigint): number {
  return diff.hunks.findIndex((h) => h.headerHash === headerHash);
}

/** Rebuild the file with one whole hunk's change applied or reverted. */
export function applyHunk(
  diff: FileDiff,
  headerHash: bigint,
  oldLines: readonly string[],
  mode: SelectionMode,
): string {
  const hunk = hunkByHash(diff, headerHash);
  if (!hunk) return joinLines(oldLines);
  return applySelection(
    { ...diff, hunks: [hunk] },
    { mode, positions: selectionPositions(hunk.lines) },
    oldLines,
  );
}

/**
 * Split a hunk's lines into per-side lists, which the diff card renders as
 * aligned old/new columns.
 */
export function splitHunkSides(hunk: Hunk): {
  oldSide: DiffLine[];
  newSide: DiffLine[];
} {
  const oldSide: DiffLine[] = [];
  const newSide: DiffLine[] = [];
  for (const line of hunk.lines) {
    if (line.lineType === DiffLineType.Add) newSide.push(line);
    else if (line.lineType === DiffLineType.Delete) oldSide.push(line);
    else {
      oldSide.push(line);
      newSide.push(line);
    }
  }
  return { oldSide, newSide };
}

/** `+12,−3` summary text for a hunk, used by the diff card header. */
export function hunkSummary(hunk: Hunk): string {
  return `+${addedLineCount(hunk)},−${deletedLineCount(hunk)}`;
}

/** `+120 −45` summary for a whole file diff. */
export function fileDiffSummary(diff: FileDiff): string {
  const added = diff.hunks.reduce((sum, h) => sum + addedLineCount(h), 0);
  const deleted = diff.hunks.reduce((sum, h) => sum + deletedLineCount(h), 0);
  return `+${added} −${deleted}`;
}

/** Split file contents into lines, dropping the empty element after a final newline. */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** True when the content ends without a newline, which matters for staging. */
export function missingFinalNewline(content: string): boolean {
  return content.length > 0 && !content.endsWith("\n");
}
