/**
 * The organization calendar: month / week / day views over every employee's events
 * (geometry in calendar-geom.ts), events coloured per employee from the categorical
 * palette, a legend that names each employee's cadence and doubles as the employee filter,
 * and one dialog for creating and editing an event — the scheduled-task dialog minus its
 * target fields, with the employee as a select. The grid is always on screen: a skeleton of
 * it while the first fetch is out, the empty grid with a one-line hint when the organization
 * has no events yet — dismissible, and repeated in the page's "?" so it stays reachable —
 * the grid plus an error strip when a refetch fails. A month cell shows a few chips and folds
 * the rest into a button that opens the whole day in a popover rather than the create dialog.
 * Past instances carry the outcome the scheduler recorded; every write confirms first, and
 * reports back whatever the server has to say about the rota.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import type {
  OrgCalendarItem,
  OrgCalendarOutcome,
  OrgChartResponse,
} from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { S } from "../../lib/strings";
import { useUiClock } from "../../lib/use-ui-clock";
import { apiErrorText } from "../../lib/api-error";
import { formatDateTime } from "../../lib/format";
import { useDocumentTitle } from "../../lib/use-document-title";
import { employeeColor } from "../../lib/category-colors";
import { ICON_SIZE } from "../../lib/icon-scale";
import { toneInk, toneStrip } from "../../lib/tone";
import type { Tone } from "../../lib/tone";
import { useAuth } from "../../state/auth";
import { useCompany } from "../../state/company";
import { Button } from "../../components/ui/button";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Input, Textarea } from "../../components/ui/input";
import { Modal } from "../../components/ui/modal";
import { ConfirmModal } from "../../components/ui/confirm-modal";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { CloseIcon } from "../../components/ui/icons";
import { Skeleton } from "../../components/ui/skeleton";
import { usePortalPanel } from "../../components/ui/use-portal-panel";
import { toastAttention, toastError, toastSuccess } from "../../components/ui/toast";
import { OrgPage, useOrg } from "./org-layout";
import {
  cadenceOf,
  chipLanes,
  dayFraction,
  dayKey,
  expandEvents,
  instancesByDay,
  monthGrid,
  shiftAnchor,
  timeLabel,
  toLocalInput,
  viewRange,
  weekDays,
} from "./calendar-geom";
import type { Cadence, CalendarView, ChipSlot, EventInstance, GridDay } from "./calendar-geom";
import { dismissHint, hintKey, isHintDismissed } from "./page-hints";

const PREV_ICON = "M15 18 9 12l6-6";
const NEXT_ICON = "m9 18 6-6-6-6";

const OUTCOME_TONE: Record<OrgCalendarOutcome, Tone> = {
  fired: "success",
  queued: "attention",
  paused: "muted",
  missed: "danger",
  error: "danger",
};

/** The mark a recorded outcome leaves on its instance: a check, an hourglass, a pause, a cross, an alert. */
const OUTCOME_ICON: Record<OrgCalendarOutcome, string> = {
  fired: "M5 13l4 4L19 7",
  queued: "M6 3h12M6 21h12M8 3v3.5L12 10l4-3.5V3M8 21v-3.5L12 14l4 3.5V21",
  paused: "M9 5v14M15 5v14",
  missed: "M18 6 6 18M6 6l12 12",
  error: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v4m0 4h.01",
};

/** Hour rows of the day and week columns (px per hour): a day is 24 × this tall. */
const HOUR_PX = 44;
/** The footprint of a chip in those columns: half an hour, the smallest slot a line of text fits at this row height. */
const CHIP_SLOT_MS = 30 * 60_000;
/** The columns open scrolled to 06:00 and show sixteen hours; the night is reached by scrolling. */
const VISIBLE_FROM_HOUR = 6;
const VISIBLE_HOURS = 16;
/** Chips shown per month cell before the rest fold into a count. */
const MONTH_CELL_CHIPS = 3;
/**
 * Width of the day popover, in px rather than a `w-` class: usePortalPanel clamps the panel's
 * left edge against this number, and the app's root font size is a user setting (16 / 18 / 20
 * px), so a rem-based class and a px constant would agree only at one of the three tiers.
 */
const DAY_PANEL_WIDTH = 240;

interface FormState {
  /** Editing an existing event (its file is fixed): agentId + name; null when creating. */
  editing: { agentId: string; name: string } | null;
  agentId: string;
  name: string;
  title: string;
  prompt: string;
  enabled: boolean;
  startAt: string;
  endAt: string;
  period: string;
}

function cadenceLabel(c: Cadence): string {
  const t = S.company.calendar.cadence;
  switch (c.kind) {
    case "once":
      return t.once;
    case "minutes":
      return t.minutes(c.n);
    case "hours":
      return t.hours(c.n);
    case "days":
      return c.n === 1 ? t.daily(c.time) : t.days(c.n, c.time);
    case "weeks":
      return c.n === 1 ? t.weekly(c.time) : t.weeks(c.n, c.time);
    default:
      return t.invalid;
  }
}

const hourLabel = (h: number) => `${h < 10 ? "0" : ""}${h}:00`;
/** The footprint of a chip inside its hour band, in px (CHIP_SLOT_MS tall, less the 1px seam). */
const CHIP_H = (CHIP_SLOT_MS / 3_600_000) * HOUR_PX - 2;
/** A grid day's weekday name, Monday first — the order the columns and the headers are in. */
const weekdayName = (day: GridDay): string =>
  S.company.calendar.weekdays[(new Date(day.dayStartMs).getDay() + 6) % 7] ?? "";

export function CalendarPage() {
  const { projectId, orgId, org } = useOrg();
  const navigate = useNavigate();
  const company = useCompany();
  const { user } = useAuth();
  useDocumentTitle(org ? `${org.name} · ${S.nav.org.calendar}` : S.nav.org.calendar);
  const [events, setEvents] = useState<OrgCalendarItem[] | null>(null);
  const [invalidFiles, setInvalidFiles] = useState<
    Array<{ agentId: string; name: string; error: string }>
  >([]);
  const [chart, setChart] = useState<OrgChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CalendarView>("month");
  const [anchor, setAnchor] = useState(() => Date.now());
  const now = useUiClock(60_000);
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<"name" | "prompt" | "startAt" | "agentId", string>>
  >({});
  const [confirmSave, setConfirmSave] = useState(false);
  const [deleting, setDeleting] = useState<{ agentId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The empty-calendar note goes away for good once read; the page's "?" carries the same
  // sentence. The key holds the organization, so switching to another one — which does not
  // unmount this page — re-reads the dismissal instead of carrying the last answer over.
  const emptyHintKey = hintKey(user?.userId ?? null, projectId, orgId, "calendar");
  const [hintDismissed, setHintDismissed] = useState(() => isHintDismissed(emptyHintKey));
  useEffect(() => {
    setHintDismissed(isHintDismissed(emptyHintKey));
  }, [emptyHintKey]);

  const load = useCallback(async () => {
    try {
      const [cal, ch] = await Promise.all([
        api.listOrgCalendar(projectId, orgId),
        api.getOrgChart(projectId, orgId),
      ]);
      setEvents(cal.events);
      setInvalidFiles(cal.invalidFiles);
      setChart(ch);
      setError(null);
    } catch (e) {
      setError(apiErrorText(e));
    }
  }, [projectId, orgId]);
  // A fired slot arrives as an org_run event; a budget pause flips `paused` on every event of that employee.
  const { runs, budget } = company.versions;
  useEffect(() => {
    void load();
  }, [load, runs, budget]);

  // The "now" the past marks and the time line read: a minute's precision is all they show, and it
  // comes from the shared UI clock (F2) — a separate 60 s timer here was one more thing to leak on
  // an unmount, and it missed the clock entirely when the tab woke from sleep.

  const loaded = events !== null;
  // The day and week columns open at the working hours (the hour label sits astride its
  // line, so the scroll stops a few pixels short of it); the night above is one scroll away.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && view !== "month") el.scrollTop = VISIBLE_FROM_HOUR * HOUR_PX - 10;
  }, [view, loaded]);

  const employees = chart?.employees ?? [];
  const names = new Map(employees.map((e) => [e.agentId, e.name]));
  /** Colour index by chart order, so an employee keeps its hue across days and views. */
  const colorOf = (agentId: string) => {
    const i = employees.findIndex((e) => e.agentId === agentId);
    return employeeColor(i === -1 ? employees.length : i);
  };

  const range = viewRange(anchor, view);
  const instances = useMemo(() => {
    const list = (events ?? []).filter(
      (e) => employeeFilter === "" || e.agentId === employeeFilter,
    );
    return expandEvents(list, range.startMs, range.endMs, now);
  }, [events, employeeFilter, range.startMs, range.endMs, now]);
  const byDay = useMemo(() => instancesByDay(instances), [instances]);

  const openCreate = (atMs?: number) => {
    setFieldErrors({});
    setForm({
      editing: null,
      agentId: employeeFilter || (employees[0]?.agentId ?? ""),
      name: "",
      title: "",
      prompt: "",
      enabled: true,
      startAt: toLocalInput(new Date(atMs ?? Date.now()).toISOString()),
      endAt: "",
      period: "",
    });
  };
  const openEdit = (ev: OrgCalendarItem) => {
    setFieldErrors({});
    setForm({
      editing: { agentId: ev.agentId, name: ev.name },
      agentId: ev.agentId,
      name: ev.name,
      title: ev.title ?? "",
      prompt: ev.prompt,
      enabled: ev.enabled,
      startAt: toLocalInput(ev.startAt),
      endAt: toLocalInput(ev.endAt),
      period: ev.period ?? "",
    });
  };
  const set = (patch: Partial<FormState>) => setForm((f) => (f === null ? f : { ...f, ...patch }));

  const validate = (): boolean => {
    if (form === null) return false;
    const next: typeof fieldErrors = {};
    if (!form.agentId) next.agentId = S.common.requiredField;
    if (!form.name.trim()) next.name = S.common.requiredField;
    if (!form.prompt.trim()) next.prompt = S.common.requiredField;
    if (!form.startAt) next.startAt = S.common.requiredField;
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async () => {
    if (form === null) return;
    setBusy(true);
    try {
      const body = {
        ...(form.title.trim() ? { title: form.title.trim() } : {}),
        prompt: form.prompt,
        enabled: form.enabled,
        startAt: new Date(form.startAt).toISOString(),
        ...(form.period.trim() ? { period: form.period.trim() } : {}),
        ...(form.endAt ? { endAt: new Date(form.endAt).toISOString() } : {}),
      };
      const written =
        form.editing !== null
          ? await api.updateOrgCalendarEvent(
              projectId,
              orgId,
              form.editing.agentId,
              form.editing.name,
              body,
            )
          : await api.createOrgCalendarEvent(projectId, orgId, {
              ...body,
              agentId: form.agentId,
              name: form.name.trim(),
            });
      toastSuccess(S.common.saved);
      // Rota advice, not a failure: the event is stored either way, so it rides in a second
      // toast rather than turning the save into an error.
      const warnings = written.warnings ?? [];
      if (warnings.length > 0) {
        toastAttention(`${S.company.calendar.warningsPrefix} · ${warnings.join(" · ")}`);
      }
      setConfirmSave(false);
      setForm(null);
      void load();
    } catch (e) {
      setConfirmSave(false);
      toastError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (deleting === null) return;
    setBusy(true);
    try {
      await api.deleteOrgCalendarEvent(projectId, orgId, deleting.agentId, deleting.name);
      setDeleting(null);
      setForm(null);
      void load();
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** Open the desk session an instance's run went to (a past, fired instance). */
  const openDesk = async (agentId: string) => {
    try {
      const desk = await api.getOrgDesk(projectId, orgId, agentId);
      navigate(`/chat/${desk.sessionId}`);
    } catch (e) {
      toastError(apiErrorText(e));
    }
  };

  const todayKey = dayKey(now);

  /**
   * One event instance as a chip. Employee colour carries identity; the recorded outcome (on
   * the one instance it belongs to) rides at the end as a toned glyph; a past instance fades,
   * and a disabled or paused event is struck through so the chip says it will not fire.
   *
   * `dayLabel` is what a chip in the week and day columns needs and a month cell's chip does not:
   * in a column nothing else says which day a chip is on, so its name carries the date. The
   * name is set with aria-label rather than left to the visible "09:00 label", because the
   * tooltip already spells out the employee, the recorded outcome and the paused/disabled notes
   * and a chip with none of them said a third of as much as the card it opens.
   */
  const chip = (
    i: EventInstance,
    opts: { block?: boolean; dayLabel?: string; onOpen?: () => void } = {},
  ) => {
    const color = colorOf(i.event.agentId);
    const outcome = i.outcome;
    const label = i.event.title ?? i.event.name;
    const inert = !i.event.enabled || i.event.paused;
    const title = [
      opts.dayLabel !== undefined
        ? S.company.calendar.eventOnDay(opts.dayLabel, timeLabel(i.atMs), label)
        : `${timeLabel(i.atMs)} · ${label}`,
      names.get(i.event.agentId) ?? i.event.agentId,
      outcome !== null
        ? (S.company.calendarOutcomes[outcome] ?? outcome)
        : i.past
          ? S.company.calendar.past
          : null,
      !i.event.enabled ? S.company.calendar.disabledNote : null,
      i.event.paused ? S.company.calendar.pausedNote : null,
    ]
      .filter((p) => p !== null)
      .join(" · ");
    return (
      <button
        key={i.key}
        type="button"
        title={title}
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation();
          opts.onOpen?.();
          openEdit(i.event);
        }}
        className={`flex min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] leading-5 transition-opacity ${color.chip} ${
          opts.block ? "h-full w-full" : "w-full"
        } ${i.past && outcome === null ? "opacity-60" : ""} ${
          inert ? "line-through decoration-1 opacity-60" : ""
        }`}
      >
        <span className="shrink-0 font-mono tabular-nums">{timeLabel(i.atMs)}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {outcome !== null && (
          <span className={`inline-flex shrink-0 items-center ${toneInk[OUTCOME_TONE[outcome]]}`}>
            <GlyphIcon d={OUTCOME_ICON[outcome]} size={ICON_SIZE.inlineGlyph} />
          </span>
        )}
      </button>
    );
  };

  const heading =
    view === "month"
      ? S.company.calendar.monthTitle(
          new Date(anchor).getFullYear(),
          new Date(anchor).getMonth() + 1,
        )
      : view === "week"
        ? `${dayKey(range.startMs)} – ${dayKey(range.endMs - 1)}`
        : `${dayKey(anchor)} ${S.company.calendar.weekdays[(new Date(anchor).getDay() + 6) % 7] ?? ""}`;

  const toolbar = (
    <>
      <Segmented
        options={[
          { value: "month" as const, label: S.company.calendar.month },
          { value: "week" as const, label: S.company.calendar.week },
          { value: "day" as const, label: S.company.calendar.day },
        ]}
        value={view}
        onChange={setView}
        cols={3}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={employees.length === 0}
        onClick={() => openCreate()}
      >
        {S.company.calendar.create}
      </Button>
    </>
  );

  /**
   * A month cell: the day number, up to three chips, the rest folded into a button that opens
   * the whole day; the cell itself creates at 09:00.
   *
   * It is a `td`, because a month grid is a table (WCAG 1.3.1): seven `th scope="col"` weekdays
   * over rows of days, so a reader can ask what the column of a cell is. Each cell opens with
   * the day spelled out in text, which is the one thing a chip's own name cannot say in the
   * month view — the date sits in the cell, not in the chip, or three chips would each repeat it.
   */
  const monthCell = (day: GridDay) => {
    const list = byDay.get(day.key) ?? [];
    const shown = list.slice(0, MONTH_CELL_CHIPS);
    const isToday = day.key === todayKey;
    const createMs = day.dayStartMs + 9 * 3_600_000;
    const weekday = S.company.calendar.weekdays[(new Date(day.dayStartMs).getDay() + 6) % 7] ?? "";
    return (
      <td
        key={day.key}
        className={`border-r border-gray-100 align-top transition-colors duration-150 last:border-r-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900/60 ${
          day.inMonth ? "" : "bg-gray-50/60 text-gray-500 dark:bg-gray-900/40 dark:text-gray-600"
        }`}
      >
        {/* The cell's own date, read before its contents. This is CONTENT and not an aria-label on
            the cell on purpose: a `td`'s aria-label is not announced by every reader's table
            navigation, while its text always is. The visible day number is hidden from assistive
            technology so the date is not read twice. */}
        <span className="sr-only">{`${day.key} ${weekday}`}</span>
        <div className="relative min-h-24 p-1">
          {/* The cell itself is NOT the control — it holds the day's number and its chips, so
              making it a button would nest interactive elements (WCAG SC 4.1.2, and invalid
              HTML). The create affordance is this one real button, absolutely positioned to
              cover the cell's top strip where the number sits, which is where the pointer
              target used to be. A keyboard user now gets the same action at the same place. */}
          <button
            type="button"
            title={S.company.calendar.createAt(`${day.key} 09:00`)}
            aria-label={S.company.calendar.createAt(`${day.key} 09:00`)}
            onClick={() => openCreate(createMs)}
            className="absolute inset-x-0 top-0 z-10 h-7 cursor-pointer rounded-t"
          />
          <p className="mb-1 flex h-5 items-center">
            <span
              aria-hidden
              className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums ${
                isToday
                  ? "bg-[var(--accent-bg)] font-semibold text-[var(--accent-fg)]"
                  : day.inMonth
                    ? "text-gray-600 dark:text-gray-300"
                    : "text-gray-500 dark:text-gray-600"
              }`}
            >
              {new Date(day.dayStartMs).getDate()}
            </span>
          </p>
          <div className="space-y-0.5">
            {shown.map((i) => chip(i))}
            {list.length > shown.length && (
              <DayOverflow
                hidden={list.length - shown.length}
                total={list.length}
                dateLabel={`${day.key} ${weekday}`}
                onOpenDay={() => {
                  setAnchor(day.dayStartMs);
                  setView("day");
                }}
              >
                {(close) => list.map((i) => chip(i, { onOpen: close }))}
              </DayOverflow>
            )}
          </div>
        </div>
      </td>
    );
  };

  /**
   * Roving tabindex over the week/day hour grid, which `role="grid"` now demands of it
   * (WCAG 2.2 SC 2.1.1, and the APG keyboard contract for a grid).
   *
   * These 24 hour cells per day column were `<div onClick>`: a week view is SEVEN of them, so
   * 168 create targets that no keyboard could reach and a screen reader never announced. The
   * month cell had the same problem. Making every cell a real `<button>` would fix the role and
   * the keyboard but put 168 stops in the Tab order, which is its own trap.
   *
   * The grid's semantics and its keyboard have to agree, because a `grid` promises BOTH: a
   * screen reader announces "row 3, column 2" and a sighted-at-the-keyboard user expects the
   * arrow keys to move the same way. So the stop is one per GRID, not one per day column —
   * seven Tab stops became one, which is what the roving tabindex was reaching for anyway — and
   * all four arrow keys walk it: up and down the hours, left and right across the days. Home
   * and End walk the row, and with Control the whole grid. Enter or Space still creates: the
   * focused cell holds a real button.
   */
  const [focusedSlot, setFocusedSlot] = useState<{ day: string; hour: number } | null>(null);
  /** The one cell currently holding the grid's tab stop; the effect below follows it. */
  const activeCellRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeCellRef.current?.focus();
  }, [focusedSlot]);

  /**
   * One hour of one day: the `gridcell`, the create button filling it, and the chips that start
   * in it. The cell WRAPS its button rather than being one, so the button keeps the role that
   * says "this creates something" while the cell keeps its place in the grid; the roving
   * tabindex is on the button, which is what actually takes focus.
   */
  const hourCell = (
    days: GridDay[],
    day: GridDay,
    dayIndex: number,
    h: number,
    stop: { day: string; hour: number },
    chips: readonly ChipSlot<EventInstance>[],
  ) => {
    const isToday = day.key === todayKey;
    const at = new Date(now);
    const active = stop.day === day.key && stop.hour === h;
    return (
      <div
        key={`${day.key}/${h}`}
        role="gridcell"
        className={`relative min-w-0 border-l border-gray-100 dark:border-gray-800 ${
          isToday ? "bg-[var(--accent-bg)]/[0.03]" : ""
        }`}
      >
        <button
          type="button"
          title={S.company.calendar.createAt(`${day.key} ${hourLabel(h)}`)}
          aria-label={S.company.calendar.createAt(`${day.key} ${hourLabel(h)}`)}
          tabIndex={active ? 0 : -1}
          {...(active ? { ref: activeCellRef } : {})}
          className="absolute inset-0 cursor-pointer border-t border-gray-100 transition-colors duration-150 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900/60"
          onClick={() => openCreate(day.dayStartMs + h * 3_600_000)}
          onFocus={() =>
            setFocusedSlot((prev) =>
              prev?.day === day.key && prev.hour === h ? prev : { day: day.key, hour: h },
            )
          }
          onKeyDown={(e) => {
            /** A step in one direction, wrapping at the ends of the hours and of the days. */
            const step = (dDay: number, dHour: number) => {
              e.preventDefault();
              setFocusedSlot({
                day: days[(dayIndex + dDay + days.length) % days.length]?.key ?? day.key,
                hour: (h + dHour + 24) % 24,
              });
            };
            if (e.key === "ArrowDown") step(0, 1);
            else if (e.key === "ArrowUp") step(0, -1);
            else if (e.key === "ArrowRight") step(1, 0);
            else if (e.key === "ArrowLeft") step(-1, 0);
            // Home / End walk the row; with Control, the first and last cell of the whole grid.
            else if (e.key === "Home") step(e.ctrlKey ? -dayIndex : 0, -h);
            else if (e.key === "End") step(e.ctrlKey ? days.length - 1 - dayIndex : 0, 23 - h);
          }}
        />
        {isToday && at.getHours() === h && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
            style={{ top: (at.getMinutes() / 60) * HOUR_PX - 1 }}
          >
            <span className="-ml-1 h-2 w-2 rounded-full bg-[var(--accent-bg)]" />
            <span className="h-0.5 flex-1 bg-[var(--accent-bg)]" />
          </div>
        )}
        {chips.map(({ item, lane, lanes }) => (
          <div
            key={item.key}
            // z-10 because the NEXT row's cell comes later in the document and would otherwise
            // paint over, and swallow the clicks of, the few pixels a late chip overhangs it.
            className="absolute z-10"
            style={{
              top: (new Date(item.atMs).getMinutes() / 60) * HOUR_PX + 1,
              height: CHIP_H,
              left: `calc(${(lane / lanes) * 100}% + 2px)`,
              width: `calc(${100 / lanes}% - 4px)`,
            }}
          >
            {chip(item, { block: true, dayLabel: `${day.key} ${weekdayName(day)}` })}
          </div>
        ))}
      </div>
    );
  };

  /** The week and day views share one frame: a day header row, then the hour grid with its gutter.
   *
   *  `role="grid"` (WCAG 1.3.1): the frame owns a `row` of `columnheader` days and a `rowgroup`
   *  of 24 hour `row`s, each a `rowheader` (the hour) plus one `gridcell` per day — so a reader
   *  hears the day of a cell and where it sits, which the old `grid grid-cols-7` of plain `div`s
   *  never did. The rows are flex rows rather than one grid of absolutely positioned day
   *  columns: the hour bands have to BE the rows for that structure to be honest, and a row of a
   *  3rem gutter plus seven `flex-1` cells lays out exactly as the old seven 1fr columns did. */
  const timeGrid = (days: GridDay[]) => {
    /** Lanes packed once per day, then bucketed by the hour band each chip starts in, so a chip
     *  rides inside the cell of its own hour and overhangs it as it always has. */
    const chipsByHour = new Map<string, ChipSlot<EventInstance>[]>();
    for (const day of days) {
      for (const slot of chipLanes(byDay.get(day.key) ?? [], CHIP_SLOT_MS)) {
        const key = `${day.key}/${new Date(slot.item.atMs).getHours()}`;
        const list = chipsByHour.get(key);
        if (list !== undefined) list.push(slot);
        else chipsByHour.set(key, [slot]);
      }
    }
    /** Where the grid's single tab stop sits: where the reader left it, and the first hour of
     *  the first day otherwise — including after a view change left it on a day not on screen,
     *  which would otherwise leave the grid with no tab stop at all. */
    const stop =
      focusedSlot !== null && days.some((d) => d.key === focusedSlot.day)
        ? focusedSlot
        : { day: days[0]?.key ?? "", hour: 0 };
    return (
      <div className="overflow-x-auto">
        <div
          role="grid"
          aria-label={`${S.company.calendar.hourGrid} · ${heading}`}
          className={`${days.length === 1 ? "" : "min-w-[52rem]"} overflow-hidden rounded-md border border-gray-200 dark:border-gray-800`}
        >
          <div
            role="row"
            className="flex border-b border-gray-200 text-[11px] font-medium text-gray-500 dark:border-gray-800 dark:text-gray-400"
          >
            <div role="presentation" className="w-12 shrink-0" />
            {days.map((day) => {
              const d = new Date(day.dayStartMs);
              const isToday = day.key === todayKey;
              return (
                <div
                  key={day.key}
                  role="columnheader"
                  className={`flex min-w-0 flex-1 items-center gap-1.5 border-l border-gray-100 px-2 py-1.5 dark:border-gray-800 ${
                    isToday ? "font-semibold text-gray-900 dark:text-gray-100" : ""
                  }`}
                >
                  {weekdayName(day)}
                  <span
                    className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 tabular-nums ${
                      isToday ? "bg-[var(--accent-bg)] text-[var(--accent-fg)]" : ""
                    }`}
                  >
                    {d.getDate()}
                  </span>
                </div>
              );
            })}
          </div>
          <div
            ref={scrollRef}
            role="rowgroup"
            className="flex flex-col overflow-y-auto"
            style={{ height: VISIBLE_HOURS * HOUR_PX }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} role="row" className="flex shrink-0" style={{ height: HOUR_PX }}>
                {/* The hour names its own row, so a cell can be placed by time. */}
                <div role="rowheader" aria-label={hourLabel(h)} className="relative w-12 shrink-0">
                  {h > 0 && (
                    <span
                      aria-hidden
                      className="absolute -top-1.5 right-2 font-mono text-[10px] tabular-nums text-gray-500 dark:text-gray-400"
                    >
                      {hourLabel(h)}
                    </span>
                  )}
                </div>
                {days.map((day, i) =>
                  hourCell(days, day, i, h, stop, chipsByHour.get(`${day.key}/${h}`) ?? []),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const grid =
    view === "month" ? (
      <div className="overflow-x-auto">
        {/* A month grid IS a table (WCAG 1.3.1): seven `th scope="col"` weekdays over rows of
            days, so a reader gets the weekday of a column and the day of a cell instead of an
            undifferentiated stream of divs. `table-fixed` gives the seven equal columns the
            `grid-cols-7` gave it. */}
        <div className="min-w-[44rem] overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                {S.company.calendar.weekdays.map((w) => (
                  <th
                    key={w}
                    scope="col"
                    className="px-2 py-1.5 text-left text-[11px] font-medium text-gray-500 dark:text-gray-400"
                  >
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthGrid(anchor).map((row, r) => (
                <tr key={r}>{row.map(monthCell)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ) : view === "week" ? (
      timeGrid(weekDays(anchor))
    ) : (
      timeGrid([{ key: dayKey(anchor), dayStartMs: range.startMs, inMonth: true }])
    );

  const editingEvent =
    form?.editing != null
      ? (events ?? []).find(
          (e) => e.agentId === form.editing?.agentId && e.name === form.editing?.name,
        )
      : undefined;

  return (
    <OrgPage title={S.nav.org.calendar} info={S.company.calendar.info} actions={toolbar} wide>
      {/* Navigation row: previous / today / next, the heading, and the employee filter. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          title={S.company.calendar.prev}
          aria-label={S.company.calendar.prev}
          onClick={() => setAnchor((a) => shiftAnchor(a, view, -1))}
        >
          <GlyphIcon d={PREV_ICON} size={ICON_SIZE.iconButton} />
        </Button>
        <Button size="sm" onClick={() => setAnchor(Date.now())}>
          {S.company.calendar.today}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title={S.company.calendar.next}
          aria-label={S.company.calendar.next}
          onClick={() => setAnchor((a) => shiftAnchor(a, view, 1))}
        >
          <GlyphIcon d={NEXT_ICON} size={ICON_SIZE.iconButton} />
        </Button>
        <span className="text-sm font-semibold tabular-nums">{heading}</span>
        <div className="ml-auto w-48">
          <Select
            size="sm"
            aria-label={S.company.calendar.filterEmployee}
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
          >
            <option value="">{S.company.calendar.allEmployees}</option>
            {employees.map((e) => (
              <option key={e.agentId} value={e.agentId}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Legend: one entry per employee in the chart's colour order, naming its cadence; a click filters to it. */}
      {employees.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-x-1 gap-y-1 text-[11px]">
          {employees.map((e) => {
            const own = (events ?? []).filter((ev) => ev.agentId === e.agentId);
            const cadences = own.map(
              (ev) => `${ev.title ?? ev.name} ${cadenceLabel(cadenceOf(ev))}`,
            );
            const shown = cadences.slice(0, 2);
            const rest = cadences.length - shown.length;
            const active = employeeFilter === e.agentId;
            return (
              <button
                key={e.agentId}
                type="button"
                title={
                  active ? S.company.calendar.allEmployees : S.company.calendar.legendFilter(e.name)
                }
                aria-pressed={active}
                onClick={() => setEmployeeFilter(active ? "" : e.agentId)}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-gray-100 dark:hover:bg-gray-800 ${
                  active ? "bg-gray-100 dark:bg-gray-800" : ""
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${colorOf(e.agentId).dot}`} />
                <span className="font-medium text-gray-700 dark:text-gray-200">{e.name}</span>
                <span
                  className="truncate text-gray-500 dark:text-gray-400"
                  title={cadences.join(" · ")}
                >
                  {cadences.length === 0
                    ? S.company.calendar.legendEmpty
                    : `${shown.join(" · ")}${rest > 0 ? ` +${rest}` : ""}`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error !== null && (
        <div
          className={`mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${toneStrip.danger}`}
        >
          <span>{S.company.calendar.loadFailed(error)}</span>
          <Button size="sm" onClick={() => void load()}>
            {S.common.retry}
          </Button>
        </div>
      )}

      {events !== null && events.length === 0 && invalidFiles.length === 0 && !hintDismissed && (
        <div
          className={`mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${toneStrip.muted}`}
        >
          <span className="min-w-0 flex-1">{S.company.calendar.emptyHint}</span>
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            title={S.company.calendar.dismissHint}
            aria-label={S.company.calendar.dismissHint}
            onClick={() => {
              dismissHint(emptyHintKey);
              setHintDismissed(true);
            }}
          >
            <CloseIcon />
          </Button>
        </div>
      )}

      {events === null && error === null ? <CalendarSkeleton view={view} /> : grid}

      {invalidFiles.length > 0 && (
        <div className={`mt-4 rounded-md border px-3 py-2 text-xs ${toneStrip.danger}`}>
          <p className="mb-1 font-medium">{S.company.calendar.invalidFiles}</p>
          <ul className="space-y-0.5 font-mono">
            {invalidFiles.map((f) => (
              <li key={`${f.agentId}/${f.name}`}>
                {f.agentId}/{f.name}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Create / edit dialog: the scheduled-task form minus its target, the employee as a select. */}
      <Modal
        open={form !== null}
        title={
          form?.editing != null
            ? S.company.calendar.editTitle(form.name)
            : S.company.calendar.createTitle
        }
        onClose={() => setForm(null)}
        widthClass="sm:max-w-lg"
        footer={
          <>
            {form?.editing != null && (
              <Button
                size="sm"
                variant="danger"
                className="mr-auto"
                disabled={busy}
                onClick={() => setDeleting(form.editing)}
              >
                {S.company.calendar.delete}
              </Button>
            )}
            <Button size="sm" onClick={() => setForm(null)} disabled={busy}>
              {S.common.cancel}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => {
                if (validate()) setConfirmSave(true);
              }}
            >
              {form?.editing != null ? S.common.save : S.common.create}
            </Button>
          </>
        }
      >
        {form !== null && (
          <div className="space-y-3">
            {editingEvent !== undefined && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                {editingEvent.nextFireAt !== undefined && (
                  <span>
                    {S.company.calendar.nextFire}{" "}
                    <span className="font-mono tabular-nums">
                      {formatDateTime(editingEvent.nextFireAt)}
                    </span>
                  </span>
                )}
                {editingEvent.lastFiredAt !== undefined && (
                  <span className="inline-flex items-center gap-1">
                    {S.company.calendar.lastFired}{" "}
                    <span className="font-mono tabular-nums">
                      {formatDateTime(editingEvent.lastFiredAt)}
                    </span>
                    {editingEvent.lastOutcome !== undefined && (
                      <span className={toneInk[OUTCOME_TONE[editingEvent.lastOutcome]]}>
                        {S.company.calendarOutcomes[editingEvent.lastOutcome] ??
                          editingEvent.lastOutcome}
                      </span>
                    )}
                    {editingEvent.lastOutcome === "fired" && (
                      <button
                        type="button"
                        className="underline"
                        onClick={() => void openDesk(editingEvent.agentId)}
                      >
                        {S.company.openDesk}
                      </button>
                    )}
                  </span>
                )}
                {editingEvent.paused && (
                  <span className={toneInk.attention}>{S.company.calendar.pausedNote}</span>
                )}
                {editingEvent.invalidReason !== undefined && (
                  <span className={toneInk.danger}>{editingEvent.invalidReason}</span>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Select
                size="sm"
                label={S.company.calendar.employee}
                required
                value={form.agentId}
                disabled={form.editing !== null}
                {...(fieldErrors.agentId !== undefined ? { error: fieldErrors.agentId } : {})}
                onChange={(e) => set({ agentId: e.target.value })}
              >
                {employees.map((e) => (
                  <option key={e.agentId} value={e.agentId}>
                    {e.name}
                  </option>
                ))}
              </Select>
              <Input
                size="sm"
                label={S.company.calendar.name}
                required
                hint={S.company.calendar.nameHint}
                {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
                value={form.name}
                disabled={form.editing !== null}
                onChange={(e) => set({ name: e.target.value })}
                className="font-mono"
                placeholder="daily_sweep"
              />
            </div>
            <Input
              size="sm"
              label={S.common.name}
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
            />
            <Textarea
              label={S.company.calendar.prompt}
              required
              size="sm"
              rows={4}
              hint={S.company.calendar.promptHint}
              {...(fieldErrors.prompt !== undefined ? { error: fieldErrors.prompt } : {})}
              value={form.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
            />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input
                size="sm"
                label={S.company.calendar.startAt}
                required
                type="datetime-local"
                hint={S.company.calendar.staggerHint}
                {...(fieldErrors.startAt !== undefined ? { error: fieldErrors.startAt } : {})}
                value={form.startAt}
                onChange={(e) => set({ startAt: e.target.value })}
                className="font-mono"
              />
              <Input
                size="sm"
                label={S.company.calendar.period}
                value={form.period}
                hint={S.company.calendar.periodHint}
                onChange={(e) => set({ period: e.target.value })}
                className="font-mono"
                placeholder="1d"
              />
              <Input
                size="sm"
                label={S.company.calendar.endAt}
                type="datetime-local"
                value={form.endAt}
                onChange={(e) => set({ endAt: e.target.value })}
                className="font-mono"
              />
              <label className="flex items-center gap-2 self-end pb-1.5 text-xs text-gray-600 dark:text-gray-300">
                <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} />
                {S.company.calendar.enabled}
              </label>
            </div>
          </div>
        )}
      </Modal>
      <ConfirmModal
        open={confirmSave}
        title={S.common.confirmSaveTitle}
        tone="primary"
        confirmLabel={S.common.save}
        busy={busy}
        onClose={() => (busy ? undefined : setConfirmSave(false))}
        onConfirm={() => void save()}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {S.company.calendar.saveConfirm(form?.name ?? "")}
        </p>
      </ConfirmModal>
      <ConfirmModal
        open={deleting !== null}
        title={S.company.calendar.delete}
        confirmLabel={S.common.delete}
        busy={busy}
        onClose={() => (busy ? undefined : setDeleting(null))}
        onConfirm={() => void remove()}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {S.company.calendar.deleteConfirm(deleting?.name ?? "")}
        </p>
      </ConfirmModal>
    </OrgPage>
  );
}

/**
 * The chips a month cell could not fit, behind the count that stands for them. The count used
 * to be plain text inside a cell whose own click creates an event at 09:00, so reading "3 more"
 * opened the create dialog; it is a button now, it stops that click, and it opens the day
 * instead — every chip of it in time order, plus a link into the day view.
 *
 * The panel is portaled to document.body and placed by usePortalPanel, which also closes it on
 * an outside click, on Esc (captured, so an enclosing dialog stays open), and on a scroll or a
 * resize that moves the trigger. Portaled or not, a React event still travels the *React* tree,
 * so a click inside the panel would reach the day cell's create handler: the panel stops it at
 * its own root, and a chip closes the panel before opening its event.
 */
function DayOverflow({
  hidden,
  total,
  dateLabel,
  onOpenDay,
  children,
}: {
  /** How many chips the cell could not show — what the trigger counts. */
  hidden: number;
  /** How many the day holds in all — what the panel lists, and how tall it is expected to be. */
  total: number;
  /** The day the panel heads with, as the day view names it ("2026-09-08 Tue"). */
  dateLabel: string;
  onOpenDay: () => void;
  /** The day's chips; `close` puts the panel away as one of them opens its event. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { triggerRef, panelRef, position } = usePortalPanel({
    open,
    onClose: () => setOpen(false),
    // A chip row is 20px tall; the header and the panel's own padding add about 40.
    estimatedHeight: total * 22 + 40,
    panelWidth: DAY_PANEL_WIDTH,
  });
  const close = () => setOpen(false);
  const label = S.company.calendar.moreEventsExpand(hidden);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="block w-full rounded px-1 text-left text-[10px] text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
      >
        {S.company.calendar.moreEvents(hidden)}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="group"
            aria-label={dateLabel}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: position.topPx,
              bottom: position.bottomPx,
              left: position.left,
              width: DAY_PANEL_WIDTH,
            }}
            className="anim-pop z-[60] flex max-h-[70vh] max-w-[calc(100vw-2rem)] flex-col rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-2 py-1.5 dark:border-gray-800">
              <span className="truncate text-[11px] font-medium tabular-nums text-gray-700 dark:text-gray-200">
                {dateLabel}
              </span>
              <button
                type="button"
                onClick={() => {
                  close();
                  onOpenDay();
                }}
                className="shrink-0 text-[11px] text-gray-500 underline-offset-2 transition-colors duration-150 hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-gray-100"
              >
                {S.company.calendar.openDay}
              </button>
            </div>
            <div className="space-y-0.5 overflow-y-auto p-1">{children(close)}</div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** The grid's shape while the first fetch is out: the same frame, cells of placeholder instead of days. */
function CalendarSkeleton({ view }: { view: CalendarView }) {
  if (view === "month") {
    return (
      <div className="overflow-x-auto">
        <div className="min-w-[44rem] overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
          <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-800">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="px-2 py-2">
                <Skeleton className="h-3 w-8" />
              </div>
            ))}
          </div>
          {Array.from({ length: 5 }, (_, r) => (
            <div
              key={r}
              className="grid grid-cols-7 border-b border-gray-100 last:border-b-0 dark:border-gray-800"
            >
              {Array.from({ length: 7 }, (_, c) => (
                <div
                  key={c}
                  className="min-h-24 space-y-1 border-r border-gray-100 p-1.5 last:border-r-0 dark:border-gray-800"
                >
                  <Skeleton className="h-3 w-4" />
                  {(r + c) % 3 === 0 && <Skeleton className="h-4 w-full" />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
      <div className="flex gap-4 border-b border-gray-200 px-14 py-2 dark:border-gray-800">
        {Array.from({ length: view === "week" ? 7 : 1 }, (_, i) => (
          <Skeleton key={i} className="h-3 w-12" />
        ))}
      </div>
      <div className="space-y-px p-2" style={{ height: VISIBLE_HOURS * HOUR_PX }}>
        {Array.from({ length: VISIBLE_HOURS }, (_, i) => (
          <div key={i} className="flex items-start gap-3" style={{ height: HOUR_PX }}>
            <Skeleton className="h-2.5 w-8" />
            {i % 4 === 1 && <Skeleton className="h-5 w-40" />}
          </div>
        ))}
      </div>
    </div>
  );
}
