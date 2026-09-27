/**
 * The conversation list's batch bar: how many are marked, the four reversible things that
 * can be done to all of them, and the way out.
 *
 * Only the REVERSIBLE operations are here. Delete is not, deliberately: it is the one batch
 * whose mistake cannot be undone, and a bar that puts it next to "Pin" invites the same
 * reflex that makes a drag-and-drop archive land on the wrong row. A user who wants four
 * conversations gone deletes four conversations, each with its own confirmation naming its
 * own title — the cost is four dialogs, and it buys certainty that the right one went.
 *
 * Every control reports what it WOULD do, not what is available: "Unpin" appears whenever
 * the selection contains a pinned row, and unpinning a mixed selection leaves the already
 * unpinned ones alone. Greying a control out because "not all of them are pinned" would
 * make the mixed case — the common one — the one case you cannot do, which is backwards.
 */
import { S } from "../../lib/strings";
import { ARCHIVE_ICON, PIN_ICON, UNARCHIVE_ICON } from "../ui/session-row-menu";
import { Icon } from "../ui/group-list";
import { BarAction } from "./bar-action";

/** Close cross — the expanded search field's clear button and the batch bar's way out. */
export const CLOSE_ICON = "M18 6L6 18M6 6l12 12";

export function SelectionBar({
  count,
  anyPinned,
  anyUnpinned,
  anyArchived,
  anyActive,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onClear,
}: {
  count: number;
  anyPinned: boolean;
  anyUnpinned: boolean;
  anyArchived: boolean;
  anyActive: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onClear: () => void;
}) {
  // role=status + aria-live: the count changes as rows are marked, and that number IS the
  // answer to "how many am I about to archive" — a screen reader user has no other way to
  // hear it, since the checkboxes are aria-hidden inside the row buttons.
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="selection-bar"
      className="mt-1 flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-1 dark:bg-gray-800"
    >
      <span className="min-w-0 flex-1 truncate px-1 text-xs text-gray-600 dark:text-gray-300">
        {S.chat.selectedConversations(count)}
      </span>
      <BarAction
        label={S.chat.pinSession}
        icon={PIN_ICON}
        onClick={onPin}
        show={count > 0 && anyUnpinned}
      />
      <BarAction
        label={S.chat.unpinSession}
        icon={PIN_ICON}
        onClick={onUnpin}
        show={count > 0 && anyPinned}
      />
      <BarAction
        label={S.chat.archiveSelected}
        icon={ARCHIVE_ICON}
        onClick={onArchive}
        show={count > 0 && anyActive}
      />
      <BarAction
        label={S.chat.unarchiveSelected}
        icon={UNARCHIVE_ICON}
        onClick={onUnarchive}
        show={count > 0 && anyArchived}
      />
      <button
        type="button"
        title={S.chat.cancelSelection}
        aria-label={S.chat.cancelSelection}
        onClick={onClear}
        className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-gray-500 transition-colors duration-150 hover:bg-gray-200/70 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-100"
      >
        <Icon d={CLOSE_ICON} size={11} />
      </button>
    </div>
  );
}
