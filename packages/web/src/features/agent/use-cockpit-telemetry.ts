/** Project-scoped live telemetry, with acknowledged REST commands and polling fallback. */
import { useEffect, useRef, useState, useCallback } from "react";
import type { SwarmAgentNode, SwarmEdge } from "./agent-cockpit.js";

export interface LiveTurnSummary {
  turnId: string;
  terminalSeq: number;
  status: "queued" | "running" | "completed" | "interrupted" | "failed";
  durationMs: number;
  outcome?: string;
  streamRecords: number;
}

export interface LiveMailboxEntry {
  agentName: string;
  queueDepth: number;
  pendingReplies: number;
  leaseState: "acquired" | "idle" | "expired";
  leaseRemainingSec?: number;
}

/** Existing swarm events folded for the timeline; task starts do not confirm delivery. */
export interface LiveHandoffEvent {
  messageId: string;
  source?: "task_started";
  taskId?: string;
  from: string;
  to: string;
  content?: string;
  timestamp: number;
}

/** Only alerts observed on this project's live stream; snapshots contain no loop history. */
export interface LiveLoopEvent {
  id: string;
  taskId: string;
  agentId?: string;
  timestamp: number;
  message: string;
}

export const LOOP_EVENT_LIMIT = 50;

/**
 * How far this connection is from the server's truth.
 *
 * The state exists because the alternative failure is invisible. A client that drops and
 * reconnects gets a fresh snapshot but NOT the events it missed during the gap — the loop
 * alerts and handoffs are built only from deltas, and a snapshot carries no event history. So
 * a client that quietly resumed would show a feed that is missing a stretch and look
 * completely healthy. `behind` is the honest report of exactly that.
 */
export type CockpitStreamState =
  /** Connected, and the cursor accounts for every event this server has published. */
  | "live"
  /** No connection yet, or a reconnect is in flight. */
  | "connecting"
  /** Connected and applying a snapshot/backlog; not yet reconciled. */
  | "resyncing"
  /**
   * Connected, but the server's bounded replay window no longer reaches back to this client's
   * cursor, so some events were lost permanently. The snapshot that followed reconciles the
   * tree; the delta-built feeds (loop alerts, handoffs) are known to have a hole in them.
   */
  | "behind";

/**
 * A per-hook-instance decorrelating salt.
 *
 * The house backoff idiom is `pseudoRandom(seed, salt)` in core's research budget: an
 * avalanche mixer, used there to make a retry schedule REPRODUCIBLE across runs, which is
 * why its seed there is a retry counter. That property is exactly wrong for this use and so is
 * the other house helper, `getRandomBackoffMinutes` in core's task watchdog (server-side, and
 * quantised to whole minutes). What reconnect decorrelation needs is for two clients that
 * dropped at the same instant to pick different delays, so the seed is random per hook
 * instance and the mixer constants are the house ones.
 */
function decorrelatingSalt(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

/** The house avalanche mixer (core `agent/research/research-budget.ts`), used on a client salt. */
function jitterValue(seed: number, salt: number): number {
  let value = (seed * 0x9e37_79b9 + salt * 0x85eb_ca6b) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb_352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846c_a68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_296;
}

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;

/**
 * Reconnect delay for attempt `attempt`, with full jitter.
 *
 * Full jitter — a uniform draw from `[0, ceiling]` — rather than the house helper's
 * symmetric `±25%` band, because a symmetric band does not decorrelate: it still centres every
 * client on the same instant, which is the herd. Drawing from zero is what actually spreads a
 * fleet that dropped together, and the exponential ceiling stops a client that is genuinely
 * down from hammering the server forever. A client that reconnects successfully resets the
 * attempt count, so this is a per-outage backoff rather than a lifetime one.
 */
export function reconnectDelayMs(attempt: number, salt: number): number {
  // The attempt is clamped to a finite integer BEFORE it is used as an exponent. A NaN here
  // propagates all the way out (`Math.min(NaN, 16)` is NaN, `2 ** NaN` is NaN), and
  // `setTimeout(NaN)` fires immediately — so a non-finite counter would turn the backoff
  // into a hot reconnect loop, which is the exact failure this whole mechanism prevents.
  const raw = Number.isFinite(attempt) ? Math.floor(attempt) : 0;
  const exponent = Math.max(0, Math.min(raw, 16));
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** exponent);
  const drawn = jitterValue(exponent + 1, Number.isFinite(salt) ? salt >>> 0 : 0);
  return Math.round(drawn * ceiling);
}

/** How far along the stream one client is, and whether that distance is complete. */
export interface StreamProgress {
  streamState: CockpitStreamState;
  missedEvents: number | null;
  cursor: number | null;
}

/**
 * Folds one server message into the client's stream progress. Pure, so the resume state
 * machine is testable without a DOM and — more importantly — so there is exactly one place
 * where "am I behind?" is decided, rather than a rule restated in each branch of a
 * WebSocket handler.
 *
 * The rules, in order of precedence:
 * - a `cockpit_stream_gap` is terminal for this connection's honesty: the server could not
 *   replay back to where this client was, so the delta-built feeds have a permanent hole and
 *   the state says so until the client reconnects again;
 * - a `cockpit_resume` means the backlog was fully delivered, so the client is live and has
 *   missed nothing on this connection;
 * - a `cockpit_init` reconciles against server truth, which also means "current through here".
 * Anything else is a delta: it advances the cursor and changes nothing else. A delta arriving
 * while `behind` does NOT clear the flag — the lost stretch cannot be un-lost by events that
 * come after it.
 */
export function applyStreamMessage(progress: StreamProgress, msg: unknown): StreamProgress {
  const record = (msg ?? {}) as {
    type?: unknown;
    seq?: unknown;
    cursor?: unknown;
    missed?: unknown;
  };
  const isSeq = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  // `seq` is the stream's own stamp and is authoritative. `cursor` is what the two resume
  // messages report, and it is NOT interchangeable with `seq`: the server sends
  // `cockpit_stream_gap` and `cockpit_resume` with a `cursor` field, and reading only `seq`
  // would leave the client holding its pre-resume cursor and asking for the same unreachable
  // window on every subsequent reconnect — a permanent gap loop.
  const cursor = isSeq(record.seq)
    ? record.seq
    : isSeq(record.cursor)
      ? record.cursor
      : progress.cursor;
  const isSnapshotOrControl =
    record.type === "cockpit_init" ||
    record.type === "cockpit_resume" ||
    record.type === "cockpit_stream_gap";
  if (
    !isSnapshotOrControl &&
    progress.cursor !== null &&
    isSeq(record.seq) &&
    record.seq > progress.cursor + 1 &&
    progress.streamState !== "behind"
  ) {
    // Preserve the last contiguous cursor. The hook closes this socket and reconnects from
    // here so the server can replay the missing stretch instead of advancing past the hole.
    return {
      streamState: "behind",
      missedEvents: record.seq - progress.cursor - 1,
      cursor: progress.cursor,
    };
  }
  if (record.type === "cockpit_stream_gap") {
    return {
      streamState: "behind",
      // A number the server could state, or null for "unknown" — which is a different claim
      // from zero and must not be rendered as "nothing was missed".
      missedEvents:
        typeof record.missed === "number" && Number.isFinite(record.missed) ? record.missed : null,
      cursor,
    };
  }
  if (record.type === "cockpit_resume") {
    return { streamState: "live", missedEvents: 0, cursor };
  }
  if (record.type === "cockpit_init") {
    // A snapshot repairs current state, but it cannot recreate alerts or handoffs built
    // from events that fell out of the replay window. The server sends this after a gap.
    return progress.streamState === "behind"
      ? { ...progress, cursor }
      : { streamState: "live", missedEvents: 0, cursor };
  }
  // Referential stability when nothing moved, so the caller can skip a render on the many
  // unsequenced frames a stream produces.
  return cursor === progress.cursor ? progress : { ...progress, cursor };
}

export function retainLoopEvent(events: LiveLoopEvent[], value: unknown): LiveLoopEvent[] {
  if (!value || typeof value !== "object") return events;
  if (
    !("type" in value) ||
    value.type !== "loop_detected" ||
    !("taskId" in value) ||
    typeof value.taskId !== "string" ||
    !value.taskId.trim() ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    Math.abs(value.timestamp) > 8.64e15 ||
    !("payload" in value) ||
    !value.payload ||
    typeof value.payload !== "object" ||
    !("message" in value.payload) ||
    typeof value.payload.message !== "string" ||
    !value.payload.message.trim()
  )
    return events;
  const agentId =
    "agentId" in value && typeof value.agentId === "string" && value.agentId.trim()
      ? value.agentId
      : undefined;
  const event: LiveLoopEvent = {
    id: JSON.stringify([value.taskId, agentId, value.timestamp, value.payload.message]),
    taskId: value.taskId,
    agentId,
    timestamp: value.timestamp,
    message: value.payload.message,
  };
  if (events.some((existing) => existing.id === event.id)) return events;
  return [event, ...events].slice(0, LOOP_EVENT_LIMIT);
}

export interface KeyFleetProvider {
  provider: string;
  status: "active" | "cooldown" | "error";
  latencyMs: number;
  cooldownSec: number;
}

export interface CockpitTelemetryState {
  connected: boolean;
  transport: "ws" | "http" | "connecting" | "offline";
  /**
   * Whether this client's view of the stream is complete. See {@link CockpitStreamState};
   * `behind` is the one an operator needs to see, because it is the only state in which the
   * delta-built feeds are known to be incomplete rather than merely possibly so.
   */
  streamState: CockpitStreamState;
  /**
   * How many stream events this client missed, or null when the server could not state a
   * number (a cursor from a previous server process, or one that was never issued). null means
   * "unknown", which is a different claim from 0 and is rendered as such.
   */
  missedEvents: number | null;
  /** The server sequence number this client has applied through, or null before the first one. */
  cursor: number | null;
  activeTaskId: string | null;
  swarmAgents: SwarmAgentNode[];
  swarmEdges: SwarmEdge[];
  turnSummaries: LiveTurnSummary[];
  mailboxEntries: LiveMailboxEntry[];
  handoffs: LiveHandoffEvent[];
  loopEvents: LiveLoopEvent[];
  keyFleet: { healthy: boolean; activeCount: number; providers: KeyFleetProvider[] };
  lastEventTime: number | null;
  isDispatching: boolean;
  error: string | null;
  triggerTask: (goal: string, files?: string[]) => Promise<boolean>;
  dispatchDirective: (to: string, content: string, from?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

type Telemetry = Omit<CockpitTelemetryState, "triggerTask" | "dispatchDirective" | "refresh">;
interface MailboxSummary {
  queueDepth?: number;
  pendingReplyCount?: number;
  lease?: { leaseState?: LiveMailboxEntry["leaseState"]; expiresAt?: number };
}
interface Snapshot {
  swarm?: { agents?: SwarmAgentNode[]; edges?: SwarmEdge[] };
  mailbox?: Record<string, MailboxSummary>;
  replay?: {
    events?: Array<{
      kind?: string;
      status?: LiveTurnSummary["status"];
      turnId?: string;
      seq: number;
      payload?: string | { durationMs?: number; outcome?: string; recordCount?: number };
    }>;
  };
  keyFleet?: Telemetry["keyFleet"];
}
interface ProjectScope {
  projectId: string;
  abort: AbortController;
  socket: WebSocket | null;
  refresh: () => Promise<void>;
  dispatching: boolean;
}

function emptyTelemetry(projectId: string | null): Telemetry {
  return {
    connected: false,
    transport: projectId ? "connecting" : "offline",
    streamState: projectId ? "connecting" : "connecting",
    missedEvents: 0,
    cursor: null,
    activeTaskId: null,
    swarmAgents: [],
    swarmEdges: [],
    turnSummaries: [],
    mailboxEntries: [],
    handoffs: [],
    loopEvents: [],
    keyFleet: { healthy: false, activeCount: 0, providers: [] },
    lastEventTime: null,
    isDispatching: false,
    error: null,
  };
}

function mailboxEntries(mailbox: Record<string, MailboxSummary>): LiveMailboxEntry[] {
  return Object.entries(mailbox).map(([agentName, summary]) => ({
    agentName,
    queueDepth: summary.queueDepth ?? 0,
    pendingReplies: summary.pendingReplyCount ?? 0,
    leaseState: summary.lease?.leaseState ?? "idle",
    leaseRemainingSec: summary.lease?.expiresAt
      ? Math.max(0, Math.round((summary.lease.expiresAt - Date.now()) / 1000))
      : undefined,
  }));
}

function snapshotPatch(data: Snapshot): Partial<Telemetry> {
  const patch: Partial<Telemetry> = { lastEventTime: Date.now() };
  if (data.swarm?.agents) patch.swarmAgents = data.swarm.agents;
  if (data.swarm?.edges) patch.swarmEdges = data.swarm.edges;
  if (data.mailbox) patch.mailboxEntries = mailboxEntries(data.mailbox);
  if (data.keyFleet) patch.keyFleet = data.keyFleet;
  if (data.replay?.events) {
    patch.turnSummaries = data.replay.events
      .filter(
        (ev) => ev.kind === "turn_done" || ev.status === "completed" || ev.status === "failed",
      )
      .map((ev) => {
        const payload = typeof ev.payload === "object" ? ev.payload : undefined;
        return {
          turnId: ev.turnId ?? `turn-${ev.seq}`,
          terminalSeq: ev.seq,
          status: ev.status ?? "completed",
          durationMs: payload?.durationMs ?? 0,
          outcome: typeof ev.payload === "string" ? ev.payload : payload?.outcome,
          streamRecords: payload?.recordCount ?? 0,
        };
      });
  }
  return patch;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "message" in value) {
    return errorMessage(value.message, fallback);
  }
  return fallback;
}

async function readResponse(res: Response) {
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) {
    throw new Error(errorMessage(json?.error, `Request failed (HTTP ${res.status})`));
  }
  if (!json || typeof json !== "object") throw new Error("Invalid cockpit response");
  return json;
}

export function useCockpitTelemetry(
  projectId: string | null = null,
  _sessionId = "default-session",
): CockpitTelemetryState {
  const [state, setState] = useState(() => ({ projectId, ...emptyTelemetry(projectId) }));
  const scopeRef = useRef<ProjectScope | null>(null);

  useEffect(() => {
    setState({ projectId, ...emptyTelemetry(projectId) });
    if (!projectId) return;

    const scope: ProjectScope = {
      projectId,
      abort: new AbortController(),
      socket: null,
      refresh: async () => {},
      dispatching: false,
    };
    scopeRef.current = scope;
    const current = () => scopeRef.current === scope && !scope.abort.signal.aborted;
    const wsOpen = () =>
      typeof WebSocket !== "undefined" && scope.socket?.readyState === WebSocket.OPEN;
    const update = (patch: Partial<Telemetry>) => {
      if (current()) setState((previous) => ({ ...previous, ...patch }));
    };
    // The server sequence number this client has applied through. Lives in a ref, not in
    // state: it changes on every message and nothing renders it per-event, and putting it in
    // state would re-render the cockpit on every swarm event purely to keep a value that only
    // the reconnect URL and the reducer below read.
    let progress: StreamProgress = { streamState: "connecting", missedEvents: 0, cursor: null };
    let streamGeneration: string | null = null;
    // Backoff attempt counter, reset on a successful open, and this hook instance's own salt.
    // Together they are what keeps a fleet of clients that dropped at the same instant from
    // reconnecting at the same instant — see reconnectDelayMs.
    const salt = decorrelatingSalt();
    let attempt = 0;
    let snapshotRevision = 0;
    let telemetryError: string | null = null;
    let pendingRefresh: Promise<void> | null = null;
    scope.refresh = () => {
      if (!current()) return Promise.resolve();
      if (pendingRefresh) return pendingRefresh;
      const revision = snapshotRevision;
      pendingRefresh = (async () => {
        try {
          const res = await fetch(
            `/api/cockpit/telemetry?project=${encodeURIComponent(projectId)}`,
            {
              signal: scope.abort.signal,
            },
          );
          const json = await readResponse(res);
          if (!json.data || typeof json.data !== "object")
            throw new Error("Invalid telemetry response");
          if (!current()) return;
          const recoveredError = telemetryError;
          telemetryError = null;
          setState((previous) => ({
            ...previous,
            error: previous.error === recoveredError ? null : previous.error,
          }));
          update({
            ...(revision === snapshotRevision ? snapshotPatch(json.data) : {}),
            connected: true,
            transport: wsOpen() ? "ws" : "http",
          });
        } catch (err) {
          if (!current()) return;
          telemetryError = errorMessage(err, "Unable to load cockpit telemetry");
          update({
            connected: wsOpen(),
            transport: wsOpen() ? "ws" : "offline",
            error: telemetryError,
          });
        } finally {
          pendingRefresh = null;
        }
      })();
      return pendingRefresh;
    };

    function connect() {
      if (!current() || typeof window === "undefined") return;
      if (scope.socket && scope.socket.readyState < WebSocket.CLOSING) return;
      try {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        // `since` is what turns a reconnect into a resume. Sent only when this client has a
        // cursor: the first connection must take a full snapshot, and asking the server to
        // answer "what did I miss" about a stream it has not shown this client yet is a
        // question with no right answer.
        const resume =
          progress.cursor === null
            ? ""
            : `&since=${progress.cursor}${streamGeneration === null ? "" : `&generation=${encodeURIComponent(streamGeneration)}`}`;
        const ws = new WebSocket(
          `${protocol}//${window.location.host}/api/cockpit/stream?project=${encodeURIComponent(projectId!)}${resume}`,
        );
        scope.socket = ws;
        const activeSocket = () => current() && scope.socket === ws;
        ws.onopen = () => {
          if (!activeSocket()) return;
          // A successful open ends this outage, so the next backoff starts from the base
          // delay again. Without this a client that drops once an hour would spend every
          // subsequent reconnect at the 30s ceiling.
          attempt = 0;
          update({ connected: true, transport: "ws", streamState: "resyncing" });
        };
        ws.onmessage = (event) => {
          if (!activeSocket()) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.projectId && msg.projectId !== projectId) return;
            if (
              (msg.type === "cockpit_init" ||
                msg.type === "cockpit_resume" ||
                msg.type === "cockpit_stream_gap") &&
              typeof msg.generation === "string"
            ) {
              streamGeneration = msg.generation;
            }
            // One reducer, applied to every message, so the cursor can never go stale because
            // a new message type was added to the stream without updating a branch here.
            const previousProgress = progress;
            const next = applyStreamMessage(previousProgress, msg);
            const detectedSequenceGap =
              previousProgress.streamState !== "behind" &&
              next.streamState === "behind" &&
              previousProgress.cursor !== null &&
              typeof msg?.seq === "number" &&
              Number.isSafeInteger(msg.seq) &&
              msg.seq > previousProgress.cursor + 1 &&
              msg.type !== "cockpit_init" &&
              msg.type !== "cockpit_resume" &&
              msg.type !== "cockpit_stream_gap";
            if (next !== progress) {
              progress = next;
              update({
                streamState: next.streamState,
                missedEvents: next.missedEvents,
                cursor: next.cursor,
              });
            }
            if (detectedSequenceGap) {
              // A silently dropped live frame is repairable while it remains in the replay
              // window. Disconnect now; staying open would continue past the missing cursor.
              ws.close();
              return;
            }
            if (msg.type === "cockpit_init" && msg.data) {
              snapshotRevision++;
              update(snapshotPatch(msg.data));
            } else if (msg.type === "swarm_event" && msg.event) {
              update({ lastEventTime: Date.now() });
              if (msg.event.type === "loop_detected") {
                setState((previous) => {
                  if (!current() || previous.projectId !== projectId) return previous;
                  return {
                    ...previous,
                    loopEvents: retainLoopEvent(previous.loopEvents, msg.event),
                  };
                });
              }
              if (
                msg.event.type === "directive_dispatched" &&
                typeof msg.event.payload?.messageId === "string"
              ) {
                snapshotRevision++;
                const payload = msg.event.payload;
                setState((previous) => {
                  if (!current()) return previous;
                  const handoff: LiveHandoffEvent = {
                    messageId: String(payload.messageId),
                    from: typeof payload.from === "string" ? payload.from : "unknown",
                    to: typeof payload.to === "string" ? payload.to : "unknown",
                    content: typeof payload.content === "string" ? payload.content : undefined,
                    timestamp:
                      typeof msg.event.timestamp === "number" ? msg.event.timestamp : Date.now(),
                  };
                  const handoffs =
                    previous.projectId === projectId
                      ? [
                          handoff,
                          ...previous.handoffs.filter((h) => h.messageId !== handoff.messageId),
                        ].slice(0, 50)
                      : previous.handoffs;
                  return { ...previous, ...{ handoffs } };
                });
              }
              if (
                msg.event.type === "task_started" &&
                typeof msg.event.taskId === "string" &&
                msg.event.taskId.trim() &&
                msg.event.agentId === "orchestrator" &&
                typeof msg.event.timestamp === "number" &&
                Number.isFinite(msg.event.timestamp)
              ) {
                // The coordinator emits this BEFORE planning and mailbox.send. The coder
                // is the pipeline's planned target, not evidence of a delivered assignment.
                const handoff: LiveHandoffEvent = {
                  messageId: `task_started:${msg.event.taskId}:${msg.event.timestamp}`,
                  source: "task_started",
                  taskId: msg.event.taskId,
                  from: msg.event.agentId,
                  to: "coder",
                  content:
                    typeof msg.event.payload?.goal === "string"
                      ? msg.event.payload.goal
                      : undefined,
                  timestamp: msg.event.timestamp,
                };
                setState((previous) => {
                  if (!current() || previous.projectId !== projectId) return previous;
                  return {
                    ...previous,
                    handoffs: [
                      handoff,
                      ...previous.handoffs.filter((h) => h.messageId !== handoff.messageId),
                    ].slice(0, 50),
                  };
                });
              }
              if (msg.event.taskId) update({ activeTaskId: msg.event.taskId });
              if (msg.event.type === "task_completed" || msg.event.type === "task_failed") {
                update({ activeTaskId: null, isDispatching: scope.dispatching });
                if (msg.event.type === "task_failed") {
                  update({ error: errorMessage(msg.event.error, "Swarm task failed") });
                }
                void scope.refresh();
              }
            } else if (msg.type === "swarm_task_accepted") {
              update({ activeTaskId: msg.taskId ?? null, isDispatching: true });
            } else if (msg.type === "swarm_task_settled") {
              update({ activeTaskId: null, isDispatching: scope.dispatching });
              void scope.refresh();
            } else if (msg.type === "swarm_task_error" || msg.type === "swarm_task_rejected") {
              update({
                activeTaskId: null,
                isDispatching: scope.dispatching,
                error: errorMessage(msg.error ?? msg.reason, "Swarm task failed"),
              });
            } else if (msg.type === "directive_rejected") {
              update({ error: errorMessage(msg.reason, "Directive rejected") });
            } else if (msg.type === "directive_dispatched") {
              snapshotRevision++;
              update({
                lastEventTime: Date.now(),
                ...(msg.mailbox ? { mailboxEntries: mailboxEntries(msg.mailbox) } : {}),
              });
            } else if (msg.type === "key_fleet_update" && msg.keyFleet) {
              snapshotRevision++;
              update({ keyFleet: msg.keyFleet, lastEventTime: Date.now() });
            }
          } catch {
            update({ error: "Invalid cockpit stream message" });
          }
        };
        const disconnected = () => {
          if (!activeSocket()) return;
          scope.socket = null;
          ws.close();
          // The cursor is deliberately NOT cleared here. It is the whole point of the resume:
          // the next connect() carries it as `since`, and the server answers with the events
          // this client missed. Clearing it would turn every drop back into a blind restart.
          progress = { ...progress, streamState: "connecting" };
          update({
            connected: false,
            transport: "offline",
            isDispatching: scope.dispatching,
            streamState: "connecting",
          });
          // The REST snapshot is still fetched on a drop because it is the only source for
          // state the delta feeds do not carry (mailbox leases, key health, turn summaries).
          // It is not a substitute for the resume: it has no event history.
          void scope.refresh();
        };
        ws.onclose = disconnected;
        ws.onerror = disconnected;
      } catch {
        scope.socket = null;
        void scope.refresh();
      }
    }

    connect();
    // Bootstrap also covers browsers/proxies that leave the socket stuck connecting.
    void scope.refresh();

    /**
     * Self-scheduling reconnect with jittered full-jitter backoff, replacing a fixed 5s
     * interval. The fixed interval was the reconnect-storm bug: every client in a fleet that
     * dropped together came back on the same 5s phase, which is the thundering herd this
     * exists to prevent. Self-scheduling (rather than `setInterval`) also means the backoff
     * actually grows while a client stays down instead of being reset by the next tick.
     */
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    const scheduleReconnect = () => {
      if (!current()) return;
      reconnect = setTimeout(
        () => {
          if (!current()) return;
          if (!wsOpen()) {
            attempt += 1;
            connect();
            void scope.refresh();
          }
          scheduleReconnect();
        },
        reconnectDelayMs(attempt, salt),
      );
    };
    scheduleReconnect();
    return () => {
      scope.abort.abort();
      if (reconnect !== null) clearTimeout(reconnect);
      scope.socket?.close();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [projectId]);

  const dispatch = useCallback(
    async (path: string, body: object, task: boolean): Promise<boolean> => {
      const scope = scopeRef.current;
      if (!projectId || !scope || scope.projectId !== projectId || scope.abort.signal.aborted)
        return false;
      if (task && scope.dispatching) return false;
      const current = () => scopeRef.current === scope && !scope.abort.signal.aborted;
      if (task) scope.dispatching = true;
      setState((previous) => ({
        ...previous,
        error: null,
        ...(task ? { isDispatching: true } : {}),
      }));
      try {
        // A successful send is not an acknowledgement. REST supplies an explicit result.
        const res = await fetch(`/api/cockpit/${path}?project=${encodeURIComponent(projectId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, ...body }),
          signal: scope.abort.signal,
        });
        const json = await readResponse(res);
        if (json.success !== true) throw new Error("Cockpit command was not acknowledged");
        if (task && ["failed", "unhandled"].includes(json.result?.status)) {
          throw new Error(errorMessage(json.result?.error, "Swarm task failed"));
        }
        if (!current()) return false;
        if (json.mailbox) {
          setState((previous) => ({ ...previous, mailboxEntries: mailboxEntries(json.mailbox) }));
        }
        void scope.refresh();
        return true;
      } catch (err) {
        if (current())
          setState((previous) => ({
            ...previous,
            error: errorMessage(err, "Cockpit command failed"),
          }));
        return false;
      } finally {
        if (task) {
          scope.dispatching = false;
          if (current())
            setState((previous) => ({ ...previous, isDispatching: false, activeTaskId: null }));
        }
      }
    },
    [projectId],
  );
  const triggerTask = useCallback(
    (goal: string, files?: string[]) => dispatch("swarm/run", { goal, files, maxRounds: 3 }, true),
    [dispatch],
  );
  const dispatchDirective = useCallback(
    (to: string, content: string, from = "operator") =>
      dispatch("mailbox/send", { from, to, content }, false),
    [dispatch],
  );
  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    if (scope?.projectId === projectId) await scope.refresh();
  }, [projectId]);

  // Do not paint the previous project's data during the render before effect cleanup.
  const telemetry = state.projectId === projectId ? state : emptyTelemetry(projectId);
  return { ...telemetry, triggerTask, dispatchDirective, refresh };
}
