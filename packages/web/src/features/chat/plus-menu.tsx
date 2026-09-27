/**
 * The composer's "+" extension menu, extracted from chat-input.tsx: the data-driven menu and
 * the shape of one of its entries. The composer's own item list (image upload, file
 * attachment, goal mode) and its settings footer stay in chat-input.tsx — they are what the
 * menu is driven with. A mechanical move; the menu's behaviour is unchanged.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { S } from "../../lib/strings";
import { Dropdown } from "../../components/ui/dropdown";
import { GlyphIcon } from "../../components/ui/glyph-icon";

/** One entry of the composer's "+" extension menu. */
export interface PlusMenuItem {
  key: string;
  icon: string;
  label: string;
  desc: string;
  /** Whether the entry is currently engaged (rendered with a check mark; clicking toggles). */
  active: boolean;
  /** Grayed out and inert (e.g. goal mode while a run is in progress); the menu still opens. */
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * The composer's "+" extension menu: a general-purpose entry point for input add-ons (goal
 * mode today; future modes, plugins, apps, files slot in as further items) plus input
 * settings (`footer`, currently the mid-run send mode row). Data-driven — the caller passes
 * the item list and footer; the menu itself knows nothing about the entries. The button is
 * never disabled: settings must stay reachable during a run, so unavailable *items* gray out
 * individually instead.
 */
export function PlusMenu({
  items,
  footer,
  direction = "up",
}: {
  items: PlusMenuItem[];
  footer?: ReactNode;
  direction?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      open={open}
      setOpen={setOpen}
      // Placement is portal-driven like the rest of the toolbar (its scroll container would
      // clip an absolutely-positioned panel); only size classes belong here.
      menuClass="w-72"
      portal={{ direction, align: "left" }}
      button={
        <button
          type="button"
          aria-label={S.chat.plusMenu}
          title={S.chat.plusMenu}
          onClick={() => setOpen(!open)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <GlyphIcon d="M12 5v14M5 12h14" size={15} className="shrink-0" />
        </button>
      }
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={item.active}
          disabled={item.disabled}
          onClick={() => {
            setOpen(false);
            item.onSelect();
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-gray-800 dark:disabled:hover:bg-transparent ${
            item.active
              ? "font-medium text-gray-900 dark:text-gray-100"
              : "text-gray-600 dark:text-gray-400"
          }`}
        >
          <GlyphIcon d={item.icon} className="shrink-0 text-gray-500 dark:text-gray-500" />
          <span className="shrink-0">{item.label}</span>
          <span className="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-500">
            {item.desc}
          </span>
          <span className="w-3 shrink-0 text-center">{item.active ? "✓" : ""}</span>
        </button>
      ))}
      {footer && (
        <div className="mt-1 border-t border-gray-100 pt-1 dark:border-gray-800">{footer}</div>
      )}
    </Dropdown>
  );
}
