/**
 * ToolFleetService integration tests: the server's facade over the Universal Tool Mesh.
 *
 * The plan's Track 6 exit criterion is one call that "authenticates, invokes external API,
 * and logs an encrypted audit trail without credential exposure", so the headline test here
 * walks that whole path: a secret goes into the vault, a tool is registered and bound, the
 * call dispatches through the injected executor with the credential already resolved, and
 * the audit trail carries the outcome but never the value.
 *
 * Everything under the facade is real — a real vault file, a real sealed audit file, a real
 * child process for `invokeCli`. Only the two things the service is *given* are faked: the
 * refresh transport (no socket is opened) and the executor (no provider is called).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  providersByScheme,
  type CliCommandManifest,
  type CredentialAuthScheme,
  type MeshTool,
  type PkceProviderConfig,
  type TokenResponse,
} from "@prismshadow/penguin-core";

import {
  FleetKeymaster,
  ToolFleetService,
  type RefreshTransport,
  type ToolFleetServiceOptions,
} from "../../src/services/tool-fleet/index.js";

const MASTER = "fleet-service-master-passphrase";
const NOW = 5_000_000;
/** A github-shaped value, so a redaction rule can recognize it if one ever leaks. */
const SECRET = "ghp_live_secret_abcdef0123456789abcdef0123456789";

const GITHUB_CONFIG: PkceProviderConfig = {
  providerId: "github",
  clientId: "gh-client",
  clientSecret: "gh-secret",
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  redirectUri: "http://127.0.0.1:7364/callback",
  defaultScopes: ["repo", "user"],
};

const READ_TOOL: MeshTool = {
  id: "github_list_issues",
  providerId: "github",
  name: "List issues",
  description: "List issues or tickets in a tracker",
  access: "read",
  authScheme: "API_KEY",
  capabilities: ["issue.list"],
};

/** A second read tool on the same credential, for scenarios that need a different outcome. */
const FLAKY_TOOL: MeshTool = {
  id: "github_list_prs",
  providerId: "github",
  name: "List pull requests",
  description: "List open pull requests",
  access: "read",
  authScheme: "API_KEY",
  capabilities: ["pull_request.list"],
};

const WRITE_TOOL: MeshTool = {
  id: "github_create_issue",
  providerId: "github",
  name: "Create an issue",
  description: "Open an issue in a repository",
  access: "write",
  authScheme: "API_KEY",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
      body: { type: "string" },
    },
  },
};

/** A transport that answers a token refresh instead of opening a socket. */
function makeTransport(): RefreshTransport {
  return {
    async post() {
      return {
        status: 200,
        async json() {
          return {
            access_token: "rotated-tok",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rotated-refresh",
          };
        },
      };
    },
  };
}

async function makeDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pnmesh-service-"));
}

interface RecordedCall {
  tool: MeshTool;
  credentialId: string;
  authScheme: CredentialAuthScheme;
  arguments: Record<string, unknown>;
  /** The value the mesh's credential id resolved to, read through the vault. */
  resolvedSecret: string;
}

/** The result an executor returns: a fixed shape, or one that varies by tool. */
type OutcomeSpec =
  | Partial<{ ok: boolean; status: number; error: string; durationMs: number }>
  | ((
      toolId: string,
    ) => Partial<{ ok: boolean; status: number; error: string; durationMs: number }>);

/**
 * A facade whose executor records what the mesh handed it. The service builds its own
 * keymaster, so the executor reads the vault through the service's instance — captured here
 * after construction, before any invocation can run.
 */
async function makeRecordingService(
  dir: string,
  outcome: OutcomeSpec = {},
  options: ToolFleetServiceOptions = {},
): Promise<{ service: ToolFleetService; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const holder: { keymaster: FleetKeymaster } = {
    keymaster: undefined as unknown as FleetKeymaster,
  };
  const service = new ToolFleetService(makeTransport(), {
    masterKey: MASTER,
    vaultPath: path.join(dir, "vault.json"),
    auditPath: path.join(dir, "audit.bin"),
    ...options,
    executor: async (request) => {
      const resolvedSecret = await holder.keymaster.getSecret(request.credentialId);
      calls.push({ ...request, resolvedSecret });
      const extra = typeof outcome === "function" ? outcome(request.tool.id) : outcome;
      return { ok: true, durationMs: 1, ...extra };
    },
  });
  holder.keymaster = service.getKeymaster();
  await service.initialize();
  return { service, calls };
}

/** A facade with no executor, for the paths that must fail before dispatch. */
async function makeService(
  dir: string,
  options: ToolFleetServiceOptions = {},
  configure: { initialize?: boolean } = {},
): Promise<ToolFleetService> {
  const service = new ToolFleetService(makeTransport(), {
    masterKey: MASTER,
    vaultPath: path.join(dir, "vault.json"),
    auditPath: path.join(dir, "audit.bin"),
    ...options,
  });
  if (configure.initialize !== false) await service.initialize();
  return service;
}

/**
 * Registers a tool that needs an API key, stores one, and binds them. A second tool on the
 * same provider reuses the stored key rather than adding a credential, so a scenario that
 * binds two tools still has exactly one credential to report on.
 */
async function bindGithubKey(service: ToolFleetService, tool: MeshTool): Promise<string> {
  if (service.getRegistry().get(tool.id) === undefined) service.registerTool(tool);
  const existing = service.getKeymaster().credentialsForProvider("github")[0];
  const credentialId =
    existing !== undefined
      ? existing.id
      : (await service.getKeymaster().storeSecret("github", "API_KEY", SECRET)).id;
  service.bind(tool.id, credentialId);
  return credentialId;
}

/** Polls the trail until it holds at least `count` entries, so an async audit subscriber lands. */
async function untilTrailHolds(service: ToolFleetService, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (service.auditTrail().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ToolFleetService", () => {
  const dirs: string[] = [];
  const services: ToolFleetService[] = [];

  afterEach(async () => {
    for (const service of services) {
      try {
        service.dispose();
      } catch {
        // a disposed facade is the desired end state
      }
    }
    services.length = 0;
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("exposes the pieces it wires together", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    expect(service.getKeymaster()).toBeInstanceOf(FleetKeymaster);
    expect(service.getAudit().size).toBe(0);
    expect(service.getRegistry().size).toBe(0);
    expect(service.getRefreshScheduler().isRunning).toBe(false);
  });

  it("initializes an empty fleet on first boot", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    expect(await service.initialize()).toEqual({ credentials: 0, auditEntries: 0 });
    expect(service.getRegistry().isInitialized).toBe(true);
    expect(service.health().providers).toBe(providersByScheme("OAUTH2").length);
  });

  it("reloads a vault and audit trail an earlier instance wrote to disk", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const vaultPath = path.join(dir, "vault.json");
    const auditPath = path.join(dir, "audit.bin");
    let credentialId: string;
    {
      const { service, calls } = await makeRecordingService(dir, {}, { vaultPath, auditPath });
      services.push(service);
      credentialId = await bindGithubKey(service, READ_TOOL);
      await service.invoke(READ_TOOL.id, {});
      expect(calls).toHaveLength(1);
      expect(service.auditTrail()).toHaveLength(1);
    }
    {
      const second = await makeService(dir, { vaultPath, auditPath });
      services.push(second);
      expect(await second.initialize()).toEqual({ credentials: 1, auditEntries: 1 });
      expect(second.auditTrail()[0]!.toolId).toBe(READ_TOOL.id);
      // The secret the first instance stored survives on disk, under the same master key.
      expect(await second.getKeymaster().getSecret(credentialId)).toBe(SECRET);
    }
  });

  it("registerTool rejects a tool whose provider is not a known preset", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    expect(() =>
      service.registerTool({
        id: "nope_tool",
        providerId: "not-a-provider",
        name: "Nope",
        description: "Nothing",
        access: "read",
      }),
    ).toThrow(/references unknown provider/);
  });

  it("registerTool rejects a duplicate tool id", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    service.registerTool(READ_TOOL);
    expect(() => service.registerTool(READ_TOOL)).toThrow(/already registered/);
  });

  it("registerTools rolls the batch back when a row is invalid", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    expect(() =>
      service.registerTools([
        READ_TOOL,
        WRITE_TOOL,
        {
          id: "bad_tool",
          providerId: "not-a-provider",
          name: "Bad",
          description: "Nothing",
          access: "read",
        },
      ]),
    ).toThrow(/references unknown provider/);
    // Nothing from the batch survived the failure.
    expect(service.getRegistry().size).toBe(0);
  });

  it("bind refuses before initialize() has loaded the vault", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir, {}, { initialize: false });
    services.push(service);
    service.registerTool(READ_TOOL);
    expect(() => service.bind(READ_TOOL.id, "cred_nope")).toThrow(
      /Cannot bind a credential before/,
    );
  });

  it("bind refuses a credential whose provider or scheme does not match the tool", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    service.registerTool(READ_TOOL);
    // A slack key cannot authenticate a github tool.
    const slack = await service.getKeymaster().storeSecret("slack", "API_KEY", "slack-key");
    expect(() => service.bind(READ_TOOL.id, slack.id)).toThrow(/belongs to provider/);
    // An OAUTH2 github token cannot authenticate a tool that declared API_KEY.
    const oauth = await service.getKeymaster().storeSecret("github", "OAUTH2", "oauth-tok");
    expect(() => service.bind(READ_TOOL.id, oauth.id)).toThrow(/uses scheme/);
    expect(service.getRegistry().bindingCount).toBe(0);
  });

  it("invoke resolves the credential, dispatches through the executor, and audits without exposing the secret", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service, calls } = await makeRecordingService(dir);
    services.push(service);
    const credentialId = await bindGithubKey(service, READ_TOOL);
    expect(service.getRegistry().bindingCount).toBe(1);

    const result = await service.invoke(READ_TOOL.id, { owner: "prism-shadow", limit: 10 });

    expect(result.ok).toBe(true);
    // The executor received the bound credential and the arguments the caller passed...
    expect(calls).toHaveLength(1);
    expect(calls[0]!.credentialId).toBe(credentialId);
    expect(calls[0]!.authScheme).toBe("API_KEY");
    expect(calls[0]!.tool.id).toBe(READ_TOOL.id);
    expect(calls[0]!.arguments).toEqual({ owner: "prism-shadow", limit: 10 });
    // ...and that id is a real key in the vault, resolving to the stored value.
    expect(calls[0]!.resolvedSecret).toBe(SECRET);

    // Exactly one audit entry, naming the tool, the provider, and the credential it used.
    const trail = service.auditTrail();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      toolId: READ_TOOL.id,
      providerId: "github",
      credentialId,
      access: "read",
      ok: true,
    });
    // The value never reaches any of the three surfaces an API or a UI would render.
    expect(JSON.stringify(service.auditTrail())).not.toContain(SECRET);
    expect(JSON.stringify(service.listCredentials())).not.toContain(SECRET);
    expect(JSON.stringify(service.health())).not.toContain(SECRET);
  });

  it("invoke writes exactly one audit entry per call, for a success and a failure", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    // Two read tools on one credential, so the failing call does not park the credential the
    // next call needs — a failure with a status marks the rotation tracker, and a second
    // resolve of the same tool would then be refused rather than audited.
    const { service } = await makeRecordingService(dir, (toolId) =>
      toolId === FLAKY_TOOL.id ? { ok: false, status: 503, error: "upstream down" } : {},
    );
    services.push(service);
    const credentialId = await bindGithubKey(service, READ_TOOL);
    await bindGithubKey(service, FLAKY_TOOL);

    const ok = await service.invoke(READ_TOOL.id, {});
    const failed = await service.invoke(FLAKY_TOOL.id, {});

    expect(ok.ok).toBe(true);
    expect(failed.ok).toBe(false);
    const trail = service.auditTrail();
    expect(trail).toHaveLength(2);
    // Newest first: the failure, then the success.
    expect(trail[0]!.toolId).toBe(FLAKY_TOOL.id);
    expect(trail[0]!.ok).toBe(false);
    expect(trail[0]!.context).toEqual({ status: 503, error: "upstream down" });
    expect(trail[1]!.toolId).toBe(READ_TOOL.id);
    expect(trail[1]!.ok).toBe(true);
    expect(trail[1]!.credentialId).toBe(credentialId);
    // A failure is audited rather than dropped. Note the fleet trail records the credential
    // as "unknown" on a failure even though the mesh resolved it and used it — pinned here
    // because it is the behavior the code has; see the note in the report.
    expect(trail[0]!.credentialId).toBe("unknown");
  });

  it("invoke redacts a secret the executor echoed back in an error, in the mesh's own record", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    // The trail stays in memory here: a mirrored record and the service's own record land in
    // the same flush window, and the on-disk trail's tmp filename is fixed per process, so
    // two concurrent flushes can race on the rename. See the note in the report.
    const { service } = await makeRecordingService(
      dir,
      (toolId) =>
        toolId === FLAKY_TOOL.id
          ? { ok: false, status: 401, error: `authorization: Bearer ${SECRET}` }
          : {},
      { auditPath: undefined },
    );
    services.push(service);
    await bindGithubKey(service, FLAKY_TOOL);
    const unsubscribe = service.mirrorMeshAudit();

    const result = await service.invoke(FLAKY_TOOL.id, {});
    await untilTrailHolds(service, 2);
    unsubscribe();

    expect(result.ok).toBe(false);
    const trail = service.auditTrail();
    // The mesh's own audit record is redacted before it is emitted, so the entry mirrored
    // from the registry's stream never carries the value a provider echoed into an error.
    const mirrored = trail[1]!;
    expect(mirrored.ok).toBe(false);
    expect(mirrored.context?.error).toContain("<redacted>");
    expect(JSON.stringify(mirrored)).not.toContain(SECRET);
    // The service's own entry is a separate record of the same call.
    expect(trail[0]!.ok).toBe(false);
  });

  it("invoke refuses a write tool until the caller consents, and audits nothing for the refusal", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service, calls } = await makeRecordingService(dir);
    services.push(service);
    await bindGithubKey(service, WRITE_TOOL);

    await expect(service.invoke(WRITE_TOOL.id, { title: "t" })).rejects.toMatchObject({
      code: "denied_access",
    });
    // A call the mesh refused never reached a credential, so the trail stays empty.
    expect(calls).toHaveLength(0);
    expect(service.auditTrail()).toHaveLength(0);
  });

  it("invoke runs a write tool when the caller passes allowWrite", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service, calls } = await makeRecordingService(dir);
    services.push(service);
    const credentialId = await bindGithubKey(service, WRITE_TOOL);

    const result = await service.invoke(WRITE_TOOL.id, { title: "ship it" }, { allowWrite: true });

    expect(result.ok).toBe(true);
    expect(calls[0]!.credentialId).toBe(credentialId);
    expect(service.auditTrail()[0]).toMatchObject({
      toolId: WRITE_TOOL.id,
      access: "write",
      ok: true,
    });
  });

  it("readOnly refuses a write tool even with explicit allowWrite", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service, calls } = await makeRecordingService(dir, { ok: true }, { readOnly: true });
    services.push(service);
    await bindGithubKey(service, WRITE_TOOL);

    await expect(
      service.invoke(WRITE_TOOL.id, { title: "t" }, { allowWrite: true }),
    ).rejects.toMatchObject({ code: "denied_access" });
    expect(calls).toHaveLength(0);
    expect(service.auditTrail()).toHaveLength(0);
  });

  it("invoke reports an unknown tool", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service } = await makeRecordingService(dir);
    services.push(service);
    service.registerTool(READ_TOOL);
    await expect(service.invoke("no_such_tool", {})).rejects.toMatchObject({
      code: "unknown_tool",
    });
  });

  it("invoke refuses without an executor configured, before a credential is read", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    service.registerTool(READ_TOOL);
    // The mesh can resolve but cannot dispatch without an executor, and it fails before any
    // credential is read or any entry is written.
    await expect(service.invoke(READ_TOOL.id, {})).rejects.toMatchObject({
      code: "not_initialized",
    });
    expect(service.auditTrail()).toHaveLength(0);
  });

  it("invoke rejects arguments that fail the tool's input schema", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service, calls } = await makeRecordingService(dir);
    services.push(service);
    await bindGithubKey(service, WRITE_TOOL);

    await expect(
      service.invoke(WRITE_TOOL.id, { body: "no title" }, { allowWrite: true }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(
      service.invoke(WRITE_TOOL.id, { title: 42 }, { allowWrite: true }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(calls).toHaveLength(0);
  });

  it("resolve returns a projection the UI can render without a secret", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service } = await makeRecordingService(dir);
    services.push(service);
    const credentialId = await bindGithubKey(service, READ_TOOL);

    const resolved = service.resolve(READ_TOOL.id);

    expect(resolved.credentialId).toBe(credentialId);
    expect(resolved.authScheme).toBe("API_KEY");
    expect(resolved.providerName).toBe("GitHub");
    expect(resolved.safeView).toMatchObject({ toolId: READ_TOOL.id, access: "read" });
    expect(JSON.stringify(resolved)).not.toContain(SECRET);
  });

  it("resolve refuses a write tool in a read-only fleet", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service } = await makeRecordingService(dir, {}, { readOnly: true });
    services.push(service);
    service.registerTool(WRITE_TOOL);
    expect(() => service.resolve(WRITE_TOOL.id)).toThrow(/writes and the mesh is read-only/);
  });

  it("discover returns only tools that have a bound credential", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service } = await makeRecordingService(dir);
    services.push(service);
    service.registerTool(READ_TOOL);
    // Nothing is bound, so the intent is uncallable and discovery says so rather than
    // returning a tool that would fail at call time.
    expect(service.discover("list issues")).toHaveLength(0);

    const credentialId = await bindGithubKey(service, READ_TOOL);
    const hits = service.discover("list issues");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tool.id).toBe(READ_TOOL.id);
    expect(hits[0]!.credentialId).toBe(credentialId);
    expect(JSON.stringify(hits)).not.toContain(SECRET);
  });

  it("listConnectableProviders marks a provider connected only once a credential is stored", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    const before = service.listConnectableProviders().find((provider) => provider.id === "github");
    expect(before).toMatchObject({
      id: "github",
      name: "GitHub",
      category: "developer tools",
      authScheme: "OAUTH2",
      connected: false,
    });
    expect(before!.toolCount).toBeGreaterThan(0);

    await service.getKeymaster().storeSecret("github", "API_KEY", SECRET);

    const after = service.listConnectableProviders().find((provider) => provider.id === "github");
    expect(after!.connected).toBe(true);
    // The list is the OAuth-capable presets; it does not grow because a key was stored.
    expect(service.listConnectableProviders()).toHaveLength(providersByScheme("OAUTH2").length);
  });

  it("health summarizes the fleet and the invocations it observed", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service } = await makeRecordingService(dir, (toolId) =>
      toolId === FLAKY_TOOL.id ? { ok: false, status: 500, error: "boom" } : {},
    );
    services.push(service);
    await bindGithubKey(service, READ_TOOL);
    await bindGithubKey(service, FLAKY_TOOL);
    await service.invoke(READ_TOOL.id, {});
    await service.invoke(FLAKY_TOOL.id, {});

    const health = service.health();
    expect(health.providers).toBe(providersByScheme("OAUTH2").length);
    expect(health).toMatchObject({
      connectedProviders: 1,
      credentials: 1,
      tools: 2,
      bindings: 2,
      invocations: 2,
      invocationFailures: 1,
    });
    expect(health.meanDurationMs).toBeGreaterThan(0);
    expect(JSON.stringify(health)).not.toContain(SECRET);
  });

  it("mirrorMeshAudit mirrors the mesh's own audit stream into the fleet trail", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const { service } = await makeRecordingService(dir);
    services.push(service);
    await bindGithubKey(service, READ_TOOL);
    const unsubscribe = service.mirrorMeshAudit();

    await service.invoke(READ_TOOL.id, {});

    // One entry from the service's own record and one from the registry's audit stream.
    await untilTrailHolds(service, 2);
    expect(service.auditTrail().map((entry) => entry.toolId)).toEqual([READ_TOOL.id, READ_TOOL.id]);

    unsubscribe();
    await service.invoke(READ_TOOL.id, {});
    // The mirror is gone, so only the service's own entry is added.
    await untilTrailHolds(service, 3);
    expect(service.auditTrail()).toHaveLength(3);
    expect(JSON.stringify(service.auditTrail())).not.toContain(SECRET);
  });

  it("registerProviderConfig lets the scheduler plan a refresh for an expiring credential", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    service.registerProviderConfig(GITHUB_CONFIG);
    const response: TokenResponse = {
      access_token: "access-tok",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-tok",
    };
    const stored = await service
      .getKeymaster()
      .storeTokenResponse("github", GITHUB_CONFIG, response, { now: NOW });
    expect(stored.expiresAt).toBe(NOW + 3_600_000);

    // One scheduled refresh: the github credential has an expiry and a registered config.
    expect(service.getRefreshScheduler().rescheduleAll(NOW)).toBe(1);
    expect(service.getRefreshScheduler().snapshot().scheduled).toBe(1);
    expect(service.getRefreshScheduler().jobFor(stored.id)).toBeDefined();
    // The companion access-token record holds a short-lived bearer value, so it is never
    // scheduled even though it shares the provider and the expiry.
    expect(service.getRefreshScheduler().jobFor(`${stored.id}:access`)).toBeUndefined();

    // A provider with no registered config contributes nothing, and the github job survives
    // a re-run of the same schedule rather than being duplicated or dropped.
    await service.getKeymaster().storeTokenResponse("slack", GITHUB_CONFIG, response, {
      accountId: "slack-no-config",
      now: NOW,
    });
    expect(service.getRefreshScheduler().rescheduleAll(NOW)).toBe(1);
    expect(service.getRefreshScheduler().snapshot().scheduled).toBe(1);
  });

  it("startRefreshLoop and stopRefreshLoop toggle the loop, and dispose stops it", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir, { refreshTickMs: 60_000 }, { initialize: false });
    services.push(service);
    expect(service.getRefreshScheduler().isRunning).toBe(false);
    service.startRefreshLoop();
    expect(service.getRefreshScheduler().isRunning).toBe(true);
    service.stopRefreshLoop();
    expect(service.getRefreshScheduler().isRunning).toBe(false);
    service.startRefreshLoop();
    service.dispose();
    expect(service.getRefreshScheduler().isRunning).toBe(false);
  });

  it("invokeCli runs a real child process and audits a redacted argv", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const service = await makeService(dir);
    services.push(service);
    const manifest: CliCommandManifest = {
      id: "cli_probe",
      providerId: "github",
      description: "Evaluate code with node",
      access: "read",
      command: process.execPath,
      args: [
        { name: "flag", positional: true, required: true, help: "node flag" },
        { name: "code", positional: true, required: true, help: "code to evaluate" },
        {
          name: "token",
          positional: true,
          required: false,
          secret: true,
          help: "a value the child receives but the trail never keeps",
        },
      ],
    };

    const result = await service.invokeCli(
      manifest,
      { flag: "-e", code: "process.stdout.write(process.argv[1])", token: SECRET },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.command).toBe(process.execPath);
    // The secret reached the child as its real value — the process echoed it back...
    expect(result.stdout).toBe(SECRET);
    // ...while the argv the caller may log, and the audit entry, carry the redacted form.
    expect(result.argv).toEqual(["-e", "process.stdout.write(process.argv[1])", "<redacted>"]);
    const entry = service.auditTrail()[0]!;
    expect(entry).toMatchObject({
      toolId: "cli_probe",
      providerId: "github",
      credentialId: "cli",
      access: "read",
      ok: true,
    });
    expect(entry.context).toEqual({ argv: result.argv, exitCode: 0 });
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });
});
