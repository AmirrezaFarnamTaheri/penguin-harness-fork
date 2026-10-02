/**
 * Connectivity posture — what the app actually knows about reaching its own server, as opposed to
 * what the browser claims about the network (F17.1).
 *
 * The two are different questions and the UI must not conflate them:
 *
 *   - `navigator.onLine` is a statement about the device's link. It is evidence, not proof of
 *     reachability, and it is famously optimistic (captive portals, VPNs, a dead local server).
 *   - A single failed request is a statement about that request. One transient failure must not
 *     produce a persistent "you are offline" banner, so failures are counted and only a
 *     *consecutive* run of them (with a real probe behind each) changes the posture.
 *
 * Cached content is a third, independent fact: the transcript already rendered stays readable
 * whatever the posture is, and the model exposes that separately from whether writes can be
 * attempted. That separation is the honest part of the copy this module drives — "showing what is
 * already loaded" is a promise the app can keep; "your message will be sent later" is not.
 *
 * The module is pure except for the monitor factory at the bottom, which takes its clock, timer
 * and probe as injected dependencies so the whole state machine is unit-testable in node (the web
 * package's test environment has no DOM, by policy).
 */

/** What the app believes about reaching the server right now. */
export type ConnectivityPosture =
  /** A probe succeeded; the server answered. */
  | "online"
  /** Nothing has been probed yet (first load, no evidence either way). */
  | "checking"
  /** At least one probe failed, but not enough consecutive failures to call it unreachable. */
  | "reconnecting"
  /** Enough consecutive probe failures to state that the local server is unreachable. */
  | "server-unreachable"
  /** The browser itself reports no network link. */
  | "browser-offline";

/** Which banner the posture calls for. `none` is the common case and must stay cheap. */
export type ConnectivityBanner =
  | "none"
  /** Device offline (browser evidence). */
  | "browser-offline"
  /** Probing after an outage, or one transient failure — informational, not an offline claim. */
  | "reconnecting"
  /** Confirmed unreachable (consecutive probe failures). */
  | "server-unreachable"
  /** A probe succeeded after an outage; shown briefly, then cleared. */
  | "recovered";

/** Why a manual retry is not available right now (null = it is). */
export type RetryBlockReason = "in-flight" | "rate-limited";

export interface ConnectivityState {
  posture: ConnectivityPosture;
  banner: ConnectivityBanner;
  /** Consecutive probe failures since the last success; reset by a success. */
  consecutiveFailures: number;
  /** Whether the browser reports a link (navigator.onLine). */
  browserOnline: boolean;
  /** Outcome of the last completed probe; `none` before the first one. */
  lastProbe: "none" | "success" | "failure";
  /** A link came back (or a probe is due) after an outage and the server is not verified yet. */
  needsVerification: boolean;
  /** Whether a real outage has been observed; only then is "reconnecting" worth showing. */
  outageSeen: boolean;
  /**
   * Always true in this app, and deliberately part of the model rather than an assumption: the
   * rendered transcript is React state, so it survives any posture. Exposed so the banner copy
   * and the E2E fixtures assert the same fact instead of each re-deriving it.
   */
  cachedContentReadable: true;
  /** Writes are blocked only by evidence, never by a single failed request. */
  writesBlocked: boolean;
  /** Automatic probing has given up after the attempt cap; only a manual retry (or 'online') resumes. */
  autoRetriesExhausted: boolean;
  /** Manual retry availability, with the reason when it is not available. */
  retry: { allowed: boolean; reason: RetryBlockReason | null };
  /** Monotonic timestamp (ms) the current posture was entered; for the "since" copy and tests. */
  sinceMs: number;
  /** Monotonic timestamp of the last successful probe, null before the first one. */
  lastSuccessAtMs: number | null;
}

export interface ConnectivityEvent {
  type: "browser-online" | "browser-offline" | "probe-started" | "probe-succeeded" | "probe-failed";
  /** Monotonic ms (performance.now()-like); injected so tests are deterministic. */
  atMs: number;
}

/** Consecutive failures needed before the app states the server is unreachable. */
export const FAILURE_THRESHOLD = 2;

/** How long the "reconnected" notice stays before the banner clears. */
export const RECOVERY_NOTICE_MS = 3000;

/** Initial state: nothing probed yet, browser link unknown until the first event. */
export function initialConnectivityState(atMs = 0): ConnectivityState {
  return {
    posture: "checking",
    banner: "none",
    consecutiveFailures: 0,
    browserOnline: true,
    lastProbe: "none",
    needsVerification: false,
    outageSeen: false,
    cachedContentReadable: true,
    writesBlocked: false,
    autoRetriesExhausted: false,
    retry: { allowed: false, reason: "in-flight" },
    sinceMs: atMs,
    lastSuccessAtMs: null,
  };
}

/**
 * The pure transition. Every clause here is one sentence of the card:
 *
 *   - `browser-offline` is believed immediately (the device says so) and blocks writes, but says
 *     nothing about the cached transcript;
 *   - `browser-online` is NOT recovery: it moves to `reconnecting` and keeps waiting for a probe,
 *     so the banner cannot clear on a browser event alone;
 *   - a single `probe-failed` is `reconnecting`, only the threshold makes it `server-unreachable`;
 *   - `probe-succeeded` is the only transition to `online`, and it shows the brief `recovered`
 *     notice when it followed an outage.
 */
export function reduceConnectivity(
  state: ConnectivityState,
  event: ConnectivityEvent,
): ConnectivityState {
  const flags = {
    browserOnline: state.browserOnline,
    lastProbe: state.lastProbe,
    consecutiveFailures: state.consecutiveFailures,
    needsVerification: state.needsVerification,
    outageSeen: state.outageSeen,
    probing: false,
  };
  let enteringNotice: ConnectivityBanner | null = null;

  switch (event.type) {
    case "browser-offline":
      flags.browserOnline = false;
      flags.outageSeen = true;
      break;
    case "browser-online":
      // A link event says the device has a route again. It says nothing about the server, so the
      // posture becomes "reconnecting" and the banner stays up until a probe succeeds.
      flags.browserOnline = true;
      flags.needsVerification = true;
      break;
    case "probe-started":
      flags.probing = true;
      if (state.posture !== "online") flags.needsVerification = true;
      break;
    case "probe-succeeded": {
      const wasDown =
        state.outageSeen ||
        state.banner === "browser-offline" ||
        state.banner === "server-unreachable" ||
        state.banner === "reconnecting";
      flags.lastProbe = "success";
      flags.consecutiveFailures = 0;
      flags.needsVerification = false;
      flags.outageSeen = false;
      if (wasDown) enteringNotice = "recovered";
      break;
    }
    case "probe-failed":
      // A failure while the device has no link is not evidence about the server — it is the
      // expected consequence of the link being down, and it must not count toward the threshold.
      if (flags.browserOnline) {
        flags.lastProbe = "failure";
        flags.consecutiveFailures += 1;
        if (flags.consecutiveFailures >= FAILURE_THRESHOLD) flags.outageSeen = true;
      }
      break;
  }

  const next = applyFlags(state, flags, event.atMs);
  if (enteringNotice !== null) return { ...next, banner: enteringNotice, sinceMs: event.atMs };
  return next;
}

/** Projects the evidence flags onto the posture/banner/write-gating fields. */
function applyFlags(
  state: ConnectivityState,
  flags: {
    browserOnline: boolean;
    lastProbe: "none" | "success" | "failure";
    consecutiveFailures: number;
    needsVerification: boolean;
    outageSeen: boolean;
    probing: boolean;
  },
  atMs: number,
): ConnectivityState {
  const unreachableAt = FAILURE_THRESHOLD;
  let posture: ConnectivityPosture;
  if (!flags.browserOnline) posture = "browser-offline";
  else if (flags.lastProbe === "success") posture = "online";
  else if (flags.consecutiveFailures >= unreachableAt) posture = "server-unreachable";
  else if (flags.needsVerification || flags.consecutiveFailures > 0) posture = "reconnecting";
  else posture = "checking";

  let banner: ConnectivityBanner;
  if (posture === "browser-offline") banner = "browser-offline";
  else if (posture === "server-unreachable") banner = "server-unreachable";
  else if (posture === "reconnecting" && flags.outageSeen) banner = "reconnecting";
  else banner = "none";
  // The transient success notice survives further events until it is explicitly cleared.
  if (state.banner === "recovered" && posture === "online" && banner === "none")
    banner = "recovered";

  return {
    ...state,
    posture,
    banner,
    consecutiveFailures: flags.consecutiveFailures,
    browserOnline: flags.browserOnline,
    lastProbe: flags.lastProbe,
    needsVerification: flags.needsVerification,
    outageSeen: flags.outageSeen,
    // Writes are blocked only by sustained evidence: no link, the failure threshold, or a link
    // that came back but has not been confirmed by a probe. One transient failure is not enough.
    writesBlocked:
      !flags.browserOnline ||
      flags.consecutiveFailures >= unreachableAt ||
      // A link that came back after a real outage, before a probe confirms the server: writes are
      // attempted only once there is evidence they can land. A first transient failure is NOT
      // that evidence — blocking a send on one hiccup would be its own kind of false report.
      (flags.needsVerification && flags.outageSeen && flags.lastProbe !== "success"),
    autoRetriesExhausted: flags.needsVerification ? state.autoRetriesExhausted : false,
    retry: { allowed: !flags.probing && posture !== "online", reason: null },
    sinceMs: state.posture === posture ? state.sinceMs : atMs,
  };
}

/**
 * Clears the transient `recovered` notice. A separate transition rather than a timer inside the
 * reducer keeps the reducer total and the notice window testable with a single call.
 */
export function clearRecoveredNotice(state: ConnectivityState, atMs: number): ConnectivityState {
  if (state.banner !== "recovered") return state;
  return { ...state, banner: state.posture === "online" ? "none" : state.banner, sinceMs: atMs };
}

export interface ConnectivityMonitorOptions {
  /**
   * The health probe. Must honour the AbortSignal (a timeout or `stop()` aborts it) and resolve
   * true only for a real success.
   */
  probe: (signal: AbortSignal) => Promise<boolean>;
  onSnapshot: (state: ConnectivityState, previous: ConnectivityState) => void;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Per-attempt timeout; an attempt that outlives it is a failure (the signal is aborted). */
  probeTimeoutMs?: number;
  /** Automatic probe attempts after failures before the monitor waits for a manual retry. */
  maxAutoAttempts?: number;
  /** Backoff before automatic attempt N (0-based). */
  backoffMs?: (attempt: number) => number;
  /** Minimum spacing between manual retries (the "bounded manual retry"). */
  minManualRetryIntervalMs?: number;
  /** How long the recovered notice stays before clearing itself. */
  recoveryNoticeMs?: number;
  /** Interval between healthy probes, so a later outage is noticed without a request failing first. */
  healthyProbeIntervalMs?: number;
}

export interface ConnectivityMonitor {
  snapshot(): ConnectivityState;
  /** Starts probing immediately and wires the periodic healthy probe. */
  start(): void;
  /** Cancels the in-flight probe and every timer; late probe results are ignored. */
  stop(): void;
  /** Manual retry: bounded by the in-flight rule and the spacing, and always re-probes. */
  retry(): boolean;
  /** Browser link events (`online` / `offline`). */
  reportBrowserOnline(online: boolean): void;
  /** Test/introspection seam: whether an attempt is currently in flight. */
  isProbing(): boolean;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const DEFAULT_MAX_AUTO_ATTEMPTS = 6;
const DEFAULT_MANUAL_RETRY_INTERVAL_MS = 1000;
const DEFAULT_HEALTHY_PROBE_INTERVAL_MS = 30_000;

/**
 * Drives {@link reduceConnectivity} with real probes, bounded in all four ways the card names:
 * each attempt has a timeout, every attempt is cancellable, automatic attempts are capped, and
 * manual retries are rate-limited. The monitor never throws: a probe that rejects is a failure
 * event, because the alternative is an unhandled rejection on a path that exists to report
 * network trouble.
 */
export function createConnectivityMonitor(
  options: ConnectivityMonitorOptions,
): ConnectivityMonitor {
  const now = options.now ?? (() => performance.now());
  const setT = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxAutoAttempts = options.maxAutoAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;
  const backoffMs =
    options.backoffMs ?? ((attempt: number) => Math.min(1000 * 2 ** attempt, 15_000));
  const manualRetryIntervalMs =
    options.minManualRetryIntervalMs ?? DEFAULT_MANUAL_RETRY_INTERVAL_MS;
  const recoveryNoticeMs = options.recoveryNoticeMs ?? RECOVERY_NOTICE_MS;
  const healthyProbeIntervalMs =
    options.healthyProbeIntervalMs ?? DEFAULT_HEALTHY_PROBE_INTERVAL_MS;
  // A non-positive interval would turn the slow heartbeat into a busy loop, so it falls back to
  // the default rather than probing continuously.
  const slowProbeIntervalMs =
    healthyProbeIntervalMs > 0 ? healthyProbeIntervalMs : DEFAULT_HEALTHY_PROBE_INTERVAL_MS;

  let state = initialConnectivityState(now());
  let stopped = false;
  /**
   * Which run of the monitor a callback belongs to. `stop()` is a cancellation, not a conclusion:
   * React StrictMode runs cleanup and setup back to back, so `start()` has to reopen what
   * `stop()` closed. Bumping this on both edges is what lets a late result from the run BEFORE
   * the restart be recognized and dropped instead of being applied to the new run (CR).
   */
  let generation = 0;
  let inFlight: AbortController | null = null;
  /** Timeout handle of the current attempt, cleared on settle AND on stop(). */
  let attemptTimeout: unknown = null;
  let attempt = 0;
  /**
   * The consecutive-failure count when the ladder last got a fresh allowance (start, success, or
   * a manual retry). The exhaustion trigger compares against this instead of zero, because the
   * raw count stays high until a probe SUCCEEDS: a level-triggered comparison would drop a
   * retry's very next failure straight back onto the slow path, so "try again" would buy exactly
   * one probe (CR).
   */
  let failureBaseline = 0;
  /** Whether the fast ladder has handed over to the slow heartbeat (cleared by a fresh allowance). */
  let slowProbe = false;
  let lastProbeStartedAtMs: number | null = null;
  let timer: unknown = null;
  let noticeTimer: unknown = null;

  const emit = (next: ConnectivityState): void => {
    const previous = state;
    state = next;
    if (!stopped) options.onSnapshot(next, previous);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      // The handle, not the function: `clearTimeout(fn)` is a silent no-op and would leave a
      // stale backoff timer alive to fire after stop() or after a manual retry.
      clearT(timer);
      timer = null;
    }
  };

  const schedule = (fn: () => void, ms: number): void => {
    clearTimer();
    timer = setT(() => {
      timer = null;
      if (!stopped) fn();
    }, ms);
  };

  /** Cancels a pending notice timer without touching the current state. */
  const cancelNoticeTimer = (): void => {
    if (noticeTimer !== null) {
      clearT(noticeTimer);
      noticeTimer = null;
    }
  };

  /** Cancels the timer AND drops a notice that is currently showing (used when stopping). */
  const clearNotice = (): void => {
    cancelNoticeTimer();
    if (state.banner === "recovered") emit(clearRecoveredNotice(state, now()));
  };

  const finish = (ok: boolean): void => {
    if (stopped) return;
    inFlight = null;
    if (ok) {
      attempt = 0;
      slowProbe = false;
      failureBaseline = 0;
      // Cancel any notice from an EARLIER recovery before applying this one; the notice this
      // success just entered must survive (a `clearNotice()` here would erase it immediately).
      cancelNoticeTimer();
      emit(reduceConnectivity(state, { type: "probe-succeeded", atMs: now() }));
      if (recoveryNoticeMs > 0 && state.banner === "recovered") {
        noticeTimer = setT(() => {
          noticeTimer = null;
          if (!stopped) emit(clearRecoveredNotice(state, now()));
        }, recoveryNoticeMs);
      }
      schedule(() => probeNow(false), healthyProbeIntervalMs);
      return;
    }
    attempt += 1;
    emit(reduceConnectivity(state, { type: "probe-failed", atMs: now() }));
    if (!state.browserOnline) {
      // The browser is offline; sweeping the link is the online event's job, so do not burn
      // automatic attempts on a network that is not there.
      return;
    }
    if (
      slowProbe ||
      attempt >= maxAutoAttempts ||
      state.consecutiveFailures - failureBaseline >= FAILURE_THRESHOLD * 2
    ) {
      if (!slowProbe) emit({ ...state, autoRetriesExhausted: true });
      slowProbe = true;
      // The fast ladder is over, but the question "is the server back?" cannot be: with nothing
      // scheduled, the banner keeps saying unreachable and writes stay blocked until the user
      // clicks Retry or reloads — a server that recovered on its own stays invisible (CR). The
      // fast backoff hands over to the same slow heartbeat a healthy link uses: no further
      // backoff growth, and still exactly one probe in flight at a time.
      schedule(() => probeNow(false), slowProbeIntervalMs);
      return;
    }
    schedule(() => probeNow(false), backoffMs(attempt - 1));
  };

  const probeNow = (manual: boolean): void => {
    if (stopped || inFlight !== null) return;
    const startedAt = now();
    if (
      manual &&
      lastProbeStartedAtMs !== null &&
      startedAt - lastProbeStartedAtMs < manualRetryIntervalMs
    ) {
      emit({ ...state, retry: { allowed: false, reason: "rate-limited" } });
      return;
    }
    lastProbeStartedAtMs = startedAt;
    const controller = new AbortController();
    const probeGeneration = generation;
    inFlight = controller;
    emit(reduceConnectivity(state, { type: "probe-started", atMs: startedAt }));
    // The retry control is offered while an attempt is in flight as "unavailable, in flight", and
    // becomes available again on any settle; `manual` probes therefore re-enable it deliberately.
    emit({ ...state, retry: { allowed: manual, reason: null } });

    // The handle is kept per attempt, not just in the shared slot: after a restart the shared
    // slot belongs to the NEW probe, and a late settle from this one must clear only its own.
    const timeoutHandle = setT(() => {
      // A probe that never settles is a failure with evidence (the timeout), not a hang.
      controller.abort();
    }, probeTimeoutMs);
    attemptTimeout = timeoutHandle;

    // The handle is cleared BEFORE the stopped check: a probe that settles after stop() must not
    // leave its timeout armed (the leak this fixes: a cancelled attempt kept the timer alive).
    const endAttempt = (): void => {
      clearT(timeoutHandle);
      if (attemptTimeout === timeoutHandle) attemptTimeout = null;
    };

    /** True when this attempt still speaks for the current run (see {@link generation}). */
    const current = (): boolean => !stopped && generation === probeGeneration;

    void options
      .probe(controller.signal)
      .then((ok) => {
        endAttempt();
        if (!current()) return;
        finish(ok === true);
      })
      .catch(() => {
        endAttempt();
        if (!current()) return;
        finish(false);
      })
      .finally(() => {
        if (!current()) return;
        // Offered whenever the posture is not already healthy; whether it may actually run right
        // now is decided by the spacing check in retry(), which reports "rate-limited" itself.
        emit({ ...state, retry: { allowed: state.posture !== "online", reason: null } });
      });
  };

  return {
    snapshot: () => state,
    start() {
      if (!stopped && inFlight !== null) return;
      // Reopening after stop(): the previous run's cancellation is not a verdict about the
      // server, so this run gets a fresh probe and its own full auto-retry allowance (a stopped
      // monitor may have burned attempts that never produced an answer).
      generation += 1;
      stopped = false;
      attempt = 0;
      slowProbe = false;
      failureBaseline = state.consecutiveFailures;
      probeNow(false);
    },
    stop() {
      stopped = true;
      generation += 1;
      inFlight?.abort();
      inFlight = null;
      if (attemptTimeout !== null) {
        clearT(attemptTimeout);
        attemptTimeout = null;
      }
      clearTimer();
      clearNotice();
    },
    retry() {
      if (stopped) return false;
      const startedAt = now();
      if (inFlight !== null) {
        emit({ ...state, retry: { allowed: false, reason: "in-flight" } });
        return false;
      }
      if (
        lastProbeStartedAtMs !== null &&
        startedAt - lastProbeStartedAtMs < manualRetryIntervalMs
      ) {
        emit({ ...state, retry: { allowed: false, reason: "rate-limited" } });
        return false;
      }
      clearTimer();
      // A manual retry is the user saying "try again", so it restores the automatic allowance
      // and leaves the slow path: otherwise a retry that fails once is instantly exhausted again
      // and the very next retry has nothing to schedule (CR).
      attempt = 0;
      slowProbe = false;
      failureBaseline = state.consecutiveFailures;
      probeNow(true);
      return true;
    },
    reportBrowserOnline(online: boolean) {
      if (stopped) return;
      if (online) {
        emit(reduceConnectivity(state, { type: "browser-online", atMs: now() }));
        // Recovery is a probe question, never a browser-event question: probe immediately.
        probeNow(false);
      } else {
        emit(reduceConnectivity(state, { type: "browser-offline", atMs: now() }));
      }
    },
    isProbing: () => inFlight !== null,
  };
}
