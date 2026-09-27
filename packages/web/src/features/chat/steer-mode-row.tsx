/**
 * Mid-run send mode (steer vs queue-as-follow-up), extracted from chat-input.tsx: the settings
 * row itself, plus the preference it edits — the mode type, its storage key and the validated
 * localStorage read the composer seeds its state from, all one unit, so the composer imports
 * them back (a mechanical move; the preference's semantics are unchanged).
 */
import { S } from "../../lib/strings";
import { GlyphIcon } from "../../components/ui/glyph-icon";

/**
 * Mid-run send mode: steer (delivered mid-run as a [user_steering] input) vs follow-up
 * (queued server-side until the run ends). A remembered per-user UI preference, persisted
 * the same way as the sidebar grouping mode (validated localStorage read under a
 * `penguin.*` key); configurable from the "+" menu's settings row in draft state and active
 * sessions alike.
 */
export type SteerMode = "steer" | "followup";
export const STEER_MODE_KEY = "penguin.steerMode";
export function initialSteerMode(): SteerMode {
  return localStorage.getItem(STEER_MODE_KEY) === "followup" ? "followup" : "steer";
}

/** Sliders icon (24×24 line path) for the mid-run send-mode settings row. */
const SLIDERS_ICON = "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6";

/**
 * The mid-run send mode row, rendered as the "+" menu's settings footer: Steer (default) /
 * Queue as a follow-up, the full explanation hover-only via each pill's title (the toolbar's
 * "full meaning on hover" convention). Laid out like the menu's items — leading icon, label,
 * the control where an item's description sits — so the menu reads as one list. Clicking a
 * pill keeps the menu open — it's a setting, not an action — and the row is never disabled:
 * the preference is settable before and during a run.
 */
export function SteerModeRow({
  steerMode,
  onChangeSteerMode,
}: {
  steerMode: SteerMode;
  onChangeSteerMode: (mode: SteerMode) => void;
}) {
  // Compact pills, no bordered wrapper: the control must not out-height an item's 16px text
  // line by more than the row paddings absorb — h-5 pills inside py-1 land the row at the
  // same 28px an item's text + py-1.5 does, so the menu keeps one line rhythm.
  const modeButton = (mode: SteerMode, label: string, hint: string) => (
    <button
      type="button"
      title={hint}
      aria-pressed={steerMode === mode}
      onClick={() => onChangeSteerMode(mode)}
      className={`h-5 rounded px-1.5 text-xs transition-colors duration-150 ${
        steerMode === mode
          ? "bg-gray-200 font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-100"
          : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex w-full items-center gap-2 px-3 py-1 text-xs">
      <GlyphIcon d={SLIDERS_ICON} className="shrink-0 text-gray-500 dark:text-gray-500" />
      <span className="min-w-0 flex-1 truncate text-gray-600 dark:text-gray-400">
        {S.chat.steerModeLabel}
      </span>
      <div
        role="group"
        aria-label={S.chat.steerModeLabel}
        className="flex shrink-0 items-center gap-0.5"
      >
        {modeButton("steer", S.chat.steerModeSteer, S.chat.steerModeSteerHint)}
        {modeButton("followup", S.chat.steerModeFollowUp, S.chat.steerModeFollowUpHint)}
      </div>
    </div>
  );
}
