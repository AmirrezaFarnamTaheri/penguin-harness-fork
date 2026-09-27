/**
 * ProviderGateway — one credential-selection state machine for the whole product.
 *
 * ## What this is for
 *
 * A caller configures several credentials for a provider (several API keys, several OAuth
 * accounts, a mix of both) and asks the gateway which one to use for the next call. The
 * gateway answers three questions, and nothing else:
 *
 *  1. **Which credential** should the next call use? (round-robin, skipping the ones that are
 *     cooling or disabled)
 *  2. **What kind of failure** did that credential just produce? (a closed vocabulary — see
 *     {@link FAILURE_KIND} — not a `catch` chain of string comparisons)
 *  3. **What should happen to that credential** as a result? (cool down, disable, or nothing)
 *
 * ## What this is NOT for — the boundary
 *
 * **This module must not be used to defeat a rate limit by multiplying identities.** The
 * distinction is not a matter of taste, so it is written down rather than left to a reader's
 * judgement:
 *
 *  - **Legitimate, and what this does:** a user who *owns* several credentials and wants their
 *    own traffic spread across them, and wants a transient 429 to park one of them for a
 *    minute rather than retry-storming it while a 401 gets a dead key taken out of the pool
 *    for good. Multi-credential failover is ordinary proxy behaviour; every production proxy
 *    with a key list must distinguish a transient 429 (cool down, retry) from a permanently
 *    dead 401/403 (mark dead, stop using it), and getting that distinction wrong is a bug
 *    whether or not a rate limit is involved.
 *  - **Out of scope, and what this must never become:** acquiring or rotating *identities* in
 *    order to send more traffic than one identity is entitled to — farmed accounts, throwaway
 *    signups, anything that exists to multiply an entitlement rather than to fail over
 *    between entitlements the caller already holds.
 *
 * Nothing in the API can tell those two apart, because they are the same call to this module;
 * the difference is entirely in *why the caller has N credentials*. So the rule is a
 * documented constraint, not an enforced one: **the pool passed in is credentials the caller
 * legitimately controls.** If you are reading this while considering a change that would make
 * this module grow, acquire, or manufacture credentials, the answer is no.
 *
 * Related: fingerprint spoofing, captcha solving, WAF evasion and account rotation are all
 * out of scope for the same reason, and none of this module is useful for any of them — it
 * holds no transport, sets no headers, and makes no requests of its own.
 *
 * ## Relationship to the code that already exists
 *
 * Four health trackers are live today (see the module's history note in the report that
 * introduced it): `ApiKeyRotator`, `WeightedKeyRotator`, `KeyFleetMonitor`'s parallel index,
 * and `CredentialRotationTracker` in this directory. **None of them is being changed by this
 * land.** What lands here is the classification *vocabulary* and the state machine that the
 * four disagree about, plus a shadow reporter that runs the new classifier next to whatever
 * the old code decided and logs both. See {@link observeFailure} for the shadow contract and
 * the flip procedure below.
 *
 * ## The flip procedure — a deliberate, later act
 *
 * The classification boundary is the genuinely dangerous part of this change, so the
 * behaviour is **not** switched over in the same release that introduces the vocabulary. The
 * sequence, in order:
 *
 *  1. **This release (shadow).** `observeFailure` is called next to every existing action site
 *     and logs one line per failure carrying the legacy action, the new kind, the new action,
 *     and whether they agree. Nothing about the existing pools changes.
 *  2. **Watch one release.** The only question to answer is: *does `agrees: false` ever fire,
 *     and for which inputs?* Collect the disagreements. Every one that is not already in
 *     `KNOWN_DIVERGENCES` in `test/fleet/provider-gateway.test.ts` is a finding: either the
 *     vocabulary is missing a real provider shape, or the evidence collector is not reading a
 *     field the old classifier did. Fix the collector, never the old branch.
 *  3. **Sign off the residual set.** Residual disagreements are not automatically bugs. The
 *     known ones are *intentional*: this vocabulary refuses to blame a credential for a
 *     provider outage, which the old `"other"` branch did. Each one gets a written reason in
 *     the enumeration.
 *  4. **Flip, one call site at a time.** Replace the action argument with the classification's
 *     recovery, per site, per release. Not a single sweeping cutover — the sites are in
 *     different processes with different blast radii.
 *  5. **Then, and only then, delete `observeFailure`** and the old predicates it shadowed.
 *
 * A reviewer asking "is it time to flip?" should be able to answer from one log query: zero
 * un-enumerated `agrees: false` lines over a full release.
 */

/**
 * The closed failure vocabulary. Every provider failure the gateway can reason about is one of
 * these; anything that matches none of them is {@link FAILURE_KIND.Unknown} and is *observed*,
 * never guessed at.
 *
 * This is a closed set on purpose. The failure taxonomies it replaces matched English prose
 * (`/usage limit reached/i`, `/\b429\b/`, `text.includes("quota")`), which means a provider
 * that changes its error message silently changes behaviour — and a model that writes a quota
 * message in a *successful* response body can be misread as a quota failure. Matching on
 * status codes and declared provider error codes is boring and reviewable, and an unrecognised
 * provider degrades to `Unknown` (observe, don't park) rather than to a guess.
 */
export const FAILURE_KIND = {
  /** Provider-side throttling, usually a 429. The credential is fine; the window is not. */
  RateLimited: "rate_limited",
  /** The credential's *quota* is spent until the provider says it resets. */
  QuotaExhausted: "quota_exhausted",
  /**
   * The credential itself was refused: 401, an explicit invalid/expired credential code, or a
   * 403 carrying one. Dead until somebody reauthorizes it — no amount of waiting fixes a
   * revoked token, and retrying one just spends the provider's rate budget.
   */
  CredentialRejected: "credential_rejected",
  /** 5xx, overload, capacity. The provider is having a bad time; the credential is blameless. */
  ProviderUnavailable: "provider_unavailable",
  /** A definitive 4xx rejection of the *request* (bad params, context too long, bad tool). */
  RequestRejected: "request_rejected",
  /** No recognised signal. Counted, never parked. */
  Unknown: "unknown",
} as const;
export type FailureKind = (typeof FAILURE_KIND)[keyof typeof FAILURE_KIND];

/**
 * What the gateway does with the credential that produced a failure. This is the part that
 * actually matters operationally, and it is deliberately coarser than {@link FailureKind}:
 * several kinds share a recovery, and the recovery is what a behaviour flip would change.
 *
 * Note the two no-op recoveries, `Ignore` and `Surface`. They exist because the failure they
 * describe is **not about the credential** — a provider 503 and a caller sending a malformed
 * request are both things that will recur identically on every other credential, and marking
 * the credential down for them is how a pool slowly poisons itself. The pre-existing
 * `"other"` branch could not express this: it recorded a failure on the credential for every
 * error that was neither auth nor rate limit, including every 5xx.
 */
export const RECOVERY = {
  /** Park the credential for a bounded wait; it returns on its own. */
  CoolDown: "cool_down",
  /** Park for the provider's stated quota window, still bounded by the maximum wait. */
  CoolDownUntilReset: "cool_down_until_reset",
  /** Park permanently. Only {@link ProviderGateway.revive} brings a credential back. */
  Disable: "disable",
  /** Count it, change nothing else. Reserved for genuinely unclassifiable failures. */
  Observe: "observe",
  /** The failure is not this credential's fault. Do not count it, do not park it. */
  Ignore: "ignore",
  /** The request is wrong, not the credential. Do not count it, do not park it. */
  Surface: "surface",
} as const;
export type RecoveryAction = (typeof RECOVERY)[keyof typeof RECOVERY];

const RECOVERY_FOR_KIND: Readonly<Record<FailureKind, RecoveryAction>> = {
  [FAILURE_KIND.RateLimited]: RECOVERY.CoolDown,
  [FAILURE_KIND.QuotaExhausted]: RECOVERY.CoolDownUntilReset,
  [FAILURE_KIND.CredentialRejected]: RECOVERY.Disable,
  [FAILURE_KIND.ProviderUnavailable]: RECOVERY.Ignore,
  [FAILURE_KIND.RequestRejected]: RECOVERY.Surface,
  [FAILURE_KIND.Unknown]: RECOVERY.Observe,
};

/**
 * Provider error codes meaning *this credential* was refused. Declared as a set of codes, not
 * as prose, so adding support for a provider is a reviewed one-line edit.
 */
const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "invalid_api_key",
  "authentication_error",
  "unauthorized",
  "invalid_token",
  "expired_token",
  "token_expired",
  "account_deactivated",
  "account_suspended",
]);

/** Provider error codes meaning *throttling* — a window, not a spent entitlement. */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "rate_limit",
  "rate_limit_error",
  "requests_exceeded",
  "tokens_exceeded",
  "too_many_requests",
  "resource_exhausted",
]);

/**
 * Provider error codes meaning the *quota* is spent. Kept apart from {@link RATE_LIMIT_CODES}
 * because the recoveries differ: a rate limit clears on our backoff, quota clears on the
 * provider's clock, and conflating them parks a credential for seconds when the real wait is
 * hours (or the reverse).
 */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  "quota_exceeded",
  "insufficient_quota",
  "insufficient_user_quota",
  "billing_hard_limit_reached",
  "exceeded_current_quota",
]);

/** Provider error codes meaning the provider itself is degraded. */
const CAPACITY_CODES: ReadonlySet<string> = new Set([
  "overloaded_error",
  "server_overloaded",
  "engine_overloaded",
  "model_capacity_exhausted",
  "capacity_exceeded",
  "service_unavailable",
  "api_unavailable",
]);

/** HTTP statuses that mean the provider is degraded rather than the request being wrong. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504, 529]);

/** The structured evidence {@link classifyFailure} reasons over. */
export interface ProviderFailure {
  /** HTTP status, when the transport exposed one. */
  readonly status?: number;
  /** Machine-readable provider error code (`error.code`). */
  readonly code?: string;
  /** Provider error type (`error.type`), e.g. `rate_limit_error`. */
  readonly type?: string;
  /**
   * `Retry-After` as a duration in milliseconds, already parsed. The gateway honours this
   * instead of its own backoff, because the provider knows its own window and guessing is
   * worse than being told. Still clamped to the configured maximum wait.
   */
  readonly retryAfterMs?: number;
}

/** The classification, with the recovery that follows from it. */
export interface FailureClassification {
  readonly kind: FailureKind;
  readonly recovery: RecoveryAction;
  /** The provider's `Retry-After`, when one was sent and parsed. */
  readonly retryAfterMs?: number;
  /** Which rule decided this. Logged, and the fastest way to debug a surprise. */
  readonly evidence: string;
  /** The status the decision was made on, when there was one. */
  readonly status?: number;
}

/**
 * Classifies a provider failure from structured evidence.
 *
 * **The rule order is the design, and reordering it changes behaviour.** Credential signals
 * come first because a provider that says `invalid_api_key` is telling the truth about the
 * credential regardless of the status it wrapped that in (Gemini sends a 400, not a 401), and
 * because a 401 body is allowed to contain the word "quota". Status follows. Machine codes
 * fill the gaps for the providers that report a code with a generic status. Anything left is
 * {@link FAILURE_KIND.Unknown}, which observes rather than parks.
 *
 * Note that this deliberately does *not* read a message or a body. Prose matching is what the
 * classifiers this replaces did, and a message is the part of a provider response most likely
 * to change without notice, to be localised, or to appear in an unrelated field. An
 * unrecognised provider therefore costs one `Unknown` observation, not a wrong verdict.
 */
export function classifyFailure(failure: ProviderFailure): FailureClassification {
  const status = failure.status;
  const codes = new Set<string>();
  if (failure.code) codes.add(failure.code.toLowerCase());
  if (failure.type) codes.add(failure.type.toLowerCase());
  const has = (set: ReadonlySet<string>): boolean => {
    for (const code of codes) if (set.has(code)) return true;
    return false;
  };

  const done = (kind: FailureKind, evidence: string): FailureClassification => ({
    kind,
    recovery: RECOVERY_FOR_KIND[kind],
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    evidence,
    ...(status !== undefined ? { status } : {}),
  });

  if (has(CREDENTIAL_CODES)) return done(FAILURE_KIND.CredentialRejected, "credential-code");
  if (status === 401) return done(FAILURE_KIND.CredentialRejected, "status-401");
  // A 403 is the one genuinely ambiguous status: it can mean "your key is dead", "your quota
  // is gone", "we are overloaded", or "we don't like this request". A code disambiguates it;
  // with no code the honest verdict is that the *request* was refused, not the credential.
  if (status === 403) {
    if (has(QUOTA_CODES)) return done(FAILURE_KIND.QuotaExhausted, "status-403+quota-code");
    if (has(CAPACITY_CODES)) {
      return done(FAILURE_KIND.ProviderUnavailable, "status-403+capacity-code");
    }
    return done(FAILURE_KIND.RequestRejected, "status-403-bare");
  }

  if (has(QUOTA_CODES)) return done(FAILURE_KIND.QuotaExhausted, "quota-code");
  if (has(RATE_LIMIT_CODES) || status === 429) {
    return done(FAILURE_KIND.RateLimited, has(RATE_LIMIT_CODES) ? "rate-limit-code" : "status-429");
  }
  if (has(CAPACITY_CODES)) return done(FAILURE_KIND.ProviderUnavailable, "capacity-code");
  if (status !== undefined && UNAVAILABLE_STATUSES.has(status)) {
    return done(FAILURE_KIND.ProviderUnavailable, "status-unavailable");
  }
  // 408 is the provider giving up on a request it never finished reading: a transport event.
  if (status === 408) return done(FAILURE_KIND.ProviderUnavailable, "status-408");
  if (status !== undefined && status >= 400 && status <= 499) {
    return done(FAILURE_KIND.RequestRejected, "status-4xx");
  }
  return done(FAILURE_KIND.Unknown, "no-signal");
}

/**
 * Backoff bounds. The default floor is one second and the default ceiling one minute, so a
 * persistently throttled credential keeps trying on a sane cadence instead of disappearing
 * for the rest of the session; the ceiling on the whole cooldown is fifteen minutes, so a
 * provider that reports a day-long reset does not park a credential for a day.
 */
export const DEFAULT_BACKOFF_OPTIONS = {
  floorMs: 1_000,
  baseMs: 2_000,
  ceilingMs: 60_000,
  maxCooldownMs: 900_000,
  /** Half-width of the jitter band, as a fraction. 0.25 → [0.75×, 1.25×] of the raw backoff. */
  jitterRatio: 0.25,
  /** Highest exponent the doubling is allowed to reach, so it cannot overflow into nonsense. */
  maxExponent: 10,
} as const;

export interface BackoffOptions {
  readonly floorMs?: number;
  readonly baseMs?: number;
  readonly ceilingMs?: number;
  readonly maxCooldownMs?: number;
  readonly jitterRatio?: number;
  readonly maxExponent?: number;
}

/**
 * Computes the cooldown for the `consecutiveFailures`-th consecutive parking, before jitter.
 *
 * `consecutiveFailures` counts *parkings*, not lifetime failures, so a credential that fails
 * once at 09:00 and then works all day starts its next backoff from the floor — the streak is
 * what makes the backoff grow, and nothing else is.
 */
export function backoffMs(
  consecutiveFailures: number,
  options: BackoffOptions = DEFAULT_BACKOFF_OPTIONS,
): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_OPTIONS.baseMs;
  const floor = options.floorMs ?? DEFAULT_BACKOFF_OPTIONS.floorMs;
  const ceiling = options.ceilingMs ?? DEFAULT_BACKOFF_OPTIONS.ceilingMs;
  const maxExponent = options.maxExponent ?? DEFAULT_BACKOFF_OPTIONS.maxExponent;
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, maxExponent));
  return Math.min(Math.max(floor, base * 2 ** exponent), ceiling);
}

export type CredentialState = "healthy" | "cooling" | "disabled";

/**
 * Per-credential health. The counting fields deliberately mirror the `CredentialStats` shape
 * the existing fleet module already reports, so that a later cutover is a change of *source*
 * and not a change of shape for every caller that renders a key list.
 */
export interface GatewayCredentialHealth {
  readonly credentialId: string;
  readonly state: CredentialState;
  /** Why it was last parked. Absent while healthy. */
  readonly kind?: FailureKind;
  /** Epoch-ms when the cooldown lifts. Present only while cooling. */
  readonly retryAt?: number;
  /** How much longer it will be unusable. Zero unless cooling. */
  readonly cooldownRemainingMs: number;
  /** Consecutive parkings. Drives the backoff. Reset by a success. */
  readonly consecutiveFailures: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt?: number;
  readonly lastSuccessAt?: number;
  readonly lastFailureAt?: number;
  /** The `Retry-After` the provider sent for the cooldown now in force, if it sent one. */
  readonly lastRetryAfterMs?: number;
}

interface CredentialState_ {
  state: CredentialState;
  kind?: FailureKind;
  retryAt?: number;
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastRetryAfterMs?: number;
}

export interface ProviderGatewayOptions extends BackoffOptions {
  /** Clock, in epoch-ms. Injectable so backoff and cooldown are testable without sleeping. */
  readonly now?: () => number;
  /**
   * Jitter source, in [0, 1). Injectable for the same reason: a test that asserts an exact
   * cooldown pins this and gets an exact answer, and a test that wants to see the band pin it
   * to the two ends.
   */
  readonly random?: () => number;
}

/** Why a credential was passed over by {@link ProviderGateway.select}. */
export interface SkippedCredential {
  readonly credentialId: string;
  readonly state: CredentialState;
  /** Only for a cooling credential: how long until it is worth trying again. */
  readonly cooldownRemainingMs?: number;
}

export type ExhaustionReason = "no_credentials" | "all_disabled" | "all_cooling";

export type SelectionResult =
  | {
      readonly status: "selected";
      readonly credentialId: string;
      readonly skipped: readonly SkippedCredential[];
    }
  | {
      readonly status: "exhausted";
      readonly reason: ExhaustionReason;
      /**
       * Epoch-ms of the earliest credential that could become usable. Present only when
       * `reason` is `all_cooling` — it is the answer to "may I wait, or should I fail?".
       */
      readonly retryAt?: number;
      readonly cooldownRemainingMs: number;
      readonly skipped: readonly SkippedCredential[];
    };

/**
 * The credential-selection state machine.
 *
 * It stores **credential ids, never secrets**: the caller maps an id back to whatever it uses
 * to authenticate, so this module can be logged, snapshotted and serialised without a secret
 * ever passing through it.
 */
export class ProviderGateway {
  private readonly credentials = new Map<string, CredentialState_>();
  /** Stable, sorted order of every registered id, so the round-robin is reproducible. */
  private order: string[] = [];
  private cursor = -1;
  private readonly options: Required<BackoffOptions> & { random: () => number };
  private readonly clock: () => number;

  constructor(options: ProviderGatewayOptions = {}) {
    this.options = {
      floorMs: options.floorMs ?? DEFAULT_BACKOFF_OPTIONS.floorMs,
      baseMs: options.baseMs ?? DEFAULT_BACKOFF_OPTIONS.baseMs,
      ceilingMs: options.ceilingMs ?? DEFAULT_BACKOFF_OPTIONS.ceilingMs,
      maxCooldownMs: options.maxCooldownMs ?? DEFAULT_BACKOFF_OPTIONS.maxCooldownMs,
      jitterRatio: options.jitterRatio ?? DEFAULT_BACKOFF_OPTIONS.jitterRatio,
      maxExponent: options.maxExponent ?? DEFAULT_BACKOFF_OPTIONS.maxExponent,
      random: options.random ?? Math.random,
    };
    this.clock = options.now ?? Date.now;
  }

  /** How many credentials are in the pool. */
  get size(): number {
    return this.credentials.size;
  }

  /**
   * Adds credentials, preserving the health of any already present. Preserving matters: a
   * configuration reload happens on every settings save, and a gateway that reset on reload
   * would clear every cooldown exactly when someone is editing the key list.
   */
  register(credentialIds: readonly string[]): void {
    for (const id of credentialIds) {
      if (id.length === 0) continue;
      if (!this.credentials.has(id)) {
        this.credentials.set(id, {
          state: "healthy",
          consecutiveFailures: 0,
          successCount: 0,
          failureCount: 0,
        });
      }
    }
    this.order = [...this.credentials.keys()].sort((a, b) => a.localeCompare(b));
    if (this.cursor >= this.order.length) this.cursor = -1;
  }

  /** Removes credentials entirely, health included. */
  unregister(credentialIds: readonly string[]): void {
    const dropping = new Set(credentialIds);
    for (const id of dropping) this.credentials.delete(id);
    this.order = [...this.credentials.keys()].sort((a, b) => a.localeCompare(b));
    if (this.cursor >= this.order.length) this.cursor = -1;
  }

  /**
   * Picks the next credential to use, round-robin, skipping the ones that are not usable now.
   *
   * **Why round-robin over a sorted list with one cursor.** The order is sorted rather than
   * insertion-ordered so the rotation is reproducible: two gateways fed the same credentials
   * and the same outcomes pick the same next credential, which is what makes a failure
   * reproducible in a test or a bug report. The cursor advances only when a credential is
   * actually selected, so a cooling credential is *skipped over* rather than consuming a turn
   * — otherwise one credential being throttled would silently double the rotation rate of the
   * others and skew load onto whichever keys happened to be healthy.
   *
   * **Why it never returns a cooling credential.** Handing back a key that is mid-window is
   * how a fleet turns one 429 into a retry storm against the provider's own limit. When the
   * whole pool is cooling, the result says so and carries `retryAt`, so the caller can choose
   * to wait, fail, or surface it — the decision is the caller's because only the caller knows
   * whether a wait fits the request it is serving.
   */
  select(now: number = this.clock()): SelectionResult {
    if (this.order.length === 0) {
      return { status: "exhausted", reason: "no_credentials", cooldownRemainingMs: 0, skipped: [] };
    }

    // The whole pool is examined, not just the prefix up to the chosen credential, so `skipped`
    // answers "what was passed over and why" for *every* credential rather than only the ones
    // the cursor happened to walk past. A caller debugging "why is my key not being used" needs
    // the full list; the extra work is a scan of a handful of ids.
    const skipped: SkippedCredential[] = [];
    const coolingRetryAts: number[] = [];
    const candidates = this.order.length;
    let chosenIndex = -1;
    for (let step = 1; step <= candidates; step++) {
      const index = (this.cursor + step) % candidates;
      const id = this.order[index]!;
      const entry = this.credentials.get(id);
      if (entry === undefined) continue;
      if (entry.state === "disabled") {
        skipped.push({ credentialId: id, state: "disabled" });
        continue;
      }
      if (entry.state === "cooling") {
        const retryAt = this.settleIfLapsed(entry, now);
        if (retryAt !== undefined) {
          skipped.push({
            credentialId: id,
            state: "cooling",
            cooldownRemainingMs: retryAt - now,
          });
          coolingRetryAts.push(retryAt);
          continue;
        }
      }
      if (chosenIndex < 0) chosenIndex = index;
    }

    if (chosenIndex >= 0) {
      const id = this.order[chosenIndex]!;
      this.cursor = chosenIndex;
      const entry = this.credentials.get(id)!;
      entry.lastUsedAt = now;
      return { status: "selected", credentialId: id, skipped };
    }

    const retryAt = coolingRetryAts.length > 0 ? Math.min(...coolingRetryAts) : undefined;
    return {
      status: "exhausted",
      reason: coolingRetryAts.length > 0 ? "all_cooling" : "all_disabled",
      ...(retryAt !== undefined ? { retryAt } : {}),
      cooldownRemainingMs: retryAt !== undefined ? Math.max(0, retryAt - now) : 0,
      skipped,
    };
  }

  /**
   * Records that a credential worked. This resets the consecutive-failure streak, which is
   * the single most valuable line in the module: without it a credential that tripped once at
   * 09:00 and served cleanly all day is still backing off like a repeat offender at 17:00, and
   * its first genuine 429 of the evening gets a minute-long penalty it has not earned.
   */
  recordSuccess(credentialId: string, now: number = this.clock()): void {
    const entry = this.credentials.get(credentialId);
    if (entry === undefined) return;
    entry.successCount++;
    entry.lastSuccessAt = now;
    entry.lastUsedAt = now;
    entry.consecutiveFailures = 0;
    if (entry.state === "cooling") {
      entry.state = "healthy";
      entry.retryAt = undefined;
      entry.lastRetryAfterMs = undefined;
    }
  }

  /**
   * Records a failure and applies its recovery.
   *
   * The streak and the counters only move for failures the credential is answerable for. A
   * {@link RECOVERY.Ignore} or {@link RECOVERY.Surface} failure leaves the credential's record
   * untouched — not "parks it for a bit", not "counts it neutrally", *untouched* — because a
   * provider that is down, or a caller that sent a malformed request, will do the same thing
   * to every other credential, and a record that accumulates those is a record that describes
   * the weather rather than the key.
   */
  recordFailure(
    credentialId: string,
    classification: FailureClassification,
    now: number = this.clock(),
  ): GatewayCredentialHealth {
    const entry = this.credentials.get(credentialId);
    if (entry === undefined) {
      // A failure for a credential that is not in the pool: the pool was reloaded out from
      // under an in-flight call. Ignore it rather than inventing a record for a key we no
      // longer know about.
      return unknownHealth(credentialId, now);
    }

    switch (classification.recovery) {
      case RECOVERY.Disable: {
        entry.state = "disabled";
        entry.kind = classification.kind;
        entry.retryAt = undefined;
        entry.consecutiveFailures++;
        entry.failureCount++;
        entry.lastFailureAt = now;
        break;
      }
      case RECOVERY.CoolDown:
      case RECOVERY.CoolDownUntilReset: {
        entry.consecutiveFailures++;
        const raw =
          classification.retryAfterMs !== undefined
            ? classification.retryAfterMs
            : this.jitteredBackoff(entry.consecutiveFailures);
        // Bounded wait, always: a provider claiming a 24-hour reset is not believed past the
        // ceiling, and a negative or absurd `Retry-After` degrades to the computed backoff
        // rather than to a credential that is instantly free or instantly gone.
        const cooldown =
          Number.isFinite(raw) && raw > 0
            ? Math.min(raw, this.options.maxCooldownMs)
            : this.jitteredBackoff(entry.consecutiveFailures);
        entry.state = "cooling";
        entry.kind = classification.kind;
        entry.retryAt = now + cooldown;
        entry.lastRetryAfterMs = classification.retryAfterMs;
        entry.failureCount++;
        entry.lastFailureAt = now;
        break;
      }
      case RECOVERY.Observe: {
        entry.consecutiveFailures++;
        entry.failureCount++;
        entry.lastFailureAt = now;
        break;
      }
      case RECOVERY.Ignore:
      case RECOVERY.Surface:
        break;
    }

    return this.health(credentialId, now);
  }

  /**
   * Brings a disabled credential back, for when a human has reauthorized it. Cooling
   * credentials come back on their own when the window lapses; reviving one early is allowed
   * and is the manual "try it now" button.
   */
  revive(credentialId: string, now: number = this.clock()): void {
    const entry = this.credentials.get(credentialId);
    if (entry === undefined) return;
    entry.state = "healthy";
    entry.kind = undefined;
    entry.retryAt = undefined;
    entry.lastRetryAfterMs = undefined;
    entry.consecutiveFailures = 0;
    entry.lastUsedAt = now;
  }

  /** Health for one credential. Unknown ids report a healthy-looking zeroed record. */
  health(credentialId: string, now: number = this.clock()): GatewayCredentialHealth {
    const entry = this.credentials.get(credentialId);
    if (entry === undefined) return unknownHealth(credentialId, now);
    // Settle first: a cooldown that has lapsed is a fact about *time*, not about the last call
    // made. Without this, a key reads as cooling until the next `select()` — so a dashboard
    // rendering `snapshot()` would show a recovered key as down for the rest of the session.
    this.settleIfLapsed(entry, now);
    const cooling = entry.state === "cooling" ? Math.max(0, (entry.retryAt ?? now) - now) : 0;
    return {
      credentialId,
      state: entry.state,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      ...(entry.retryAt !== undefined ? { retryAt: entry.retryAt } : {}),
      cooldownRemainingMs: cooling,
      consecutiveFailures: entry.consecutiveFailures,
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      ...(entry.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
      ...(entry.lastSuccessAt !== undefined ? { lastSuccessAt: entry.lastSuccessAt } : {}),
      ...(entry.lastFailureAt !== undefined ? { lastFailureAt: entry.lastFailureAt } : {}),
      ...(entry.lastRetryAfterMs !== undefined ? { lastRetryAfterMs: entry.lastRetryAfterMs } : {}),
    };
  }

  /** Every credential's health, in the same stable order `select` rotates over. */
  snapshot(now: number = this.clock()): GatewayCredentialHealth[] {
    return this.order.map((id) => this.health(id, now));
  }

  /** Drops all state. For tests and a full pool reset. */
  clear(): void {
    this.credentials.clear();
    this.order = [];
    this.cursor = -1;
  }

  /**
   * Settles a cooling credential whose window has passed, and reports the epoch-ms it is due
   * back at. Returns `undefined` once the credential is usable again.
   *
   * The streak resets here rather than on the next success, so a credential that sat idle
   * through its own cooldown resumes at the floor instead of serving a penalty it earned
   * before the last call it made. Every reader of a credential's state goes through this, so
   * "cooling" always means "cooling *right now*" — there is no second, stale answer.
   */
  private settleIfLapsed(entry: CredentialState_, now: number): number | undefined {
    if (entry.state !== "cooling") return undefined;
    const retryAt = entry.retryAt ?? now;
    if (retryAt > now) return retryAt;
    entry.state = "healthy";
    entry.retryAt = undefined;
    entry.consecutiveFailures = 0;
    entry.lastRetryAfterMs = undefined;
    return undefined;
  }

  private jitteredBackoff(consecutiveFailures: number): number {
    const raw = backoffMs(consecutiveFailures, this.options);
    const { jitterRatio } = this.options;
    // `1 - ratio + 2*ratio*rand` is uniform over [1-ratio, 1+ratio] for uniform `rand`. The
    // band is deliberately narrow: enough that a fleet which fails together does not retry in
    // lockstep, not so wide that a credential's cooldown is dominated by the dice.
    const factor = 1 - jitterRatio + 2 * jitterRatio * this.options.random();
    return Math.min(Math.max(0, Math.round(raw * factor)), this.options.maxCooldownMs);
  }
}

function unknownHealth(credentialId: string, now: number): GatewayCredentialHealth {
  return {
    credentialId,
    state: "healthy",
    cooldownRemainingMs: 0,
    consecutiveFailures: 0,
    successCount: 0,
    failureCount: 0,
    lastUsedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Shadow mode
// ---------------------------------------------------------------------------

/**
 * The four things the pre-existing call sites actually do to a credential. This is the unit of
 * comparison for {@link observeFailure}: the *names* in the new vocabulary are new, but the
 * **action** is what a behaviour flip would change, so agreement is judged there. A kind
 * disagreement with an action agreement is reported, but is not a finding.
 */
export const LEGACY_ACTION = {
  /** `recordFailure(key, "auth")` — the key is marked permanently failed. */
  Evict: "evict",
  /** `recordFailure(key, "rate_limit", ms?)` — the key goes on a cooldown. */
  CoolDown: "cool_down",
  /** `recordFailure(key, "other")` — the failure count moves, nothing else does. */
  Observe: "observe",
  /** No `recordFailure` call at all: the branch returned before reaching the rotator. */
  None: "none",
} as const;
export type LegacyAction = (typeof LEGACY_ACTION)[keyof typeof LEGACY_ACTION];

/** How each new recovery maps onto the legacy action it is a candidate replacement for. */
const LEGACY_EQUIVALENT: Readonly<Record<RecoveryAction, LegacyAction>> = {
  [RECOVERY.Disable]: LEGACY_ACTION.Evict,
  [RECOVERY.CoolDown]: LEGACY_ACTION.CoolDown,
  [RECOVERY.CoolDownUntilReset]: LEGACY_ACTION.CoolDown,
  [RECOVERY.Observe]: LEGACY_ACTION.Observe,
  [RECOVERY.Ignore]: LEGACY_ACTION.None,
  [RECOVERY.Surface]: LEGACY_ACTION.None,
};

/** One line of shadow evidence. This is the record a reviewer reads to decide on the flip. */
export interface ShadowRecord {
  /** The credential the call site was acting on, when it had one. */
  readonly credentialId?: string;
  /** Free-form provider/model label, carried through so the record is greppable. */
  readonly provider?: string;
  /** What the old call site did. */
  readonly legacy: LegacyAction;
  /** What the new vocabulary calls the same failure. */
  readonly kind: FailureKind;
  /** What the new vocabulary would do. */
  readonly recovery: RecoveryAction;
  /** Whether the action the new vocabulary implies is the action that was taken. */
  readonly agrees: boolean;
  readonly evidence: string;
  readonly status?: number;
  readonly at: number;
}

export type ShadowSink = (record: ShadowRecord) => void;

export interface ShadowOptions {
  readonly sink?: ShadowSink;
  readonly now?: () => number;
}

export interface ObserveFailureInput {
  /** The error the call site caught, harvested from structurally — see {@link collectFailure}. */
  readonly failure: ProviderFailure;
  /** The action the existing call site took. */
  readonly legacy: LegacyAction;
  readonly credentialId?: string;
  readonly provider?: string;
}

/**
 * The shadow entry point. Classifies a failure with the new vocabulary, compares the action it
 * implies against the action the old call site actually took, and reports both. **It changes
 * no state** — that is the whole point: the old pools are still the ones deciding what
 * happens, and this only watches.
 *
 * Pass `failure` from {@link collectFailure} rather than building it by hand, so the shadow
 * sees exactly the structured evidence the classifier would see at flip time.
 */
export function observeFailure(
  input: ObserveFailureInput,
  options: ShadowOptions = {},
): { classification: FailureClassification; record: ShadowRecord } {
  const classification = classifyFailure(input.failure);
  const equivalent = LEGACY_EQUIVALENT[classification.recovery];
  const record: ShadowRecord = {
    ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    legacy: input.legacy,
    kind: classification.kind,
    recovery: classification.recovery,
    agrees: equivalent === input.legacy,
    evidence: classification.evidence,
    ...(classification.status !== undefined ? { status: classification.status } : {}),
    at: (options.now ?? Date.now)(),
  };
  (options.sink ?? defaultShadowSink)(record);
  return { classification, record };
}

/**
 * The default shadow sink: one line per failure, on `console.warn` because that is the
 * convention this codebase uses for subsystem diagnostics. It is deliberately a *log*, not a
 * metric — no counter is incremented and nothing is exported, because an invented metric is
 * something a reviewer has to unpick later and this log has a deletion date written on it.
 */
const defaultShadowSink: ShadowSink = (record) => {
  const status = record.status !== undefined ? ` status=${record.status}` : "";
  const credential = record.credentialId !== undefined ? ` credential=${record.credentialId}` : "";
  const provider = record.provider !== undefined ? ` provider=${record.provider}` : "";
  // `agrees=false` is the line to grep for; the rest is context for reading one.
  console.warn(
    `[provider-gateway/shadow]${provider}${credential}${status}` +
      ` legacy=${record.legacy} kind=${record.kind} recovery=${record.recovery}` +
      ` evidence=${record.evidence} agrees=${String(record.agrees)}`,
  );
};

const ENVELOPE_KEYS = ["error", "body", "data", "response", "responseBody"] as const;

/**
 * Harvests the structured evidence {@link classifyFailure} needs from a caught error.
 *
 * SDKs disagree about where the response body lives: OpenAI puts the parsed body on `.error`,
 * Anthropic nests it one deeper, and wrappers add `.response.data` or `.body`. So this walks
 * the error's `cause` chain (a transport error is usually *below* the SDK error) and a small,
 * fixed set of envelope fields looking for a status, a machine code, a provider type, and a
 * `Retry-After`. Depth and cycles are both bounded, and no arbitrary object is stringified —
 * an SDK error can hold the entire response, and a credential lives in these objects.
 *
 * **It never reads a message or a body string.** That is the whole difference between this
 * and the classifiers it shadows, and it is why the two can be expected to disagree: a
 * provider that only ever says "usage limit reached" in prose is genuinely unclassifiable
 * here, and lands on `Unknown`. Those disagreements are the finding the shadow release
 * exists to produce; see the flip procedure at the top of this file.
 */
export function collectFailure(error: unknown, now: number = Date.now()): ProviderFailure {
  let status: number | undefined;
  let code: string | undefined;
  let type: string | undefined;
  let retryAfterMs: number | undefined;

  const seenChain = new Set<unknown>();
  let current: unknown = error;
  while (current != null && typeof current === "object" && !seenChain.has(current)) {
    seenChain.add(current);
    const record = current as Record<string, unknown>;

    if (status === undefined) {
      const raw = record["status"] ?? record["statusCode"];
      if (typeof raw === "number" && raw >= 100 && raw <= 599) status = raw;
    }
    if (code === undefined && typeof record["code"] === "string") code = record["code"];
    if (type === undefined && typeof record["type"] === "string") type = record["type"];
    if (retryAfterMs === undefined) {
      retryAfterMs = readRetryAfter(record, now);
    }

    if (status !== undefined && code !== undefined && type !== undefined) break;

    for (const key of ENVELOPE_KEYS) {
      const nested = record[key];
      if (nested == null || typeof nested !== "object") continue;
      if (seenChain.has(nested)) continue;
      if (status === undefined) {
        const raw =
          (nested as Record<string, unknown>)["status"] ??
          (nested as Record<string, unknown>)["statusCode"];
        if (typeof raw === "number" && raw >= 100 && raw <= 599) status = raw;
      }
      if (code === undefined && typeof (nested as Record<string, unknown>)["code"] === "string") {
        code = (nested as Record<string, unknown>)["code"] as string;
      }
      if (type === undefined && typeof (nested as Record<string, unknown>)["type"] === "string") {
        type = (nested as Record<string, unknown>)["type"] as string;
      }
      if (retryAfterMs === undefined) {
        retryAfterMs = readRetryAfter(nested as Record<string, unknown>, now);
      }
    }

    current = record["cause"];
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/**
 * Reads a `Retry-After` in the two forms a provider can send, plus the numeric `retry_after` /
 * `reset_after` fields some provider bodies use. Seconds are the common case; an HTTP-date is
 * resolved against the caller's `now` — hence the parameter — so a stale one degrades to
 * "retry immediately" rather than to a wrong long wait, and so a test can pin the clock.
 */
function readRetryAfter(level: Record<string, unknown>, now: number): number | undefined {
  const headers = level["headers"];
  if (headers != null && typeof headers === "object") {
    const bag = headers as { get?: (name: string) => unknown };
    const raw = typeof bag.get === "function" ? bag.get("retry-after") : undefined;
    const parsed = parseRetryAfterValue(typeof raw === "string" ? raw : undefined, now);
    if (parsed !== undefined) return parsed;
    const plain = (headers as Record<string, unknown>)["retry-after"];
    if (typeof plain === "string") {
      const fromPlain = parseRetryAfterValue(plain, now);
      if (fromPlain !== undefined) return fromPlain;
    }
  }

  for (const key of ["retry_after", "retryAfter", "reset_after", "resetAfter"]) {
    const value = level[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      // These body fields are always seconds; there is no date form in a JSON body.
      return Math.round(value * 1000);
    }
  }
  return undefined;
}

function parseRetryAfterValue(
  raw: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
