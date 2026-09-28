/**
 * Multi-select skills dropdown (bottom toolbar, after approval mode), extracted from
 * chat-input.tsx (a mechanical move — the toolbar's trigger and the composer's own `/skills`
 * picker, which uses SkillPickList directly, are both unchanged).
 */
import { useState } from "react";
import type { SkillMetadataItem } from "@prismshadow/penguin-server/api";
import { S } from "../../lib/strings";
import { Dropdown } from "../../components/ui/dropdown";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { ChevronDown } from "../../components/ui/icons";
import { ICON_SIZE } from "../../lib/icon-scale";
import { SkillPickList } from "../skills/skill-pick-list";
import { BOOK_ICON } from "./skill-use";

/**
 * Multi-select skills dropdown (bottom toolbar, after approval mode): styled like the model
 * selector — button = book icon + "Skills" label + selected-count badge (no badge at 0; when the
 * card is narrower than @md the label hides, leaving just icon + badge); the menu body is the
 * shared SkillPickList (search box + toggle rows), without its bulk row — picking skills to send
 * a message with is a per-message act on a handful of names, not a set to fill in. Multi-select
 * semantics: clicking a row toggles its selection and **the menu stays open**; closes on Escape /
 * click outside (built into Dropdown). Popup direction depends on context (same as the approval
 * mode selector).
 */
export function SkillSelect({
  skills,
  selected,
  onToggle,
  disabled,
  direction = "up",
}: {
  skills: SkillMetadataItem[];
  selected: string[];
  onToggle: (name: string) => void;
  disabled: boolean;
  direction?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      open={open}
      setOpen={setOpen}
      // As wide as reasonably possible so descriptions stay readable; portal placement clamps
      // it to the viewport, so the old hand-tuned anchor-offset clamps are no longer needed.
      menuClass="w-[26rem]"
      portal={{ direction, align: "left" }}
      button={
        <button
          type="button"
          aria-label={S.chat.skillsSelect}
          title={S.chat.skillsSelect}
          disabled={disabled}
          // The panel is unmounted while closed, so its search box starts empty on every open.
          onClick={() => setOpen(!open)}
          className="flex h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <GlyphIcon d={BOOK_ICON} className="shrink-0" />
          {/* When the card is narrower than @md, only the icon + badge remain (title shows the full name). */}
          <span className="hidden min-w-0 truncate @md:block">{S.chat.skillsSelect}</span>
          {/* Selected-count badge (the chip row above the input mirrors the selection too). */}
          {selected.length > 0 && (
            <span className="shrink-0 rounded-full bg-gray-200/80 px-1.5 py-px font-mono text-[10px] font-semibold text-gray-700 dark:bg-gray-700/60 dark:text-gray-200">
              {selected.length}
            </span>
          )}
          <ChevronDown size={ICON_SIZE.caretDense} />
        </button>
      }
    >
      <SkillPickList
        skills={skills}
        selected={selected}
        onToggle={onToggle}
        emptyHint={S.chat.skillsEmptyHint}
      />
    </Dropdown>
  );
}
