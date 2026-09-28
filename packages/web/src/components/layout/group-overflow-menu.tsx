/**
 * Registry-backed workspace group's overflow (… to the right of the header's "+"):
 * Rename workspace / Delete workspace in the session-row menu's compact style. Sits among the
 * header's action buttons — outside the header's collapse toggle, so opening it never
 * expands/collapses the group. Body-portaled like every menu inside the scroller.
 */
import { useState } from "react";
import { S } from "../../lib/strings";
import {
  PENCIL_ICON,
  TRASH_ICON,
  overflowMenuDangerClass,
  overflowMenuGlyph,
  overflowMenuRowClass,
} from "../ui/session-row-menu";
import { Dropdown } from "../ui/dropdown";
import { Icon } from "../ui/group-list";

/** The workspace group's overflow-menu trigger: three FILLED dots (the stroke version read too faint at this size). */
function EllipsisGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

export function GroupOverflowMenu({
  onRename,
  onDelete,
}: {
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** Close first, then act (the rename modal opens on top; the delete is immediate). */
  const item = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <Dropdown
      open={open}
      setOpen={setOpen}
      portal={{ direction: "down", align: "right" }}
      menuClass="w-32"
      className="shrink-0"
      button={
        /* No hover pill on this trigger (user: color, not background, should carry the
           hover hint) — feedback is the glyph deepening in light / brightening in dark,
           the session-row ellipsis treatment. Geometry: the same h-7 w-7 square as the
           sibling "+" and the LAST action in the header, flush at GroupHeader's px-1
           inset — which equals the session rows' pr-1, so with the row trigger's 16px
           glyph the dot columns line up with the rows' trailing slot below. */
        <button
          type="button"
          title={S.chat.workspaceMenu}
          aria-label={S.chat.workspaceMenu}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 w-7 shrink-0 items-center justify-center text-gray-500 transition-colors duration-150 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
        >
          <EllipsisGlyph size={16} />
        </button>
      }
    >
      <button type="button" className={overflowMenuRowClass} onClick={item(onRename)}>
        {overflowMenuGlyph(PENCIL_ICON)}
        {S.chat.renameWorkspace}
      </button>
      <button type="button" className={overflowMenuDangerClass} onClick={item(onDelete)}>
        <span className="shrink-0">
          <Icon d={TRASH_ICON} size={13} />
        </span>
        {S.chat.deleteWorkspace}
      </button>
    </Dropdown>
  );
}
