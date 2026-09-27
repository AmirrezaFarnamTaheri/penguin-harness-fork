/**
 * The screen-reader twin of a chart's hover bubble (WCAG 2.2 SC 1.1.1 Non-text
 * Content + 2.1.1 Keyboard).
 *
 * Every usage chart keeps its numbers in a hover bubble driven by
 * `onMouseEnter` on the marks, which means a keyboard user can never open one
 * and a screen reader never hears the series at all — the `<svg role="img">`
 * announces a name and nothing more. The bubble is not a second source of
 * truth to be re-derived, so this table is rendered from the *same* values the
 * bubble formats, cell for cell: it is the same numbers in the order a reader
 * meets them, including the dash where a bucket has no rate to show.
 *
 * It is `sr-only`, not `hidden`: `display: none` would remove it from the
 * accessibility tree too, which is the opposite of the point. Screen-reader
 * users get a real `<table>` with a `<caption>` and column headers, so they can
 * navigate it by cell; sighted users are unaffected, and the hover bubble keeps
 * working exactly as before.
 */
export interface ChartDataRow {
  /** Stable identity for the row (a bucket key, or bucket + series): a table row keyed by its index would re-order on a re-sort. */
  key: string;
  cells: string[];
}

/**
 * One hidden table, one row per point, cells in `head` order. Values arrive
 * already formatted by the caller, so the table and the bubble cannot drift into
 * saying different things about the same number.
 */
export function ChartDataTable({
  caption,
  head,
  rows,
}: {
  /** Accessible name of the table; the chart's own title, so the two name the same thing. */
  caption: string;
  head: string[];
  rows: ChartDataRow[];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {/* `scope` on every header: a screen reader announcing a data cell must know which column and which row it is in. */}
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {row.cells.map((cell, i) =>
              // The first cell of every table here is the bucket, which names the row the way a row header should.
              i === 0 ? (
                <th key={i} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={i}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
