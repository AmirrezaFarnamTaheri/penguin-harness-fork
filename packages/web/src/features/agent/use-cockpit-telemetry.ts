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

/** A directive_dispatched swarm event, folded for the consensus handoff timeline. */
export interface LiveHandoffEvent {
  messageId: string;
  from: string;
  to: string;
  content?: string;
  timestamp: number;
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
  activeTaskId: string | null;
  swarmAgents: SwarmAgentNode[];
  swarmEdges: SwarmEdge[];
  turnSummaries: LiveTurnSummary[];
  mailboxEntries: LiveMailboxEntry[];
  handoffs: LiveHandoffEvent[];
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
    activeTaskId: null,
    swarmAgents: [],
    swarmEdges: [],
    turnSummaries: [],
    mailboxEntries: [],
    handoffs: [],
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
        const ws = new WebSocket(
          `${protocol}//${window.location.host}/api/cockpit/stream?project=${encodeURIComponent(projectId!)}`,
        );
        scope.socket = ws;
        const activeSocket = () => current() && scope.socket === ws;
        ws.onopen = () => {
          if (activeSocket()) update({ connected: true, transport: "ws" });
        };
        ws.onmessage = (event) => {
          if (!activeSocket()) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.projectId && msg.projectId !== projectId) return;
            if (msg.type === "cockpit_init" && msg.data) {
              snapshotRevision++;
              update(snapshotPatch(msg.data));
            } else if (msg.type === "swarm_event" && msg.event) {
              update({ lastEventTime: Date.now() });
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
          update({ connected: false, transport: "offline", isDispatching: scope.dispatching });
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
    const poll = setInterval(() => {
      if (!wsOpen()) {
        void scope.refresh();
        connect();
      }
    }, 5000);
    return () => {
      scope.abort.abort();
      clearInterval(poll);
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
