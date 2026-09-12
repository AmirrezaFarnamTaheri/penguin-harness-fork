/**
 * Quota and rate-limit detection, error classification, and cooldown calculation.
 */

export interface QuotaDetectionResult {
  isQuota: boolean;
  isAuthenticationFailure: boolean;
  isOverloaded?: boolean;
  isContextLengthExceeded?: boolean;
  resetMs?: number;
  resetText?: string;
  code?: number | string;
  reason?: string;
}

export const DEFAULT_COOLDOWN_SEC = 15 * 60;

export const QUOTA_RE = /RESOURCE_EXHAUSTED \(code 429\)/;
export const RESET_RE = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/;

export function parseResetDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const QUOTA_PATTERNS = [
  /RESOURCE_EXHAUSTED/i,
  /rate_limit_exceeded/i,
  /quota_exceeded/i,
  /insufficient_quota/i,
  /too many requests/i,
  /\b429\b/,
  /exceeded your current quota/i,
  /usage limit reached/i,
  /tokens per minute/i,
  /requests per minute/i,
  /requests per day/i,
];

const AUTH_PATTERNS = [
  /invalid_api_key/i,
  /authentication_error/i,
  /unauthorized/i,
  /\b401\b/,
  /incorrect api key/i,
  /permission denied/i,
];

const OVERLOAD_PATTERNS = [
  /\boverload(?:ed|ing)?\b/i,
  /\bcapacity\b/i,
  /temporar(?:y|ily) unavailable/i,
  /service unavailable/i,
  /server busy/i,
  /\b529\b/,
  /\b503\b/,
];

const CONTEXT_LENGTH_PATTERNS = [
  /context[_\s-]*(?:length|window)/i,
  /context_length_exceeded/i,
  /maximum context/i,
  /max(?:imum)? tokens/i,
  /too many tokens/i,
];

const RESET_DURATION_RE = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/i;
const RETRY_AFTER_RE = /retry-after:\s*(\d+)/i;
const SECONDS_RESET_RE = /reset_after[:\s]+(\d+(?:\.\d+)?)\s*s?/i;

export function parseDurationToMs(text: string): number | undefined {
  if (!text) return undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(text.trim());
  if (!match || (!match[1] && !match[2] && !match[3])) {
    const rawNum = Number(text);
    if (!Number.isNaN(rawNum) && rawNum > 0) return rawNum * 1000;
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

export function formatDurationMs(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function extractCode(input: unknown): number | string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const code = record.code ?? record.status ?? record.statusCode;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

export function detectQuotaExhaustion(input: unknown): QuotaDetectionResult {
  const text = typeof input === "string"
    ? input
    : input instanceof Error
      ? `${input.name}: ${input.message}`
      : JSON.stringify(input ?? "");
  const code = extractCode(input);
  const isAuth = AUTH_PATTERNS.some((pattern) => pattern.test(text));
  const isQuota = QUOTA_PATTERNS.some((pattern) => pattern.test(text));
  const isOverloaded = OVERLOAD_PATTERNS.some((pattern) => pattern.test(text));
  const isContextLengthExceeded = CONTEXT_LENGTH_PATTERNS.some((pattern) => pattern.test(text));

  if (isAuth) {
    return {
      isQuota: false,
      isAuthenticationFailure: true,
      isOverloaded,
      isContextLengthExceeded,
      code,
      reason: "Authentication error / invalid API key",
    };
  }

  if (!isQuota) {
    return {
      isQuota: false,
      isAuthenticationFailure: false,
      isOverloaded,
      isContextLengthExceeded,
      code,
      reason: isOverloaded
        ? "Provider overloaded or temporarily unavailable"
        : isContextLengthExceeded
          ? "Context length exceeded"
          : undefined,
    };
  }

  let resetMs: number | undefined;
  let resetText: string | undefined;

  const resetMatch = RESET_DURATION_RE.exec(text);
  if (resetMatch?.[1]) {
    resetText = resetMatch[1];
    resetMs = parseDurationToMs(resetText);
  }

  if (!resetMs) {
    const retryAfterMatch = RETRY_AFTER_RE.exec(text);
    if (retryAfterMatch?.[1]) {
      const sec = Number(retryAfterMatch[1]);
      if (!Number.isNaN(sec) && sec > 0) {
        resetMs = sec * 1000;
        resetText = `${sec}s`;
      }
    }
  }

  if (!resetMs) {
    const secMatch = SECONDS_RESET_RE.exec(text);
    if (secMatch?.[1]) {
      const sec = Number(secMatch[1]);
      if (!Number.isNaN(sec) && sec > 0) {
        resetMs = sec * 1000;
        resetText = `${sec}s`;
      }
    }
  }

  if (!resetMs) {
    resetMs = 60_000;
    resetText = "60s";
  }

  return {
    isQuota: true,
    isAuthenticationFailure: false,
    isOverloaded,
    isContextLengthExceeded,
    resetMs,
    resetText,
    code,
    reason: "Rate limit or quota exhausted",
  };
}

export class CooldownRegistry {
  private until = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  public set(model: string, resetSeconds?: number): void {
    this.until.set(model, this.now() + (resetSeconds ?? DEFAULT_COOLDOWN_SEC) * 1000);
  }

  public cooling(model: string): boolean {
    const t = this.until.get(model);
    return t !== undefined && t > this.now();
  }

  public describe(model: string): string {
    const t = this.until.get(model);
    if (t === undefined || t <= this.now()) return "ready";
    return formatDurationMs(t - this.now());
  }

  public clear(model?: string): void {
    if (model) this.until.delete(model);
    else this.until.clear();
  }
}
