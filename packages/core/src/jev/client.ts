import {
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";

/** A small, typed transport around the verified `@typesafe-ai/sdk` System One API. */
export interface JevClientOptions {
  /** Required credential. It is never logged or included in returned diagnostics. */
  apiKey: string;
  /** API root, not the `/v1/systemone` path; the SDK appends that path. */
  baseUrl?: string;
  /** Model override; the SDK default is `jev-latest`. */
  model?: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum SDK retries after the first attempt. */
  maxRetries?: number;
  /** Hard wall-clock budget for the complete request, including retries. */
  totalTimeoutMs?: number;
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long the circuit stays open before a probe is allowed. */
  circuitResetMs?: number;
  /** Injectable transport for tests and hosts that own the HTTP stack. */
  fetch?: typeof fetch;
  /** Injectable clock for deterministic circuit-breaker tests. */
  now?: () => number;
}

export type JevCircuitState = "closed" | "open";

const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

function validateBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || JEV_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Jev baseUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Jev baseUrl must use http or https");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Jev baseUrl must use https (http is allowed only for loopback)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Jev baseUrl must not contain embedded credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("Jev baseUrl must not contain a query or fragment");
  }
  return raw.replace(/\/+$/, "");
}

export interface JevAskOptions<Q extends Questions = Questions> {
  /** Override the client's total deadline for this one request. */
  deadlineMs?: number;
  /** Validate the provider result before the circuit records a successful transport. */
  validate?: (result: SystemOneResult<Q>) => void;
}

/** Thrown without making a network request while the local circuit is open. */
export class JevCircuitOpenError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number) {
    super(`Jev circuit is open until ${new Date(retryAt).toISOString()}`);
    this.name = "JevCircuitOpenError";
    this.retryAt = retryAt;
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Calls TypeSafe System One with bounded time/retry settings and a local circuit breaker.
 *
 * The SDK is deliberately kept behind this seam: callers receive typed System One
 * results, while failure policy and credential handling stay under harness control.
 */
export class JevClient {
  private readonly client: TypeSafeClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly failureThreshold: number;
  private readonly circuitResetMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  /** When the most recent failure was recorded: the breaker's window starts here, not at boot. */
  private lastFailureAtMs = 0;
  private circuitOpenedUntil = 0;
  private halfOpenProbe = false;

  constructor(options: JevClientOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey === "") throw new Error("Jev API key is required");
    const baseUrl = validateBaseUrl(options.baseUrl);
    this.model = options.model?.trim() || "jev-latest";
    if (this.model.length > 128) throw new Error("Jev model must be at most 128 characters");
    this.timeoutMs = boundedInteger(options.timeoutMs, 4000, 100, 30_000);
    this.totalTimeoutMs = boundedInteger(options.totalTimeoutMs, 4000, 100, 30_000);
    this.maxRetries = boundedInteger(options.maxRetries, 0, 0, 2);
    this.failureThreshold = boundedInteger(options.failureThreshold, 3, 1, 10);
    this.circuitResetMs = boundedInteger(options.circuitResetMs, 30_000, 1000, 300_000);
    this.now = options.now ?? Date.now;
    const transport = options.fetch ?? globalThis.fetch;
    if (typeof transport !== "function") throw new Error("Jev requires a fetch implementation");
    this.client = new TypeSafeClient({
      apiKey,
      // Always explicit: an ambient TYPESAFE_BASE_URL must not redirect a host-owned key.
      baseURL: baseUrl,
      defaultModel: this.model,
      logLevel: "off",
      timeout: this.timeoutMs,
      retry: { maxRetries: this.maxRetries },
      fetch: async (input, init) => {
        const response = await transport(input, { ...init, redirect: "error" });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new Error("Jev endpoint redirects are not allowed");
        }
        return response;
      },
    });
  }

  /** Current local circuit state, useful for diagnostics without making a request. */
  circuitState(): JevCircuitState {
    if (this.circuitOpenedUntil === 0) return "closed";
    if (this.now() < this.circuitOpenedUntil) return "open";
    return "closed";
  }

  /** Reset a locally opened circuit, primarily for an explicit operator action. */
  resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.lastFailureAtMs = 0;
    this.circuitOpenedUntil = 0;
    this.halfOpenProbe = false;
  }
  /**
   * Sends one bounded System One request. Generic question typing is preserved;
   * callers that consume the result must still validate provider data at their
   * boundary (the tool advisor below does so).
   */
  async ask<Q extends Questions>(
    request: SystemOneRequest<Q>,
    signal?: AbortSignal,
    options: JevAskOptions<Q> = {},
  ): Promise<SystemOneResult<Q>> {
    if (signal?.aborted) throw new APIUserAbortError("Jev request was cancelled");
    const now = this.now();
    if (this.circuitOpenedUntil !== 0 && now < this.circuitOpenedUntil) {
      throw new JevCircuitOpenError(this.circuitOpenedUntil);
    }
    if (this.circuitOpenedUntil !== 0) {
      if (this.halfOpenProbe) throw new JevCircuitOpenError(this.now() + this.circuitResetMs);
      this.halfOpenProbe = true;
    }

    const withModel = request.model === undefined ? { ...request, model: this.model } : request;
    const deadlineMs = boundedInteger(options.deadlineMs, this.totalTimeoutMs, 50, 30_000);
    const timeoutSignal = AbortSignal.timeout(deadlineMs);
    const requestSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    try {
      const result = await this.client.systemOne(withModel, {
        timeout: this.timeoutMs,
        retry: { maxRetries: this.maxRetries },
        signal: requestSignal,
      });
      options.validate?.(result);
      this.recordSuccess();
      return result;
    } catch (error) {
      if (this.isCancellation(signal)) {
        // The caller stopped it. Not a transport failure: it must not move the breaker.
        throw error;
      }
      // The internal deadline fires the SAME composed signal, and the SDK classifies any abort
      // of it as a user abort — so a slow provider arrived here as `APIUserAbortError` and was
      // reported to the reader as "cancelled", which blames them for the provider's latency and
      // makes the timeout diagnostic unreachable. Re-label it with the cause we actually know:
      // our own deadline, not a person.
      this.recordFailure();
      if (timeoutSignal.aborted) throw new APITimeoutError(deadlineMs, { cause: error });
      throw error;
    } finally {
      if (this.circuitOpenedUntil !== 0 && this.halfOpenProbe) this.halfOpenProbe = false;
    }
  }

  private isCancellation(signal?: AbortSignal): boolean {
    // The SDK reports its own timeout as APIUserAbortError too. Only the caller's
    // signal distinguishes a user cancellation; the internal deadline is a failure.
    return signal?.aborted === true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenedUntil = 0;
    this.halfOpenProbe = false;
  }

  private recordFailure(): void {
    // The breaker is TIME-BOUNDED, not merely consecutive. One process-wide counter reached by
    // every Session and subagent meant that a one-second network blip during a run with four
    // tool calls in flight tripped the threshold on its own — all four timed out at the same
    // deadline — and then every tool call in every session on the server recorded "circuit open"
    // for the whole reset window. Failures that are older than the window describe a provider
    // that has since had time to recover, so they no longer count toward opening it again.
    const now = this.now();
    if (this.lastFailureAtMs !== 0 && now - this.lastFailureAtMs >= this.circuitResetMs) {
      this.consecutiveFailures = 0;
    }
    this.lastFailureAtMs = now;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.circuitOpenedUntil = now + this.circuitResetMs;
    }
  }
}
