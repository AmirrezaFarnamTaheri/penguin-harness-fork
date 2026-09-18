/**
 * Tool mesh registry tests — the Track 6 synthesis point.
 *
 * The properties worth pinning:
 *
 *  - Every rejection that can happen *before* a credential is read from the vault does
 *    happen before: unknown tool, denied write, invalid arguments, uninitialized vault.
 *  - A write tool requires explicit per-call consent; a read-only mesh refuses it outright.
 *  - The audit trail records both success and failure, and its context is redacted, so an
 *    error body that quotes a secret cannot leak through it.
 *  - Discovery excludes tools with no bound credential, because returning one would produce
 *    a call that cannot authenticate.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EncryptedCredentialStore,
  ToolMeshError,
  ToolMeshRegistry,
  oauthConnectableProviders,
  createBuiltinCapabilityCatalog,
  type MeshTool,
  type ToolExecutor,
} from "../../src/fleet/index.js";
import { CredentialRotationTracker } from "../../src/fleet/credential-rotation.js";

const MASTER = "mesh-master-passphrase";

/**
 * Runs a mesh operation that must reject and returns the error, so the assertion can check
 * the error code rather than just the message — `bind` validates before it returns, so its
 * rejections are throws, not promise rejections.
 */
function expectMeshError(operation: () => unknown): ToolMeshError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ToolMeshError) return error;
    throw error;
  }
  throw new Error("expected the operation to throw a ToolMeshError");
}

const LINEAR_CREATE: MeshTool = {
  id: "linear_issue_create",
  providerId: "linear",
  name: "Create issue",
  description: "Creates a Linear issue",
  access: "write",
  capabilities: ["issue.create"],
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" }, priority: { type: "integer" } },
  },
};

const LINEAR_LIST: MeshTool = {
  id: "linear_issue_list",
  providerId: "linear",
  name: "List issues",
  description: "Lists Linear issues",
  access: "read",
  capabilities: ["issue.list"],
};

const GITHUB_READ: MeshTool = {
  id: "github_repo_list",
  providerId: "github",
  name: "List repos",
  description: "Lists repositories",
  access: "read",
  capabilities: ["repo.list"],
};

async function newRegistry(
  options: {
    rotation?: CredentialRotationTracker;
    readOnly?: boolean;
    executor?: ToolExecutor;
    initialize?: boolean;
  } = {},
): Promise<{ registry: ToolMeshRegistry; store: EncryptedCredentialStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pnmesh-mesh-"));
  const store = new EncryptedCredentialStore({
    masterKey: MASTER,
    filePath: path.join(dir, "vault.json"),
  });
  const registry = new ToolMeshRegistry({
    store,
    rotation: options.rotation ?? new CredentialRotationTracker(),
    catalog: createBuiltinCapabilityCatalog(),
    executor: options.executor,
    readOnly: options.readOnly,
  });
  registry.registerAll([LINEAR_CREATE, LINEAR_LIST, GITHUB_READ]);
  if (options.initialize !== false) await registry.initialize();
  return { registry, store, dir };
}

describe("ToolMeshRegistry registration", () => {
  it("registers a tool and derives its auth scheme from the provider preset", () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    const registry = new ToolMeshRegistry({ store });
    const tool = registry.register(LINEAR_LIST);
    expect(tool.id).toBe("linear_issue_list");
    expect(registry.get("linear_issue_list")?.authScheme).toBe("OAUTH2");
    expect(registry.size).toBe(1);
  });

  it("refuses a tool whose provider is not a preset", () => {
    const registry = new ToolMeshRegistry({
      store: new EncryptedCredentialStore({ masterKey: MASTER }),
    });
    expect(() => registry.register({ ...LINEAR_LIST, providerId: "not-a-provider" })).toThrow(
      /unknown provider/,
    );
  });

  it("accepts an unknown provider when the caller opts in", () => {
    const registry = new ToolMeshRegistry({
      store: new EncryptedCredentialStore({ masterKey: MASTER }),
    });
    expect(() =>
      registry.register({ ...LINEAR_LIST, providerId: "self-hosted" }, true),
    ).not.toThrow();
  });

  it("requires an id, providerId and name", () => {
    const registry = new ToolMeshRegistry({
      store: new EncryptedCredentialStore({ masterKey: MASTER }),
    });
    expect(() => registry.register({ ...LINEAR_LIST, id: "" })).toThrow(
      /requires an id, a providerId, and a name/,
    );
  });

  it("refuses a duplicate tool id", () => {
    const registry = new ToolMeshRegistry({
      store: new EncryptedCredentialStore({ masterKey: MASTER }),
    });
    registry.register(LINEAR_LIST);
    expect(() => registry.register(LINEAR_LIST)).toThrow(/already registered/);
  });

  it("refuses an unsupported auth scheme", () => {
    const registry = new ToolMeshRegistry({
      store: new EncryptedCredentialStore({ masterKey: MASTER }),
    });
    expect(() => registry.register({ ...LINEAR_LIST, authScheme: "NOPE" as never })).toThrow(
      /unsupported auth scheme/,
    );
  });

  it("rolls back a batch when one tool is invalid", () => {
    const registry = new ToolMeshRegistry({
      store: new EncryptedCredentialStore({ masterKey: MASTER }),
    });
    expect(() =>
      registry.registerAll([LINEAR_LIST, { ...GITHUB_READ, providerId: "not-a-provider" }]),
    ).toThrow(/unknown provider/);
    expect(registry.size).toBe(0);
  });

  it("lists, filters and removes tools", () => {
    const registry = new ToolMeshRegistry({
      store: new EncryptedCredentialStore({ masterKey: MASTER }),
    });
    registry.registerAll([LINEAR_CREATE, LINEAR_LIST, GITHUB_READ]);
    expect(registry.list()).toHaveLength(3);
    expect(registry.toolsByProvider("linear")).toHaveLength(2);
    expect(registry.remove("linear_issue_list")).toBe(true);
    expect(registry.remove("linear_issue_list")).toBe(false);
  });
});

describe("ToolMeshRegistry binding", () => {
  it("refuses to bind before the vault is loaded", async () => {
    const { registry, store, dir } = await newRegistry({ initialize: false });
    await store.set("cred-1", "linear", "OAUTH2", "tok");
    expect(() => registry.bind("linear_issue_list", "cred-1")).toThrow(
      /before ToolMeshRegistry.initialize/,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("binds a matching credential and reports it", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-1", "linear", "OAUTH2", "tok");
    const binding = registry.bind("linear_issue_list", "cred-1");
    expect(binding).toMatchObject({
      toolId: "linear_issue_list",
      credentialId: "cred-1",
      providerId: "linear",
      authScheme: "OAUTH2",
    });
    expect(registry.bindingCount).toBe(1);
    expect(registry.bindingsFor("linear_issue_list")).toHaveLength(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses a credential for the wrong provider", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-gh", "github", "OAUTH2", "tok");
    expect(expectMeshError(() => registry.bind("linear_issue_list", "cred-gh")).code).toBe(
      "unknown_credential",
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses a credential with the wrong auth scheme", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-key", "linear", "API_KEY", "tok");
    expect(expectMeshError(() => registry.bind("linear_issue_list", "cred-key")).code).toBe(
      "unknown_credential",
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses an unknown credential and an unknown tool", async () => {
    const { registry, dir } = await newRegistry();
    expect(expectMeshError(() => registry.bind("linear_issue_list", "nope")).code).toBe(
      "unknown_credential",
    );
    expect(expectMeshError(() => registry.bind("nope", "nope")).code).toBe("unknown_tool");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not duplicate an identical binding and can unbind", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-1", "linear", "OAUTH2", "tok");
    registry.bind("linear_issue_list", "cred-1");
    registry.bind("linear_issue_list", "cred-1");
    expect(registry.bindingsFor("linear_issue_list")).toHaveLength(1);
    expect(registry.unbind("linear_issue_list", "cred-1")).toBe(true);
    expect(registry.unbind("linear_issue_list", "cred-1")).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("ToolMeshRegistry resolve", () => {
  it("throws no_credential for a tool with no binding", async () => {
    const { registry, dir } = await newRegistry();
    expect(() => registry.resolve("linear_issue_list")).toThrow(/no bound credential/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves to a safe projection with no secret material", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-1", "linear", "OAUTH2", "tok_secret_value");
    registry.bind("linear_issue_list", "cred-1");
    const resolved = registry.resolve("linear_issue_list");
    expect(resolved.providerName).toBe("Linear");
    expect(resolved.credentialId).toBe("cred-1");
    expect(JSON.stringify(resolved.safeView)).not.toContain("tok_secret_value");
    expect(resolved.safeView).toMatchObject({ toolId: "linear_issue_list", access: "read" });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("honours a tool's credential allowlist", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-a", "linear", "OAUTH2", "tok");
    await store.set("cred-b", "linear", "OAUTH2", "tok");
    registry.register({
      ...LINEAR_LIST,
      id: "linear_restricted",
      restrictToCredentials: ["cred-b"],
    });
    registry.bind("linear_restricted", "cred-a");
    registry.bind("linear_restricted", "cred-b");
    expect(registry.resolve("linear_restricted").credentialId).toBe("cred-b");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("excludes every allowlisted-away credential", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-a", "linear", "OAUTH2", "tok");
    registry.register({
      ...LINEAR_LIST,
      id: "linear_restricted",
      restrictToCredentials: ["cred-b"],
    });
    registry.bind("linear_restricted", "cred-a");
    expect(() => registry.resolve("linear_restricted")).toThrow(/access config permits/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports the remaining wait when every credential is parked", async () => {
    const rotation = new CredentialRotationTracker();
    const { registry, store, dir } = await newRegistry({ rotation });
    await store.set("cred-a", "linear", "OAUTH2", "tok");
    await store.set("cred-b", "linear", "OAUTH2", "tok");
    registry.bind("linear_issue_list", "cred-a");
    registry.bind("linear_issue_list", "cred-b");
    rotation.markFailure("cred-a", 429, "rate limit exceeded", {}, 1_000);
    rotation.markFailure("cred-b", 429, "rate limit exceeded", {}, 1_000);
    expect(() => registry.resolve("linear_issue_list", 1_000)).toThrow(/rate-limited; retry in/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("falls back to a healthy credential when one is parked", async () => {
    const rotation = new CredentialRotationTracker();
    const { registry, store, dir } = await newRegistry({ rotation });
    await store.set("cred-a", "linear", "OAUTH2", "tok");
    await store.set("cred-b", "linear", "OAUTH2", "tok");
    registry.bind("linear_issue_list", "cred-a");
    registry.bind("linear_issue_list", "cred-b");
    rotation.markFailure("cred-a", 429, "rate limit exceeded", {}, 1_000);
    expect(registry.resolve("linear_issue_list", 1_000).credentialId).toBe("cred-b");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses a write tool under a read-only mesh", async () => {
    const { registry, store, dir } = await newRegistry({ readOnly: true });
    await store.set("cred-1", "linear", "OAUTH2", "tok");
    registry.bind("linear_issue_create", "cred-1");
    expect(() => registry.resolve("linear_issue_create")).toThrow(/read-only/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("ToolMeshRegistry invoke", () => {
  let dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    dirs = [];
  });

  async function mesh(executor?: ToolExecutor, readOnly = false) {
    const made = await newRegistry({ executor, readOnly });
    dirs.push(made.dir);
    await made.store.set("cred-1", "linear", "OAUTH2", "tok_secret_value");
    made.registry.bind("linear_issue_create", "cred-1");
    made.registry.bind("linear_issue_list", "cred-1");
    return made.registry;
  }

  it("refuses to invoke without an executor", async () => {
    const registry = await mesh();
    await expect(registry.invoke("linear_issue_list", {})).rejects.toMatchObject({
      code: "not_initialized",
    });
  });

  it("requires explicit consent for a write tool", async () => {
    let called = false;
    const registry = await mesh(async () => {
      called = true;
      return { ok: true, durationMs: 1 };
    });
    await expect(registry.invoke("linear_issue_create", { title: "x" })).rejects.toMatchObject({
      code: "denied_access",
    });
    expect(called).toBe(false);
  });

  it("invokes a write tool once consent is given", async () => {
    const registry = await mesh(async () => ({ ok: true, durationMs: 1 }));
    const result = await registry.invoke(
      "linear_issue_create",
      { title: "x" },
      { allowWrite: true },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a write tool outright in a read-only mesh", async () => {
    const registry = await mesh(async () => ({ ok: true, durationMs: 1 }), true);
    await expect(
      registry.invoke("linear_issue_create", { title: "x" }, { allowWrite: true }),
    ).rejects.toMatchObject({ code: "denied_access" });
  });

  it("validates required arguments before touching a credential", async () => {
    let called = false;
    const registry = await mesh(async () => {
      called = true;
      return { ok: true, durationMs: 1 };
    });
    await expect(
      registry.invoke("linear_issue_create", {}, { allowWrite: true }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(called).toBe(false);
  });

  it("validates argument types", async () => {
    const registry = await mesh(async () => ({ ok: true, durationMs: 1 }));
    await expect(
      registry.invoke("linear_issue_create", { title: 123 }, { allowWrite: true }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("records an audit entry for a successful call", async () => {
    const registry = await mesh(async () => ({ ok: true, durationMs: 5 }));
    await registry.invoke("linear_issue_list", {});
    const trail = registry.auditTrail();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      toolId: "linear_issue_list",
      providerId: "linear",
      ok: true,
      access: "read",
    });
  });

  it("records an audit entry for a failed call and parks the credential", async () => {
    const rotation = new CredentialRotationTracker();
    const made = await newRegistry({
      rotation,
      executor: async () => ({
        ok: false,
        status: 429,
        error: "rate limit exceeded",
        durationMs: 2,
      }),
    });
    dirs.push(made.dir);
    await made.store.set("cred-1", "linear", "OAUTH2", "tok");
    made.registry.bind("linear_issue_list", "cred-1");
    const result = await made.registry.invoke("linear_issue_list", {});
    expect(result.ok).toBe(false);
    expect(made.registry.auditTrail()[0]!.ok).toBe(false);
    expect(made.registry.auditTrail()[0]!.context).toMatchObject({ status: 429 });
    // The credential is parked, so the next resolve reports the wait.
    expect(() => made.registry.resolve("linear_issue_list")).toThrow(/rate-limited/);
  });

  it("redacts the audit context so an error quoting a secret cannot leak", async () => {
    const registry = await mesh(async () => ({
      ok: false,
      status: 401,
      error: "Bearer tok_secret_value is invalid",
      durationMs: 1,
    }));
    await registry.invoke("linear_issue_list", {});
    expect(JSON.stringify(registry.auditTrail())).not.toContain("tok_secret_value");
  });

  it("treats a throwing executor as a failure and still audits", async () => {
    const registry = await mesh(async () => {
      throw new Error("network down");
    });
    const result = await registry.invoke("linear_issue_list", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network down");
    expect(registry.auditTrail()).toHaveLength(1);
  });

  it("marks the credential healthy after a success", async () => {
    const rotation = new CredentialRotationTracker();
    const made = await newRegistry({
      rotation,
      executor: async () => ({ ok: true, durationMs: 1 }),
    });
    dirs.push(made.dir);
    await made.store.set("cred-1", "linear", "OAUTH2", "tok");
    made.registry.bind("linear_issue_list", "cred-1");
    await made.registry.invoke("linear_issue_list", {});
    expect(rotation.health("cred-1").successCount).toBe(1);
  });

  it("emits audit entries to subscribers", async () => {
    const events: string[] = [];
    const registry = await mesh(async () => ({ ok: true, durationMs: 1 }));
    const unsubscribe = registry.onAudit((entry) => events.push(entry.toolId));
    await registry.invoke("linear_issue_list", {});
    unsubscribe();
    await registry.invoke("linear_issue_list", {});
    expect(events).toEqual(["linear_issue_list"]);
  });

  it("survives a throwing audit subscriber", async () => {
    const registry = await mesh(async () => ({ ok: true, durationMs: 1 }));
    registry.onAudit(() => {
      throw new Error("subscriber blew up");
    });
    await expect(registry.invoke("linear_issue_list", {})).resolves.toMatchObject({ ok: true });
  });

  it("caps the retained audit trail", async () => {
    const registry = await mesh(async () => ({ ok: true, durationMs: 1 }));
    for (let index = 0; index < 8; index++) {
      await registry.invoke("linear_issue_list", {});
    }
    expect(registry.auditTrail(3)).toHaveLength(3);
    expect(registry.auditTrail(3)[0]!.toolId).toBe("linear_issue_list");
  });
});

describe("ToolMeshRegistry discovery and fleet views", () => {
  it("resolves tools by intent and excludes those without a credential", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-1", "linear", "OAUTH2", "tok");
    registry.bind("linear_issue_list", "cred-1");
    // GitHub tool has no binding, so it must not appear as a discoverable option.
    const found = registry.discover("list issues in a tracker");
    expect(found.map((resolved) => resolved.tool.id)).toEqual(["linear_issue_list"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns nothing when the catalog has no matching capability", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-1", "linear", "OAUTH2", "tok");
    registry.bind("linear_issue_list", "cred-1");
    expect(registry.discover("zzzzq")).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns nothing when no catalog is configured", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    const registry = new ToolMeshRegistry({ store });
    await registry.initialize();
    expect(registry.discover("list issues")).toEqual([]);
  });

  it("reports connected providers and fleet health", async () => {
    const { registry, store, dir } = await newRegistry();
    await store.set("cred-1", "linear", "OAUTH2", "tok");
    await store.set("cred-2", "github", "OAUTH2", "tok");
    expect(registry.connectedProviders()).toEqual(["github", "linear"]);
    expect(registry.hasCredentialForProvider("linear")).toBe(true);
    expect(registry.hasCredentialForProvider("notion")).toBe(false);
    expect(registry.fleetHealth()).toHaveLength(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("exposes the PKCE-connectable provider menu", () => {
    const connectable = oauthConnectableProviders();
    expect(connectable.length).toBeGreaterThan(100);
    expect(connectable).toContain("linear");
    expect(connectable).toContain("github");
  });
});
