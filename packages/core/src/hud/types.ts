/**
 * Real-time HUD Statusline and Metrics types.
 * Absorbed and unified from claude-hud, CodexBar, and opencode-bar.
 */

export interface HudSpeedMetrics {
  tokensPerSecond: number;
  outputTokens: number;
  elapsedMs: number;
  isStreaming: boolean;
}

export interface HudPromptCacheMetrics {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  anchorTimestamp?: number;
  ttlSeconds: number;
  remainingSeconds: number;
  state: "active" | "warning" | "expired" | "none";
}

export interface HudVcsMetrics {
  branch?: string;
  dirtyFilesCount: number;
  stagedFilesCount: number;
  isClean: boolean;
}

export interface HudActiveTask {
  id: string;
  toolName: string;
  startTime: number;
  durationMs: number;
}

export interface HudSessionSnapshot {
  sessionId: string;
  modelId: string;
  provider: string;
  contextWindow: number;
  totalTokensUsed: number;
  contextCapacityPct: number;
  speed: HudSpeedMetrics;
  promptCache: HudPromptCacheMetrics;
  costUsd: number;
  costSavingsUsd: number;
  compactionsCount: number;
  vcs?: HudVcsMetrics;
  activeTasks: HudActiveTask[];
  timestamp: number;
}
