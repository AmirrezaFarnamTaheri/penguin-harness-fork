/**
 * One queued-message hint line (undelivered steering / queued follow-up) with its recall
 * button, extracted from chat-input.tsx (a mechanical move — both places that render it are
 * unchanged). Owns the recall glyph, which only it reads.
 */
import { S } from "../../lib/strings";
import { GlyphIcon } from "../../components/ui/glyph-icon";

/**
 * Curved-back arrow glyph (24×24 line path) for the recall control: arrowhead at the left,
 * the shaft looping back beneath it — the undo reading, not the trash-can one. A recalled
 * message is not discarded, it comes back to the composer, and the icon has to say that on
 * its own (owner directive: this control carries no text).
 */
const RECALL_ICON = "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11";

/**
 * One queued-message hint line (undelivered steering / queued follow-up) with its recall
 * button (#287): the button withdraws the message server-side and puts its content back into
 * the input box for editing and resending. No button when the channel offers no recall
 * (old server: entries without ids, or no handler supplied).
 *
 * Icon-only, so the two localized strings become its accessible name instead of its body:
 * `recallQueued` is the short one the button is *called* (aria-label), `recallQueuedTitle` the
 * tooltip that says what happens. Sized like the other icon controls on a text-xs row, and
 * `shrink-0` next to the truncating label so it survives narrow widths. It carries the icon
 * set's gray (a step darker than the hint text it sits beside), not the label's: gray-400 on
 * white is under the 3:1 an interactive control owes, and this one is interactive.
 */
export function QueuedMessageLine({
  label,
  onRecall,
  disabled,
}: {
  label: string;
  onRecall?: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <p className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-500">{label}</p>
      {onRecall && (
        <button
          type="button"
          aria-label={S.chat.recallQueued}
          title={S.chat.recallQueuedTitle}
          disabled={disabled}
          onClick={onRecall}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <GlyphIcon d={RECALL_ICON} size={13} />
        </button>
      )}
    </div>
  );
}
