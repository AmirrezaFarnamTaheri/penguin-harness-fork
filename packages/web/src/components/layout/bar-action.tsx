/** One batch-bar control: a glyph with its tooltip, the same hover treatment the header's icon controls use. Hidden entirely when it has nothing to act on. */
import { ICON_SIZE } from "../../lib/icon-scale";
import { Icon } from "../ui/group-list";

export function BarAction({
  label,
  icon,
  onClick,
  show,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 hover:bg-gray-200/70 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
    >
      <Icon d={icon} size={ICON_SIZE.iconButton} />
    </button>
  );
}
