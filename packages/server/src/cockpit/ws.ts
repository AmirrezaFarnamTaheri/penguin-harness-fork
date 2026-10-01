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
import path from "node:path";
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
  parseApiKeys,
  resolveModelEnv,
  catalogEntryFor,
  type SwarmEvent,
  type SwarmRoleHandlers,
} from "@prismshadow/penguin-core";
import type { AuthService } from "../auth/service.js";
import type { ProjectService } from "../services/project-service.js";
import type { ProjectConfigService } from "../services/project-config-service.js";
import { SESSION_COOKIE } from "../auth/middleware.js";
import { CockpitEventLog } from "./event-log.js";

const COCKPIT_STREAM_PATH = /^\/(api\/cockpit\/stream|ws\/cockpit)$/;
const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64KB backpressure guard

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED_AMOUNT) {
    ws.send(payload);
  }
}

/**
 * Serializes one event, stamps it with the next sequence number, records it for replay, and
 * pushes it to every client.
 *
 * This replaces the previous bare `broadcast` at every call site, which is the point: a
 * sequence number that some messages carry and others do not is a cursor a client cannot
 * trust. Going through one function is what makes `seq` a property of the stream rather than
 * of one caller's discipline. A client that was connected the whole time learns the cursor
 * from the traffic it already receives, and a client that reconnects can name where it stopped.
 */
function publish(runtime: ProjectCockpitRuntime, event: Record<string, unknown>): void {
  const entry = runtime.eventLog.publishStamped((seq) => JSON.stringify({ ...event, seq }));
  for (const client of runtime.clients) {
    safeSend(client, entry.payload);
  }
}

/**
 * The `since` cursor a reconnecting client asked for, or undefined when it did not ask.
 * Read from the query string rather than an in-band `resume` message so the answer can be sent
 * during the upgrade, in the same synchronous block that registers the client — see
 * attachCockpitWebSocket for why that ordering is what makes the replay race-free.
 */
function parseSince(url: URL): number | undefined {
  const raw = url.searchParams.get("since");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolveKeyTarget(msg: Record<string, unknown>): string {
  if (typeof msg.keyId === "string" && msg.keyId.trim()) {
    return msg.keyId.trim();
  }
  return typeof msg.maskedKey === "string" ? msg.maskedKey : "";
}

export const RUNTIME_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface CockpitWebSocketDeps {
  swarmHandlers?: SwarmRoleHandlers;
  authService?: AuthService;
  projectService?: ProjectService;
  projectConfigService?: ProjectConfigService;
  root?: string;
  log?: (line: string) => void;
  workspaceRoot?: string;
  idleTimeoutMs?: number;
}

export interface ProjectCockpitRuntime {
  swarmHandlers?: SwarmRoleHandlers;
  projectId: string;
  coordinator: SwarmCoordinator;
  keyFleet: KeyFleetMonitor;
  codeGraphWatcher: CodeGraphWatcher;
  clients: Set<WebSocket>;
  /**
   * Bounded replay log for this project's stream. Every envelope published to `clients` is
   * stamped and recorded here, which is what lets a client that dropped say how far it got
   * instead of reconnecting blind. Owned by the runtime so its lifetime matches the clients'
   * and the reap below discards it with them.
   */
  eventLog: CockpitEventLog;
  idleTimer?: NodeJS.Timeout | null;
  cleanup?: () => void;
}

const projectRuntimes = new Map<string, ProjectCockpitRuntime>();
const projectRuntimePromises = new Map<string, Promise<ProjectCockpitRuntime>>();

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
      const pendingCount =
        typeof runtime.coordinator.getPendingTaskCount === "function"
          ? runtime.coordinator.getPendingTaskCount()
          : 0;
      const activeTaskId =
        typeof runtime.coordinator.getActiveTaskId === "function"
          ? runtime.coordinator.getActiveTaskId()
          : null;
      if (pendingCount > 0 || activeTaskId !== null) {
        scheduleRuntimeReap(runtime, deps, timeoutMs);
        return;
      }
      try {
        runtime.cleanup?.();
        runtime.keyFleet.stopAutoProbing();
        runtime.keyFleet.clear();
        runtime.codeGraphWatcher.close();
      } catch (err) {
        deps.log?.(
          `[cockpit-ws][${runtime.projectId}] error closing watcher: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const [key, stored] of projectRuntimes) {
        if (stored === runtime) projectRuntimes.delete(key);
      }
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
      rt.keyFleet.stopAutoProbing();
      rt.keyFleet.clear();
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
  projectRuntimePromises.clear();
}

/**
 * Genuine live HTTP provider probe against authentic model discovery endpoints.
 */
export async function probeProviderKey(
  provider: string,
  key: string,
  options: { baseUrl?: string; clientType?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const normProv = provider.toLowerCase().trim();
  const start = performance.now();

  try {
    let url = "";
    const headers: Record<string, string> = {};

    if (options.baseUrl) {
      const endpoint = new URL(options.baseUrl);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password
      ) {
        return { ok: false, latencyMs: 0, error: "Invalid configured probe endpoint" };
      }
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/models`;
      endpoint.search = "";
      endpoint.hash = "";
      url = endpoint.toString();
      const protocol = options.clientType?.toLowerCase() ?? normProv;
      if (
        protocol.includes("ant-messages") ||
        protocol.includes("claude") ||
        protocol === "anthropic"
      ) {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
      } else if (protocol.includes("gemini") || protocol === "google") {
        headers["x-goog-api-key"] = key;
      } else {
        headers.Authorization = `Bearer ${key}`;
      }
    } else if (normProv === "openai") {
      url = "https://api.openai.com/v1/models";
      headers.Authorization = `Bearer ${key}`;
    } else if (normProv === "anthropic") {
      url = "https://api.anthropic.com/v1/models";
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (normProv === "google" || normProv === "gemini") {
      url = "https://generativelanguage.googleapis.com/v1beta/models";
      headers["x-goog-api-key"] = key;
    } else if (normProv === "groq") {
      url = "https://api.groq.com/openai/v1/models";
      headers.Authorization = `Bearer ${key}`;
    } else if (normProv === "deepseek") {
      url = "https://api.deepseek.com/models";
      headers.Authorization = `Bearer ${key}`;
    } else if (normProv === "openrouter") {
      url = "https://openrouter.ai/api/v1/models";
      headers.Authorization = `Bearer ${key}`;
    } else if (normProv === "mistral") {
      url = "https://api.mistral.ai/v1/models";
      headers.Authorization = `Bearer ${key}`;
    } else {
      return { ok: false, latencyMs: 0, error: "No probe endpoint configured for provider" };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;

    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers,
        signal,
      });
      clearTimeout(timeoutId);
      const latencyMs = Math.max(1, Math.round(performance.now() - start));
      if (res.ok) {
        return { ok: true, latencyMs };
      }
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    } catch {
      clearTimeout(timeoutId);
      const latencyMs = Math.max(1, Math.round(performance.now() - start));
      return {
        ok: false,
        latencyMs,
        error: options.signal?.aborted
          ? "Probe cancelled"
          : controller.signal.aborted
            ? "Probe timed out (5s)"
            : "Probe request failed",
      };
    }
  } catch {
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    return {
      ok: false,
      latencyMs,
      error: "Invalid probe configuration",
    };
  }
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
      for (const m of raw.models) {
        if (!m || typeof m !== "object") continue;
        const provider = typeof m.provider === "string" ? m.provider.toLowerCase().trim() : "";
        const modelId = typeof m.model_id === "string" ? m.model_id.trim() : "";
        if (!provider || !modelId) continue;
        const rawKeysInput =
          "api_keys" in m && m.api_keys !== undefined
            ? m.api_keys
            : "api_key" in m
              ? m.api_key
              : undefined;
        const keys = parseApiKeys(rawKeysInput as string | string[] | undefined);
        if (keys.length === 0) continue;

        const modelRef = `${provider}/${modelId}`;
        const catalog = catalogEntryFor(provider, modelId);
        const clientType = typeof m.client_type === "string" ? m.client_type : catalog?.clientType;
        const env = resolveModelEnv(modelId, clientType);
        const groups = raw.group_defaults;
        const group =
          groups && typeof groups === "object" && provider in groups
            ? (groups as Record<string, unknown>)[provider]
            : undefined;
        const groupBaseUrl =
          group &&
          typeof group === "object" &&
          "default_base_url" in group &&
          typeof group.default_base_url === "string"
            ? group.default_base_url
            : undefined;
        const baseUrl =
          (typeof m.base_url === "string" && m.base_url.trim() ? m.base_url.trim() : undefined) ??
          groupBaseUrl ??
          catalog?.baseUrl ??
          (env ? process.env[env.envBaseUrlKey] : undefined);
        monitor.registerProvider({
          projectId,
          provider,
          modelId,
          modelRef,
          keys,
          strategy: "round-robin",
          probeFn: (probeProvider: string, key: string, signal?: AbortSignal) =>
            probeProviderKey(probeProvider, key, { baseUrl, clientType, signal }),
        });
      }
    }
  } catch (err) {
    deps.log?.(
      `[cockpit-ws] error syncing key fleet for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function refreshProjectRuntimeConfig(
  runtime: ProjectCockpitRuntime,
  deps: CockpitWebSocketDeps = {},
): Promise<void> {
  if (deps.projectConfigService) {
    try {
      const policy = await deps.projectConfigService.getCommandPolicy(runtime.projectId);
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
        runtime.coordinator.shellGuardian.setCustomRules(customRules);
      } else {
        runtime.coordinator.shellGuardian.setCustomRules([]);
      }
    } catch (err) {
      deps.log?.(
        `[cockpit-ws] error updating ShellGuardian rules for project ${runtime.projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await syncProjectKeyFleet(deps, runtime.projectId, runtime.keyFleet);
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
  if (deps.root) {
    requireWorkspaceRoot(deps.root);
    return projectDir(deps.root, projectId);
  }
  return requireWorkspaceRoot(deps.workspaceRoot);
}

function requireWorkspaceRoot(root: string | undefined): string {
  if (!root || !path.isAbsolute(root) || root.includes("\0"))
    throw new Error("Cockpit runtime requires an explicit absolute project or workspace root");
  return path.resolve(root);
}

/**
 * One runtime per resolved workspace directory. The async factory and the sync seams must
 * agree on this key: a bare `projectId` key ignored the root, so `getSharedCodeGraphWatcher`
 * called twice with different roots silently kept the first root's watcher, and the sync
 * seams never matched the async factory's runtimes (see the quorum workaround).
 */
function runtimeKeyFor(workspaceDir: string, projectId: string): string {
  return JSON.stringify([path.resolve(workspaceDir), projectId]);
}

export async function getOrCreateProjectRuntime(
  projectId = DEFAULT_PROJECT_ID,
  deps: CockpitWebSocketDeps = {},
): Promise<ProjectCockpitRuntime> {
  const workspaceDir = resolveProjectWorkspaceDir(deps, projectId);
  const runtimeKey = runtimeKeyFor(workspaceDir, projectId);
  const existing = projectRuntimes.get(runtimeKey);
  if (existing) {
    if (existing.clients.size === 0) {
      scheduleRuntimeReap(existing, deps);
    } else {
      cancelRuntimeReap(existing);
    }
    return existing;
  }

  const inFlight = projectRuntimePromises.get(runtimeKey);
  if (inFlight) {
    return inFlight;
  }

  const creationPromise = (async () => {
    try {
      const codeGraphWatcher = new CodeGraphWatcher(workspaceDir);

      const shellGuardian = await createProjectShellGuardian(deps, projectId);
      const coordinator = new SwarmCoordinator({
        shellGuardian,
        sessionId: `swarm-${projectId}-${Date.now()}`,
      });

      const keyFleet = new KeyFleetMonitor();
      await syncProjectKeyFleet(deps, projectId, keyFleet);

      const clients = new Set<WebSocket>();

      const runtime: ProjectCockpitRuntime = {
        swarmHandlers: deps.swarmHandlers,
        projectId,
        coordinator,
        keyFleet,
        codeGraphWatcher,
        clients,
        eventLog: new CockpitEventLog(),
      };
      projectRuntimes.set(runtimeKey, runtime);

      if (runtime.clients.size === 0) {
        scheduleRuntimeReap(runtime, deps);
      }

      codeGraphWatcher.on("error", (err) => {
        deps.log?.(
          `[cockpit-ws][${projectId}] code graph watcher error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      const unsubCoordinator = coordinator.subscribe((event: SwarmEvent) => {
        publish(runtime, {
          type: "swarm_event",
          projectId,
          timestamp: Date.now(),
          event: redactObject(event),
        });
      });

      const unsubKeyFleet = keyFleet.subscribe((_stats) => {
        publish(runtime, {
          type: "key_fleet_update",
          projectId,
          timestamp: Date.now(),
          keyFleet: redactObject(keyFleet.getCockpitSnapshot()),
          reports: redactObject(keyFleet.getFleetReport()),
          stats: keyFleet.getFleetStats(),
        });
      });

      const onChange = (ev: unknown) => {
        publish(runtime, {
          type: "topology_change",
          projectId,
          timestamp: Date.now(),
          event: ev,
          stats: codeGraphWatcher.getStats(),
        });
      };
      codeGraphWatcher.on("change", onChange);

      runtime.cleanup = () => {
        unsubCoordinator();
        unsubKeyFleet();
        codeGraphWatcher.off?.("change", onChange);
      };

      void codeGraphWatcher.init().catch((err) => {
        deps.log?.(
          `[cockpit-ws][${projectId}] topology initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return runtime;
    } finally {
      projectRuntimePromises.delete(runtimeKey);
    }
  })();

  projectRuntimePromises.set(runtimeKey, creationPromise);
  return creationPromise;
}

function getOrCreateProjectRuntimeSync(
  projectId = DEFAULT_PROJECT_ID,
  workspaceRoot?: string,
): ProjectCockpitRuntime {
  workspaceRoot = requireWorkspaceRoot(workspaceRoot);
  const runtimeKey = runtimeKeyFor(workspaceRoot, projectId);
  let rt = projectRuntimes.get(runtimeKey);
  if (rt) {
    if (rt.clients.size === 0) {
      scheduleRuntimeReap(rt);
    } else {
      cancelRuntimeReap(rt);
    }
    return rt;
  }
  const coordinator = new SwarmCoordinator({
    shellGuardian: new ShellGuardian(),
    sessionId: `swarm-${projectId}-${Date.now()}`,
  });
  const keyFleet = new KeyFleetMonitor();
  const codeGraphWatcher = new CodeGraphWatcher(workspaceRoot);
  codeGraphWatcher.on("error", () => {});
  void codeGraphWatcher.init();
  rt = {
    projectId,
    coordinator,
    keyFleet,
    codeGraphWatcher,
    clients: new Set(),
    eventLog: new CockpitEventLog(),
  };
  projectRuntimes.set(runtimeKey, rt);
  if (rt.clients.size === 0) {
    scheduleRuntimeReap(rt);
  }
  return rt;
}

export function getSharedSwarmCoordinator(
  projectId = DEFAULT_PROJECT_ID,
  workspaceRoot?: string,
): SwarmCoordinator {
  return getOrCreateProjectRuntimeSync(projectId, workspaceRoot).coordinator;
}

export function getSharedKeyFleetMonitor(
  projectId = DEFAULT_PROJECT_ID,
  workspaceRoot?: string,
): KeyFleetMonitor {
  return getOrCreateProjectRuntimeSync(projectId, workspaceRoot).keyFleet;
}

export function getSharedCodeGraphWatcher(
  workspaceRoot?: string,
  projectId = DEFAULT_PROJECT_ID,
): CodeGraphWatcher {
  return getOrCreateProjectRuntimeSync(projectId, workspaceRoot).codeGraphWatcher;
}

export function attachCockpitWebSocket(server: HttpServer, deps: CockpitWebSocketDeps = {}): void {
  // Fail before registering an upgrade listener or creating any runtime resources.
  resolveProjectWorkspaceDir(deps, DEFAULT_PROJECT_ID);
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
    const since = parseSince(url);
    const requestedGeneration = url.searchParams.get("generation");

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

      // The client is registered with the broadcast set only AFTER its backlog has been sent,
      // and the whole block below is synchronous. That ordering is the race fix, not a style
      // preference: if the socket were live first, a `publish` landing between registration and
      // the backlog would deliver a NEW event to a client that has not yet been sent the OLDER
      // events it missed, and the client's applied order would be inverted. Synchronous send,
      // then register: every later event is newer than everything sent so far, always.
      if (since !== undefined) {
        const sameGeneration = requestedGeneration === runtime.eventLog.generation;
        const replay = sameGeneration
          ? runtime.eventLog.since(since)
          : { entries: [], gap: true, missed: null, cursor: runtime.eventLog.cursor };
        if (replay.gap) {
          // The cursor fell out of the bounded window. Say so explicitly and resync from
          // state: a client told "you are behind" plus a fresh snapshot is honest, where a
          // silently truncated replay would look identical to being up to date.
          safeSend(
            ws,
            JSON.stringify({
              type: "cockpit_stream_gap",
              projectId,
              generation: runtime.eventLog.generation,
              missed: replay.missed,
              cursor: replay.cursor,
              reason: sameGeneration ? "outside_replay_window" : "stream_generation_changed",
              timestamp: Date.now(),
            }),
          );
        } else {
          for (const entry of replay.entries) {
            // The retained bytes already carry their own `seq`, so they are forwarded
            // verbatim rather than re-stamped: re-serializing would risk a client applying
            // an event under a sequence number different from the one its gap was measured in.
            safeSend(ws, entry.payload);
          }
          safeSend(
            ws,
            JSON.stringify({
              type: "cockpit_resume",
              projectId,
              generation: runtime.eventLog.generation,
              replayed: replay.entries.length,
              missed: replay.missed,
              cursor: replay.cursor,
              timestamp: Date.now(),
            }),
          );
        }
      }

      // Sent on EVERY connect, including a clean resume. After a resumed backlog this snapshot
      // is redundant state, but it is cheap, it is the same payload the REST path serves, and
      // it means a resumed client is reconciled to server truth by construction rather than by
      // the client correctly having applied every replayed delta — which is the difference
      // between "usually converges" and "is guaranteed to be current".
      const snapshot = buildCockpitSnapshot(
        runtime.coordinator,
        runtime.keyFleet,
        runtime.codeGraphWatcher,
        projectId,
      );
      safeSend(
        ws,
        JSON.stringify({
          ...snapshot,
          seq: runtime.eventLog.cursor,
          generation: runtime.eventLog.generation,
        }),
      );

      runtime.clients.add(ws);

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
            if (!["revive", "cooldown", "evict", "revive_all"].includes(action as string)) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "key_action_rejected",
                  reason: `Invalid or unsupported action '${action}'. Must be one of: revive, cooldown, evict, revive_all`,
                  timestamp: Date.now(),
                }),
              );
              return;
            }

            if (action === "revive_all") {
              runtime.keyFleet.reviveAllCooldowns();
              safeSend(
                ws,
                JSON.stringify({
                  type: "key_action_acknowledged",
                  action,
                  timestamp: Date.now(),
                }),
              );
              return;
            }

            const provider =
              typeof msg.provider === "string" ? msg.provider.trim().toLowerCase() : "";
            const target = resolveKeyTarget(msg);

            if (!provider) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "key_action_rejected",
                  reason: "Provider is required for key action",
                  timestamp: Date.now(),
                }),
              );
              return;
            }

            if (!target) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "key_action_rejected",
                  reason: "keyId or maskedKey is required for key action",
                  timestamp: Date.now(),
                }),
              );
              return;
            }

            if (!runtime.keyFleet.hasKey(provider, target)) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "key_action_rejected",
                  reason: `Key '${target}' not found under provider '${provider}'`,
                  timestamp: Date.now(),
                }),
              );
              return;
            }

            let changed = false;
            if (action === "revive") {
              changed = runtime.keyFleet.reviveKey(provider, target);
            } else if (action === "cooldown") {
              const cooldownMs =
                typeof msg.cooldownMs === "number" && msg.cooldownMs > 0 ? msg.cooldownMs : 60_000;
              changed = runtime.keyFleet.cooldownKey(provider, target, cooldownMs);
            } else if (action === "evict") {
              changed = runtime.keyFleet.evictKey(provider, target);
            }

            safeSend(
              ws,
              JSON.stringify({
                type: "key_action_acknowledged",
                action,
                provider,
                target,
                changed,
                timestamp: Date.now(),
              }),
            );
            return;
          }

          if (msg.type === "send_directive") {
            const from =
              (typeof msg.from === "string" ? msg.from : "operator").trim().slice(0, 64) ||
              "operator";
            const to =
              (typeof msg.to === "string" ? msg.to : "coder").toLowerCase().trim().slice(0, 64) ||
              "coder";
            if (!runtime.coordinator.hasAgent(to)) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "directive_rejected",
                  reason: `Recipient agent '${to}' is not registered in swarm`,
                  timestamp: Date.now(),
                }),
              );
              return;
            }

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
              publish(runtime, {
                type: "directive_dispatched",
                projectId,
                directive: redactObject(directive),
                mailbox: runtime.coordinator.getMailboxSummaries(),
                timestamp: Date.now(),
              });
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
              ? (msg.files
                  .filter((f: unknown) => typeof f === "string" && f.trim())
                  .map((f: string) => f.slice(0, 1024))
                  .slice(0, 50) as string[])
              : undefined;
            const proposedCommands = Array.isArray(msg.proposedCommands)
              ? (msg.proposedCommands
                  .filter((c: unknown) => typeof c === "string" && c.trim())
                  .map((c: string) => c.slice(0, 4096))
                  .slice(0, 20) as string[])
              : undefined;
            const maxRounds =
              typeof msg.maxRounds === "number"
                ? Math.min(Math.max(1, Math.floor(msg.maxRounds)), 10)
                : 3;
            const simulate = msg.simulate === true;

            if (!simulate && !runtime.swarmHandlers?.onExecute) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "swarm_task_rejected",
                  taskId,
                  code: "swarm_handler_missing",
                  status: 400,
                  reason:
                    "No task handler configured for this project; request simulation explicitly.",
                  timestamp: Date.now(),
                }),
              );
              return;
            }

            if (runtime.coordinator.getPendingTaskCount() >= 10) {
              safeSend(
                ws,
                JSON.stringify({
                  type: "swarm_task_rejected",
                  taskId,
                  reason: "Swarm task queue limit reached (10). Project is under backpressure.",
                  status: 429,
                  timestamp: Date.now(),
                }),
              );
              return;
            }

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
              .runTask(
                {
                  id: taskId,
                  goal,
                  files,
                  proposedCommands,
                  maxRounds,
                  simulate,
                },
                runtime.swarmHandlers,
              )
              .then((res: unknown) => {
                if ((res as { status?: string })?.status !== "settled") {
                  publish(runtime, {
                    type: "swarm_task_error",
                    projectId,
                    taskId,
                    error: `Swarm task ended with status: ${(res as { status?: string })?.status ?? "unknown"}`,
                    result: redactObject(res),
                    timestamp: Date.now(),
                  });
                  return;
                }
                publish(runtime, {
                  type: "swarm_task_settled",
                  projectId,
                  taskId,
                  result: redactObject(res),
                  timestamp: Date.now(),
                });
              })
              .catch((err: unknown) => {
                publish(runtime, {
                  type: "swarm_task_error",
                  projectId,
                  taskId,
                  error: err instanceof Error ? err.message : String(err),
                  timestamp: Date.now(),
                });
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
  coordinator: SwarmCoordinator,
  keyFleet: KeyFleetMonitor,
  codeGraphWatcher: CodeGraphWatcher,
  projectId = DEFAULT_PROJECT_ID,
) {
  return {
    type: "cockpit_init",
    projectId,
    scope: "project",
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
