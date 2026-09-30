/**
 * Retains the most useful HTTP status while a failover chain is exhausted. A later 429
 * must not hide an earlier actionable failure (for example, an invalid request or key).
 * Callers should note only failed attempts; with no recorded response the fallback is 502.
 */
export class FailureStatusTracker {
  private lastNonRateLimitStatus: number | undefined;
  private sawRateLimit = false;

  note(status: number): void {
    if (status === 429) {
      this.sawRateLimit = true;
      return;
    }
    this.lastNonRateLimitStatus = status;
  }

  finalStatus(): number {
    return this.lastNonRateLimitStatus ?? (this.sawRateLimit ? 429 : 502);
  }
}
