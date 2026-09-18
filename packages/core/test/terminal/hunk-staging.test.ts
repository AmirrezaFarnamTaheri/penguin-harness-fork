import { describe, expect, it } from "vitest";
import {
  DIFF_FILE_HEADER_RE,
  DiffLineType,
  HUNK_HEADER_RE,
  addedLineCount,
  applyHunk,
  applySelection,
  deletedLineCount,
  fileDiffSummary,
  hashHunkHeader,
  hunkByHash,
  hunkIndexByHash,
  hunkLineCount,
  hunkSummary,
  missingFinalNewline,
  parseUnifiedDiff,
  positionKey,
  selectionPositions,
  splitHunkSides,
  splitLines,
} from "../../src/terminal/hunk-staging";
import type { DiffLinePosition, LineSelection } from "../../src/terminal/hunk-staging";

// index: a b c d e → worktree: a B c X d e
const STAGE_PATCH = [
  "diff --git a/file.txt b/file.txt",
  "index 1111111..2222222 100644",
  "--- a/file.txt",
  "+++ b/file.txt",
  "@@ -1,5 +1,6 @@",
  " a",
  "-b",
  "+B",
  " c",
  "+X",
  " d",
  " e",
].join("\n");

// HEAD: 0 → index: 0 1 2 3
const UNSTAGE_PATCH = [
  "diff --git a/file.txt b/file.txt",
  "index 1111111..2222222 100644",
  "--- a/file.txt",
  "+++ b/file.txt",
  "@@ -1 +1,4 @@",
  " 0",
  "+1",
  "+2",
  "+3",
].join("\n");

// index: start mid end → worktree: start end
const DISCARD_PATCH = [
  "diff --git a/file.txt b/file.txt",
  "index 1111111..2222222 100644",
  "--- a/file.txt",
  "+++ b/file.txt",
  "@@ -1,3 +1,2 @@",
  " start",
  "-mid",
  " end",
].join("\n");

const select = (
  mode: LineSelection["mode"],
  positions: Array<[number | null, number | null]>,
): LineSelection => ({
  mode,
  positions: positions.map(([oldLineNumber, newLineNumber]): DiffLinePosition => ({
    oldLineNumber,
    newLineNumber,
  })),
});

describe("hunk staging", () => {
  it("matches the header regexes", () => {
    expect(HUNK_HEADER_RE.test("@@ -1,5 +1,6 @@ body")).toBe(true);
    expect(HUNK_HEADER_RE.exec("@@ -1,5 +1,6 @@")!.slice(1)).toEqual(["1", "5", "1", "6"]);
    // A single-line range omits the count, which defaults to 1.
    expect(HUNK_HEADER_RE.exec("@@ -1 +1,4 @@")!.slice(1)).toEqual(["1", undefined, "1", "4"]);
    expect(HUNK_HEADER_RE.test("@@ nonsense")).toBe(false);
    expect(DIFF_FILE_HEADER_RE.exec("diff --git a/x y.txt b/x y.txt")!.slice(1)).toEqual([
      "x y.txt",
      "x y.txt",
    ]);
  });

  it("hashes hunk headers stably", () => {
    const header = { oldStart: 1, oldLines: 5, newStart: 1, newLines: 6 };
    expect(hashHunkHeader(header)).toBe(hashHunkHeader(header));
    // Different ranges hash differently.
    expect(hashHunkHeader(header)).not.toBe(hashHunkHeader({ ...header, newLines: 7 }));
    // The hash is a 64-bit value.
    expect(hashHunkHeader(header) > 0n).toBe(true);
  });

  it("parses a unified diff", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    expect(diff.hunks).toHaveLength(1);
    const [hunk] = diff.hunks;
    expect(hunk!.header).toEqual({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 6 });
    expect(hunk!.headerHash).toBe(hashHunkHeader(hunk!.header));
    expect(hunkLineCount(hunk!)).toBe(7);
    expect(addedLineCount(hunk!)).toBe(2);
    expect(deletedLineCount(hunk!)).toBe(1);
    expect(diff.lines).toBe(7);
    expect(diff.untracked).toBe(false);
    expect(diff.sizeDelta).toBeGreaterThan(0);
    expect(diff.sizes[1]).toBeGreaterThan(diff.sizes[0]);
    // Line numbers track both sides; adds carry no old number, deletes no new one.
    const positions = hunk!.lines.map((l) => [
      l.lineType,
      l.position.oldLineNumber,
      l.position.newLineNumber,
    ]);
    expect(positions).toEqual([
      [DiffLineType.None, 1, 1],
      [DiffLineType.Delete, 2, null],
      [DiffLineType.Add, null, 2],
      [DiffLineType.None, 3, 3],
      [DiffLineType.Add, null, 4],
      [DiffLineType.None, 4, 5],
      [DiffLineType.None, 5, 6],
    ]);
  });

  it("ignores metadata and non-diff content", () => {
    const diff = parseUnifiedDiff(["not a diff at all", "neither is this"].join("\n"));
    expect(diff.hunks).toHaveLength(0);
    expect(diff.lines).toBe(0);
    // Rename and mode headers are skipped, and the tab prefix git adds for
    // paths with spaces is stripped from the content.
    const withMeta = parseUnifiedDiff(
      [
        "diff --git a/a b.txt b/a b.txt",
        "new file mode 100644",
        "index 1111111..2222222",
        "similarity index 100%",
        "rename from old.txt",
        "--- a/a b.txt",
        "+++ b/a b.txt",
        "@@ -1 +1 @@",
        "\t-a",
        "\t+a2",
      ].join("\n"),
    );
    expect(withMeta.hunks).toHaveLength(1);
    expect(withMeta.hunks[0]!.lines.map((l) => `${l.lineType}:${l.content}`)).toEqual([
      "3:a",
      "2:a2",
    ]);
  });

  it("stages a single changed line, leaving the rest unstaged", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    const index = splitLines("a\nb\nc\nd\ne\n");
    // Select only the b→B modification (both its deleted and added positions).
    const staged = applySelection(
      diff,
      select("stage", [
        [2, null],
        [null, 2],
      ]),
      index,
    );
    expect(staged).toBe("a\nB\nc\nd\ne\n");
  });

  it("stages an added line without touching the rest", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    const index = splitLines("a\nb\nc\nd\ne\n");
    const staged = applySelection(diff, select("stage", [[null, 4]]), index);
    // Only the "X" line is added to the index; the b→B change stays unstaged.
    expect(staged).toBe("a\nb\nc\nX\nd\ne\n");
  });

  it("stages the whole hunk when every change is selected", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    const index = splitLines("a\nb\nc\nd\ne\n");
    const staged = applySelection(
      diff,
      select("stage", [
        [2, null],
        [null, 2],
        [null, 4],
      ]),
      index,
    );
    expect(staged).toBe("a\nB\nc\nX\nd\ne\n");
  });

  it("unstages a line, reverting the index toward head", () => {
    const diff = parseUnifiedDiff(UNSTAGE_PATCH);
    const index = splitLines("0\n1\n2\n3\n");
    // Un-stage the "1" (new line 2 in the index).
    const unstaged = applySelection(diff, select("unstage", [[null, 2]]), index);
    expect(unstaged).toBe("0\n2\n3\n");
    // Un-staging everything reverts the index to HEAD.
    const all = applySelection(
      diff,
      select("unstage", [
        [null, 2],
        [null, 3],
        [null, 4],
      ]),
      index,
    );
    expect(all).toBe("0\n");
  });

  it("discards a deleted line, restoring it in the working copy", () => {
    const diff = parseUnifiedDiff(DISCARD_PATCH);
    const worktree = splitLines("start\nend\n");
    // Discarding the deletion of "mid" puts it back.
    const discarded = applySelection(diff, select("discard", [[2, null]]), worktree);
    expect(discarded).toBe("start\nmid\nend\n");
    // Leaving it selected (nothing to discard) keeps the working copy.
    const kept = applySelection(diff, select("discard", []), worktree);
    expect(kept).toBe("start\nend\n");
  });

  it("discards an added line from the working copy", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    const worktree = splitLines("a\nB\nc\nX\nd\ne\n");
    // Discard only the added "X" (new line 4): it disappears, "B" stays.
    const discarded = applySelection(diff, select("discard", [[null, 4]]), worktree);
    expect(discarded).toBe("a\nB\nc\nd\ne\n");
  });

  it("applies and reverts whole hunks by stable hash", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    const [hunk] = diff.hunks;
    const index = splitLines("a\nb\nc\nd\ne\n");
    expect(hunkByHash(diff, hunk!.headerHash)).toBe(hunk);
    expect(hunkIndexByHash(diff, hunk!.headerHash)).toBe(0);
    expect(hunkByHash(diff, 12345n)).toBeNull();
    expect(hunkIndexByHash(diff, 12345n)).toBe(-1);
    const staged = applyHunk(diff, hunk!.headerHash, index, "stage");
    expect(staged).toBe("a\nB\nc\nX\nd\ne\n");
    // An unknown hash leaves the content alone.
    expect(applyHunk(diff, 999n, index, "stage")).toBe("a\nb\nc\nd\ne\n");
  });

  it("splits a hunk onto two aligned sides", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    const [hunk] = diff.hunks;
    const { oldSide, newSide } = splitHunkSides(hunk!);
    // Context lines appear on both sides; adds only on the new, deletes only old.
    expect(oldSide.map((l) => l.content)).toEqual(["a", "b", "c", "d", "e"]);
    expect(newSide.map((l) => l.content)).toEqual(["a", "B", "c", "X", "d", "e"]);
    expect(hunkSummary(hunk!)).toBe("+2,−1");
    expect(fileDiffSummary(diff)).toBe("+2 −1");
  });

  it("collects the positions a selection touches", () => {
    const diff = parseUnifiedDiff(STAGE_PATCH);
    const [hunk] = diff.hunks;
    const positions = selectionPositions(hunk!.lines);
    expect(positions.map((p) => positionKey(p))).toEqual(["2:-", "-:2", "-:4"]);
    expect(selectionPositions([])).toEqual([]);
  });

  it("splits lines and detects the final newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    // The empty element after a final newline is dropped.
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(missingFinalNewline("a\nb")).toBe(true);
    expect(missingFinalNewline("a\nb\n")).toBe(false);
    expect(missingFinalNewline("")).toBe(false);
  });

  it("handles hunks that start past the first line", () => {
    // A change in the middle of a longer file: the catch-up pass must copy the
    // leading unchanged lines from the right side.
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -3,3 +3,3 @@",
      " three",
      "-four",
      "+FOUR",
      " five",
    ].join("\n");
    const diff = parseUnifiedDiff(patch);
    const index = splitLines("one\ntwo\nthree\nfour\nfive\n");
    const staged = applySelection(
      diff,
      select("stage", [
        [4, null],
        [null, 4],
      ]),
      index,
    );
    expect(staged).toBe("one\ntwo\nthree\nFOUR\nfive\n");
  });

  it("leaves unselected hunks untouched", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "@@ -3 +3 @@",
      "-c",
      "+C",
    ].join("\n");
    const diff = parseUnifiedDiff(patch);
    const index = splitLines("a\nb\nc\n");
    // Only the second hunk's line is selected, so the first hunk is never
    // applied — the first hunk's catch-up also never runs.
    const staged = applySelection(
      diff,
      select("stage", [
        [3, null],
        [null, 3],
      ]),
      index,
    );
    expect(staged).toBe("a\nb\nC\n");
  });
});
