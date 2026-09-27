/**
 * List-settings menu option: leading glyph + label, with a checkmark marking the active
 * choice (reference-style radio row; aria-pressed carries the state). Same type scale and
 * leading-glyph column as the session/workspace overflow menus (font matches Session
 * more options), so the two menus read as one family.
 *
 * The glyph is decorative — it names the option's subject (a folder for Workspace
 * grouping, a clock for recency) beside a label that is never dropped, so the row's
 * accessible name stays the label alone.
 */
import { CheckIcon } from "../ui/icons";
import { overflowMenuGlyph, overflowMenuRowClass } from "../ui/session-row-menu";

export function MenuRadioRow({
  icon,
  label,
  checked,
  onSelect,
}: {
  icon: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={onSelect}
      className={`${overflowMenuRowClass} justify-between`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {overflowMenuGlyph(icon)}
        <span className="truncate">{label}</span>
      </span>
      {checked && <CheckIcon className="shrink-0 text-gray-500 dark:text-gray-400" />}
    </button>
  );
}
