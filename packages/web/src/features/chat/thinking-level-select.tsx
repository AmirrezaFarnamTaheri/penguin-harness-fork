/**
 * Conversation-time thinking-level picker, extracted from chat-input.tsx (a mechanical move —
 * both the draft card's and the session composer's use of it are unchanged). Owns the spark
 * glyph, which only it reads.
 */
import { useState } from "react";
import { S } from "../../lib/strings";
import { Dropdown } from "../../components/ui/dropdown";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { ChevronDown } from "../../components/ui/icons";
import { ICON_SIZE } from "../../lib/icon-scale";
import { SELECTABLE_THINKING_LEVELS, thinkingLevelLabel } from "./thinking-level";

/** Spark glyph for the thinking-level picker (24x24 line path, consistent with the toolbar icon set). */
const SPARK_ICON = "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z";

/**
 * Conversation-time thinking-level picker, used in two places. Both variants list only the
 * concrete levels (per review: a title bar names the control; short names only, no
 * descriptions, no "default"/"follow" row, and no "none" — many models cannot disable
 * thinking; a stored legacy "none" still displays via the label table, just never offered):
 * - Draft state (docked left of the model selector): shows the **selected Agent's** current
 *   `model.thinking_level` and writes a picked level straight through to the Agent settings —
 *   it applies to the session created on first send and becomes the Agent's new default
 *   (switch-becomes-default). An Agent without an explicit override shows an em dash until a
 *   level is picked.
 * - Active session: the level is a **per-turn parameter** sent with each task. The displayed
 *   value initializes to the Agent config's level and auto-follows it while the user hasn't
 *   picked (the parent resolves the display value and keeps omitting the level from tasks
 *   until touched); an explicit pick sticks for the session and rides on every subsequent
 *   send, never writing through to the Agent config.
 */
export function ThinkingLevelSelect({
  value,
  onChange,
  disabled,
  direction = "down",
  note,
}: {
  /** Level to display and mark selected ("" = none to show yet); null = the Agent config is still loading (draft). */
  value: string | null;
  onChange: (level: string) => void;
  disabled: boolean;
  /** Popup direction: down for the draft card (room below), up for the bottom-docked session composer. */
  direction?: "down" | "up";
  /** Footnote under the rows — the session variant's pre-pick reminder: a change applies right away but invalidates the model's cached context, so compacting first is recommended. */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const label =
    value === null ? "…" : (thinkingLevelLabel(S.chat.thinkingLevelNames, value) ?? "—");
  return (
    <Dropdown
      open={open}
      setOpen={setOpen}
      menuClass="w-max min-w-36"
      portal={{ direction, align: "right" }}
      button={
        <button
          type="button"
          title={`${S.chat.thinkingLevel}：${label}`}
          aria-label={S.chat.thinkingLevel}
          disabled={disabled || value === null}
          onClick={() => setOpen(!open)}
          className="flex h-8 max-w-36 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <GlyphIcon d={SPARK_ICON} className="shrink-0" />
          {/* When the card is narrower than @md, only the icon remains (title shows the full state). */}
          <span className="hidden min-w-0 truncate @md:block">{label}</span>
          <ChevronDown size={ICON_SIZE.caretDense} />
        </button>
      }
    >
      {/* Title bar: names the control (the rows themselves are just the tier names). */}
      <div className="border-b border-gray-100 px-3 pb-1.5 pt-0.5 text-xs font-semibold text-gray-500 dark:border-gray-800 dark:text-gray-400">
        {S.chat.thinkingLevel}
      </div>
      {SELECTABLE_THINKING_LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          onClick={() => {
            onChange(level);
            setOpen(false);
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-gray-100 dark:hover:bg-gray-800 ${
            level === value
              ? "font-medium text-gray-900 dark:text-gray-100"
              : "text-gray-600 dark:text-gray-400"
          }`}
        >
          {/* The one surface that annotates: a menu row is where the tier is CHOSEN, so it
              names the wire value the pick will send. The trigger above stays the plain
              name — in zh that is low/medium/high/very high/max, in en the annotation is a no-op. */}
          <span className="min-w-0 flex-1 truncate">
            {S.chat.thinkingLevelMenuName(S.chat.thinkingLevelNames[level] ?? level, level)}
          </span>
          <span className="w-3 shrink-0 text-center">{level === value ? "✓" : ""}</span>
        </button>
      ))}
      {note && (
        <div className="max-w-56 border-t border-gray-100 px-3 pb-1 pt-1.5 text-[11px] leading-snug text-gray-500 dark:border-gray-800 dark:text-gray-500">
          {note}
        </div>
      )}
    </Dropdown>
  );
}
