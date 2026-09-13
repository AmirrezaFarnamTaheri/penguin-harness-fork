/**
 * Real-time Token Generation Speed Tracker with sliding window smoothing.
 * Absorbed from claude-hud speed-tracker.ts.
 */

import type { HudSpeedMetrics } from "./types.js";

const MIN_DELTA_MS = 500;
const SPEED_WINDOW_MS = 2500;

interface Sample {
  tokens: number;
  time: number;
}

export class HudSpeedTracker {
  private samples: Sample[] = [];
  private startTime: number = 0;
  private totalOutputTokens: number = 0;
  private isStreaming: boolean = false;

  startStream(now: number = Date.now()): void {
    this.startTime = now;
    this.totalOutputTokens = 0;
    this.samples = [{ tokens: 0, time: now }];
    this.isStreaming = true;
  }

  recordTokens(tokenDelta: number, now: number = Date.now()): void {
    if (!this.isStreaming) {
      this.startStream(now);
    }
    this.totalOutputTokens += tokenDelta;
    this.samples.push({ tokens: this.totalOutputTokens, time: now });

    // Prune samples older than the sliding window
    const cutoff = now - SPEED_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0]!.time < cutoff) {
      this.samples.shift();
    }
  }

  finishStream(): void {
    this.isStreaming = false;
  }

  getMetrics(now: number = Date.now()): HudSpeedMetrics {
    if (this.samples.length < 2 || !this.isStreaming) {
      return {
        tokensPerSecond: 0,
        outputTokens: this.totalOutputTokens,
        elapsedMs: this.startTime > 0 ? Math.max(0, now - this.startTime) : 0,
        isStreaming: this.isStreaming,
      };
    }

    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const deltaMs = last.time - first.time;
    const deltaTokens = last.tokens - first.tokens;

    let tokensPerSecond = 0;
    if (deltaMs >= MIN_DELTA_MS && deltaTokens > 0) {
      tokensPerSecond = Math.round((deltaTokens / deltaMs) * 1000 * 10) / 10;
    }

    return {
      tokensPerSecond,
      outputTokens: this.totalOutputTokens,
      elapsedMs: Math.max(0, now - this.startTime),
      isStreaming: this.isStreaming,
    };
  }

  reset(): void {
    this.samples = [];
    this.startTime = 0;
    this.totalOutputTokens = 0;
    this.isStreaming = false;
  }
}
