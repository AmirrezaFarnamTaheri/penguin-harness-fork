import { useMemo } from "react";
import { DiffBlock } from "../../components/ui/diff-block";

/**
 * Edit-tool output renderer: the tool's own summary line and trailing notes stay plain text;
 * the git-style unified diff between them is rendered with the existing DiffBlock so
 * line-level add/remove highlighting is reused, not reinvented. Parsing is conservative —
 * only lines after a real hunk header (`@@`) count as diff lines, so failure outputs
 * ("old_string not found…") and legacy summaries without a diff never render as colored
 * additions. The hunk header itself stays out of DiffBlock (its parser would drop `@@` lines
 * and silently splice removed and added text together).
 */
export function EditToolOutput({ output }: { output: string }) {
  const parts = useMemo(() => {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith("@@"));
    if (start === -1) return null;
    // Trailing notes (elision count, runtime attribution) ride along after the diff;
    // anything else ends the diff region.
    const after: string[] = [];
    let index = lines.length;
    while (index > start) {
      const line = lines[index - 1]!;
      if (
        line.startsWith("@@") ||
        line.startsWith("…and ") ||
        /^\[editor attribution: /.test(line)
      ) {
        after.unshift(line);
        index -= 1;
        continue;
      }
      break;
    }
    if (index === start) return null;
    // Three summary shapes reach this renderer, one per writing tool:
    //   edit_file   → `Replaced 2 occurrences in "path".`
    //   write_file  → `Created "path" (12 lines, 340 bytes).` / `Overwrote "path" (…)`
    // The path label is cosmetic — the diff renders either way — so an unmatched line is not a
    // parse failure, but matching all three is what lets a file OVERWRITE show the diff the
    // core already paid to compute, instead of a wall of plain text.
    const filePath =
      /^Replaced \d+ occurrences? in "(.+)"\.$/.exec(lines[0] ?? "")?.[1] ??
      /^(?:Created|Overwrote) "(.+)"\(/.exec(lines[0] ?? "")?.[1] ??
      undefined;
    return {
      before: lines.slice(0, start).join("\n"),
      diff: lines.slice(start, index).join("\n"),
      after,
      filePath,
    };
  }, [output]);
  if (!parts) return <pre className="whitespace-pre-wrap break-all">{output}</pre>;
  return (
    <div className="min-w-0 space-y-2">
      <pre className="whitespace-pre-wrap break-all">{parts.before}</pre>
      <DiffBlock filePath={parts.filePath} diffString={parts.diff} collapsedLines={12} />
      {parts.after.length > 0 ? (
        <pre className="whitespace-pre-wrap break-all">{parts.after.join("\n")}</pre>
      ) : null}
    </div>
  );
}
