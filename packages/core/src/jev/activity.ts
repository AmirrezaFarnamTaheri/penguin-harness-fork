/**
 * A bounded, privacy-safe activity record for the advisory path.
 *
 * Why this exists. A feature that can be slow, unavailable, rate-limited or open its circuit on
 * a bad day is invisible until someone reports "it feels slow". Operators need to see the shape
 * of it — how often it answers, how often it times out, how often the circuit is open, how
 * often a response is rejected as malformed — without any of that being a channel for tool
 * arguments, prompts, provider response bodies or credentials.
 *
 * So the record is deliberately narrow:
 *
 * - it is a FIXED set of named counters and gauges, not a map keyed by anything. A metric whose
 *   key space comes from data is a memory leak and a cardinality explosion waiting to happen;
 * - every value is a count, a duration, or a boolean drawn from a closed vocabulary. Nothing
 *   free-form crosses into it, so there is nothing here to redact later;
 * - the reason is one of a small enum, never a provider string. The provider's words never
 *   enter a process log, and a log line can never become a smuggling channel.
 *
 * The circuit state is sampled, not mirrored: this records that the circuit was open at the
 * moment of a call, and does not try to be a second source of truth about the breaker's own
 * state.
 */

export type AdvisoryReason =
  | "advised"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "circuit_open"
  | "connection_error"
  | "invalid_response"
  /** The provider answered with an HTTP error. The status is recorded separately, not as a key. */
  | "provider_http";

/** Every reason the advisory path can report. A reason outside this set is a bug, not input. */
export const ADVISORY_REASONS: readonly AdvisoryReason[] = [
  "advised",
  "unavailable",
  "timeout",
  "cancelled",
  "circuit_open",
  "connection_error",
  "invalid_response",
  "provider_http",
];

/**
 * Maps a diagnostic word to the closed vocabulary, with the HTTP status split out.
 *
 * The diagnostic itself is a string produced by `safeDiagnostic`, which already refuses to carry
 * a provider body. Narrowing it here is the second gate: a metric whose key space is closed
 * cannot be turned into a log-injection or cardinality channel by anything upstream.
 */
export function bucketReason(diagnostic: string): { reason: AdvisoryReason; httpStatus?: number } {
  if (ADVISORY_REASONS.includes(diagnostic as AdvisoryReason)) {
    return { reason: diagnostic as AdvisoryReason };
  }
  const match = /^provider_http_(\d{3})$/.exec(diagnostic);
  if (match !== null) {
    const status = Number(match[1]);
    return {
      reason: "provider_http",
      httpStatus: status >= 400 && status <= 599 ? status : undefined,
    };
  }
  return { reason: "unavailable" };
}

export interface AdvisoryActivity {
  /** Observations that produced a usable answer. */
  answered: number;
  /** Observations that did not, for any reason. */
  unavailable: number;
  /** Observations the host declined to make (no credential, no advisor composed). */
  skipped: number;
  /** Calls that were already decided before the advisory seam was reached. */
  skippedDecided: number;
  /** Calls the command policy vetoed before the advisory was consulted. */
  skippedPolicy: number;
  readonly byReason: ReadonlyMap<AdvisoryReason, number>;
  /** Latency percentiles of answered calls; read from {@link latencyPercentiles}. */
  readonly providerHttpStatuses: ReadonlyMap<number, number>;
}

const MAX_SAMPLES = 256;

/**
 * A fixed-field counter. One instance per process (or per host, if you prefer); cheap enough to
 * call on every tool call, and holding no per-call data whatsoever.
 */
export class AdvisoryActivityRecorder {
  private answered = 0;
  private unavailableCount = 0;
  private skipped = 0;
  private skippedDecided = 0;
  private skippedPolicy = 0;
  private samples: number[] = [];
  private readonly byReason = new Map<AdvisoryReason, number>();
  /** Provider HTTP statuses seen, as counts. A number, never a key built from a response. */
  private readonly httpStatuses = new Map<number, number>();

  /** Records the outcome of one advisory attempt. */
  record(input: {
    advised: boolean;
    /** The diagnostic word from the advisory path; bucketed, never stored verbatim. */
    reason: string;
    /** End-to-end latency in milliseconds; ignored for an answer that never happened. */
    latencyMs?: number;
  }): void {
    const { reason, httpStatus } = bucketReason(input.reason);
    this.byReason.set(reason, (this.byReason.get(reason) ?? 0) + 1);
    if (httpStatus !== undefined) {
      this.httpStatuses.set(httpStatus, (this.httpStatuses.get(httpStatus) ?? 0) + 1);
    }
    if (input.advised) {
      this.answered += 1;
      if (
        input.latencyMs !== undefined &&
        Number.isFinite(input.latencyMs) &&
        input.latencyMs >= 0
      ) {
        // Bounded sample ring: the point is a distribution, not an audit of every call, and an
        // unbounded list here would be the very leak this module exists to avoid.
        this.samples.push(input.latencyMs);
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
      }
    } else {
      this.unavailableCount += 1;
    }
  }

  /** Records a call the advisory never saw, and why — a count, never a payload. */
  recordSkipped(reason: "disabled" | "decided" | "policy"): void {
    if (reason === "decided") this.skippedDecided += 1;
    else if (reason === "policy") this.skippedPolicy += 1;
    else this.skipped += 1;
  }

  /** A snapshot safe to log or export: every value is a number or a word from a closed set. */
  snapshot(): AdvisoryActivity {
    const ordered = new Map<AdvisoryReason, number>();
    for (const reason of ADVISORY_REASONS) {
      const count = this.byReason.get(reason);
      if (count !== undefined) ordered.set(reason, count);
    }
    return {
      answered: this.answered,
      unavailable: this.unavailableCount,
      skipped: this.skipped,
      skippedDecided: this.skippedDecided,
      skippedPolicy: this.skippedPolicy,
      byReason: ordered,
      providerHttpStatuses: new Map(this.httpStatuses),
    };
  }

  /** p50 / p95 of answered latency, or null when nothing has answered. */
  latencyPercentiles(): { p50: number; p95: number } | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return { p50: at(0.5), p95: at(0.95) };
  }

  reset(): void {
    this.answered = 0;
    this.unavailableCount = 0;
    this.skipped = 0;
    this.skippedDecided = 0;
    this.skippedPolicy = 0;
    this.samples = [];
    this.byReason.clear();
    this.httpStatuses.clear();
  }
}
