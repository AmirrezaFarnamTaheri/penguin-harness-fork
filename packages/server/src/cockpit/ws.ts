/**
 * Cockpit Real-Time Telemetry & Swarm WebSocket Transport.
 *
 * Multiplexes live runtime events across:
 * - Swarm Multi-Agent Topology & Consensus Deliberation
 * - Key Rotator Fleet Latency & Cooldown Status
 * - Shell Guardian Security Audit Events
 * - Turn Ledger Lifecycle & Replay Streams
 * - Mailbox Bureau Leases & Queue Depths
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  SwarmCoordinator,
  KeyFleetMonitor,
  CodeGraphWatcher,
  type SwarmEvent,
} from "@prismshadow/penguin-core";
import type { AuthService } from "../auth/service.js";
import { SESSION_COOKIE } from "../auth/middleware.js";

const COCKPIT_STREAM_PATH = /^\/(api\/cockpit\/stream|ws\/cockpit)$/;

export interface CockpitWebSocketDeps {
  authService?: AuthService;
  log?: (line: string) => void;
  workspaceRoot?: string;
}

let sharedCoordinator: SwarmCoordinator | null = null;
let sharedKeyFleet: KeyFleetMonitor | null = null;
let sharedCodeGraphWatcher: CodeGraphWatcher | null = null;

export function getSharedSwarmCoordinator(): SwarmCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = new SwarmCoordinator();
  }
  return sharedCoordinator;
}

export function getSharedKeyFleetMonitor(): KeyFleetMonitor {
  if (!sharedKeyFleet) {
    sharedKeyFleet = new KeyFleetMonitor();
  }
  return sharedKeyFleet;
}

export function getSharedCodeGraphWatcher(workspaceRoot = process.cwd()): CodeGraphWatcher {
  if (!sharedCodeGraphWatcher) {
    sharedCodeGraphWatcher = new CodeGraphWatcher(workspaceRoot);
    void sharedCodeGraphWatcher.init();
  }
  return sharedCodeGraphWatcher;
}

export function attachCockpitWebSocket(server: HttpServer, deps: CockpitWebSocketDeps = {}): void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const coordinator = getSharedSwarmCoordinator();
  const keyFleet = getSharedKeyFleetMonitor();
  const codeGraphWatcher = getSharedCodeGraphWatcher(deps.workspaceRoot);
  const connectedClients = new Set<WebSocket>();

  // Subscribe coordinator events and broadcast to all connected cockpit clients
  coordinator.subscribe((event: SwarmEvent) => {
    const payload = JSON.stringify({
      type: "swarm_event",
      timestamp: Date.now(),
      event,
    });
    for (const ws of connectedClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  });

  // Subscribe key fleet updates and broadcast to cockpit clients
  keyFleet.subscribe((_stats) => {
    const payload = JSON.stringify({
      type: "key_fleet_update",
      timestamp: Date.now(),
      keyFleet: keyFleet.getCockpitSnapshot(),
      reports: keyFleet.getFleetReport(),
      stats: keyFleet.getFleetStats(),
    });
    for (const ws of connectedClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  });

  // Subscribe code graph changes and broadcast to cockpit clients
  codeGraphWatcher.on("change", (ev) => {
    const payload = JSON.stringify({
      type: "topology_change",
      timestamp: Date.now(),
      event: ev,
      stats: codeGraphWatcher.getStats(),
    });
    for (const ws of connectedClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!COCKPIT_STREAM_PATH.test(url.pathname)) return;

    if (!isAllowedOrigin(req)) {
      return refuse(socket, 403, "Forbidden");
    }

    // Authenticate if authService is provided
    if (deps.authService) {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const authed = token ? deps.authService.authenticateWithMeta(token) : null;
      if (!authed && !isLocalhostOrDev(req)) {
        return refuse(socket, 401, "Unauthorized");
      }
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      connectedClients.add(ws);

      // Send initial cockpit telemetry snapshot
      const snapshot = buildCockpitSnapshot(coordinator);
      ws.send(JSON.stringify(snapshot));

      ws.on("message", async (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            return;
          }

          if (msg.type === "probe_key") {
            const provider = typeof msg.provider === "string" ? msg.provider : "anthropic";
            const maskedKey = typeof msg.maskedKey === "string" ? msg.maskedKey : "";
            const result = await keyFleet.probeKey(provider, maskedKey);
            ws.send(
              JSON.stringify({
                type: "key_probe_settled",
                result,
                timestamp: Date.now(),
              }),
            );
            return;
          }

          if (msg.type === "probe_fleet") {
            const results = await keyFleet.probeFleet();
            ws.send(
              JSON.stringify({
                type: "fleet_probe_settled",
                results,
                timestamp: Date.now(),
              }),
            );
            return;
          }

          if (msg.type === "key_action") {
            const action = msg.action;
            const provider = typeof msg.provider === "string" ? msg.provider : "";
            const maskedKey = typeof msg.maskedKey === "string" ? msg.maskedKey : "";
            if (action === "revive") {
              keyFleet.reviveKey(provider, maskedKey);
            } else if (action === "cooldown") {
              keyFleet.cooldownKey(provider, maskedKey, typeof msg.cooldownMs === "number" ? msg.cooldownMs : 60_000);
            } else if (action === "evict") {
              keyFleet.evictKey(provider, maskedKey);
            } else if (action === "revive_all") {
              keyFleet.reviveAllCooldowns();
            }
            return;
          }

          if (msg.type === "send_directive") {
            const from = typeof msg.from === "string" ? msg.from : "operator";
            const to = typeof msg.to === "string" ? msg.to : "coder";
            const content = typeof msg.content === "string" ? msg.content : "";
            if (content.trim()) {
              const directive = coordinator.dispatchDirective(from, to, content.trim());
              const confirmPayload = JSON.stringify({
                type: "directive_dispatched",
                directive,
                mailbox: coordinator.getMailboxSummaries(),
                timestamp: Date.now(),
              });
              for (const client of connectedClients) {
                if (client.readyState === client.OPEN) {
                  client.send(confirmPayload);
                }
              }
            }
            return;
          }

          if (msg.type === "trigger_swarm") {
            const goal = typeof msg.goal === "string" ? msg.goal : "Autonomous local coding task";
            const files = Array.isArray(msg.files) ? msg.files : undefined;
            const proposedCommands = Array.isArray(msg.proposedCommands) ? msg.proposedCommands : undefined;

            ws.send(
              JSON.stringify({
                type: "swarm_task_accepted",
                goal,
                timestamp: Date.now(),
              }),
            );

            // Execute task asynchronously
            void coordinator.runTask({
              goal,
              files,
              proposedCommands,
              maxRounds: msg.maxRounds ?? 3,
            }).then((res: unknown) => {
              ws.send(
                JSON.stringify({
                  type: "swarm_task_settled",
                  result: res,
                  timestamp: Date.now(),
                }),
              );
            }).catch((err: unknown) => {
              ws.send(
                JSON.stringify({
                  type: "swarm_task_error",
                  error: err instanceof Error ? err.message : String(err),
                  timestamp: Date.now(),
                }),
              );
            });
          }
        } catch {
          // malformed json
        }
      });

      ws.on("close", () => {
        connectedClients.delete(ws);
      });

      ws.on("error", (err) => {
        deps.log?.(`[cockpit-ws] socket error: ${err.message}`);
        connectedClients.delete(ws);
      });
    });
  });
}

export function buildCockpitSnapshot(
  coordinator: SwarmCoordinator = getSharedSwarmCoordinator(),
  keyFleet: KeyFleetMonitor = getSharedKeyFleetMonitor(),
  codeGraphWatcher: CodeGraphWatcher = getSharedCodeGraphWatcher(),
) {
  return {
    type: "cockpit_init",
    timestamp: Date.now(),
    data: {
      swarm: {
        agents: coordinator.getAgents(),
        edges: coordinator.getEdges(),
        standings: coordinator.getStandings(),
      },
      mailbox: coordinator.getMailboxSummaries(),
      watchdog: coordinator.getWatchdogStatus(),
      replay: coordinator.getReplayView(),
      keyFleet: keyFleet.getCockpitSnapshot(),
      topology: codeGraphWatcher.getStats(),
    },
  };
}

function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.host === (req.headers.host ?? "");
}

function isLocalhostOrDev(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
