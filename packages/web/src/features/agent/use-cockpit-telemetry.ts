/**
 * React hook for real-time Cockpit telemetry and autonomous Swarm dispatch.
 * Connects to the server WebSocket endpoint (/api/cockpit/stream) with automatic
 * reconnection and graceful REST fallback (/api/cockpit/telemetry).
 */

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
  keyFleet: {
    healthy: boolean;
    activeCount: number;
    providers: KeyFleetProvider[];
  };
  lastEventTime: number | null;
  isDispatching: boolean;
  triggerTask: (goal: string, files?: string[]) => Promise<void>;
  dispatchDirective: (to: string, content: string, from?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function useCockpitTelemetry(_sessionId = "default-session"): CockpitTelemetryState {
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<"ws" | "http" | "connecting" | "offline">(
    "connecting",
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [swarmAgents, setSwarmAgents] = useState<SwarmAgentNode[]>([
    { id: "orchestrator", role: "orchestrator", status: "idle", tasksCompleted: 0 },
    { id: "coder", role: "coder", status: "idle", tasksCompleted: 0 },
    { id: "reviewer", role: "reviewer", status: "idle", tasksCompleted: 0 },
    { id: "tester", role: "tester", status: "idle", tasksCompleted: 0 },
    { id: "researcher", role: "researcher", status: "idle", tasksCompleted: 0 },
  ]);
  const [swarmEdges, setSwarmEdges] = useState<SwarmEdge[]>([
    { from: "orchestrator", to: "coder", kind: "directive", activeCount: 0 },
    { from: "coder", to: "reviewer", kind: "handoff", activeCount: 0 },
    { from: "reviewer", to: "orchestrator", kind: "review_gate", activeCount: 0 },
    { from: "coder", to: "tester", kind: "handoff", activeCount: 0 },
  ]);
  const [turnSummaries, setTurnSummaries] = useState<LiveTurnSummary[]>([]);
  const [mailboxEntries, setMailboxEntries] = useState<LiveMailboxEntry[]>([]);
  const [keyFleet, setKeyFleet] = useState<{
    healthy: boolean;
    activeCount: number;
    providers: KeyFleetProvider[];
  }>({
    healthy: false,
    activeCount: 0,
    providers: [],
  });
  const [lastEventTime, setLastEventTime] = useState<number | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);

  const applySnapshot = useCallback((data: any) => {
    if (!data) return;
    if (data.swarm?.agents) {
      setSwarmAgents(data.swarm.agents);
    }
    if (data.swarm?.edges) {
      setSwarmEdges(data.swarm.edges);
    }
    if (data.mailbox) {
      const mbList: LiveMailboxEntry[] = Object.entries(data.mailbox).map(
        ([agentName, summary]: [string, any]) => ({
          agentName,
          queueDepth: summary.queueDepth ?? 0,
          pendingReplies: summary.pendingReplyCount ?? 0,
          leaseState: summary.lease?.leaseState ?? "idle",
          leaseRemainingSec: summary.lease?.expiresAt
            ? Math.max(0, Math.round((summary.lease.expiresAt - Date.now()) / 1000))
            : undefined,
        }),
      );
      setMailboxEntries(mbList);
    }
    if (data.replay?.events) {
      const turns: LiveTurnSummary[] = [];
      for (const ev of data.replay.events) {
        if (ev.kind === "turn_done" || ev.status === "completed" || ev.status === "failed") {
          turns.push({
            turnId: ev.turnId ?? `turn-${ev.seq}`,
            terminalSeq: ev.seq,
            status: ev.status ?? "completed",
            durationMs: typeof ev.payload?.durationMs === "number" ? ev.payload.durationMs : 0,
            outcome:
              typeof ev.payload === "string"
                ? ev.payload
                : typeof ev.payload?.outcome === "string"
                  ? ev.payload.outcome
                  : undefined,
            streamRecords: typeof ev.payload?.recordCount === "number" ? ev.payload.recordCount : 0,
          });
        }
      }
      if (turns.length > 0) setTurnSummaries(turns);
    }
    if (data.keyFleet) {
      setKeyFleet(data.keyFleet);
    }
    setLastEventTime(Date.now());
  }, []);

  const fetchRestTelemetry = useCallback(async () => {
    try {
      const res = await fetch("/api/cockpit/telemetry");
      if (res.ok) {
        const json = await res.json();
        applySnapshot(json.data);
        setConnected(true);
        setTransport("http");
      }
    } catch {
      setConnected(false);
      setTransport("offline");
    }
  }, [applySnapshot]);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer: NodeJS.Timeout | null = null;

    function connectWs() {
      if (typeof window === "undefined") return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/cockpit/stream`;

      try {
        const ws = new WebSocket(url);
        socketRef.current = ws;

        ws.onopen = () => {
          if (unmounted) return;
          setConnected(true);
          setTransport("ws");
        };

        ws.onmessage = (event) => {
          if (unmounted) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "cockpit_init" && msg.data) {
              applySnapshot(msg.data);
            } else if (msg.type === "swarm_event" && msg.event) {
              setLastEventTime(Date.now());
              if (msg.event.taskId) setActiveTaskId(msg.event.taskId);
              if (msg.event.type === "task_completed" || msg.event.type === "task_failed") {
                setActiveTaskId(null);
                setIsDispatching(false);
                void fetchRestTelemetry();
              }
            } else if (msg.type === "swarm_task_accepted") {
              setIsDispatching(true);
            } else if (msg.type === "swarm_task_settled") {
              setIsDispatching(false);
              void fetchRestTelemetry();
            } else if (msg.type === "directive_dispatched") {
              setLastEventTime(Date.now());
              if (msg.mailbox) {
                const mbList: LiveMailboxEntry[] = Object.entries(msg.mailbox).map(
                  ([agentName, summary]: [string, any]) => ({
                    agentName,
                    queueDepth: summary.queueDepth ?? 0,
                    pendingReplies: summary.pendingReplyCount ?? 0,
                    leaseState: summary.lease?.leaseState ?? "idle",
                    leaseRemainingSec: summary.lease?.expiresAt
                      ? Math.max(0, Math.round((summary.lease.expiresAt - Date.now()) / 1000))
                      : undefined,
                  }),
                );
                setMailboxEntries(mbList);
              }
            } else if (msg.type === "key_fleet_update" && msg.keyFleet) {
              setKeyFleet(msg.keyFleet);
              setLastEventTime(Date.now());
            }
          } catch {
            // malformed
          }
        };

        ws.onclose = () => {
          if (unmounted) return;
          setConnected(false);
          setTransport("http");
          // Fall back to REST polling while disconnected
          void fetchRestTelemetry();
          reconnectTimer = setTimeout(connectWs, 5000);
        };

        ws.onerror = () => {
          if (unmounted) return;
          void fetchRestTelemetry();
        };
      } catch {
        void fetchRestTelemetry();
      }
    }

    connectWs();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socketRef.current) socketRef.current.close();
    };
  }, [applySnapshot, fetchRestTelemetry]);

  const triggerTask = useCallback(
    async (goal: string, files?: string[]) => {
      setIsDispatching(true);
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "trigger_swarm",
            goal,
            files,
            maxRounds: 3,
          }),
        );
      } else {
        // Fall back to REST endpoint
        try {
          const res = await fetch("/api/cockpit/swarm/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal, files, maxRounds: 3 }),
          });
          const json = await res.json();
          if (json.success) {
            void fetchRestTelemetry();
          }
        } finally {
          setIsDispatching(false);
        }
      }
    },
    [fetchRestTelemetry],
  );

  const dispatchDirective = useCallback(
    async (to: string, content: string, from = "operator"): Promise<boolean> => {
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "send_directive",
            from,
            to,
            content,
          }),
        );
        return true;
      }
      try {
        const res = await fetch("/api/cockpit/mailbox/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to, content }),
        });
        if (res.ok) {
          void fetchRestTelemetry();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [fetchRestTelemetry],
  );

  return {
    connected,
    transport,
    activeTaskId,
    swarmAgents,
    swarmEdges,
    turnSummaries,
    mailboxEntries,
    keyFleet,
    lastEventTime,
    isDispatching,
    triggerTask,
    dispatchDirective,
    refresh: fetchRestTelemetry,
  };
}
