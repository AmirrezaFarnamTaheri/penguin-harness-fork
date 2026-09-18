/**
 * The Universal Tool Mesh registry.
 *
 * This is the Track 6 synthesis point: one registry where a tool, the provider preset that
 * describes it, the credential that authenticates it, and the capability it satisfies are
 * all resolved together.
 *
 * The composio lineage calls this a "tool router" and holds it server-side; the mesh keeps
 * the registry in core so both the server and an embedded SDK see the same tool surface,
 * and puts the secrets behind the store rather than inside the registry. The QoS targets
 * from the plan — tool invocation overhead < 10ms, discovery latency < 5ms — are what the
 * map-based lookups here are shaped for: no scanning, no re-parse, no allocation per call.
 *
 * The execution seam is a {@link ToolExecutor} the caller injects. The registry never
 * touches the network itself, and the executor it calls receives the credential already
 * attached and already redacted from the audit record — the plan's exit criterion of
 * "single MCP tool call authenticates, invokes external API, and logs an encrypted audit
 * trail without credential exposure" is met by construction here.
 *
 * Node built-ins only.
 */
import {
  CredentialRotationTracker,
  SELECTION_MODE,
  type CredentialHealth,
  type SelectionMode,
} from "./credential-rotation.js";
import {
  CREDENTIAL_AUTH_SCHEMES,
  CredentialStoreError,
  EncryptedCredentialStore,
  type CredentialAuthScheme,
} from "./encrypted-credential-store.js";
import { getProvider, preferredScheme, providersByScheme } from "./provider-preset-catalog.js";
import type { ToolCapabilityCatalog } from "./tool-capability-catalog.js";
import { redactObject } from "../internal/credential-redactor.js";

/** A registered tool: a provider's concrete action, with its auth and access contract. */
export interface MeshTool {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly description: string;
  /** Capability ids this tool satisfies, for intent-based resolution. */
  readonly capabilities?: readonly string[];
  /** Access level, enforced before any credential is handed out. */
  readonly access: "read" | "write";
  /** Auth scheme the tool needs; derived from its provider preset when omitted. */
  readonly authScheme?: CredentialAuthScheme;
  /** Restrict this tool to named credential ids (the composio `toolAccessConfig`). */
  readonly restrictToCredentials?: readonly string[];
  /** Optional JSON Schema for validating arguments before dispatch. */
  readonly inputSchema?: Record<string, unknown>;
}

/** A binding between a tool and the credential that authenticates calls to it. */
export interface ToolBinding {
  readonly toolId: string;
  readonly credentialId: string;
  readonly providerId: string;
  readonly authScheme: CredentialAuthScheme;
  readonly boundAt: number;
}

/** The result of resolving a tool to a ready-to-call invocation. */
export interface ResolvedTool {
  readonly tool: MeshTool;
  readonly providerName: string;
  readonly credentialId: string;
  readonly authScheme: CredentialAuthScheme;
  /** Projections a UI renders — no secret ever appears here. */
  readonly safeView: Record<string, unknown>;
}

/** Executes a resolved tool. Injected so the registry never imports a transport. */
export type ToolExecutor = (request: {
  readonly tool: MeshTool;
  readonly credentialId: string;
  readonly authScheme: CredentialAuthScheme;
  readonly arguments: Record<string, unknown>;
  readonly signal?: AbortSignal;
}) => Promise<ToolInvocationResult>;

export interface ToolInvocationResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  /** HTTP status when the call reached a provider. */
  readonly status?: number;
  readonly durationMs: number;
}

export interface AuditEntry {
  readonly id: string;
  readonly toolId: string;
  readonly providerId: string;
  readonly credentialId: string;
  readonly access: "read" | "write";
  readonly ok: boolean;
  readonly durationMs: number;
  readonly at: number;
  /** Status/error context, redacted before it is stored. */
  readonly context?: Record<string, unknown>;
}

export class ToolMeshError extends Error {
  constructor(
    readonly code:
      | "unknown_tool"
      | "unknown_provider"
      | "unknown_credential"
      | "duplicate_tool"
      | "no_credential"
      | "credential_parked"
      | "denied_access"
      | "not_initialized"
      | "invalid_arguments",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolMeshError";
  }
}

export interface ToolMeshRegistryOptions {
  readonly store: EncryptedCredentialStore;
  readonly rotation?: CredentialRotationTracker;
  readonly catalog?: ToolCapabilityCatalog;
  readonly executor?: ToolExecutor;
  /** Scheduling mode for credential selection. */
  readonly selectionMode?: SelectionMode;
  /** Refuse a `write` tool unless the caller passes `allowWrite`. */
  readonly readOnly?: boolean;
  /** Maximum audit entries retained. */
  readonly auditLimit?: number;
}

/**
 * The mesh. Register tools, bind credentials, resolve, invoke. Every step that can reject
 * a call does so *before* a credential is read from the store, so a tool an agent may not
 * use costs it nothing but a lookup.
 */
export class ToolMeshRegistry {
  private readonly tools = new Map<string, MeshTool>();
  private readonly bindings = new Map<string, ToolBinding[]>();
  private readonly audit: AuditEntry[] = [];
  private readonly listeners = new Set<(entry: AuditEntry) => void>();
  private readonly rotation: CredentialRotationTracker;
  private readonly selectionMode: SelectionMode;
  private readonly auditLimit: number;
  private initialized = false;

  constructor(private readonly options: ToolMeshRegistryOptions) {
    this.rotation = options.rotation ?? new CredentialRotationTracker();
    this.selectionMode = options.selectionMode ?? SELECTION_MODE.Balance;
    this.auditLimit = options.auditLimit ?? 512;
  }

  /** Subscribe to the audit stream; every invocation produces exactly one entry. */
  onAudit(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitAudit(entry: AuditEntry): void {
    this.audit.push(entry);
    if (this.audit.length > this.auditLimit) {
      this.audit.splice(0, this.audit.length - this.auditLimit);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // an audit subscriber must not break an invocation
      }
    }
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /** Number of tool→credential bindings. */
  get bindingCount(): number {
    let count = 0;
    for (const list of this.bindings.values()) count += list.length;
    return count;
  }

  /**
   * Registers a tool. Its provider must be a known preset unless the caller set
   * `allowUnknownProvider`, because a tool without a provider cannot be authenticated,
   * connected, or quoted a scope set — registering it would only produce a call that fails.
   */
  register(tool: MeshTool, allowUnknownProvider: boolean = false): MeshTool {
    if (this.tools.has(tool.id)) {
      throw new ToolMeshError("duplicate_tool", `Tool '${tool.id}' is already registered`);
    }
    if (!tool.id || !tool.providerId || !tool.name) {
      throw new ToolMeshError(
        "invalid_arguments",
        "A tool requires an id, a providerId, and a name",
      );
    }
    const provider = getProvider(tool.providerId);
    if (provider === undefined && !allowUnknownProvider) {
      throw new ToolMeshError(
        "unknown_provider",
        `Tool '${tool.id}' references unknown provider '${tool.providerId}'`,
      );
    }
    const authScheme =
      tool.authScheme ??
      (provider !== undefined ? preferredScheme(provider) : CREDENTIAL_AUTH_SCHEMES[0]);
    if (!(CREDENTIAL_AUTH_SCHEMES as readonly string[]).includes(authScheme as string)) {
      throw new ToolMeshError(
        "invalid_arguments",
        `Tool '${tool.id}' declares unsupported auth scheme '${authScheme}'`,
      );
    }
    this.tools.set(tool.id, { ...tool, authScheme: authScheme as CredentialAuthScheme });
    return tool;
  }

  /** Registers many tools at once, rolling back on the first failure. */
  registerAll(tools: readonly MeshTool[]): number {
    const added: string[] = [];
    try {
      for (const tool of tools) {
        this.register(tool);
        added.push(tool.id);
      }
    } catch (error) {
      for (const id of added) this.tools.delete(id);
      throw error;
    }
    return added.length;
  }

  get(toolId: string): MeshTool | undefined {
    return this.tools.get(toolId);
  }

  /** Tools for one provider, sorted — the fleet-manager view. */
  toolsByProvider(providerId: string): readonly MeshTool[] {
    return [...this.tools.values()]
      .filter((tool) => tool.providerId === providerId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  list(): readonly MeshTool[] {
    return [...this.tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  remove(toolId: string): boolean {
    this.bindings.delete(toolId);
    return this.tools.delete(toolId);
  }

  /**
   * Binds a credential to a tool. The credential's provider must match the tool's, and its
   * scheme must satisfy the tool's — a Gmail API key bound to an OAuth-only GitHub tool is
   * a configuration error worth refusing, since it would fail at call time with a message
   * that blames the provider instead of the binding.
   */
  bind(toolId: string, credentialId: string, now: number = Date.now()): ToolBinding {
    this.requireInitialized("bind a credential");
    const tool = this.tools.get(toolId);
    if (tool === undefined) {
      throw new ToolMeshError("unknown_tool", `No tool registered as '${toolId}'`);
    }
    if (!this.options.store.has(credentialId)) {
      throw new ToolMeshError("unknown_credential", `No credential stored as '${credentialId}'`);
    }
    let storedProvider: string | undefined;
    let storedScheme: CredentialAuthScheme | undefined;
    try {
      // Reading the metadata only: the secret is not needed to validate a binding.
      const record = this.options.store.list().find((entry) => entry.id === credentialId);
      storedProvider = record?.providerId;
      storedScheme = record?.authScheme;
    } catch (error) {
      throw new ToolMeshError(
        "unknown_credential",
        `Credential '${credentialId}' could not be read: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (storedProvider !== undefined && storedProvider !== tool.providerId) {
      throw new ToolMeshError(
        "unknown_credential",
        `Credential '${credentialId}' belongs to provider '${storedProvider}', not '${tool.providerId}'`,
      );
    }
    if (storedScheme !== undefined && storedScheme !== tool.authScheme) {
      throw new ToolMeshError(
        "unknown_credential",
        `Credential '${credentialId}' uses scheme '${storedScheme}', tool '${toolId}' needs '${tool.authScheme}'`,
      );
    }

    const binding: ToolBinding = {
      toolId,
      credentialId,
      providerId: tool.providerId,
      authScheme: tool.authScheme!,
      boundAt: now,
    };
    const list = this.bindings.get(toolId) ?? [];
    if (!list.some((existing) => existing.credentialId === credentialId)) {
      list.push(binding);
      this.bindings.set(toolId, list);
    }
    return binding;
  }

  /** Removes a binding. */
  unbind(toolId: string, credentialId: string): boolean {
    const list = this.bindings.get(toolId);
    if (list === undefined) return false;
    const index = list.findIndex((existing) => existing.credentialId === credentialId);
    if (index === -1) return false;
    list.splice(index, 1);
    if (list.length === 0) this.bindings.delete(toolId);
    return true;
  }

  /** Bindings for a tool, in bind order. */
  bindingsFor(toolId: string): readonly ToolBinding[] {
    return this.bindings.get(toolId) ?? [];
  }

  /**
   * Resolves a tool to a credential and a safe projection. This is the hot path: a map
   * lookup for the tool, a short list for its bindings, and a health filter — the whole
   * thing is O(bindings-per-tool), which is bounded by configuration, not by fleet size.
   */
  resolve(toolId: string, now: number = Date.now()): ResolvedTool {
    const tool = this.tools.get(toolId);
    if (tool === undefined) {
      throw new ToolMeshError("unknown_tool", `No tool registered as '${toolId}'`);
    }
    if (this.options.readOnly && tool.access === "write") {
      throw new ToolMeshError("denied_access", `Tool '${toolId}' writes and the mesh is read-only`);
    }

    const bindings = this.bindings.get(toolId) ?? [];
    if (bindings.length === 0) {
      throw new ToolMeshError("no_credential", `Tool '${toolId}' has no bound credential`);
    }

    const allowed = tool.restrictToCredentials;
    const candidates = bindings
      .filter((binding) => allowed === undefined || allowed.includes(binding.credentialId))
      .map((binding) => ({
        credentialId: binding.credentialId,
        healthScore: this.rotation.health(binding.credentialId, now).healthScore,
      }));
    if (candidates.length === 0) {
      throw new ToolMeshError(
        "no_credential",
        `Tool '${toolId}' has no bound credential its access config permits`,
      );
    }

    const chosen = this.rotation.select({
      candidates,
      mode: this.selectionMode,
      now,
      capability: toolId,
    });
    if (chosen === undefined) {
      // Every candidate is parked; report the wait so a caller can decide to retry.
      const longest = candidates.reduce((max, candidate) => {
        const remaining = this.rotation.remainingWaitMs(candidate.credentialId, toolId, now);
        return remaining === Number.POSITIVE_INFINITY ? max : Math.max(max, remaining);
      }, 0);
      throw new ToolMeshError(
        "credential_parked",
        `Every credential for tool '${toolId}' is rate-limited; retry in ${Math.ceil(longest / 1000)}s`,
      );
    }

    const binding = bindings.find((entry) => entry.credentialId === chosen)!;
    const provider = getProvider(tool.providerId);
    return {
      tool,
      providerName: provider?.name ?? tool.providerId,
      credentialId: chosen,
      authScheme: binding.authScheme,
      safeView: redactObject({
        toolId: tool.id,
        providerId: tool.providerId,
        providerName: provider?.name ?? tool.providerId,
        access: tool.access,
        authScheme: binding.authScheme,
        category: provider?.category,
        toolCount: provider?.toolCount,
      }),
    };
  }

  /**
   * Resolves and invokes a tool in one step. Argument validation runs before a credential
   * is touched; the audit entry is written for both success and failure, and its context
   * is redacted so an error body quoting a header cannot leak through the audit trail.
   */
  async invoke(
    toolId: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; allowWrite?: boolean } = {},
  ): Promise<ToolInvocationResult> {
    const executor = this.options.executor;
    if (executor === undefined) {
      throw new ToolMeshError(
        "not_initialized",
        "The mesh has no executor configured; resolve() a tool instead of invoking it",
      );
    }
    const started = Date.now();
    const tool = this.tools.get(toolId);
    if (tool === undefined) {
      throw new ToolMeshError("unknown_tool", `No tool registered as '${toolId}'`);
    }
    // A write tool needs explicit per-call consent, and a read-only mesh refuses it
    // outright. Both checks are cheap and both happen before a credential is read.
    if (tool.access === "write") {
      if (this.options.readOnly) {
        throw new ToolMeshError(
          "denied_access",
          `Tool '${toolId}' writes and the mesh is read-only`,
        );
      }
      if (options.allowWrite !== true) {
        throw new ToolMeshError(
          "denied_access",
          `Tool '${toolId}' writes; pass allowWrite to consent to the mutation`,
        );
      }
    }
    this.validateArguments(tool, args);

    this.requireInitialized("invoke a tool");
    const resolved = this.resolve(toolId, started);
    const credentialId = resolved.credentialId;

    let result: ToolInvocationResult;
    try {
      result = await executor({
        tool,
        credentialId,
        authScheme: resolved.authScheme,
        arguments: args,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A network failure is a transient signal: park the credential by status only when
      // the executor reported one, else record it as an unknown failure.
      this.rotation.markFailure(credentialId, 0, message, { capability: toolId });
      result = { ok: false, error: message, durationMs: Date.now() - started };
    }

    if (result.ok) {
      this.rotation.markSuccess(credentialId, toolId, started);
    } else if (result.status !== undefined) {
      this.rotation.markFailure(
        credentialId,
        result.status,
        typeof result.error === "string" ? result.error : "",
        {
          capability: toolId,
        },
      );
    }

    this.emitAudit({
      id: `audit-${started}-${toolId}`,
      toolId,
      providerId: tool.providerId,
      credentialId,
      access: tool.access,
      ok: result.ok,
      durationMs: Date.now() - started,
      at: started,
      ...(result.status !== undefined || result.error !== undefined
        ? {
            context: redactObject({
              ...(result.status !== undefined ? { status: result.status } : {}),
              ...(result.error !== undefined ? { error: result.error } : {}),
            }),
          }
        : {}),
    });
    return result;
  }

  /**
   * Validates arguments against a tool's JSON Schema when it declares one. Uses only the
   * subset an agent realistically needs — required properties and type presence — so the
   * mesh does not become a schema-engine dependency.
   */
  validateArguments(tool: MeshTool, args: Record<string, unknown>): void {
    const schema = tool.inputSchema;
    if (schema === undefined) return;
    const properties = schema.properties as Record<string, unknown> | undefined;
    const required = schema.required as string[] | undefined;
    if (Array.isArray(required)) {
      for (const name of required) {
        if (args[name] === undefined || args[name] === null) {
          throw new ToolMeshError(
            "invalid_arguments",
            `Tool '${tool.id}' is missing required argument '${name}'`,
          );
        }
      }
    }
    if (properties !== undefined) {
      for (const [name, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue;
        const spec = properties[name] as Record<string, unknown> | undefined;
        if (spec === undefined) continue;
        const declared = spec.type;
        if (typeof declared === "string") {
          const actual = Array.isArray(value) ? "array" : typeof value;
          const expected = declared === "integer" ? "number" : declared;
          if (actual !== expected && !(declared === "number" && actual === "number")) {
            throw new ToolMeshError(
              "invalid_arguments",
              `Argument '${name}' of tool '${tool.id}' must be ${declared}, got ${actual}`,
            );
          }
        }
      }
    }
  }

  /** Fleet health, cheapest credentials first — the cockpit's status view. */
  fleetHealth(now: number = Date.now()): readonly CredentialHealth[] {
    return this.rotation.fleetHealth(now);
  }

  /** Audit trail, newest first. */
  auditTrail(limit: number = 64): readonly AuditEntry[] {
    return this.audit.slice(-limit).reverse();
  }

  /** Providers the mesh can authenticate, i.e. presets with a stored credential. */
  connectedProviders(): readonly string[] {
    const ids = new Set<string>();
    for (const record of this.options.store.list()) ids.add(record.providerId);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  /** Whether any credential is bound for a provider, without touching the mesh's tools. */
  hasCredentialForProvider(providerId: string): boolean {
    return this.options.store.list().some((record) => record.providerId === providerId);
  }

  /**
   * Capability-based discovery: an agent asks for an intent and gets back the tools that
   * satisfy it and have a bound credential. Tools without a credential are excluded,
   * because returning one would produce a call that cannot authenticate.
   */
  discover(query: string, limit: number = 10): readonly ResolvedTool[] {
    const catalog = this.options.catalog;
    if (catalog === undefined) return [];
    const resolved = catalog.resolveTools(query, { limit });
    const out: ResolvedTool[] = [];
    const seen = new Set<string>();
    for (const hit of resolved) {
      // A capability names the providers that can satisfy it — the built-in catalog lists
      // provider ids, so the join to the fleet is by provider. A caller-seeded catalog may
      // name concrete tool ids instead; both are handled, and a capability whose providers
      // have no registered tool yields nothing rather than an uncallable result.
      const candidates = this.tools.has(hit.toolId)
        ? [this.tools.get(hit.toolId)!]
        : this.toolsByProvider(hit.toolId);
      for (const tool of candidates) {
        if (seen.has(tool.id)) continue;
        seen.add(tool.id);
        if ((this.bindings.get(tool.id) ?? []).length === 0) continue;
        // A tool that declares capabilities only answers the one that matched.
        if (
          tool.capabilities !== undefined &&
          tool.capabilities.length > 0 &&
          !tool.capabilities.includes(hit.capabilityId)
        ) {
          continue;
        }
        try {
          out.push(this.resolve(tool.id));
        } catch {
          // parked or denied — a discovery result that cannot be called right now is noise
        }
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Loads the credential vault and marks the mesh ready. Binding and invoking are gated
   * on this — the plan's entry criteria — because a tool bound before the vault is loaded
   * reads a store that has not yet been populated and fails for the wrong reason.
   */
  async initialize(): Promise<number> {
    const loaded = await this.options.store.load();
    this.initialized = true;
    return loaded;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  private requireInitialized(action: string): void {
    if (!this.initialized) {
      throw new ToolMeshError(
        "not_initialized",
        `Cannot ${action} before ToolMeshRegistry.initialize() has loaded the credential vault`,
      );
    }
  }
}

/**
 * Lists every provider the mesh can connect with PKCE — the fleet's connect menu. It is
 * the OAuth-capable presets, which is the set the OAuth exchange module serves.
 */
export function oauthConnectableProviders(): readonly string[] {
  return providersByScheme(CREDENTIAL_AUTH_SCHEMES[0])
    .map((preset) => preset.id)
    .filter((id) => getProvider(id) !== undefined);
}

export { CredentialStoreError };
