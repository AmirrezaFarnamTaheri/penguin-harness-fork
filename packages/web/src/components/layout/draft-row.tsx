/** Single parked-draft row: first line of the unsent text + hover delete (opening resumes the draft at `/chat/<draft-id>`). */
import { S } from "../../lib/strings";
import type { DraftSessionEntry } from "../../features/chat/draft-sessions";
import { draftSessionTitle } from "../../features/chat/draft-sessions";
import { Truncated } from "../ui/truncated";
import { Icon } from "../ui/group-list";

export function DraftRow({
  entry,
  active,
  onOpen,
  onDelete,
}: {
  entry: DraftSessionEntry;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const title = draftSessionTitle(entry) || S.chat.draftUntitled;
  return (
    <li>
      <div
        // Same truncated-title scroll reveal as the session rows (#309).
        data-title-reveal
        className={`group flex items-center rounded-md pr-1 transition-colors duration-150 ${
          active
            ? "bg-gray-200/70 dark:bg-gray-800"
            : "hover:bg-gray-200/50 dark:hover:bg-gray-800/70"
        }`}
      >
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left"
        >
          <Truncated
            scrollReveal
            text={title}
            className={`min-w-0 flex-1 text-sm ${
              active
                ? "font-medium text-gray-900 dark:text-gray-100"
                : "text-gray-700 dark:text-gray-300"
            }`}
          />
        </button>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            title={S.chat.deleteDraft}
            aria-label={S.chat.deleteDraft}
            onClick={onDelete}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 opacity-0 transition-all duration-150 hover:bg-gray-300/60 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-red-400"
          >
            <Icon
              d="M4 6h16M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6M6 6v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6M10 10.5v6M14 10.5v6"
              size={14}
            />
          </button>
        </div>
      </div>
    </li>
  );
}
