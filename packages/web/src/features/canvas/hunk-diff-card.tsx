/**
 * Git hunk diff card (Track 5, Tier 3).
 *
 * Renders a unified-diff patch as keyboard-driven staging surface: every
 * hunk shows its `@@` header and per-line add/delete markers, and each changed
 * line is selectable so the caller can stage, unstage or discard exactly those
 * lines. Parsing, line typing and selection positions all come from the core
 * hunk-staging module; this file only draws. No tests live here.
 */
import { useMemo, useState } from "react";

import {
  DiffLineType,
  HUNK_HEADER_RE,
  type DiffLine,
  type DiffLinePosition,
  type Hunk,
  hunkSummary,
  parseUnifiedDiff,
  positionKey,
  selectionPositions,
  type SelectionMode,
} from "@prismshadow/penguin-core/terminal";

export interface HunkDiffCardProps {
  /** Unified-diff text for one file (`diff --git` header optional). */
  readonly patch: string;
  readonly filePath?: string;
  /** Selection mode the primary button applies to the chosen lines. */
  readonly mode?: SelectionMode;
  /** Controlled selection, as the position keys `positionKey` produces. */
  readonly selectedKeys?: ReadonlySet<string>;
  readonly onSelectionChange?: (positions: DiffLinePosition[]) => void;
  /** Fired with the selected positions when the primary button is pressed. */
  readonly onApplySelection?: (positions: DiffLinePosition[], mode: SelectionMode) => void;
  /** Lines per hunk before the body collapses; the whole patch still parses. */
  readonly collapsedLines?: number;
  readonly className?: string;
}

const MODE_LABELS: Record<SelectionMode, string> = {
  stage: "Stage selected",
  unstage: "Unstage selected",
  discard: "Discard selected",
};

export function HunkDiffCard({
  patch,
  filePath,
  mode = "stage",
  selectedKeys,
  onSelectionChange,
  onApplySelection,
  collapsedLines = 12,
  className = "",
}: HunkDiffCardProps) {
  const [internalSelection, setInternalSelection] = useState<Set<string>>(
    () => new Set(selectedKeys ?? []),
  );
  const selection = selectedKeys ?? internalSelection;

  const diff = useMemo(() => (patch.trim().length === 0 ? null : parseUnifiedDiff(patch)), [patch]);

  // Position lookup by key so a selection can be turned back into the
  // DiffLinePositions the staging module consumes.
  const positionByKey = useMemo(() => {
    const map = new Map<string, DiffLinePosition>();
    if (!diff) return map;
    for (const hunk of diff.hunks) {
      for (const position of selectionPositions(hunk.lines)) {
        map.set(positionKey(position), position);
      }
    }
    return map;
  }, [diff]);

  const selectedPositions = useMemo(
    () =>
      [...selection]
        .map((key) => positionByKey.get(key))
        .filter((p): p is DiffLinePosition => p !== undefined),
    [selection, positionByKey],
  );

  const commit = (next: Set<string>) => {
    if (!selectedKeys) setInternalSelection(next);
    onSelectionChange?.(
      [...next]
        .map((key) => positionByKey.get(key))
        .filter((p): p is DiffLinePosition => p !== undefined),
    );
  };

  const toggleLine = (position: DiffLinePosition) => {
    const key = positionKey(position);
    const next = new Set(selection);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commit(next);
  };

  const toggleHunk = (hunk: Hunk) => {
    const keys = selectionPositions(hunk.lines).map(positionKey);
    const allSelected = keys.every((key) => selection.has(key));
    const next = new Set(selection);
    for (const key of keys) {
      if (allSelected) next.delete(key);
      else next.add(key);
    }
    commit(next);
  };

  if (!diff) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 p-6 text-sm text-gray-400 dark:border-gray-800 dark:bg-gray-900/80 dark:text-gray-500 ${className}`}
      >
        No changes to show.
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-lg border border-gray-200 bg-gray-50 text-xs font-mono shadow-xs dark:border-gray-800 dark:bg-gray-900/80 ${className}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-gray-100/70 px-3 py-1.5 font-sans dark:border-gray-800 dark:bg-gray-800/60">
        <div className="flex min-w-0 items-center gap-2 font-medium text-gray-700 dark:text-gray-300">
          <span className="truncate max-w-[16rem]" title={filePath}>
            {filePath ?? "Working tree"}
          </span>
          {diff.untracked ? (
            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
              untracked
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {selectedPositions.length > 0 ? (
            <button
              type="button"
              onClick={() => onApplySelection?.(selectedPositions, mode)}
              className="rounded-md bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
            >
              {MODE_LABELS[mode]} ({selectedPositions.length})
            </button>
          ) : null}
        </div>
      </div>

      {diff.hunks.map((hunk, hunkIndex) => (
        <HunkBody
          key={`hunk-${hunkIndex}-${hunk.headerHash.toString()}`}
          hunk={hunk}
          selection={selection}
          collapsedLines={collapsedLines}
          onToggleLine={toggleLine}
          onToggleHunk={toggleHunk}
        />
      ))}
    </div>
  );
}

interface HunkBodyProps {
  readonly hunk: Hunk;
  readonly selection: ReadonlySet<string>;
  readonly collapsedLines: number;
  readonly onToggleLine: (position: DiffLinePosition) => void;
  readonly onToggleHunk: (hunk: Hunk) => void;
}

function HunkBody({ hunk, selection, collapsedLines, onToggleLine, onToggleHunk }: HunkBodyProps) {
  const [expanded, setExpanded] = useState(false);
  const changeCount = selectionPositions(hunk.lines).length;
  const selectedCount = selectionPositions(hunk.lines).filter((p) =>
    selection.has(positionKey(p)),
  ).length;
  const allSelected = changeCount > 0 && selectedCount === changeCount;

  const visibleLines =
    expanded || hunk.lines.length <= collapsedLines
      ? hunk.lines
      : hunk.lines.slice(0, collapsedLines);
  const hidden = hunk.lines.length - visibleLines.length;
  const headerText = `@@ -${hunk.header.oldStart},${hunk.header.oldLines} +${hunk.header.newStart},${hunk.header.newLines} @@`;

  return (
    <section>
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-gray-100/40 px-3 py-1 dark:border-gray-800 dark:bg-gray-800/40">
        <button
          type="button"
          onClick={() => onToggleHunk(hunk)}
          aria-pressed={allSelected}
          className="flex items-center gap-1.5 font-mono text-[11px] text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
        >
          <span
            className={`flex h-3 w-3 items-center justify-center rounded-[3px] border ${
              allSelected
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-gray-400 dark:border-gray-500"
            }`}
            aria-hidden="true"
          >
            {allSelected ? "✓" : ""}
          </span>
          <span className="text-gray-500 dark:text-gray-500">{headerText}</span>
        </button>
        <span
          className="font-mono text-[10px] text-gray-400 dark:text-gray-500"
          title="Added / deleted lines"
        >
          {hunkSummary(hunk)}
        </span>
      </div>

      <div className="space-y-0.5 p-1.5">
        {visibleLines.map((line, index) => (
          <LineRow
            key={`${positionKey(line.position)}-${index}`}
            line={line}
            selected={selection.has(positionKey(line.position))}
            onToggle={() => onToggleLine(line.position)}
          />
        ))}
      </div>

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="block w-full border-t border-gray-200 bg-gray-100/50 py-1 text-center font-sans text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-400 dark:hover:text-gray-200"
        >
          {expanded ? "Collapse hunk" : `Show ${hidden} more lines…`}
        </button>
      ) : null}
    </section>
  );
}

function LineRow({
  line,
  selected,
  onToggle,
}: {
  readonly line: DiffLine;
  readonly selected: boolean;
  readonly onToggle: () => void;
}) {
  if (line.lineType === DiffLineType.Header) return null;

  const selectable = line.lineType === DiffLineType.Add || line.lineType === DiffLineType.Delete;
  const lineNumber = line.position.newLineNumber ?? line.position.oldLineNumber ?? "";
  const isAdd = line.lineType === DiffLineType.Add;
  const isDelete = line.lineType === DiffLineType.Delete;

  const base = "flex items-start gap-2 px-2 py-0.5";
  const tone = isAdd
    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
    : isDelete
      ? "bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
      : "text-gray-600 dark:text-gray-400";
  const marker = isAdd ? "+" : isDelete ? "−" : " ";

  return (
    <div className={`${base} ${tone} ${selectable ? "cursor-pointer" : "cursor-default"}`}>
      {selectable ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Toggle line ${lineNumber}`}
          className="mt-0.5 h-3 w-3 shrink-0 accent-blue-600"
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden="true" />
      )}
      <span className="w-8 shrink-0 select-none text-right text-gray-400 dark:text-gray-600 tabular-nums">
        {lineNumber}
      </span>
      <span
        className={`w-3 shrink-0 select-none font-bold ${
          isAdd
            ? "text-emerald-600 dark:text-emerald-400"
            : isDelete
              ? "text-rose-600 dark:text-rose-400"
              : "text-gray-300 dark:text-gray-600"
        }`}
        aria-hidden="true"
      >
        {marker}
      </span>
      <pre className="whitespace-pre-wrap break-all font-mono">{line.content}</pre>
    </div>
  );
}

/** Kept for parity with the staging module's own header-detection tests. */
export const HUNK_HEADER_PATTERN = HUNK_HEADER_RE;
