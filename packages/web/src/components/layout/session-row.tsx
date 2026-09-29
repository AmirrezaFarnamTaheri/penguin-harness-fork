/**
 * Single Session row: title + pinned indicator + status dot/approval badge, and one
 * trailing slot that swaps its content — at rest it shows the compact last-active time,
 * on row hover — or on either of them taking focus — it shows archive and delete as
 * direct icon buttons.
 * That pair is the affordance every release up to v0.2.2 shipped (as icon buttons in
 * exactly this slot), restored here: the 0.3 line had replaced it with an ellipsis
 * dropdown carrying pin / rename / archive / delete, which cost two clicks for the two
 * actions people actually reach for.
 *
 * The rest of the set did not disappear — **right-clicking the row** opens all four as a
 * context menu at the pointer (useRowContextMenu; also Shift+F10 from the keyboard and
 * press-and-hold on touch, since neither hover nor a secondary click exists there). Both
 * panels go through the Dropdown body portal so the sidebar scroller can't clip them, and
 * both read their action set from session-row-menu.tsx.
 *
 * A truncated title scrolls its tail into view while the row is hovered or
 * keyboard-focused (#309; Truncated's scrollReveal + data-title-reveal).
 */
import { memo } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { SessionInfo } from "@prismshadow/penguin-server/api";
import { S } from "../../lib/strings";
import { ICON_SIZE } from "../../lib/icon-scale";
import { toneInk } from "../../lib/tone";
import type { SessionActivity } from "../../lib/session-activity";
import { Dropdown } from "../ui/dropdown";
import { useRowContextMenu } from "../ui/context-menu";
import {
  HOVER_ROW_ACTIONS,
  PIN_ICON,
  SessionRowHoverActions,
  SessionRowMenuRows,
  contextMenuActions,
} from "../ui/session-row-menu";
import type { SessionRowAction } from "../ui/session-row-menu";
import { AgentAvatar } from "../ui/agent-avatar";
import { CheckIcon, MESSAGING_RELAY_ICON } from "../ui/icons";
import { Icon } from "../ui/group-list";
import { toastSuccess } from "../ui/toast";
import { writeClipboard } from "../ui/copy-button";
import { Truncated } from "../ui/truncated";
import { Badge } from "../ui/badge";
import {
  BackgroundTasksMark,
  ScheduleMark,
  SessionActivityIcon,
} from "../ui/session-activity-icon";

/**
 * Session status glyph: a turning hourglass while the Session is busy, a green dot once it has
 * finished with a reply the user has not seen, and nothing once that reply has been read — or
 * if the Session never ran at all. See sessionActivity.
 */
function StatusGlyph({ activity }: { activity: SessionActivity }) {
  // Reserve the glyph's box even when there is no glyph: the row is a flex line whose title
  // truncates into whatever space is left, so letting the slot collapse would re-flow the title
  // of every never-run row (and again the moment its first run starts).
  if (activity === null) return <span aria-hidden="true" className="block h-3 w-3 shrink-0" />;
  return <SessionActivityIcon activity={activity} />;
}

export interface SessionRowProps {
  s: SessionInfo;
  active: boolean;
  /** Busy / settled-read / settled-unread / never-ran, already resolved by sessionRowActivity. */
  activity: SessionActivity;
  /** Background tasks the Session still owns (sessionBackgroundTasks); 0 draws no mark. */
  background: number;
  /** A scheduled task still to fire is bound to this Session (pendingScheduleSessions); false draws no mark. */
  scheduled: boolean;
  /** Row is pinned (bubbled to its group's top; small pin glyph on the title). */
  pinned: boolean;
  /** Whether pinning can actually reorder this row — active-list rows only; folder rows hide the action (see renderRows). */
  canPin?: boolean;
  /** Preformatted compact last-active time ("" hides the slot's resting text). */
  lastActive: string;
  /** Agent display name; when set (workspace mode) a small avatar keeps the Agent context visible on the row. */
  agentHint?: string;
  /** Manual sort: the row can be drag-reordered (the sidebar wires the handlers below). */
  draggable?: boolean;
  /** Drop indicator edge while another row hovers over this one (a thin accent line above/below). */
  dropEdge?: "above" | "below" | null;
  onDragStart?: (e: ReactDragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: ReactDragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: ReactDragEvent) => void;
  onOpen: (s: SessionInfo) => void;
  onTogglePin: (s: SessionInfo) => void;
  onRename: (s: SessionInfo) => void;
  onMessaging: (s: SessionInfo) => void;
  onDelete: (s: SessionInfo) => void;
  onToggleArchive: (s: SessionInfo) => void;
  /** Selection mode is on: the row's primary action marks it instead of opening it. */
  selecting?: boolean;
  /** This row is currently marked. */
  selected?: boolean;
  /** Mark / unmark the row; the second argument is the Shift key, which extends a range. */
  onSelect?: (s: SessionInfo, shiftKey: boolean) => void;
  /** Enter selection mode with only this row marked (the row menu's "Select"). */
  onSelectMode?: () => void;
}

function SessionRowInner({
  s,
  active,
  activity,
  background,
  scheduled,
  pinned,
  canPin = false,
  lastActive,
  agentHint,
  draggable = false,
  dropEdge = null,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpen,
  onTogglePin,
  onRename,
  onMessaging,
  onDelete,
  onToggleArchive,
  selecting = false,
  selected = false,
  onSelect,
  onSelectMode,
}: SessionRowProps) {
  const ctx = useRowContextMenu();
  /** Run one action on this Session, closing the context menu first if it was open. */
  const run = (action: SessionRowAction) => {
    ctx.close();
    const handler: Record<SessionRowAction, (x: SessionInfo) => void> = {
      // "Select" acts on the LIST, not on this row's Session, so it is the one entry whose
      // handler ignores its argument — it marks this row and puts the list into selection
      // mode, which is what the menu said it would do.
      select: () => onSelectMode?.(),
      pin: onTogglePin,
      rename: onRename,
      // The copy affordance's feedback normally rides on the button itself (copy-button.tsx),
      // which a menu row cannot do: the row acts and the panel closes under it. A toast is
      // the confirmation that survives that, and it says the same word.
      copy: (x) => {
        writeClipboard(x.sessionId);
        toastSuccess(S.common.copied);
      },
      messaging: onMessaging,
      archive: onToggleArchive,
      delete: onDelete,
    };
    handler[action](s);
  };
  /**
   * Menu items hand focus back to the row before acting: the panel unmounts under the
   * user, and the context menu is the only keyboard route to pin and rename, so a
   * Shift+F10 → Enter user would otherwise be dropped onto <body> and lose their place in
   * the list. Actions that open a dialog (rename, delete) take focus from there as usual.
   */
  const runFromMenu = (action: SessionRowAction) => {
    ctx.returnFocus()?.focus();
    run(action);
  };
  const rowState = { archived: s.archived, pinned };
  return (
    <li
      className="relative"
      {...(draggable
        ? { draggable: true, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }
        : {})}
    >
      {/* Manual-drag drop indicator: a thin accent line on the edge the drop would land on (both themes read it against the row gap). */}
      {dropEdge !== null && (
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[var(--accent-bg)] ${
            dropEdge === "above" ? "-top-px" : "-bottom-px"
          }`}
        />
      )}
      <div
        // data-title-reveal: hovering the row / keyboard-focusing its button scrolls a
        // truncated title's tail into view (the Truncated below; styles.css #309 rules).
        data-title-reveal
        ref={ctx.rowRef}
        // Right-click / Shift+F10 / press-and-hold open the row's context menu. The
        // native menu is suppressed inside this handler only — the rest of the app keeps
        // the browser's own. select-none keeps a held press from raising the text
        // selection callout on touch instead of the menu.
        {...ctx.rowProps}
        className={`group flex select-none items-center rounded-md pr-1 transition-colors duration-150 ${
          draggable ? "cursor-grab " : ""
        }${
          active
            ? "bg-gray-200/70 dark:bg-gray-800"
            : "hover:bg-gray-200/50 dark:hover:bg-gray-800/70"
        }`}
      >
        <button
          type="button"
          data-testid="session-row"
          data-session-id={s.sessionId}
          // A press-and-hold that opened the context menu must not also open the Session:
          // touch screens replay the held press as a click once the finger lifts.
          onClick={(e) => {
            if (ctx.consumeLongPressClick()) return;
            // Selection mode takes the click: the row marks instead of opening, so a
            // multi-select never navigates away halfway through. Cmd/Ctrl-click does the
            // same from outside the mode, which is where the habit already lives.
            if (onSelect !== undefined && (selecting || e.metaKey || e.ctrlKey)) {
              onSelect(s, e.shiftKey);
              return;
            }
            onOpen(s);
          }}
          // In selection mode the row IS the checkbox: one button, toggled, named by its
          // title. aria-pressed rather than role=checkbox, because a checkbox promises
          // Space to toggle and this button's Space is the app's global "send message".
          {...(selecting ? { "aria-pressed": selected } : {})}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left"
        >
          {/* Selection mode puts a real checkbox in front of the title rather than tinting
              the row: a tint is invisible to a screen reader and unlabelled for everyone
              else, while a checkbox is what a user is about to press Space on. It is
              aria-hidden because the row button below already names the row and carries
              aria-pressed for the marked state — two controls for one row would be one too
              many in the tab order. */}
          {selecting && (
            <span
              aria-hidden
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
                selected
                  ? "border-accent bg-[var(--accent-bg)] text-white"
                  : "border-gray-300 dark:border-gray-600"
              }`}
            >
              {selected && <CheckIcon className="h-2.5 w-2.5" />}
            </span>
          )}
          {agentHint !== undefined && (
            <span title={agentHint} className="flex shrink-0 items-center">
              <AgentAvatar id={s.agentId} name={agentHint} size={14} className="rounded" />
              {/* The avatar is aria-hidden and title only serves pointer users: expose the Agent name to keyboard/screen-reader users as visually hidden text inside the row button. */}
              <span className="sr-only">{agentHint}</span>
            </span>
          )}
          {/* Truncated titles reveal their full text on row hover / keyboard focus by
              scrolling the tail into view (#309; scrollReveal, no-op when the title fits).
              The conditional `title` stays as the pointer-hover fallback under
              prefers-reduced-motion — not as a touch path: mobile browsers do not surface
              `title` on long-press. Touch reaches the full text by opening the Session. */}
          <Truncated
            scrollReveal
            text={s.title ?? S.chat.defaultSessionTitle}
            className={`min-w-0 flex-1 text-sm ${
              active
                ? "font-medium text-gray-900 dark:text-gray-100"
                : s.archived
                  ? "text-gray-500 dark:text-gray-400"
                  : "text-gray-700 dark:text-gray-300"
            }`}
          />
          {/* Four marks for the row's STANDING arrangements, all in one dim cluster and all in
              the `muted` ink: how the row is filed (pinned), where it can be reached from
              (messaging relay), whether it runs on its own (a scheduled task) and whether it
              owns work that outlives the turn (background tasks). None of them is live work, so
              none competes with the status glyph that follows; each names itself in a tooltip
              and in sr text, which is what lets them recede this far. */}
          {/* Pinned indicator: a dim pin after the title (unpin lives in the row menu). */}
          {pinned && canPin && (
            <span title={S.chat.pinnedSession} className={`shrink-0 ${toneInk.muted}`}>
              <Icon d={PIN_ICON} size={ICON_SIZE.rowMark} />
              <span className="sr-only">{S.chat.pinnedSession}</span>
            </span>
          )}
          {/* Enabled-messaging indicator: one glyph for every channel, the channel named in
              the tooltip and sr text (saved-but-disabled configs stay off the row; the binding
              dialog lives in the row menu). */}
          {s.messagingChannel !== undefined && (
            <span
              title={S.messaging.enabledIndicator[s.messagingChannel]}
              className={`shrink-0 ${toneInk.muted}`}
            >
              <Icon d={MESSAGING_RELAY_ICON} size={ICON_SIZE.rowMark} />
              <span className="sr-only">{S.messaging.enabledIndicator[s.messagingChannel]}</span>
            </span>
          )}
          {/* Scheduled-task indicator: the row says this conversation will run on its own, and
              the schedules panel says how often and what. A paused task, or one past its end
              time, draws nothing — nothing more will fire from it, and a mark would be noise. */}
          {scheduled && <ScheduleMark size={ICON_SIZE.rowMark} />}
          {/* Background work the conversation owns while sitting idle: parked, not running,
              so it reads as an arrangement rather than as a turn in progress. The mark leaves
              with the last task (live via session_background). */}
          {background > 0 && (
            <BackgroundTasksMark
              label={S.chat.backgroundTasks(background)}
              size={ICON_SIZE.rowMark}
            />
          )}
          {/* No per-row source tag: subagent / scheduled Sessions live in their own labelled, collapsed folders, so a badge on the title would just repeat the folder. */}
          <StatusGlyph activity={activity} />
          {s.pendingApprovalCount > 0 && (
            <span title={S.chat.pendingApprovals(s.pendingApprovalCount)}>
              <Badge tone="amber">{s.pendingApprovalCount}</Badge>
            </span>
          )}
        </button>
        {/* Trailing swap slot: resting last-active time / hover-focus archive + delete.
            The buttons form a CONSTANT-width group anchored at the slot's right edge —
            NOT a whole-slot overlay: the slot's width rides the time string (2m ago vs
            31m ago), and slot-centered glyphs landed at a different x per row, so the
            icons never formed a vertical column (the user saw them shift with the time's
            character count). Right-anchored, every row's icons share one x. min-w-12
            reserves the pair's own width, so on a row with no time they still don't
            overhang the title. The swap stays a pure opacity handoff: the time hides on
            row hover (group-hover) and while a button holds focus (peer-focus-within; the
            group precedes the time span so the peer combinator can reach it). */}
        <div className="relative flex h-6 min-w-12 shrink-0 items-center justify-end">
          {/* No hover pill on these (a fill as wide as the date read ugly); feedback is
              the glyph color deepening — red for delete. The whole slot empties in selection
              mode: a per-row archive that bypasses the batch bar and the count in it would
              be two ways to archive, one of which the user cannot see. */}
          <div className="peer absolute right-0 top-1/2 flex -translate-y-1/2 items-center">
            {selecting ? null : (
              <SessionRowHoverActions
                actions={HOVER_ROW_ACTIONS}
                state={rowState}
                moreOpen={ctx.open}
                onRun={run}
                onMore={ctx.openAt}
              />
            )}
          </div>
          {lastActive !== "" && (
            <span
              aria-hidden
              className="pointer-events-none px-1 text-[11px] text-gray-600 transition-opacity duration-150 group-hover:opacity-0 peer-focus-within:opacity-0 dark:text-gray-400"
            >
              {lastActive}
            </span>
          )}
        </div>
        {/* The full set, one right-click away (also Shift+F10 / press-and-hold — see
            useRowContextMenu). `contents` keeps this wrapper out of the row's flex
            layout: it renders no box of its own, the panel is portaled, and the anchor
            is the viewport point the gesture landed on rather than this element. */}
        <Dropdown
          open={ctx.open}
          setOpen={ctx.setOpen}
          portal={{ direction: "down", align: "left" }}
          anchorRect={ctx.anchor}
          anchorOwner={ctx.anchorOwner}
          returnFocus={ctx.returnFocus}
          className="contents"
          menuClass="w-36"
          button={null}
        >
          <SessionRowMenuRows
            actions={contextMenuActions(canPin)}
            state={rowState}
            onRun={runFromMenu}
          />
        </Dropdown>
      </div>
    </li>
  );
}

/**
 * Props that decide what the row DRAWS, compared by identity.
 *
 * The point of the list: a `searchQuery` keystroke re-renders the whole Sidebar, and every
 * value here is recomputed for the rows that survive the filter — yet none of them actually
 * changes for a row that stayed. `s` is the store's own Session object (replaced, never
 * mutated in place); `activity`, `background` and `lastActive` are recomputed each render
 * but are a string union, a number and a formatted string, all of which hold their value
 * across a keystroke — `lastActive` is a relative stamp, so it only moves when the minute
 * under it does. That is what leaves the handlers off this list: see below.
 */
const ROW_DRAW_PROPS = [
  "s",
  "active",
  "activity",
  "background",
  "scheduled",
  "pinned",
  "canPin",
  "lastActive",
  "agentHint",
  "draggable",
  "dropEdge",
  "selecting",
  "selected",
] as const satisfies readonly (keyof SessionRowProps)[];

/**
 * Custom prop comparator for SessionRow memoization.
 *
 * The thirteen handlers are deliberately NOT compared. They are excluded because comparing
 * them by identity would defeat the memo outright — the sidebar builds all thirteen inside
 * `renderRows`, so every render hands each row a fresh closure and the row would re-render
 * on every keystroke exactly as it does today. Each one is instead safe to keep, and the two
 * that are not are made safe on the caller side:
 *
 *  - `onTogglePin` is the one that reads changing state (the whole `pinnedSessions` set),
 *    so the sidebar memoises it on that set. Skipping the comparison without that memo
 *    would be a real bug, not a slow render: a stale closure computes the next set from
 *    the pins as they were before the last pin, and writing it back silently drops a pin
 *    the user just set on another row.
 *  - `onToggleArchive` reads the open Session and the grouping mode; both are memoised the
 *    same way, and the mode only decides which folder an archived open chat expands.
 *  - `onOpen` closes over the Project id, which a switch replaces along with every row.
 *  - `onRename` / `onMessaging` / `onDelete` / `onSelect` / `onSelectMode` are setters and
 *    `applySelection`, none of which change.
 *
 * The five drag handlers cannot be reasoned about this way at all, so a row that HAS them
 * always re-renders. They are per-row closures over the live `dragSession` / `dropHint`
 * state, and whether a row may accept a drop depends on the DRAGGED row, not on this one:
 * a comparator that saw unchanged `dropEdge` and skipped the render would leave the row
 * holding the `dragging === null` it was built with, and it would silently refuse the drop.
 * `draggable` is set in the same spread as those handlers, so it is exactly the flag for
 * "this row carries them".
 */
export function areSessionRowPropsEqual(prev: SessionRowProps, next: SessionRowProps): boolean {
  if (prev.draggable === true || next.draggable === true) return false;
  for (const prop of ROW_DRAW_PROPS) if (prev[prop] !== next[prop]) return false;
  return true;
}

export const SessionRow = memo(SessionRowInner, areSessionRowPropsEqual);
