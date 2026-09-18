/**
 * The tool fleet service: the server's facade over the Universal Tool Mesh.
 *
 * This is the one object the server's routes talk to. It wires the layers the Track 6
 * synthesis requires — vault, PKCE exchange, rotation, refresh, CLI wrapping, audit — and
 * presents them as the operations the cockpit actually needs:
 *
 *  - connect a provider (PKCE handshake → stored credential),
 *  - discover tools by intent,
 *  - invoke a tool with a resolved credential,
 *  - synthesize a CLI command from a manifest,
 *  - report fleet health and the audit trail.
 *
 * The exit criterion from the plan is `invoke()`: one call authenticates from the vault,
 * dispatches through the executor, and lands an audit record with the credential redacted.
 */
import {
  CredentialRotationTracker,
  SELECTION_MODE,
  ToolMeshError,
  ToolMeshRegistry,
  createBuiltinCapabilityCatalog,
  getProvider,
  invokeCli,
  preferredScheme,
  providersByScheme,
  type CliCommandManifest,
  type CredentialAuthScheme,
  type InvokeOptions,
  type InvokeResult,
  type MeshTool,
  type PkceProviderConfig,
  type ResolvedTool,
  type ToolExecutor,
  type ToolInvocationResult,
} from "@prismshadow/penguin-core";

import { FleetInvocationAudit, type FleetAuditEntry } from "./fleet-invocation-audit.js";
import { FleetKeymaster, type CredentialItem } from "./fleet-keymaster.js";
import {
  FleetTokenRefreshScheduler,
  type RefreshTransport,
} from "./fleet-token-refresh-scheduler.js";

export interface ToolFleetServiceOptions {
  /** Vault master passphrase; defaults to the machine-bound value. */
  masterKey?: string;
  /** Vault file path. */
  vaultPath?: string;
  /** Audit trail file path. */
  auditPath?: string;
  /** Refresh tick interval. */
  refreshTickMs?: number;
  /** Scheduling mode for credential selection. */
  selectionMode?: (typeof SELECTION_MODE)[keyof typeof SELECTION_MODE];
  /** Refuse write tools entirely. */
  readOnly?: boolean;
  /**
   * The dispatcher the mesh calls once a credential is resolved. Without one, invoke() only
   * resolves — the plan's exit criterion is a call that actually reaches a provider, so the
   * service takes the executor the server's transport layer supplies.
   */
  executor?: ToolExecutor;
}

/** A provider ready to connect, as the cockpit's connect menu shows it. */
export interface ConnectableProvider {
  id: string;
  name: string;
  category: string;
  authScheme: CredentialAuthScheme;
  toolCount: number;
  /** Field a tenant-hosted provider needs from the user before connecting. */
  baseUrlField?: string;
  /** Default OAuth scopes the provider documents. */
  defaultScopes?: readonly string[];
  /** Whether at least one credential is already stored. */
  connected: boolean;
}

export interface FleetHealthSummary {
  providers: number;
  connectedProviders: number;
  credentials: number;
  tools: number;
  bindings: number;
  parked: number;
  evicted: number;
  expiringSoon: number;
  invocations: number;
  invocationFailures: number;
  meanDurationMs: number;
}

export class ToolFleetService {
  private readonly keymaster: FleetKeymaster;
  private readonly audit: FleetInvocationAudit;
  private readonly registry: ToolMeshRegistry;
  private readonly rotation: CredentialRotationTracker;
  private readonly refresh: FleetTokenRefreshScheduler;
  private readonly capabilities = createBuiltinCapabilityCatalog();

  constructor(
    private readonly transport: RefreshTransport,
    options: ToolFleetServiceOptions = {},
  ) {
    this.keymaster = new FleetKeymaster({
      ...(options.masterKey !== undefined ? { masterKey: options.masterKey } : {}),
      ...(options.vaultPath !== undefined ? { filePath: options.vaultPath } : {}),
    });
    this.audit = new FleetInvocationAudit({
      ...(options.auditPath !== undefined ? { filePath: options.auditPath } : {}),
    });
    this.rotation = new CredentialRotationTracker();
    this.registry = new ToolMeshRegistry({
      store: this.keymaster.getStore(),
      rotation: this.rotation,
      catalog: this.capabilities,
      selectionMode: options.selectionMode ?? SELECTION_MODE.Balance,
      readOnly: options.readOnly ?? false,
      ...(options.executor !== undefined ? { executor: options.executor } : {}),
    });
    this.refresh = new FleetTokenRefreshScheduler(this.keymaster, this.transport, {
      ...(options.refreshTickMs !== undefined ? { tickMs: options.refreshTickMs } : {}),
    });
  }

  /** Boots the fleet: loads the vault and the trail, then seeds the refresh schedule. */
  async initialize(): Promise<{ credentials: number; auditEntries: number }> {
    const credentials = await this.keymaster.load();
    const auditEntries = await this.audit.load();
    await this.registry.initialize();
    return { credentials, auditEntries };
  }

  /** The mesh registry, for callers that resolve tools themselves. */
  getRegistry(): ToolMeshRegistry {
    return this.registry;
  }

  /** The keymaster, for the routes that manage credentials. */
  getKeymaster(): FleetKeymaster {
    return this.keymaster;
  }

  /** The audit trail. */
  getAudit(): FleetInvocationAudit {
    return this.audit;
  }

  /** Registers a provider's OAuth config, enabling both connect and refresh. */
  registerProviderConfig(config: PkceProviderConfig): void {
    this.refresh.registerProviderConfig(config);
  }

  /**
   * Lists the providers the fleet can connect, OAuth-capable first. `connected` is derived
   * from the vault, so this is the single source of truth for "what can I use right now".
   */
  listConnectableProviders(): readonly ConnectableProvider[] {
    return providersByScheme("OAUTH2").map((preset) => {
      const provider: ConnectableProvider = {
        id: preset.id,
        name: preset.name,
        category: preset.category,
        // Every preset in this list is OAuth2-capable by construction, so the fallback is
        // unreachable in practice — it is here because the type allows a scheme-less preset.
        authScheme: preferredScheme(preset) ?? "OAUTH2",
        toolCount: preset.toolCount,
        ...(preset.defaultScopes !== undefined ? { defaultScopes: preset.defaultScopes } : {}),
        connected: this.keymaster.credentialsForProvider(preset.id).length > 0,
      };
      return provider;
    });
  }

  /** Registers a tool and, when it writes, flags it so callers consent explicitly. */
  registerTool(tool: MeshTool): MeshTool {
    return this.registry.register(tool);
  }

  /** Registers many tools, rolling back on the first failure. */
  registerTools(tools: readonly MeshTool[]): number {
    return this.registry.registerAll(tools);
  }

  /** Binds a stored credential to a tool. */
  bind(toolId: string, credentialId: string): void {
    this.registry.bind(toolId, credentialId);
  }

  /** Intent-based discovery: tools with a bound credential that satisfy the request. */
  discover(query: string, limit: number = 10): readonly ResolvedTool[] {
    return this.registry.discover(query, limit);
  }

  /** Resolves a tool without invoking it — for a dry-run or a permission prompt. */
  resolve(toolId: string): ResolvedTool {
    return this.registry.resolve(toolId);
  }

  /**
   * Invokes a tool. This is the plan's exit-criterion call: the credential is resolved from
   * the vault, the executor dispatches, and the audit record is written with context
   * already redacted. A failure is recorded too — an audit with a hole where the
   * interesting entry belongs is not an audit.
   */
  async invoke(
    toolId: string,
    args: Record<string, unknown>,
    options: { allowWrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<ToolInvocationResult> {
    const result = await this.registry.invoke(toolId, args, options);
    const tool = this.registry.get(toolId);
    await this.audit.record({
      at: Date.now(),
      toolId,
      providerId: tool?.providerId ?? "unknown",
      credentialId: result.ok
        ? (this.registry.bindingsFor(toolId)[0]?.credentialId ?? "unknown")
        : "unknown",
      access: tool?.access ?? "read",
      ok: result.ok,
      durationMs: result.durationMs,
      ...(result.status !== undefined || result.error !== undefined
        ? {
            context: {
              ...(result.status !== undefined ? { status: result.status } : {}),
              ...(result.error !== undefined ? { error: result.error } : {}),
            },
          }
        : {}),
    });
    return result;
  }

  /** Subscribes to the mesh's own audit stream and mirrors it into the fleet trail. */
  mirrorMeshAudit(): () => void {
    return this.registry.onAudit(async (entry) => {
      await this.audit.record({
        at: entry.at,
        toolId: entry.toolId,
        providerId: entry.providerId,
        credentialId: entry.credentialId,
        access: entry.access,
        ok: entry.ok,
        durationMs: entry.durationMs,
        ...(entry.context !== undefined ? { context: entry.context } : {}),
      });
    });
  }

  /**
   * Synthesizes and runs a CLI command from a manifest. Returns the result and the redacted
   * argv, so a caller can log what ran without logging a secret the manifest marked.
   */
  async invokeCli(
    manifest: CliCommandManifest,
    values: Record<string, unknown>,
    options: InvokeOptions = {},
  ): Promise<InvokeResult> {
    const runner = invokeCli(manifest, values, options);
    const result = await runner.result;
    await this.audit.record({
      at: Date.now(),
      toolId: manifest.id,
      providerId: manifest.providerId,
      credentialId: "cli",
      access: manifest.access,
      ok: result.exitCode === 0,
      durationMs: result.durationMs,
      context: { argv: result.argv, exitCode: result.exitCode },
    });
    return result;
  }

  /** Fleet health for the cockpit's status panel. */
  health(now: number = Date.now()): FleetHealthSummary {
    const stats = this.audit.stats();
    const connected = new Set<string>();
    for (const credential of this.keymaster.listCredentials(now)) {
      connected.add(credential.providerId);
    }
    return {
      providers: providersByScheme("OAUTH2").length,
      connectedProviders: connected.size,
      credentials: this.keymaster.listCredentials(now).length,
      tools: this.registry.size,
      bindings: this.registry.bindingCount,
      parked: this.rotation.parkedCount,
      evicted: this.rotation.evictedCount,
      expiringSoon: this.keymaster.expiringSoon(now).length,
      invocations: stats.total,
      invocationFailures: stats.failures,
      meanDurationMs: stats.meanDurationMs,
    };
  }

  /** Recent audit entries, newest first. */
  auditTrail(limit: number = 64): readonly FleetAuditEntry[] {
    return this.audit.query({ limit });
  }

  /** Credentials as the API describes them: metadata only, never a secret. */
  listCredentials(now: number = Date.now()): readonly CredentialItem[] {
    return this.keymaster.listCredentials(now);
  }

  /** Starts the background refresh loop. */
  startRefreshLoop(): void {
    this.refresh.start();
  }

  /** Stops the refresh loop. */
  stopRefreshLoop(): void {
    this.refresh.stop();
  }

  /** Refresh scheduler, for the routes that report refresh health. */
  getRefreshScheduler(): FleetTokenRefreshScheduler {
    return this.refresh;
  }

  /** Releases vault keys and stops the refresh loop. For a clean shutdown. */
  dispose(): void {
    this.refresh.stop();
    this.keymaster.dispose();
  }
}

export {
  FleetKeymaster,
  FleetTokenRefreshScheduler,
  FleetInvocationAudit,
  getProvider,
  ToolMeshError,
};
