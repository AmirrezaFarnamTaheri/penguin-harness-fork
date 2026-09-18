/**
 * Fleet refresh scheduler tests.
 *
 * What is being pinned here is the security property, not just the uptime one: a refresh
 * token used on a schedule is a token a thief of the old one can no longer use. So the test
 * asserts the rotated value is what the vault now holds, that a provider that rotates on
 * every call is written back, and that an auth-class failure retires the credential instead
 * of hammering the provider with a dead token.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PkceProviderConfig, TokenResponse } from "@prismshadow/penguin-core";

import {
  FleetKeymaster,
  FleetTokenRefreshError,
  FleetTokenRefreshScheduler,
  type RefreshOutcome,
  type RefreshTransport,
} from "../../src/services/tool-fleet/index.js";

const MASTER = "fleet-refresh-passphrase";
const NOW = 10_000_000;

const LINEAR: PkceProviderConfig = {
  providerId: "linear",
  clientId: "lin-client",
  clientSecret: "lin-secret",
  authorizationEndpoint: "https://linear.app/oauth/authorize",
  tokenEndpoint: "https://linear.app/oauth/token",
  redirectUri: "http://127.0.0.1:7364/callback",
  defaultScopes: ["read", "write"],
};

type RequestLog = { url: string; body: URLSearchParams; headers: Record<string, string> };

function transport(
  response: TokenResponse | { status: number; error: string },
  log: RequestLog[] = [],
): RefreshTransport {
  return {
    post: async (url, body, headers) => {
      log.push({ url, body, headers });
      if ("error" in response) {
        return {
          status: response.status,
          json: async () => ({ error: response.error, error_description: response.error }),
        };
      }
      return { status: 200, json: async () => response };
    },
  };
}

const OK_RESPONSE: TokenResponse = {
  access_token: "access-2",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "refresh-2",
};

describe("FleetTokenRefreshScheduler", () => {
  const dirs: string[] = [];
  let clock = NOW;

  afterEach(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    dirs.length = 0;
    clock = NOW;
  });

  async function makeKeymaster(): Promise<{
    keymaster: FleetKeymaster;
    credentialId: string;
    dir: string;
  }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pnmesh-refresh-"));
    dirs.push(dir);
    const keymaster = new FleetKeymaster({
      masterKey: MASTER,
      filePath: path.join(dir, "vault.json"),
      idPrefix: "fleet",
    });
    await keymaster.load();
    // The expiry is pinned to the fake clock, so due/lead-time arithmetic is deterministic.
    const stored = await keymaster.storeTokenResponse(
      "linear",
      LINEAR,
      {
        access_token: "access-1",
        token_type: "Bearer",
        expires_in: 1800,
        refresh_token: "refresh-1",
      },
      { now: NOW },
    );
    return { keymaster, credentialId: stored.id, dir };
  }

  function makeScheduler(
    keymaster: FleetKeymaster,
    transportInstance: RefreshTransport,
  ): FleetTokenRefreshScheduler {
    return new FleetTokenRefreshScheduler(keymaster, transportInstance, { now: () => clock });
  }

  it("schedules refreshes for stored OAuth credentials that have an expiry", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    // Expiry is now + 30 minutes; the job is due lead-time (60s) before that.
    expect(scheduler.rescheduleAll(NOW)).toBe(1);
    expect(scheduler.jobFor(credentialId)?.dueAt).toBe(NOW + 30 * 60 * 1000 - 60_000);
  });

  it("skips a credential whose provider has no registered config", async () => {
    const { keymaster } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    expect(scheduler.rescheduleAll(NOW)).toBe(0);
    expect(scheduler.snapshot().scheduled).toBe(0);
  });

  it("skips a credential with no expiry", async () => {
    const { keymaster } = await makeKeymaster();
    await keymaster.storeSecret("linear", "API_KEY", "never-expires");
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    expect(scheduler.rescheduleAll(NOW)).toBe(1);
  });

  it("never schedules or refreshes the access-token companion record", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    // Only the durable record is scheduled; the `:access` twin shares its provider and expiry.
    expect(scheduler.rescheduleAll(NOW)).toBe(1);
    expect(scheduler.jobFor(`${credentialId}:access`)).toBeUndefined();
    // A direct refresh of the companion is refused rather than sending the access token as a
    // refresh token.
    await expect(scheduler.refreshOne(`${credentialId}:access`)).resolves.toBe(false);
    expect(await keymaster.getAccessToken(credentialId)).toBe("access-1");
  });

  it("refreshes a due credential, writes the rotated token back, and reschedules", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const log: RequestLog[] = [];
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE, log));
    scheduler.registerProviderConfig(LINEAR);
    scheduler.rescheduleAll(NOW);
    // Advance past the expiry so the job is due.
    clock = NOW + 31 * 60 * 1000;

    const ok = await scheduler.refreshOne(credentialId);
    expect(ok).toBe(true);

    // The rotated refresh token is now the durable secret; the old one is spent.
    expect(await keymaster.getSecret(credentialId)).toBe("refresh-2");
    expect(await keymaster.getAccessToken(credentialId)).toBe("access-2");
    // The new expiry drives the next schedule.
    expect(scheduler.jobFor(credentialId)?.dueAt).toBe(clock + 3600 * 1000 - 60_000);

    const request = log[0]!;
    expect(request.url).toBe(LINEAR.tokenEndpoint);
    expect(request.body.get("grant_type")).toBe("refresh_token");
    expect(request.body.get("refresh_token")).toBe("refresh-1");
    // The secret travels by Basic auth, not in the query string.
    expect(request.headers.authorization).toMatch(/^Basic /);
  });

  it("counts a rotation only when the provider issued a new refresh token", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const sameToken: TokenResponse = { ...OK_RESPONSE, refresh_token: "refresh-1" };
    const scheduler = makeScheduler(keymaster, transport(sameToken));
    scheduler.registerProviderConfig(LINEAR);
    await scheduler.refreshOne(credentialId);
    expect(scheduler.snapshot().rotated).toBe(0);
    expect(scheduler.snapshot().succeeded).toBe(1);
  });

  it("counts a rotation when the provider reissues the refresh token", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    await scheduler.refreshOne(credentialId);
    expect(scheduler.snapshot().rotated).toBe(1);
  });

  it("publishes outcomes to subscribers", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    const outcomes: RefreshOutcome[] = [];
    const stop = scheduler.onRefresh((outcome) => outcomes.push(outcome));
    await scheduler.refreshOne(credentialId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ credentialId, ok: true, rotated: true });
    stop();
    await scheduler.refreshOne(credentialId);
    expect(outcomes).toHaveLength(1);
  });

  it("records a failed refresh without rotating and keeps the credential", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport({ status: 400, error: "invalid_grant" }));
    scheduler.registerProviderConfig(LINEAR);
    const ok = await scheduler.refreshOne(credentialId);
    expect(ok).toBe(false);
    expect(scheduler.snapshot().failed).toBe(1);
    expect(scheduler.snapshot().succeeded).toBe(0);
    expect(scheduler.snapshot().rotated).toBe(0);
    // The stored secret is untouched; a retry can still attempt it.
    expect(await keymaster.getSecret(credentialId)).toBe("refresh-1");
  });

  it("retires a credential whose refresh dies on auth", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport({ status: 400, error: "invalid_grant" }));
    scheduler.registerProviderConfig(LINEAR);
    scheduler.rescheduleAll(NOW);
    expect(scheduler.snapshot().scheduled).toBe(1);
    await scheduler.refreshOne(credentialId);
    // An auth failure is not retryable: the job is dropped for a human to reauthorize.
    expect(scheduler.jobFor(credentialId)).toBeUndefined();
  });

  it("refuses to refresh without a provider config", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    await expect(scheduler.refreshOne(credentialId)).rejects.toThrow(FleetTokenRefreshError);
  });

  it("drops a refresh for a credential that no longer exists", async () => {
    const { keymaster } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    scheduler.rescheduleAll(NOW);
    const ok = await scheduler.refreshOne("fleet_linear_gone");
    expect(ok).toBe(false);
  });

  it("runs every due refresh in one tick", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    expect(scheduler.rescheduleAll(NOW)).toBe(1);
    // Advance past the expiry so the job is due.
    clock = NOW + 31 * 60 * 1000;
    expect(scheduler.jobFor(credentialId)?.dueAt).toBeLessThan(clock);
    const result = await scheduler.tick();
    expect(result).toEqual({ succeeded: 1, failed: 0 });
    expect(scheduler.snapshot().lastTickAt).toBe(clock);
    // A successful refresh clears the spent job and the caller reschedules from the new expiry.
    expect(scheduler.snapshot().scheduled).toBe(1);
  });

  it("starts and stops the loop idempotently", async () => {
    const { keymaster } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    // A second start must not add a second timer.
    scheduler.start();
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
    // Stopping when stopped is a no-op, not an error.
    scheduler.stop();
  });

  it("cancels a scheduled credential", async () => {
    const { keymaster, credentialId } = await makeKeymaster();
    const scheduler = makeScheduler(keymaster, transport(OK_RESPONSE));
    scheduler.registerProviderConfig(LINEAR);
    scheduler.rescheduleAll(NOW);
    scheduler.cancel(credentialId);
    expect(scheduler.snapshot().scheduled).toBe(0);
  });
});
