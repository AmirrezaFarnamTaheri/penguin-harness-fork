/**
 * Fleet keymaster tests: the server's credential vault service.
 *
 * The properties worth pinning:
 *
 *  - A secret that goes in never comes back out through the metadata surface —
 *    `listCredentials` is what the HTTP layer sees, and it carries no secret field.
 *  - A PKCE token response stores the refresh token as the durable secret and the access
 *    token as a companion record, because an access token alone cannot be refreshed.
 *  - Expiry bookkeeping derives the lifecycle status the UI shows.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PkceProviderConfig, TokenResponse } from "@prismshadow/penguin-core";

import {
  EXPIRY_WARN_MS,
  FleetKeymaster,
  FleetKeymasterError,
  credentialStatus,
} from "../../src/services/tool-fleet/index.js";

const MASTER = "fleet-master-passphrase";
const NOW = 1_000_000;

const LINEAR_CONFIG: PkceProviderConfig = {
  providerId: "linear",
  clientId: "lin-client",
  clientSecret: "lin-secret",
  authorizationEndpoint: "https://linear.app/oauth/authorize",
  tokenEndpoint: "https://linear.app/oauth/token",
  redirectUri: "http://127.0.0.1:7364/callback",
  defaultScopes: ["read", "write"],
};

async function makeKeymaster(
  dir: string,
  options: { load?: boolean } = {},
): Promise<FleetKeymaster> {
  const keymaster = new FleetKeymaster({
    masterKey: MASTER,
    filePath: path.join(dir, "vault.json"),
    idPrefix: "fleet",
  });
  if (options.load !== false) await keymaster.load();
  return keymaster;
}

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pnmesh-keymaster-"));
  return dir;
}

function tokenResponse(parts: Partial<TokenResponse> = {}): TokenResponse {
  return {
    access_token: "access-tok",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "refresh-tok",
    ...parts,
  };
}

describe("FleetKeymaster", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("allocates unguessable ids carrying the provider and the configured prefix", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const a = keymaster.allocateId("linear");
    const b = keymaster.allocateId("linear");
    expect(a).toMatch(/^fleet_linear_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("refuses to allocate an id without a provider", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    expect(() => keymaster.allocateId("")).toThrow(FleetKeymasterError);
  });

  it("refuses every mutation before load()", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir, { load: false });
    expect(keymaster.isLoaded).toBe(false);
    await expect(keymaster.storeSecret("linear", "OAUTH2", "tok")).rejects.toMatchObject({
      code: "not_initialized",
    });
    await expect(keymaster.getSecret("nope")).rejects.toMatchObject({ code: "not_initialized" });
  });

  it("refuses an empty secret", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    await expect(keymaster.storeSecret("linear", "OAUTH2", "")).rejects.toMatchObject({
      code: "no_secret",
    });
  });

  it("stores a secret, reads it back, and never lists it", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeSecret("linear", "OAUTH2", "super-secret");
    expect(stored.providerId).toBe("linear");
    expect(keymaster.has(stored.id)).toBe(true);
    expect(await keymaster.getSecret(stored.id)).toBe("super-secret");

    // The metadata surface is the one the API sees; it must not carry the value.
    const listed = keymaster.listCredentials();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(stored.id);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("super-secret");
    expect(keymaster.getStore()).toBeDefined();
  });

  it("honours a caller-supplied account id", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeSecret("linear", "OAUTH2", "tok", {
      accountId: "work-account",
    });
    expect(stored.id).toBe("work-account");
    expect(keymaster.listCredentials()[0]!.accountId).toBe("work-account");
  });

  it("stores a token response with the refresh token durable and the access token alongside", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeTokenResponse("linear", LINEAR_CONFIG, tokenResponse(), {
      now: NOW,
    });
    expect(stored.authScheme).toBe("OAUTH2");
    expect(stored.expiresAt).toBe(NOW + 3600 * 1000);
    // The refresh token is the durable secret...
    expect(await keymaster.getSecret(stored.id)).toBe("refresh-tok");
    // ...and the access token is reachable without a second round-trip.
    expect(await keymaster.getAccessToken(stored.id)).toBe("access-tok");
    // Scopes are normalized to an array.
    expect(keymaster.listCredentials(NOW)[0]!.scopes).toEqual(["read", "write"]);
  });

  it("parses a space-separated scope string", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeTokenResponse(
      "linear",
      LINEAR_CONFIG,
      tokenResponse({ scope: "read write  " }),
      { now: NOW },
    );
    expect(keymaster.listCredentials(NOW).find((c) => c.id === stored.id)!.scopes).toEqual([
      "read",
      "write",
    ]);
  });

  it("accepts an array scope verbatim", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeTokenResponse(
      "linear",
      LINEAR_CONFIG,
      tokenResponse({ scope: ["read", "write"] }),
      { now: NOW },
    );
    expect(keymaster.listCredentials(NOW).find((c) => c.id === stored.id)!.scopes).toEqual([
      "read",
      "write",
    ]);
  });

  it("stores the access token as durable when no refresh token was issued", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeTokenResponse(
      "linear",
      LINEAR_CONFIG,
      tokenResponse({ refresh_token: undefined }),
      { now: NOW },
    );
    expect(await keymaster.getSecret(stored.id)).toBe("access-tok");
    // No companion record exists, so the accessor reports nothing rather than throwing.
    expect(await keymaster.getAccessToken(stored.id)).toBeUndefined();
  });

  it("revokes the durable secret and its access companion", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeTokenResponse("linear", LINEAR_CONFIG, tokenResponse(), {
      now: NOW,
    });
    await keymaster.revoke(stored.id);
    expect(keymaster.has(stored.id)).toBe(false);
    expect(await keymaster.getAccessToken(stored.id)).toBeUndefined();
    await expect(keymaster.getSecret(stored.id)).rejects.toMatchObject({
      code: "unknown_credential",
    });
  });

  it("revokes an API-key credential that has no companion", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const stored = await keymaster.storeSecret("linear", "API_KEY", "key-value");
    await expect(keymaster.revoke(stored.id)).resolves.toBeUndefined();
    expect(keymaster.has(stored.id)).toBe(false);
  });

  it("scopes credentials by provider", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    await keymaster.storeSecret("linear", "API_KEY", "k1");
    await keymaster.storeSecret("slack", "API_KEY", "k2");
    expect(keymaster.credentialsForProvider("slack")).toHaveLength(1);
    expect(keymaster.credentialsForProvider("github")).toHaveLength(0);
  });

  it("reports expiring credentials soonest first", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    const later = await keymaster.storeSecret("linear", "API_KEY", "k", {
      expiresAt: NOW + 10 * 60 * 1000,
    });
    const sooner = await keymaster.storeSecret("slack", "API_KEY", "k", {
      expiresAt: NOW + 60 * 1000,
    });
    const fresh = await keymaster.storeSecret("github", "API_KEY", "k", {
      expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    });
    const ids = keymaster.expiringSoon(NOW).map((item) => item.id);
    expect(ids).toEqual([sooner.id, later.id]);
    expect(ids).not.toContain(fresh.id);
  });

  it("persists across instances on disk", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const first = await makeKeymaster(dir);
    const stored = await first.storeSecret("linear", "API_KEY", "disk-secret");
    first.dispose();
    const second = await makeKeymaster(dir);
    expect(await second.getSecret(stored.id)).toBe("disk-secret");
  });

  it("disposes the vault key and then requires a load", async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const keymaster = await makeKeymaster(dir);
    keymaster.dispose();
    expect(keymaster.isLoaded).toBe(false);
    await keymaster.load();
    expect(keymaster.isLoaded).toBe(true);
  });
});

describe("credentialStatus", () => {
  it("is active for a secret with no expiry", () => {
    expect(credentialStatus(undefined, NOW)).toBe("active");
  });

  it("is expired once the moment has passed", () => {
    expect(credentialStatus(NOW, NOW)).toBe("expired");
    expect(credentialStatus(NOW - 1, NOW)).toBe("expired");
  });

  it("is expiring inside the warning window and active outside it", () => {
    expect(credentialStatus(NOW + EXPIRY_WARN_MS, NOW)).toBe("expiring");
    expect(credentialStatus(NOW + EXPIRY_WARN_MS + 1, NOW)).toBe("active");
  });
});
