/**
 * Parse the phase table that opens a CI evidence bundle.
 *
 * Provenance: the bundle's `command-summary.md` is a five-column Markdown table — `Phase | Result | Duration |
 * Exit | Log` — with one row per CI phase and a link from each row to that phase's captured log file. It is the
 * bundle's executive summary: a reader scans it to find which phase failed before opening any log. Three of its
 * columns are machine-readable enough to be worth parsing (the duration is a number with an `s` suffix, the exit
 * code is an integer, the log cell is a filename in backticks) and the `Result` column is an uppercase verdict
 * the observed bundles spell `PASS`. Rows that do not have five cells are malformed rather than merely unusual,
 * so they are reported separately instead of being squeezed into the table.
 */

/** Verdict the observed bundles write for a phase that completed successfully. */
export const COMMAND_SUMMARY_PASS = "PASS";

/** Verdict for a phase that failed. */
export const COMMAND_SUMMARY_FAIL = "FAIL";

/** One row of the phase table. */
export interface CommandSummaryRow {
  /** Phase name as written. */
  phase: string;
  /** Verdict as written, e.g. `PASS`. */
  result: string;
  /** Duration in seconds, or `null` when the cell is not a `<number>s` value. */
  durationSeconds: number | null;
  /** Exit code, or `null` when the cell is not an integer. */
  exitCode: number | null;
  /** Filename from inside the backticks, or `null` when the cell has no code span. */
  log: string | null;
  /** The cell text verbatim, kept so a reader can reconstruct a row the fields lose information from. */
  cells: string[];
}

/** Parsed phase table. */
export interface CommandSummary {
  /** Column headings from the header row. */
  columns: string[];
  /** Rows that had one cell per column. */
  rows: CommandSummaryRow[];
  /** Lines that looked like table rows but did not have one cell per column, verbatim. */
  malformedRows: string[];
  /** Lines that were neither a header, a separator nor a row, verbatim and in order. */
  outsideTable: string[];
  /** The separator row, when the document carried one. */
  separator: string | null;
}

/** Match a duration cell such as `7.4s`, `124.3s` or `0s`. */
const DURATION_CELL = /^(\d+(?:\.\d+)?)s$/;

/** Match an exit-code cell such as `0` or `1`. */
const EXIT_CODE_CELL = /^-?\d+$/;

/** Match a code span containing a filename, such as `` `install-frozen-pnpm-dependency-graph.log` ``. */
const LOG_CELL = /^`([^`]+)`$/;

function splitRow(line: string): string[] {
  // A Markdown table row is pipes with a space each side of the content; trimming leaves the cells clean.
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function isRowLike(line: string): boolean {
  return line.startsWith("|") && line.endsWith("|") && line.length > 2;
}

/**
 * Parse command-summary Markdown. The table is found anywhere in the document; anything before the header or
 * after it that is not a table line lands in `outsideTable`, so prose around the table survives the parse.
 */
export function parseCommandSummary(markdown: string): CommandSummary {
  const lines = markdown.split(/\r?\n/);
  const columns: string[] = [];
  const rows: CommandSummaryRow[] = [];
  const malformedRows: string[] = [];
  const outsideTable: string[] = [];
  let separator: string | null = null;
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (!headerSeen) {
      if (isRowLike(trimmed)) {
        columns.push(...splitRow(trimmed));
        headerSeen = true;
      } else {
        outsideTable.push(trimmed);
      }
      continue;
    }

    if (separator === null) {
      // The separator row is a row of dashes with optional per-column alignment colons; it is consumed, not
      // reported, but a document that omits it still parses — the header is followed directly by data rows.
      if (/^\|[-:|\s]+\|$/.test(trimmed)) {
        separator = trimmed;
        continue;
      }
    }

    if (!isRowLike(trimmed)) {
      outsideTable.push(trimmed);
      continue;
    }

    const cells = splitRow(trimmed);
    if (columns.length > 0 && cells.length !== columns.length) {
      malformedRows.push(trimmed);
      continue;
    }

    const duration = cells[2] === undefined ? null : DURATION_CELL.exec(cells[2]);
    const exit = cells[3] === undefined ? null : EXIT_CODE_CELL.exec(cells[3]);
    const log = cells[4] === undefined ? null : LOG_CELL.exec(cells[4]);
    rows.push({
      phase: cells[0] ?? "",
      result: cells[1] ?? "",
      durationSeconds: duration ? Number(duration[1]) : null,
      exitCode: exit ? Number(exit[0]) : null,
      log: log ? (log[1] ?? null) : null,
      cells,
    });
  }

  return { columns, rows, malformedRows, outsideTable, separator };
}

/** Round a duration to the one-decimal form the summary table writes, e.g. `7.386` → `7.4s`. */
export function formatDurationLabel(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toString()}s`;
}

/** Whether every row of the table reports the given verdict. A table with no rows reports nothing. */
export function allRowsHaveResult(summary: CommandSummary, result: string): boolean {
  if (summary.rows.length === 0) return false;
  return summary.rows.every((row) => row.result === result);
}
