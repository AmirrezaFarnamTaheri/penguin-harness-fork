/**
 * Prompt Cache TTL and State Tracker.
 * Absorbed from claude-hud prompt-cache.ts.
 */

import type { HudPromptCacheMetrics } from "./types.js";

export const DEFAULT_PROMPT_CACHE_TTL_SECONDS = 300; // 5 minutes standard

export class HudPromptCacheTracker {
  private anchorTimestamp?: number;
  private ttlSeconds: number;
  private cacheReadTokens: number = 0;
  private cacheCreationTokens: number = 0;

  constructor(ttlSeconds: number = DEFAULT_PROMPT_CACHE_TTL_SECONDS) {
    this.ttlSeconds = ttlSeconds;
  }

  recordUsage(
    cacheCreationTokens: number,
    cacheReadTokens: number,
    now: number = Date.now(),
  ): void {
    this.cacheCreationTokens += cacheCreationTokens;
    this.cacheReadTokens += cacheReadTokens;

    if (cacheCreationTokens > 0 || cacheReadTokens > 0) {
      // Refresh the anchor on cache write or read
      this.anchorTimestamp = now;
    }
  }

  getMetrics(now: number = Date.now()): HudPromptCacheMetrics {
    if (!this.anchorTimestamp) {
      return {
        cacheReadTokens: this.cacheReadTokens,
        cacheCreationTokens: this.cacheCreationTokens,
        ttlSeconds: this.ttlSeconds,
        remainingSeconds: 0,
        state: "none",
      };
    }

    const elapsedSeconds = Math.floor((now - this.anchorTimestamp) / 1000);
    const remainingSeconds = Math.max(0, this.ttlSeconds - elapsedSeconds);

    let state: "active" | "warning" | "expired" = "active";
    if (remainingSeconds === 0) {
      state = "expired";
    } else if (remainingSeconds <= Math.min(60, Math.floor(this.ttlSeconds / 5))) {
      state = "warning";
    }

    return {
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      anchorTimestamp: this.anchorTimestamp,
      ttlSeconds: this.ttlSeconds,
      remainingSeconds,
      state,
    };
  }

  reset(): void {
    this.anchorTimestamp = undefined;
    this.cacheReadTokens = 0;
    this.cacheCreationTokens = 0;
  }
}
