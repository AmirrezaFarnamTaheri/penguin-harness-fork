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
import { WebSocketServer, WebSocket } from "ws";
import {
  SwarmCoordinator,
  KeyFleetMonitor,
  CodeGraphWatcher,
  ShellGuardian,
  type SafetyRule,
  DEFAULT_PROJECT_ID,
  projectDir,
  redactObject,
  type SwarmEvent,
} from "@prismshadow/penguin-core";
import type { AuthService } from "../auth/service.js";
import type { ProjectService } from "../services/project-service.js";
import type { ProjectConfigService } from "../services/project-config-service.js";
import { SESSION_COOKIE } from "../auth/middleware.js";

const COCKPIT_STREAM_PATH = /^\/(api\/cockpit\/stream|ws\/cockpit)$/;
const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64KB backpressure guard

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED_AMOUNT) {
    ws.send(payload);
  }
}

function broadcast(clients: Iterable<WebSocket>, payload: string): void {
  for (const client of clients) {
    safeSend(client, payload);
  }
}

function resolveKeyTarget(msg: Record<string, unknown>): string {
  if (typeof msg.keyId === "string" && msg.keyId.trim()) {
    return msg.keyId.trim();
  }
  return typeof msg.maskedKey === "string" ? msg.maskedKey : "";
}

export const RUNTIME_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface CockpitWebSocketDeps {
  authService?: AuthService;
  projectService?: ProjectService;
  projectConfigService?: ProjectConfigService;
  root?: string;
  log?: (line: string) => void;
  workspaceRoot?: string;
  idleTimeoutMs?: number;
}

export interface ProjectCockpitRuntime {
  projectId: string;
  coordinator: SwarmCoordinator;
  keyFleet: KeyFleetMonitor;
  codeGraphWatcher: CodeGraphWatcher;
  clients: Set<WebSocket>;
  idleTimer?: NodeJS.Timeout | null;
  cleanup?: () => void;
}

const projectRuntimes = new Map<string, ProjectCockpitRuntime>();

export function cancelRuntimeReap(runtime: ProjectCockpitRuntime): void {
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }
}

export function scheduleRuntimeReap(
  runtime: ProjectCockpitRuntime,
  deps: CockpitWebSocketDeps = {},
  timeoutMs = deps.idleTimeoutMs ?? RUNTIME_IDLE_TIMEOUT_MS,
): void {
  cancelRuntimeReap(runtime);
  runtime.idleTimer = setTimeout(() => {
    if (runtime.clients.size === 0) {
      try {
        runtime.cleanup?.();
        runtime.codeGraphWatcher.close();
      } catch (err) {
        deps.log?.(
          `[cockpit-ws][${runtime.projectId}] error closing watcher: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      projectRuntimes.delete(runtime.projectId);
      deps.log?.(`[cockpit-ws][${runtime.projectId}] idle runtime reaped after ${timeoutMs}ms`);
    }
  }, timeoutMs);
  if (typeof runtime.idleTimer.unref === "function") {
    runtime.idleTimer.unref();
  }
}

export function resetCockpitRuntimesForTesting(): void {
  for (const rt of projectRuntimes.values()) {
    cancelRuntimeReap(rt);
    try {
      rt.cleanup?.();
      rt.codeGraphWatcher.close();
    } catch {
      // ignore
    }
    for (const ws of rt.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    rt.clients.clear();
  }
  projectRuntimes.clear();
}

export async function syncProjectKeyFleet(
  deps: CockpitWebSocketDeps,
  projectId: string,
  monitor: KeyFleetMonitor,
): Promise<void> {
  if (!deps.projectConfigService) return;
  try {
    const raw = await deps.projectConfigService.readRaw(projectId);
    monitor.clear();
    if (raw && Array.isArray(raw.models)) {
      const byProvider = new Map<string, { modelId: string; keys: string[] }>();
      for (const m of raw.models) {
        if (
          m &&
          typeof m === "object" &&
          typeof m.provider === "string" &&
          typeof m.model_id === "string" &&
          typeof m.api_key === "string" &&
          m.api_key.trim() !== ""
        ) {
          const prov = m.provider.toLowerCase();
          const existing = byProvider.get(prov);
          const rawKey = m.api_key.trim();
          if (!existing) {
            byProvider.set(prov, { modelId: m.model_id, keys: [rawKey] });
          } else if (!existing.keys.includes(rawKey)) {
            existing.keys.push(rawKey);
          }
        }
      }
      for (const [provider, data] of byProvider) {
        monitor.registerProvider({
          provider,
          modelId: data.modelId,
          modelRef: `${provider}/${data.modelId}`,
          keys: data.keys,
          strategy: "round-robin",
        });
      }
    }
  } catch (err) {
    deps.log?.(
      `[cockpit-ws] error syncing key fleet for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function createProjectShellGuardian(
  deps: CockpitWebSocketDeps,
  projectId: string,
): Promise<ShellGuardian> {
  const guardian = new ShellGuardian();
  if (deps.projectConfigService) {
    try {
      const policy = await deps.projectConfigService.getCommandPolicy(projectId);
      if (policy.enabled !== false && Array.isArray(policy.rules)) {
        const customRules: SafetyRule[] = policy.rules
          .filter((r) => r.enabled !== false)
          .map((r) => {
            let regex: RegExp;
            try {
              regex = new RegExp(r.pattern, "i");
            } catch {
              regex = new RegExp(r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            }
            return {
              id: `policy-${r.name}`,
              severity: "critical" as const,
              pattern: regex,
              description: r.description || `Command policy rule '${r.name}'`,
              requiresApproval: true,
            };
          });
        guardian.setCustomRules(customRules);
      }
    } catch (err) {
      deps.log?.(
        `[cockpit-ws] error configuring ShellGuardian for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return guardian;
}

function resolveProjectWorkspaceDir(deps: CockpitWebSocketDeps, projectId: string): string {
  if (deps.root && projectId !== DEFAULT_PROJECT_ID) {
    return projectDir(deps.root, projectId);
  }
  return deps.workspaceRoot ?? process.cwd();
}

export async function getOrCreateProjectRuntime(
  projectId = DEFAULT_PROJECT_ID,
  deps: CockpitWebSocketDeps = {},
): Promise<ProjectCockpitRuntime> {
  let runtime = projectRuntimes.get(projectId);
  if (runtime) {
    cancelRuntimeReap(runtime);
    return runtime;
  }

  const workspaceDir = resolveProjectWorkspaceDir(deps, projectId);
  const codeGraphWatcher = new CodeGraphWatcher(workspaceDir);
  void codeGraphWatcher.init();

  const shellGuardian = await createProjectShellGuardian(deps, projectId);
  const coordinator = new SwarmCoordinator({
    shellGuardian,
    sessionId: `swarm-${projectId}-${Date.now()}`,
  });

  const keyFleet = new KeyFleetMonitor();
  await syncProjectKeyFleet(deps, projectId, keyFleet);

  const clients = new Set<WebSocket>();

  runtime = {
    projectId,
    coordinator,
    keyFleet,
    codeGraphWatcher,
    clients,
  };
  projectRuntimes.set(projectId, runtime);

  codeGraphWatcher.on("error", (err) => {
    deps.log?.(
      `[cockpit-ws][${projectId}] code graph watcher error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const unsubCoordinator = coordinator.subscribe((event: SwarmEvent) => {
    broadcast(
      runtime!.clients,
      JSON.stringify({
        type: "swarm_event",
        projectId,
        timestamp: Date.now(),
        event: redactObject(event),
      }),
    );
  });

  const unsubKeyFleet = keyFleet.subscribe((_stats) => {
    broadcast(
      runtime!.clients,
      JSON.stringify({
        type: "key_fleet_update",
        projectId,
        timestamp: Date.now(),
        keyFleet: redactObject(keyFleet.getCockpitSnapshot()),
        reports: redactObject(keyFleet.getFleetReport()),
        stats: keyFleet.getFleetStats(),
      }),
    );
  });

  const onChange = (ev: unknown) => {
    broadcast(
      runtime!.clients,
      JSON.stringify({
        type: "topology_change",
        projectId,
        timestamp: Date.now(),
        event: ev,
        stats: codeGraphWatcher.getStats(),
      }),
    );
  };
  codeGraphWatcher.on("change", onChange);

  runtime.cleanup = () => {
    unsubCoordinator();
    unsubKeyFleet();
    codeGraphWatcher.off?.("change", onChange);
  };

  return runtime;
}

function getOrCreateProjectRuntimeSync(
  projectId = DEFAULT_PROJECT_ID,
  workspaceRoot = process.cwd(),
): ProjectCockpitRuntime {
  let rt = projectRuntimes.get(projectId);
  if (rt) {
    cancelRuntimeReap(rt);
    return rt;
  }
  const coordinator = new SwarmCoordinator();
  const keyFleet = new KeyFleetMonitor();
  const codeGraphWatcher = new CodeGraphWatcher(workspaceRoot);
  void codeGraphWatcher.init();
  rt = {
    projectId,
    coordinator,
    keyFleet,
    codeGraphWatcher,
    clients: new Set(),
  };
  projectRuntimes.set(projectId, rt);
  return rt;
}

export function getSharedSwarmCoordinator(projectId = DEFAULT_PROJECT_ID): SwarmCoordinator {
  return getOrCreateProjectRuntimeSync(projectId).coordinator;
}

export function getSharedKeyFleetMonitor(projectId = DEFAULT_PROJECT_ID): KeyFleetMonitor {
  return getOrCreateProjectRuntimeSync(projectId).keyFleet;
}

export function getSharedCodeGraphWatcher(
  workspaceRoot = process.cwd(),
  projectId = DEFAULT_PROJECT_ID,
): CodeGraphWatcher {
  return getOrCreateProjectRuntimeSync(projectId, workspaceRoot).codeGraphWatcher;
}

export function attachCockpitWebSocket(server: HttpServer, deps: CockpitWebSocketDeps = {}): void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!COCKPIT_STREAM_PATH.test(url.pathname)) return;

    if (!isAllowedOrigin(req)) {
      return refuse(socket, 403, "Forbidden");
    }

    let authedUser: { userId: string } | null = null;
    if (deps.authService) {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const authed = token ? deps.authService.authenticateWithMeta(token) : null;
      if (!authed) {
        return refuse(socket, 401, "Unauthorized");
      }
      authedUser = authed.user;
    }

    const projectId =
      url.searchParams.get("project") || url.searchParams.get("projectId") || DEFAULT_PROJECT_ID;

    if (deps.projectService && authedUser) {
      try {
        deps.projectService.requireProjectAccess(authedUser.userId, projectId);
      } catch {
        return refuse(socket, 404, "Project Not Found");
      }
    }

    const runtime = await getOrCreateProjectRuntime(projectId, deps);

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      cancelRuntimeReap(runtime);
      runtime.clients.add(ws);

      // Send initial cockpit telemetry snapshot for this project
      const snapshot = buildCockpitSnapshot(
        runtime.coordinator,
        runtime.keyFleet,
        runtime.codeGraphWatcher,
      );
      safeSend(ws, JSON.stringify(snapshot));

      ws.on("message", async (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            safeSend(ws, JSON.stringify({ type: "pong", timestamp: Date.now() }));
            return;
          }

          if (msg.type === "probe_key") {
            const provider = typeof msg.provider === "string" ? msg.provider : "anthropic";
            const target = resolveKeyTarget(msg);
            const result = await runtime.keyFleet.probeKey(provider, target);
            safeSend(
              ws,
              JSON.stringify({
                type: "key_probe_settled",
                result,
                timestamp: Date.now(),
              }),
            );
            return;
          }

          if (msg.type === "probe_fleet") {
            const results = await runtime.keyFleet.probeFleet();
            safeSend(
              ws,
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
            const target = resolveKeyTarget(msg);
            if (action === "revive") {
              runtime.keyFleet.reviveKey(provider, target);
            } else if (action === "cooldown") {
              runtime.keyFleet.cooldownKey(
                provider,
                target,
                typeof msg.cooldownMs === "number" ? msg.cooldownMs : 60_000,
              );
            } else if (action === "evict") {
              runtime.keyFleet.evictKey(provider, target);
            } else if (action === "revive_all") {
              runtime.keyFleet.reviveAllCooldowns();
            }
            return;
          }

          if (msg.type === "send_directive") {
            const from = typeof msg.from === "string" ? msg.from.slice(0, 64) : "operator";
            const to = typeof msg.to === "string" ? msg.to.slice(0, 64) : "coder";
            const content = typeof msg.content === "string" ? msg.content : "";
            const trimmed = content.trim();
            if (trimmed && trimmed.length <= 8192) {
              const summaries = runtime.coordinator.getMailboxSummaries();
              const targetSummary = summaries[to];
              if (targetSummary && targetSummary.queueDepth >= 100) {
                safeSend(
                  ws,
                  JSON.stringify({
                    type: "directive_rejected",
                    reason: `Mailbox queue for '${to}' exceeds capacity (max 100 pending)`,
                    timestamp: Date.now(),
                  }),
                );
                return;
              }
              const directive = runtime.coordinator.dispatchDirective(from, to, trimmed);
              broadcast(
                runtime.clients,
                JSON.stringify({
                  type: "directive_dispatched",
                  directive: redactObject(directive),
                  mailbox: runtime.coordinator.getMailboxSummaries(),
                  timestamp: Date.now(),
                }),
              );
            } else if (trimmed.length > 8192) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "directive_rejected",
                  reason: "Directive content exceeds maximum length of 8192 characters",
                  timestamp: Date.now(),
                }),
              );
            }
            return;
          }

          if (msg.type === "trigger_swarm") {
            const taskId =
              typeof msg.id === "string" && msg.id.trim()
                ? msg.id.trim()
                : `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const goal =
              typeof msg.goal === "string"
                ? msg.goal.slice(0, 4096)
                : "Autonomous local coding task";
            const files = Array.isArray(msg.files)
              ? (msg.files.filter((f: unknown) => typeof f === "string" && f.trim()) as string[])
              : undefined;
            const proposedCommands = Array.isArray(msg.proposedCommands)
              ? (msg.proposedCommands.filter(
                  (c: unknown) => typeof c === "string" && c.trim(),
                ) as string[])
              : undefined;
            const maxRounds =
              typeof msg.maxRounds === "number"
                ? Math.min(Math.max(1, Math.floor(msg.maxRounds)), 10)
                : 3;
            const simulate = msg.simulate === true;

            safeSend(
              ws,
              JSON.stringify({
                type: "swarm_task_accepted",
                taskId,
                goal,
                timestamp: Date.now(),
              }),
            );

            // Execute task asynchronously on this project's coordinator
            void runtime.coordinator
              .runTask({
                id: taskId,
                goal,
                files,
                proposedCommands,
                maxRounds,
                simulate,
              })
              .then((res: unknown) => {
                broadcast(
                  runtime.clients,
                  JSON.stringify({
                    type: "swarm_task_settled",
                    taskId,
                    result: redactObject(res),
                    timestamp: Date.now(),
                  }),
                );
              })
              .catch((err: unknown) => {
                broadcast(
                  runtime.clients,
                  JSON.stringify({
                    type: "swarm_task_error",
                    taskId,
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

      const removeClient = () => {
        runtime.clients.delete(ws);
        if (runtime.clients.size === 0) {
          scheduleRuntimeReap(runtime, deps);
        }
      };

      ws.on("close", removeClient);

      ws.on("error", (err) => {
        deps.log?.(`[cockpit-ws][${projectId}] socket error: ${err.message}`);
        removeClient();
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
      replay: redactObject(coordinator.getReplayView()),
      keyFleet: redactObject(keyFleet.getCockpitSnapshot()),
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
