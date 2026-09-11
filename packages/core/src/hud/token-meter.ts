/**
 * Token Meter & Velocity Tracker.
 * Unified and ported from tokscale-core (aggregator.rs, daily fold, intensity bucketing)
 * and TokenBar (usage_tail.rs, window_usage.rs, quota duration & burn estimation).
 */

export interface UsageEvent {
  tsMs: number;
  client?: string;
  agent?: string;
  model?: string;
  provider?: string;
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  messageCount?: number;
}

export type UsageEventInput = Partial<UsageEvent> & {
  input?: number;
  output?: number;
};

export interface TokenWindowRate {
  windowMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  messageCount: number;
  tokensPerSecond: number;
  tokensPerMinute: number;
}

export interface TraceBucket {
  key: string;
  client?: string;
  agent?: string;
  model?: string;
  provider?: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  messages: number;
  costUsd: number;
  tokensPerMinute: number;
}

export interface DailyContribution {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  messageCount: number;
  intensity: 0 | 1 | 2 | 3 | 4;
  modelBreakdown: Record<string, number>;
}

export type BurnLevel = "nominal" | "elevated" | "critical" | "depleted";

export interface QuotaBurnProjection {
  currentTps: number;
  currentTokensPerMin: number;
  remainingTokens: number;
  estimatedSecondsToDepletion: number | null;
  estimatedDepletionTimestamp: number | null;
  burnLevel: BurnLevel;
}

/** Safe saturating addition that avoids negative numbers and NaN */
export function saturatingAdd(...nums: Array<number | undefined | null>): number {
  let sum = 0;
  for (const n of nums) {
    if (typeof n === "number" && !Number.isNaN(n) && Number.isFinite(n) && n > 0) {
      sum += n;
    }
  }
  return sum;
}

/**
 * Assigns GitHub-style 0-4 heat intensities to daily contributions.
 * Relative to the maximum daily cost (or total tokens if all costs are 0).
 * Matches tokscale-core calculate_intensities.
 */
export function calculateIntensities(contributions: DailyContribution[]): void {
  if (contributions.length === 0) return;

  const maxCost = contributions.reduce((max, c) => Math.max(max, c.costUsd), 0);
  const maxTokens = contributions.reduce((max, c) => Math.max(max, c.totalTokens), 0);

  const useCost = maxCost > 0;
  const maxBaseline = useCost ? maxCost : maxTokens;

  if (maxBaseline <= 0) {
    for (const c of contributions) {
      c.intensity = 0;
    }
    return;
  }

  for (const c of contributions) {
    const metric = useCost ? c.costUsd : c.totalTokens;
    if (metric <= 0) {
      c.intensity = 0;
      continue;
    }
    const ratio = metric / maxBaseline;
    if (ratio >= 0.75) {
      c.intensity = 4;
    } else if (ratio >= 0.5) {
      c.intensity = 3;
    } else if (ratio >= 0.25) {
      c.intensity = 2;
    } else {
      c.intensity = 1;
    }
  }
}

/**
 * Format timestamp to UTC YYYY-MM-DD
 */
export function formatUtcDate(tsMs: number): string {
  const d = new Date(tsMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface TokenMeterOptions {
  /** Maximum retention duration for events in milliseconds. Defaults to 24h. */
  retentionMs?: number;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_INSTANTANEOUS_WINDOW_MS = 2500; // 2.5 seconds
const MIN_MEASURABLE_WINDOW_MS = 100; // 100ms

export class TokenMeter {
  private events: UsageEvent[] = [];
  private readonly retentionMs: number;

  constructor(options: TokenMeterOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  /**
   * Record a new token usage event.
   */
  record(input: UsageEventInput, now?: number): UsageEvent {
    const tsMs = input.tsMs ?? (now ?? Date.now());
    const effectiveNow = now ?? tsMs;
    const event: UsageEvent = {
      tsMs,
      client: input.client,
      agent: input.agent,
      model: input.model,
      provider: input.provider,
      input: Math.max(0, input.input ?? 0),
      output: Math.max(0, input.output ?? 0),
      reasoning: Math.max(0, input.reasoning ?? 0),
      cacheRead: Math.max(0, input.cacheRead ?? 0),
      cacheWrite: Math.max(0, input.cacheWrite ?? 0),
      costUsd: Math.max(0, input.costUsd ?? 0),
      messageCount: Math.max(1, input.messageCount ?? 1),
    };

    // Insert maintaining timestamp sort order
    if (this.events.length === 0 || tsMs >= this.events[this.events.length - 1]!.tsMs) {
      this.events.push(event);
    } else {
      let insertIdx = this.events.length;
      while (insertIdx > 0 && this.events[insertIdx - 1]!.tsMs > tsMs) {
        insertIdx--;
      }
      this.events.splice(insertIdx, 0, event);
    }

    this.prune(this.retentionMs, effectiveNow);
    return event;
  }

  /**
   * Calculate real-time instantaneous token speed (tokens/sec) over a 2.5s window.
   */
  getInstantaneousRate(now: number = Date.now()): TokenWindowRate {
    return this.getRateInWindow(DEFAULT_INSTANTANEOUS_WINDOW_MS, now);
  }

  /**
   * Calculate aggregated token usage metrics and velocity rates within a past window [now - windowMs, now].
   */
  getRateInWindow(windowMs: number, now: number = Date.now()): TokenWindowRate {
    const effectiveWindow = Math.max(MIN_MEASURABLE_WINDOW_MS, windowMs);
    const cutoff = now - effectiveWindow;

    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costUsd = 0;
    let messageCount = 0;

    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!;
      if (ev.tsMs < cutoff) break;
      if (ev.tsMs > now) continue;

      inputTokens += ev.input;
      outputTokens += ev.output;
      reasoningTokens += ev.reasoning ?? 0;
      cacheReadTokens += ev.cacheRead ?? 0;
      cacheWriteTokens += ev.cacheWrite ?? 0;
      costUsd += ev.costUsd ?? 0;
      messageCount += ev.messageCount ?? 1;
    }

    const totalTokens = saturatingAdd(
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
    );

    const seconds = effectiveWindow / 1000;
    const tokensPerSecond = seconds > 0 ? Math.round((outputTokens / seconds) * 10) / 10 : 0;
    const tokensPerMinute = seconds > 0 ? Math.round(((outputTokens * 60) / seconds) * 10) / 10 : 0;

    return {
      windowMs: effectiveWindow,
      totalTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: Number(costUsd.toFixed(6)),
      messageCount,
      tokensPerSecond,
      tokensPerMinute,
    };
  }

  /**
   * Groups usage within the window by (provider, model, agent, client) for detailed attribution.
   * Absorbed from TokenBar usage_tail.rs.
   */
  getTrace(windowMs: number, now: number = Date.now()): TraceBucket[] {
    const effectiveWindow = Math.max(MIN_MEASURABLE_WINDOW_MS, windowMs);
    const cutoff = now - effectiveWindow;
    const groups = new Map<string, {
      client?: string;
      agent?: string;
      model?: string;
      provider?: string;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      messages: number;
      costUsd: number;
    }>();

    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!;
      if (ev.tsMs < cutoff) break;
      if (ev.tsMs > now) continue;

      const p = ev.provider || "default";
      const m = ev.model || "default";
      const a = ev.agent || "default";
      const c = ev.client || "default";
      const key = `${p}::${m}::${a}::${c}`;

      let bucket = groups.get(key);
      if (!bucket) {
        bucket = {
          client: ev.client,
          agent: ev.agent,
          model: ev.model,
          provider: ev.provider,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          messages: 0,
          costUsd: 0,
        };
        groups.set(key, bucket);
      }

      const evTotal = saturatingAdd(ev.input, ev.output, ev.reasoning, ev.cacheRead, ev.cacheWrite);
      bucket.totalTokens += evTotal;
      bucket.inputTokens += ev.input;
      bucket.outputTokens += ev.output;
      bucket.messages += ev.messageCount ?? 1;
      bucket.costUsd += ev.costUsd ?? 0;
    }

    const seconds = effectiveWindow / 1000;
    const results: TraceBucket[] = [];

    for (const [key, b] of groups.entries()) {
      const tokensPerMinute = seconds > 0 ? Math.round(((b.outputTokens * 60) / seconds) * 10) / 10 : 0;
      results.push({
        key,
        client: b.client,
        agent: b.agent,
        model: b.model,
        provider: b.provider,
        totalTokens: b.totalTokens,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        messages: b.messages,
        costUsd: Number(b.costUsd.toFixed(6)),
        tokensPerMinute,
      });
    }

    return results.sort((a, b) => b.totalTokens - a.totalTokens);
  }

  /**
   * Project remaining time until quota exhaustion based on current token velocity.
   * Absorbed from TokenBar agent_quota_duration.rs.
   */
  projectQuotaBurn(
    remainingTokens: number,
    windowMs: number = 300_000, // 5 minutes moving window
    now: number = Date.now(),
  ): QuotaBurnProjection {
    const rate = this.getRateInWindow(windowMs, now);
    const currentTps = rate.tokensPerSecond;
    const currentTokensPerMin = rate.tokensPerMinute;

    if (remainingTokens <= 0) {
      return {
        currentTps,
        currentTokensPerMin,
        remainingTokens: 0,
        estimatedSecondsToDepletion: 0,
        estimatedDepletionTimestamp: now,
        burnLevel: "depleted",
      };
    }

    if (currentTps <= 0) {
      return {
        currentTps: 0,
        currentTokensPerMin: 0,
        remainingTokens,
        estimatedSecondsToDepletion: null,
        estimatedDepletionTimestamp: null,
        burnLevel: "nominal",
      };
    }

    const estimatedSeconds = Math.round(remainingTokens / currentTps);
    const estimatedDepletionTimestamp = now + estimatedSeconds * 1000;

    let burnLevel: BurnLevel = "nominal";
    if (estimatedSeconds < 300) {
      burnLevel = "critical"; // Less than 5 minutes remaining at current burn rate
    } else if (estimatedSeconds < 1800) {
      burnLevel = "elevated"; // Less than 30 minutes remaining
    }

    return {
      currentTps,
      currentTokensPerMin,
      remainingTokens,
      estimatedSecondsToDepletion: estimatedSeconds,
      estimatedDepletionTimestamp,
      burnLevel,
    };
  }

  /**
   * Fold events into daily contributions with heat-map intensity levels.
   * Absorbed from tokscale-core aggregator.rs DailyFold.
   */
  foldDaily(customEvents?: UsageEvent[]): DailyContribution[] {
    const list = customEvents ?? this.events;
    const days = new Map<string, {
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      costUsd: number;
      messageCount: number;
      modelBreakdown: Record<string, number>;
    }>();

    for (const ev of list) {
      const date = formatUtcDate(ev.tsMs);
      let day = days.get(date);
      if (!day) {
        day = {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          messageCount: 0,
          modelBreakdown: {},
        };
        days.set(date, day);
      }

      const evTotal = saturatingAdd(ev.input, ev.output, ev.reasoning, ev.cacheRead, ev.cacheWrite);
      day.inputTokens += ev.input;
      day.outputTokens += ev.output;
      day.reasoningTokens += ev.reasoning ?? 0;
      day.cacheReadTokens += ev.cacheRead ?? 0;
      day.cacheWriteTokens += ev.cacheWrite ?? 0;
      day.totalTokens += evTotal;
      day.costUsd += ev.costUsd ?? 0;
      day.messageCount += ev.messageCount ?? 1;

      if (ev.model) {
        day.modelBreakdown[ev.model] = (day.modelBreakdown[ev.model] ?? 0) + evTotal;
      }
    }

    const contributions: DailyContribution[] = [];
    const sortedDates = [...days.keys()].sort();

    for (const date of sortedDates) {
      const d = days.get(date)!;
      contributions.push({
        date,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        reasoningTokens: d.reasoningTokens,
        cacheReadTokens: d.cacheReadTokens,
        cacheWriteTokens: d.cacheWriteTokens,
        totalTokens: d.totalTokens,
        costUsd: Number(d.costUsd.toFixed(6)),
        messageCount: d.messageCount,
        intensity: 0, // Assigned below
        modelBreakdown: d.modelBreakdown,
      });
    }

    calculateIntensities(contributions);
    return contributions;
  }

  /**
   * Prune events older than cutoff window.
   */
  prune(retentionMs: number = this.retentionMs, now: number = Date.now()): number {
    const cutoff = now - retentionMs;
    const initialLen = this.events.length;
    let removeCount = 0;

    while (removeCount < this.events.length && this.events[removeCount]!.tsMs < cutoff) {
      removeCount++;
    }

    if (removeCount > 0) {
      this.events.splice(0, removeCount);
    }

    return initialLen - this.events.length;
  }

  clear(): void {
    this.events = [];
  }

  getEvents(): readonly UsageEvent[] {
    return this.events;
  }

  size(): number {
    return this.events.length;
  }
}
