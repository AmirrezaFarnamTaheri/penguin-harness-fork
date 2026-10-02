/**
 * Recall chip: the affordance that makes an archived tool result readable again.
 *
 * When a tool's output is too large to keep inline, the harness keeps a bounded summary in the
 * card and publishes an opaque recall id in the note. The chip sits directly under that output and
 * turns the id into pages of the original text, fetched from this Session's own archive route.
 *
 * Accessibility is the design constraint, not a finish:
 *
 *   - the control is a native `<button>` (Enter and Space work without a key handler) with
 *     `aria-expanded` and `aria-controls` pointing at the panel, so a screen reader announces the
 *     relationship and the state;
 *   - the panel is a labelled `region`, and its status line is `aria-live="polite"` — page loads,
 *     completion and failures are announced instead of changing silently;
 *   - Escape closes the panel while focus stays on the chip, and the whole read is bounded
 *     (`collectRecallText` with a page limit), so opening it cannot pin a transcript of megabytes
 *     in place while a turn streams;
 *   - the chip carries no path and no raw id beyond a short prefix: the id is not a file handle to
 *     a reader, and the note's own metadata is what produced this control.
 *
 * Nothing is fetched until the reader opens it — a conversation full of large outputs costs
 * nothing until someone asks to see one.
 */
import { useRef, useState } from "react";
import { apiFetch } from "../../api/client";
import { apiErrorText } from "../../lib/api-error";
import { S } from "../../lib/strings";
import { formatBytes } from "../../lib/format";
import { collectRecallText } from "../../lib/recall";
import type { RecallMetadata, RecallPage } from "../../lib/recall";

/** Pages fetched per open/“load more”, and the ceiling per open, so a read stays bounded. */
const PAGES_PER_CLICK = 8;

export function RecallChip({
  sessionId,
  recall,
}: {
  /** The Session whose archive holds the entry — the one this conversation is showing. */
  sessionId: string;
  recall: RecallMetadata;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "complete" | "partial" | "failed">(
    "idle",
  );
  const [error, setError] = useState("");
  const [nextOffset, setNextOffset] = useState(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelId = `recall-panel-${recall.recallId}`;

  const load = async (offset: number): Promise<void> => {
    setStatus("loading");
    setError("");
    const outcome = await collectRecallText(
      async (url) => {
        // The app's own client, so the cookie/CSRF conventions are the same as everywhere else and
        // a refusal is localized from its code (`apiErrorText`) instead of showing the server's
        // English sentence. `handleUnauthorized: false` keeps an archive refusal from logging the
        // reader out: an expired entry is not a broken session.
        try {
          const data = await apiFetch<RecallPage>(url, { handleUnauthorized: false });
          return { ok: true, status: 200, json: async () => data };
        } catch (err) {
          throw new Error(apiErrorText(err));
        }
      },
      { sessionId, recallId: recall.recallId, offset, pageLimit: PAGES_PER_CLICK },
    );
    setText(outcome.text);
    if (outcome.status === "failed") {
      setStatus("failed");
      setError(outcome.error);
      return;
    }
    if (outcome.status === "complete") {
      setStatus("complete");
      setNextOffset(0);
      return;
    }
    setStatus("partial");
    setNextOffset(outcome.nextOffset);
  };

  // The panel re-reads from the start when reopened: what is on screen is the entry's text, and a
  // stale page after the archive evicted it would be worse than a fresh answer.
  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void load(0);
  };

  const sizeLabel = recall.sizeBytes === null ? null : formatBytes(recall.sizeBytes);
  const label = S.chat.recallChipLabel;
  const accessibleName = sizeLabel === null ? label : `${label} (${sizeLabel})`;

  return (
    <div className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
      <button
        ref={buttonRef}
        type="button"
        aria-label={accessibleName}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            // Closing keeps focus on the chip: the panel is a reading surface, not a dialog, and
            // the reader's place in the transcript must not move.
            setOpen(false);
            buttonRef.current?.focus();
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors duration-150 hover:bg-gray-100 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-300 dark:hover:bg-gray-800/60"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        {sizeLabel !== null && (
          <span className="text-gray-500 dark:text-gray-500">{sizeLabel}</span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={S.chat.recallPanelLabel}
          className="mt-2 rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
        >
          <p
            aria-live="polite"
            className="border-b border-gray-100 px-3 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400"
          >
            {status === "loading"
              ? S.chat.recallLoading
              : status === "complete"
                ? S.chat.recallComplete(text.length)
                : status === "partial"
                  ? S.chat.recallPartial(text.length)
                  : status === "failed"
                    ? S.chat.recallFailed(error)
                    : ""}
          </p>
          {text !== "" && (
            // eslint-disable-next-line react/no-danger -- plain text in a <pre>: the archive holds
            // tool output, and this surface never interprets it as markup.
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs text-gray-800 dark:text-gray-200">
              {text}
            </pre>
          )}
          <div className="flex items-center gap-2 px-3 py-1.5">
            <button
              type="button"
              disabled={status === "loading"}
              onClick={() => void load(nextOffset)}
              className="rounded-md border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 transition-colors duration-150 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900"
            >
              {status === "partial" ? S.chat.recallLoadMore : S.chat.recallReload}
            </button>
            <span className="font-mono text-[10px] text-gray-400 dark:text-gray-600">
              {recall.recallId}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
