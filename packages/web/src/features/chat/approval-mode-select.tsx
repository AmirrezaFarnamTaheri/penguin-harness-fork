/**
 * Approval mode selector, extracted from chat-input.tsx (a mechanical move — the composer's
 * toolbar is unchanged). Owns the mode list and the grayscale line-art icon per mode, both of
 * which only it reads.
 */
import { useState } from "react";
import type { ApprovalMode } from "@prismshadow/penguin-server/api";
import { S } from "../../lib/strings";
import { Dropdown } from "../../components/ui/dropdown";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { ChevronDown } from "../../components/ui/icons";
import { ICON_SIZE } from "../../lib/icon-scale";

const APPROVAL_MODES: ApprovalMode[] = ["always-ask", "read-only", "allow-all", "deny-all"];

/**
 * Illustrative icon for each approval mode (24x24 line art, grayscale via currentColor, no
 * color-coding): allow-all uses a warning triangle — it permits everything at the user's own
 * risk, the shape hints at it visually without rendering tension through color; deny-all is a
 * no-entry sign, read-only is an eye, always-ask is a question-mark circle.
 */
const APPROVAL_MODE_ICONS: Record<ApprovalMode, string> = {
  "allow-all":
    "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01",
  "deny-all": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.64 5.64l12.72 12.72",
  "read-only":
    "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  "always-ask":
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3m.07 4h.01",
};

/**
 * Approval mode selector (custom-drawn dropdown, not the browser's native select): small,
 * grayscale.
 * Popup direction depends on context: for the draft card, vertically centered with room below
 * -> opens downward; for the chat input area docked at the bottom of the screen, where opening
 * downward would overflow the viewport with nowhere to scroll -> opens upward.
 */
export function ApprovalModeSelect({
  value,
  onChange,
  disabled,
  direction = "up",
}: {
  value: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  disabled: boolean;
  direction?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      open={open}
      setOpen={setOpen}
      // w-max: width exactly wraps the longest line (no wrapping within a line), avoiding an
      // overly wide panel. Placement is portal-driven (the toolbar scrolls horizontally on
      // phones, which would otherwise clip the panel); only size classes belong here.
      menuClass="w-max"
      portal={{ direction, align: "left" }}
      button={
        // Button styling matches the model selector (h-8 / rounded-md / solid hover background).
        <button
          type="button"
          aria-label={S.chat.approvalMode}
          title={`${S.chat.approvalMode}：${S.chat.approvalModeNames[value] ?? value}`}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          {/* Icon changes with the current mode (allow-all = warning triangle, grayscale, no color-coding) */}
          <GlyphIcon d={APPROVAL_MODE_ICONS[value]} />
          {/* Button shows only the description (the mode id is spelled out in the menu); when the card is narrower than @md, only the icon remains (title shows the full name). */}
          <span className="hidden min-w-0 truncate @md:block">
            {S.chat.approvalModeNames[value] ?? value}
          </span>
          <ChevronDown size={ICON_SIZE.caretDense} />
        </button>
      }
    >
      {APPROVAL_MODES.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => {
            onChange(m);
            setOpen(false);
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-gray-100 dark:hover:bg-gray-800 ${
            m === value
              ? "font-medium text-gray-900 dark:text-gray-100"
              : "text-gray-600 dark:text-gray-400"
          }`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="shrink-0 text-gray-500 dark:text-gray-500"
          >
            <path d={APPROVAL_MODE_ICONS[m]} />
          </svg>
          {/* Description first, mode id after (copy in strings); single line, no wrapping, selected checkmark at line end. */}
          <span className="min-w-0 flex-1 truncate whitespace-nowrap">
            {S.chat.approvalModes[m] ?? m}
          </span>
          <span className="w-3 shrink-0 text-center">{m === value ? "✓" : ""}</span>
        </button>
      ))}
    </Dropdown>
  );
}
