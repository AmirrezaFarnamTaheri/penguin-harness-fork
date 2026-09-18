/**
 * Server-side credential refresh scheduling.
 *
 * Wraps the core {@link CredentialRefreshScheduler} with the pieces a long-running server
 * needs: a wall-clock-driven tick loop, a real token transport, and the vault write-back
 * that persists a rotated refresh token.
 *
 * The Antigravity lineage refreshes with a double-checked lock so a concurrent request
 * burst cannot fire N refreshes for one account; the core scheduler collapses in-flight
 * refreshes per credential, and this service adds the expiry bookkeeping around it.
 *
 * Rotation matters for security, not just uptime: a refresh token that is used on a
 * schedule is a token an attacker who stole the old one can no longer use. Providers that
 * issue a fresh refresh token on every refresh (Google's offline_access does) get the new
 * one written back here; the old one is already dead.
 */
import {
  CredentialRefreshScheduler,
  CredentialRotationTracker,
  PkceError,
  refreshTokens,
  type PkceProviderConfig,
} from "@prismshadow/penguin-core";

import { FleetKeymaster, FleetKeymasterError } from "./fleet-keymaster.js";

export interface FleetTokenRefreshOptions {
  /** Refresh this far before expiry. Default 60s. */
  leadTimeMs?: number;
  /** Minimum interval between refresh attempts for one credential. Default 30s. */
  minIntervalMs?: number;
  /** Attempts before a credential is left expired for a human to reauthorize. Default 5. */
  maxAttempts?: number;
  /** Tick interval when running the loop. Default 30s. */
  tickMs?: number;
  /** Clock source, for tests. */
  now?: () => number;
}

export interface RefreshOutcome {
  credentialId: string;
  ok: boolean;
  /** New absolute expiry, when the refresh produced one. */
  expiresAt?: number;
  error?: string;
  rotated: boolean;
}

export interface FleetRefreshSnapshot {
  scheduled: number;
  inFlight: number;
  lastTickAt?: number;
  succeeded: number;
  failed: number;
  rotated: number;
}

/**
 * The refresh transport: takes a token endpoint, a body, and headers, and returns a parsed
 * JSON body. Extracted so a test supplies a fake provider and no network socket is opened.
 */
export interface RefreshTransport {
  post(
    url: string,
    body: URLSearchParams,
    headers: Record<string, string>,
  ): Promise<{ status: number; json(): Promise<unknown> }>;
}

export class FleetTokenRefreshError extends Error {
  constructor(
    readonly code: "not_running" | "already_running" | "no_provider_config" | "refresh_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FleetTokenRefreshError";
  }
}

export class FleetTokenRefreshScheduler {
  private readonly scheduler: CredentialRefreshScheduler;
  private readonly options: Required<FleetTokenRefreshOptions>;
  private readonly configs = new Map<string, PkceProviderConfig>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastTickAt: number | undefined;
  private succeeded = 0;
  private failed = 0;
  private rotated = 0;

  constructor(
    private readonly keymaster: FleetKeymaster,
    private readonly transport: RefreshTransport,
    options: FleetTokenRefreshOptions = {},
  ) {
    this.options = {
      leadTimeMs: options.leadTimeMs ?? 60_000,
      minIntervalMs: options.minIntervalMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 5,
      tickMs: options.tickMs ?? 30_000,
      now: options.now ?? (() => Date.now()),
    };
    this.scheduler = new CredentialRefreshScheduler({
      leadTimeMs: this.options.leadTimeMs,
      minIntervalMs: this.options.minIntervalMs,
      maxAttempts: this.options.maxAttempts,
      now: this.options.now,
    });
  }

  /** Registers the provider config a credential refreshes against. */
  registerProviderConfig(config: PkceProviderConfig): void {
    this.configs.set(config.providerId, config);
  }

  /** Whether the tick loop is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Current scheduler state, for the cockpit's status view. */
  snapshot(): FleetRefreshSnapshot {
    return {
      scheduled: this.scheduler.scheduledCount,
      inFlight: this.scheduler.inFlightCount,
      ...(this.lastTickAt !== undefined ? { lastTickAt: this.lastTickAt } : {}),
      succeeded: this.succeeded,
      failed: this.failed,
      rotated: this.rotated,
    };
  }

  /** The scheduled refresh for a credential, or nothing if none is due. */
  jobFor(credentialId: string): { dueAt: number; attempt: number } | undefined {
    const job = this.scheduler.jobFor(credentialId);
    return job === undefined ? undefined : { dueAt: job.dueAt, attempt: job.attempt };
  }

  /** Companion ids are stored alongside the durable record and are never refreshable. */
  private static isCompanion(credentialId: string): boolean {
    return credentialId.endsWith(":access");
  }

  /**
   * Schedules refreshes for every stored OAuth credential with an expiry. Called after the
   * vault loads and after every successful refresh, so the schedule always reflects the
   * vault rather than a stale copy of it.
   */
  rescheduleAll(now: number = this.options.now()): number {
    let scheduled = 0;
    for (const credential of this.keymaster.listCredentials(now)) {
      if (credential.expiresAt === undefined) continue;
      // An OAuth credential is stored twice: the refresh token as the durable secret, and
      // the access token under a `:access` companion id with the same provider and expiry.
      // The companion's secret is a short-lived bearer value — presenting it where a refresh
      // token belongs would fail and burn an attempt, so it is never scheduled.
      if (FleetTokenRefreshScheduler.isCompanion(credential.id)) continue;
      const config = this.configs.get(credential.providerId);
      if (config === undefined) continue;
      const job = this.scheduler.schedule(credential.id, credential.expiresAt);
      if (job !== undefined) scheduled++;
    }
    return scheduled;
  }

  /** Deschedules a credential (revoked or reauthorized). */
  cancel(credentialId: string): void {
    this.scheduler.cancel(credentialId);
  }

  /**
   * Starts the tick loop. Idempotent: a second call is a no-op rather than a second timer,
   * because two timers would double the refresh pressure for no benefit.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // a tick failure is logged by the caller's audit subscription, not thrown here
      });
    }, this.options.tickMs);
    // Do not keep the process alive for the refresh loop alone: an embedded server owns
    // its own lifecycle, and a timer that outlives it would refresh into a dead vault.
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.rescheduleAll();
  }

  /** Stops the loop. Safe to call when not running. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Runs one tick: refreshes everything due. Exported because a caller may prefer to drive
   * ticks from its own scheduler rather than an interval — an embedded SDK, for instance,
   * refreshes on demand instead of on a timer.
   */
  async tick(): Promise<{ succeeded: number; failed: number }> {
    this.lastTickAt = this.options.now();
    return this.scheduler.runDue((credentialId) => this.refreshOne(credentialId));
  }

  /**
   * Refreshes a single credential and writes the rotated tokens back. Returns whether the
   * credential is now usable.
   */
  async refreshOne(credentialId: string): Promise<boolean> {
    // A companion id cannot be refreshed: its secret is the access token, not a refresh token.
    if (FleetTokenRefreshScheduler.isCompanion(credentialId)) {
      this.cancel(credentialId);
      return false;
    }
    const item = this.keymaster
      .listCredentials(this.options.now())
      .find((credential) => credential.id === credentialId);
    if (item === undefined) {
      this.cancel(credentialId);
      return false;
    }
    const config = this.configs.get(item.providerId);
    if (config === undefined) {
      throw new FleetTokenRefreshError(
        "no_provider_config",
        `No provider config registered for '${item.providerId}'; cannot refresh '${credentialId}'`,
      );
    }

    const refreshToken = await this.keymaster.getSecret(credentialId);
    let outcome: RefreshOutcome;
    try {
      const response = await refreshTokens(config, refreshToken, (url, body, headers) =>
        this.transport.post(url, body, headers),
      );
      const expiresAt =
        typeof response.expires_in === "number"
          ? this.options.now() + response.expires_in * 1000
          : undefined;
      const rotated =
        response.refresh_token !== undefined && response.refresh_token !== refreshToken;
      await this.keymaster.storeTokenResponse(item.providerId, config, response, {
        accountId: credentialId,
        now: this.options.now(),
      });
      outcome = {
        credentialId,
        ok: true,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        rotated,
      };
      if (rotated) this.rotated++;
      this.succeeded++;
      // Reschedule from the new expiry, replacing the spent job. The core scheduler keeps the
      // earliest due date it knows, so the old entry has to go first or the stale time wins.
      this.scheduler.cancel(credentialId);
      if (expiresAt !== undefined) this.scheduler.schedule(credentialId, expiresAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { credentialId, ok: false, error: message, rotated: false };
      this.failed++;
      if (
        error instanceof PkceError &&
        (error.code === "no_refresh_token" || error.code === "token_exchange_failed")
      ) {
        // A refresh that dies on auth is not retryable; leave it for a human.
        this.cancel(credentialId);
      }
    }
    this.notify(outcome);
    return outcome.ok;
  }

  private readonly listeners = new Set<(outcome: RefreshOutcome) => void>();

  /** Subscribe to refresh outcomes — the audit trail hooks here. */
  onRefresh(listener: (outcome: RefreshOutcome) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(outcome: RefreshOutcome): void {
    for (const listener of this.listeners) {
      try {
        listener(outcome);
      } catch {
        // an outcome subscriber must not break a refresh
      }
    }
  }
}

export { FleetKeymasterError, CredentialRotationTracker };
