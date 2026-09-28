/**
 * One group's block — its header and body — carrying the manual group order's drop
 * indicator: a thin accent line in the gap the drop would land in, drawn against the
 * WHOLE group rather than its header, so "below" reads as "after this group and its
 * conversations" instead of "between the header and its own first row".
 *
 * The line is absolutely positioned and `inset-x-1` (matching the header's `px-1`), so
 * it consumes no layout width and cannot push the header's up-to-three action buttons
 * out of a narrow drawer.
 */
import type { ReactNode } from "react";

export function GroupBlock({
  dropEdge,
  children,
}: {
  /** Which edge of this group a drop would land on while a group drag hovers it. */
  dropEdge: "above" | "below" | null;
  children: ReactNode;
}) {
  return (
    <div className="relative pt-2.5">
      {dropEdge !== null && (
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[var(--accent-bg)] ${
            dropEdge === "above" ? "top-1" : "-bottom-1"
          }`}
        />
      )}
      {children}
    </div>
  );
}
