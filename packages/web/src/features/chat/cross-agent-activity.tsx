/**
 * Cross-agent activity for the agents dock: one chronological log of what a Task coordinated —
 * which agent ran which tool, what the parent said to a child, when a child session started, and
 * every Jev observation beside them.
 *
 * Three decisions this file exists to enforce, each of them a bug it was rewritten for:
 *
 * - SCOPE IS FIXED. The log always walks the displayed Task's tree from the root. The selected
 *   child is highlighted, never used to filter, because a tab whose contents change meaning when
 *   you click a different node is two different tabs under one name.
 * - ORDER IS DOCUMENT ORDER. Tool cards carry no single timestamp; deriving one from three
 *   different clocks and then sorting on it produced a non-transitive comparator, so the sort
 *   compared only the arrival order the walk already produced, with the timestamp as a
 *   tiebreaker for rows that share one.
 * - NOTHING HERE DECIDES ANYTHING. A policy-blocked call reads as blocked, an approval reads as
 *   the approval it was, and an advisory reads as an observation. The approval callback and the
 *   command policy are the authority and they are rendered on the tool cards themselves.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { S } from "../../lib/strings";
import { formatMessageTime, humanizeDuration } from "../../lib/format";
import { useLocale } from "../../state/locale";
import { EmptyState } from "../../components/ui/empty-state";
import { JevAdvisoryNote } from "./jev-advisory-note";
import { toneDot, toneInk } from "../../lib/tone";
import type { ChatItem, JevAdvisory, StreamModel, ToolCallItem } from "../../lib/omni/stream-model";
import { shortSessionId } from "./agent-topology";

/** Rows rendered before the list is windowed. Past this a Task's log is history, not signal. */
export const ACTIVITY_WINDOW = 200;

interface RowBase {
  id: string;
  /** The session that produced the row (the walker), so a row is never attributed to its subject. */
  walkerId: string;
  /** The session the row is ABOUT: a child session row names the child, everything else the walker. */
  subjectId: string;
  depth: number;
  atMs?: number;
  /** Arrival order within the walk: the only total ordering available for every row. */
  order: number;
}

export type CoordinationActivityRow =
  | (RowBase & { kind: "advisory"; advisory: JevAdvisory; agent: string })
  | (RowBase & { kind: "tool"; item: ToolCallItem; agent: string })
  | (RowBase & { kind: "message"; role: "parent" | "you" | "child"; text: string; agent: string })
  | (RowBase & { kind: "child"; label: string; agent: string })
  // The rest of the coordination story. A log that shows only successes and messages loses
  // exactly the events a reader opens this panel FOR: a child that died, a request that had to
  // be retried, a run that was aborted. Each is a one-line row, not a transcript.
  | (RowBase & { kind: "error"; detail: string; agent: string })
  | (RowBase & { kind: "retry"; attempt: number; status: string; gaveUp: boolean; agent: string })
  | (RowBase & { kind: "abort"; detail: string; agent: string });

/**
 * The one stamp a row can honestly carry. A tool call has three clocks (argument generation,
 * approval, execution); the call's start is when the reader saw it appear, so that is the one
 * shown, and it is never mixed with a clock that means something else.
 */
function toolStamp(item: ToolCallItem): number | undefined {
  return item.callStartedAtMs ?? item.approvalAtMs ?? item.argStartedAtMs;
}

/**
 * Cached view of a model's coordination activity, rebuilt only when the underlying model tree
 * actually changes.
 *
 * WHY THIS EXISTS. `StreamModel.items` mutates in place and the version counter is throttled to
 * roughly 8 updates a second, so a component that recomputed on every version re-walked every
 * item of every bound descendant model ~8 times a second for the whole life of a Task — and the
 * Activity view is a `role="log"` that is kept mounted even while hidden. For a long Task that is
 * the most expensive thing in the panel and it happens off screen.
 *
 * The walk itself is cheap per item, so the fix is not a faster walk: it is walking LESS. The
 * per-item `atMs` and the `tool_call` objects are stable, so the row built for a given item is
 * stable too. A row is rebuilt only when the item it came from gains a timestamp (which happens
 * once, as a streamed call settles) or when the item's advisory binds; everything else is served
 * from the previous result. The previous result is kept per (model, session id) in a WeakMap, so
 * a tree that is re-walked keeps the rows it already built.
 */
interface CachedActivity {
  readonly rows: CoordinationActivityRow[];
  /** A signature of everything a row can depend on, so a stale hit is impossible. */
  readonly signature: string;
}

const activityCache = new WeakMap<StreamModel, Map<string, CachedActivity>>();

/**
 * A signature of the tree covering every way a row's content can change.
 *
 * An item id is not enough, and the first version of this proved it: binding an advisory to a
 * card adds NO item, so an id-based guard served rows from before the observation existed. The
 * four numbers below are what actually matter — how many items exist, how many carry a bound
 * advisory, how many tool cards have settled (which is what fills in a row's timestamp), and the
 * sum of those stamps. Appends change the counts, an advisory changes the advisory count, and a
 * settling card raises the sum, so a matching signature means nothing a row reads has moved.
 *
 * It is one allocation-free pass over the arrays the walk already has to touch, which is a very
 * different cost from building and sorting every row eight times a second.
 */
/** Numeric codes for the sender vocabulary, so the signature fold stays numeric. */
const SENDER_CODES = new Map<string, number>([
  ["user", 1],
  ["parent_agent", 2],
  ["harness", 3],
  ["server", 4],
]);

function activitySignature(model: StreamModel): string {
  // A rolling fold, not aggregates. The first version counted items, advisories and settled
  // calls and summed their stamps — and two DIFFERENT trees can share all four: a run where one
  // call settles twice could match one where two calls settle once. A cache guard that can be
  // fooled into serving a stale log is worse than no cache, so every item contributes its own
  // identity and everything a row copies out of it.
  //
  // FNV-1a, 32-bit. This is a cache key, not a security hash: the only consequence of a collision
  // is a stale row, and folding per-item identity makes that as unlikely as any other hash.
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  };
  const text = (value: string): void => {
    mix(value.length);
    // Length alone would collide on any two messages of equal length; the first and last
    // characters catch the common substitutions without hashing the whole string.
    mix(value.charCodeAt(0));
    mix(value.charCodeAt(value.length - 1));
  };

  const seen = new Set<StreamModel>();
  const walk = (current: StreamModel): void => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const item of current.items) {
      mix(item.id);
      mix(item.kind.length);
      text(item.kind);
      const atMs = stampOf(item);
      mix(atMs ?? -1);
      if (item.kind === "tool_call") {
        // The three fields a tool row copies out of the card, plus enough of the advisory to tell
        // a REPLACEMENT from the original: two advisories that agree on status, choice and
        // timestamp render identically, so treating them as one is not a staleness bug.
        mix(item.callStartedAtMs ?? -1);
        mix(item.approvalAtMs ?? -1);
        mix(item.argStartedAtMs ?? -1);
        mix(item.advisory === undefined ? 0 : 1);
        if (item.advisory !== undefined) {
          text(item.advisory.status);
          text(item.advisory.choice);
          mix(item.advisory.atMs ?? -1);
        }
      }
      if (item.kind === "user_text" || item.kind === "user_steering") {
        text(item.text);
        // The sender decides a row's ROLE, so it is part of the row's identity — but it is a
        // string, and the fold takes numbers.
        const sender = "sender" in item ? item.sender : undefined;
        mix(sender === undefined ? 0 : (SENDER_CODES.get(sender) ?? -1));
      }
    }
    for (const [childId, childModel] of current.subagents) {
      text(childId);
      walk(childModel);
    }
  };
  walk(model);
  return hash.toString(36);
}

/** The activity rows for a model tree, reusing the rows a previous walk already built. */
export function coordinationActivityFor(
  rootModel: StreamModel,
  rootSessionId: string,
  agentFor: (sessionId: string) => string,
): CoordinationActivityRow[] {
  const previous = activityCache.get(rootModel) ?? new Map<string, CachedActivity>();
  activityCache.set(rootModel, previous);
  const signature = activitySignature(rootModel);
  const cached = previous.get(rootSessionId);
  if (cached !== undefined && cached.signature === signature) return cached.rows;

  const rows = collectCoordinationActivity(rootModel, rootSessionId, agentFor, cached?.rows);
  previous.set(rootSessionId, { rows, signature });
  return rows;
}

/**
 * One pass over the Task's already-bound models.
 *
 * `rootModel` and `rootSessionId` are a PAIR: the id must be the session `rootModel` belongs to,
 * because a StreamModel does not carry its own id and nothing here can check the pairing. The
 * panel always passes the conversation's own model and id, which is what makes the log's scope
 * independent of which node is selected.
 *
 * `reuse` is the previous row list. An item that produced the same row last time keeps it: the
 * row holds references to the item, not a copy of it, so a cached row renders live data with no
 * staleness — what it cannot do is notice an item that GAINED a timestamp after the first walk,
 * and those are re-derived.
 *
 * Nested models are walked in place rather than reconstructed: the collector walks the same
 * arrays the reducer appended to, so arrival order IS chronological order and no timestamp
 * comparison is needed to restore it.
 */
export function collectCoordinationActivity(
  rootModel: StreamModel,
  rootSessionId: string,
  agentFor: (sessionId: string) => string,
  reuse?: readonly CoordinationActivityRow[],
): CoordinationActivityRow[] {
  // A row's `id` is `${sessionId}:${itemId}:${kind}` — exactly the key the lookup below wants,
  // so the previous list indexes into itself with no extra field on the row type.
  const byItem = new Map<string, CoordinationActivityRow>();
  if (reuse !== undefined) {
    for (const row of reuse) byItem.set(row.id, row);
  }

  const rows: CoordinationActivityRow[] = [];
  const seen = new Set<string>();
  let order = 0;

  const walk = (current: StreamModel, sessionId: string, depth: number): void => {
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    const agent = agentFor(sessionId);
    for (const item of current.items) {
      const base = (kind: string, subjectId: string, atMs?: number): RowBase => ({
        id: `${sessionId}:${item.id}:${kind}`,
        walkerId: sessionId,
        subjectId,
        depth,
        order: order++,
        ...(atMs !== undefined ? { atMs } : {}),
      });
      switch (item.kind) {
        case "tool_call": {
          // The advisory is a property of this call, so it is its own row here and the same
          // object renders on the card: one observation, one reading, two views.
          if (item.advisory !== undefined) {
            const key = `${sessionId}:${item.id}:advisory`;
            const atMs = item.advisory.atMs;
            rows.push(
              reusable(byItem, key, atMs) ?? {
                ...base("advisory", sessionId, atMs),
                kind: "advisory",
                advisory: item.advisory,
                agent,
              },
            );
          }
          const toolKey = `${sessionId}:${item.id}:tool`;
          const toolAt = toolStamp(item);
          rows.push(
            reusable(byItem, toolKey, toolAt) ?? {
              ...base("tool", sessionId, toolAt),
              kind: "tool",
              item,
              agent,
            },
          );
          break;
        }
        case "user_steering":
        case "user_text": {
          // WHO SAID WHAT TO WHOM, both directions. `sender` names the speaker when core knows
          // it: `parent_agent` is the parent interjecting, `harness`/`server` are the system.
          // Only the parent half appeared before, which made a child that was ANSWERING a
          // steering message look as though it had said nothing at all.
          const sender = "sender" in item ? item.sender : undefined;
          if (sender !== undefined && sender !== "user" && sender !== "parent_agent") break;
          const isRoot = sessionId === rootSessionId;
          const role: "parent" | "you" | "child" =
            sender === "parent_agent" ? "parent" : isRoot ? "you" : "child";
          const messageKey = `${sessionId}:${item.id}:message`;
          const messageAt = stampOf(item);
          rows.push(
            reusable(byItem, messageKey, messageAt) ?? {
              ...base("message", sessionId, messageAt),
              kind: "message",
              role,
              text: item.text,
              agent,
            },
          );
          break;
        }
        case "llm_error": {
          // A child's provider failure is the single most important thing this panel can say and
          // it used to be invisible. The provider's own text is NOT copied here: the stream
          // renders it verbatim in the conversation, and a log row is a place it would persist.
          const code = item.errorCode;
          rows.push(
            reusable(byItem, `${sessionId}:${item.id}:error`, stampOf(item)) ?? {
              ...base("error", sessionId, stampOf(item)),
              kind: "error",
              detail: code ?? "error",
              agent,
            },
          );
          break;
        }
        case "reconnect": {
          const key = `${sessionId}:${item.id}:retry`;
          const at = stampOf(item);
          rows.push(
            reusable(byItem, key, at) ?? {
              ...base("retry", sessionId, at),
              kind: "retry",
              attempt: item.attempt,
              status: item.status,
              gaveUp: item.gaveUp === true,
              agent,
            },
          );
          break;
        }
        case "abort": {
          rows.push(
            reusable(byItem, `${sessionId}:${item.id}:abort`, stampOf(item)) ?? {
              ...base("abort", sessionId, stampOf(item)),
              kind: "abort",
              // The machine-readable cause only. A raw provider error string can carry a URL,
              // a token fragment or a customer identifier, and this row outlives the banner.
              detail: item.errorCode ?? "abort",
              agent,
            },
          );
          break;
        }
        case "subagent":
          const childKey = `${sessionId}:${item.id}:child`;
          const childAt = stampOf(item);
          rows.push(
            reusable(byItem, childKey, childAt) ?? {
              ...base("child", item.sessionId, childAt),
              kind: "child",
              subjectId: item.sessionId,
              label: shortSessionId(item.sessionId),
              agent,
            },
          );
          break;
        default:
          break;
      }
    }
    for (const [childId, childModel] of current.subagents) walk(childModel, childId, depth + 1);
  };
  walk(rootModel, rootSessionId, 0);

  // Arrival order is the ordering. The timestamp only separates rows that share one, so the
  // comparator is a total order and cannot disagree with itself.
  return rows.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return (a.atMs ?? 0) - (b.atMs ?? 0);
  });
}

/**
 * A previous row for this key, when nothing it copied has changed.
 *
 * A row holds REFERENCES to the tool card and the advisory object, not copies, so a reused row
 * renders live data — a card that has since gained its output, or an advisory that has since
 * been refined, shows through without the row being rebuilt. The one field copied BY VALUE is
 * `atMs`, which a streamed call fills in once as it settles. So the timestamp is the only staleness
 * check needed, and the row's own `id` is the key.
 */
function reusable(
  byItem: Map<string, CoordinationActivityRow>,
  key: string,
  atMs: number | undefined,
): CoordinationActivityRow | null {
  const prior = byItem.get(key);
  if (prior === undefined) return null;
  if (prior.atMs !== atMs) return null;
  return prior;
}

function stampOf(item: ChatItem): number | undefined {
  return "atMs" in item && typeof item.atMs === "number" ? item.atMs : undefined;
}

/**
 * What actually happened to the call. `forbidden` is the command policy refusing it, which is
 * not a completion and not a denial by the user — the one case a naive map reported as
 * "completed", because a policy-blocked call still emits an output message.
 */
export function toolOutcome(item: ToolCallItem): { text: string; tone: keyof typeof toneDot } {
  if (item.decision === "forbidden") {
    return { text: `${S.chat.decisionPolicy} · ${S.chat.decisionDeny}`, tone: "danger" };
  }
  if (item.decision === "deny") {
    const who = item.decisionSource === "manual" ? S.chat.decisionManual : S.chat.decisionAuto;
    return { text: `${S.chat.decisionDeny} · ${who}`, tone: "danger" };
  }
  if (item.decision === "allow") {
    const who = item.decisionSource === "manual" ? S.chat.decisionManual : S.chat.decisionAuto;
    return { text: `${S.chat.decisionAllow} · ${who}`, tone: "success" };
  }
  if (!item.outputComplete) return { text: S.coordination.toolRunning, tone: "busy" };
  if (item.output === "") return { text: S.chat.approvalWaiting, tone: "attention" };
  return { text: S.coordination.toolDone, tone: "success" };
}

const ActivityRow = memo(function ActivityRow({
  row,
  selected,
  onSelect,
}: {
  row: CoordinationActivityRow;
  selected: boolean;
  onSelect: (sessionId: string) => void;
}) {
  const { locale } = useLocale();
  const time = row.atMs === undefined ? null : formatMessageTime(row.atMs, locale);
  // Depth is indentation, the structure an SVG cannot hand a screen reader. 16px a level, with
  // a guide rule so a deep chain still reads as a chain.
  const indent = { paddingLeft: `${row.depth * 16 + 12}px` };

  if (row.kind === "advisory") {
    return (
      <li className="list-none">
        <div
          className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/60"
          style={indent}
        >
          <JevAdvisoryNote advisory={row.advisory} />
        </div>
      </li>
    );
  }

  const outcome = row.kind === "tool" ? toolOutcome(row.item) : null;
  const highlight = selected ? "bg-gray-50 dark:bg-gray-800/40" : "";

  return (
    <li className="list-none">
      <div
        className={`flex min-w-0 items-start gap-2 border-b border-gray-100 py-1.5 last:border-b-0 dark:border-gray-800/60 ${highlight}`}
        style={indent}
      >
        {row.kind === "tool" && outcome !== null && (
          <span
            aria-hidden
            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${toneDot[outcome.tone]}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {row.kind === "tool" && `${S.coordination.toolActivity} ${row.item.name}`}
              {row.kind === "error" && S.coordination.agentFailed}
              {row.kind === "retry" && S.coordination.retried}
              {row.kind === "abort" && S.coordination.aborted}
              {row.kind === "message" &&
                (row.role === "parent"
                  ? S.coordination.parentMessage
                  : row.role === "you"
                    ? S.coordination.yourMessage
                    : S.coordination.childMessage)}
              {row.kind === "child" && `${S.coordination.childSession} ${row.label}`}
            </span>
            {/* Which agent did it. A log whose subject is cross-agent activity that never names
                an agent is a transcript with extra steps. */}
            <span className="min-w-0 truncate text-[10px] text-gray-500 dark:text-gray-400">
              {row.agent}
            </span>
            <span className="min-w-0 flex-1" />
            {time !== null && (
              <time className="shrink-0 font-mono text-[10px] text-gray-500 dark:text-gray-500">
                {time}
              </time>
            )}
          </p>
          {row.kind === "tool" && outcome !== null && (
            <p className={`mt-0.5 text-[11px] ${toneInk[outcome.tone]}`}>
              {outcome.text}
              {row.item.durationMs !== undefined && (
                <span className="text-gray-500 dark:text-gray-400">
                  {" · "}
                  {humanizeDuration(row.item.durationMs, { compact: true })}
                </span>
              )}
            </p>
          )}
          {row.kind === "message" && (
            // The message itself, indented and quoted: this log exists to show the exchange
            // between agents, and a row that only says "parent-agent message" hid the words
            // that explain every decision after it.
            <p className="mt-0.5 whitespace-pre-wrap break-words border-l-2 border-gray-200 pl-2 text-[11px] leading-4 text-gray-700 dark:border-gray-700 dark:text-gray-200">
              {row.text}
            </p>
          )}
          {(row.kind === "error" || row.kind === "abort" || row.kind === "retry") && (
            // One line, tone-matched to severity, carrying the machine-readable cause only.
            // A reader learns that an agent failed and roughly why; the provider's own wording
            // stays in the conversation, where it is rendered once and not persisted here.
            <p
              className={`mt-0.5 text-[11px] ${
                row.kind === "retry" && !row.gaveUp
                  ? toneInk.attention
                  : row.kind === "error"
                    ? toneInk.danger
                    : toneInk.danger
              }`}
            >
              {row.kind === "retry"
                ? row.gaveUp
                  ? S.coordination.retryGaveUp(row.attempt)
                  : S.coordination.retrying(row.attempt)
                : `${row.detail}`}
            </p>
          )}
          {row.kind === "child" && (
            <button
              type="button"
              onClick={() => onSelect(row.subjectId)}
              className="mt-0.5 text-[11px] text-brand-600 underline-offset-2 hover:underline dark:text-brand-300"
            >
              {S.subagentPanel.openAsSession}
            </button>
          )}
        </div>
      </div>
    </li>
  );
});

export function CoordinationActivity({
  model,
  sessionId,
  version,
  agentFor,
  selectedId,
  onSelect,
}: {
  model: StreamModel;
  sessionId: string;
  /** Stream version: the model mutates in place, so this is its repaint signal. */
  version: number;
  /** Display name for a session's agent, for the row attribution. */
  agentFor: (sessionId: string) => string;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const all = useMemo(
    () => coordinationActivityFor(model, sessionId, agentFor),
    // model.items mutates in place; version is the authoritative repaint signal. The memo is
    // keyed on version because that is the only signal that FIRES on a mutation — the cached
    // walk then notices whether anything actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, sessionId, version, agentFor],
  );
  const windowed = all.length > ACTIVITY_WINDOW;
  const rows = windowed ? all.slice(all.length - ACTIVITY_WINDOW) : all;

  // A reader who has scrolled up to read an old exchange must not be yanked back to the live
  // tail by the next event. The list stops auto-following the moment they leave it, and a control
  // offers the way back — the alternative is a log that is impossible to read while it is live.
  const [following, setFollowing] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (following && list !== null) list.scrollTop = list.scrollHeight;
  }, [rows.length, following]);
  const awayFromTail = rows.length > 0 && following === false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Printed ONCE per view, not once per advisory: the reader's takeaway does not change
          with the number of observations above it. */}
      <p className="shrink-0 border-b border-gray-100 px-3 py-1.5 text-[10px] leading-4 text-gray-500 dark:border-gray-800/60 dark:text-gray-400">
        {S.coordination.advisoryOnly}
      </p>
      {rows.length === 0 ? (
        <div className="min-h-0 flex-1">
          <EmptyState title={S.coordination.empty} />
        </div>
      ) : (
        <>
          <ol
            ref={listRef}
            // The live region is correct here only because the parent keeps this view MOUNTED
            // while the other is shown: a region that mounts with its whole history already
            // inside reads all of it aloud, on every switch. Kept mounted, only appended rows
            // are announced.
            role="log"
            aria-live="polite"
            aria-label={S.coordination.activityTitle}
            className="min-h-0 flex-1 overflow-y-auto px-0 py-0"
            data-testid="coordination-activity"
            // Scrolling away from the bottom is the signal; the button below is the way back.
            onScroll={(event) => {
              const list = event.currentTarget;
              const atTail = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
              setFollowing(atTail);
            }}
          >
            {windowed && (
              <li className="list-none px-3 py-1.5 text-[10px] text-gray-500 dark:text-gray-400">
                {S.coordination.olderRowsHidden(all.length - ACTIVITY_WINDOW)}
              </li>
            )}
            {rows.map((row) => (
              <ActivityRow
                key={row.id}
                row={row}
                selected={row.subjectId === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ol>
          {/* Only while the reader is away from the tail, so the control does not sit permanently
              over the newest row in a log nobody is reading from the top. */}
          {awayFromTail && (
            <div className="flex shrink-0 justify-center border-t border-gray-100 py-1 dark:border-gray-800/60">
              <button
                type="button"
                onClick={() => setFollowing(true)}
                className="rounded px-2 py-0.5 text-[11px] text-brand-600 transition-colors duration-150 hover:bg-gray-50 dark:text-brand-300 dark:hover:bg-gray-800/60"
              >
                {S.coordination.jumpToLatest}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
