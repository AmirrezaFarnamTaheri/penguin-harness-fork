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

/**
 * Parse a `Resets in <h><m><s>` window to milliseconds.
 *
 * Returns milliseconds, like its sibling `parseDurationToMs` — the two differ in strictness,
 * not in unit: this one is anchored at both ends and treats an all-zero window as a real 0
 * rather than as an absent one, while `parseDurationToMs` also accepts a bare positive number
 * of seconds. Callers that need a countdown use `parseDurationToMs` or this function and get
 * the same unit from both.
 */
export function parseResetDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

/**
 * Every rate-limit / quota-exhaustion wording this repo recognises.
 *
 * Two classifiers used to keep disjoint tables: `isRateLimitError` (generative-model.ts —
 * decides retryability and whether a key is cooled) and `QUOTA_PATTERNS` below (the combo
 * cascade's quota verdict). A provider sending "usage limit reached" was a generic network
 * error to the runtime, so the key was never cooled and rotation kept handing it back, while
 * the cascade saw no quota failure at all; and "rate limit exceeded" (spaced) was retryable
 * per the runtime but `isQuota: false` per the cascade. Both now read this one list, so an
 * error is classified the same way wherever it is classified. `\b429\b` deliberately
 * over-matches prose (pinned in the tests); it is kept because dropping it would stop
 * matching providers that report only the status.
 */
export const RATE_LIMIT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /RESOURCE_EXHAUSTED/i,
  /resource has been exhausted/i,
  // Matches "rate_limit_exceeded", "rate limit exceeded" and "rate-limited" alike.
  /rate[-_ ]limit/i,
  /quota_exceeded/i,
  /insufficient_quota/i,
  /insufficient_user_quota/i,
  /requests_exceeded/i,
  /tokens_exceeded/i,
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

function readCode(record: Record<string, unknown>): number | string | undefined {
  const code = record.code ?? record.status ?? record.statusCode;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function extractCode(input: unknown): number | string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const top = readCode(record);
  if (top !== undefined) return top;

  // Providers commonly nest the status inside an `error` envelope
  // (`{ error: { code: "rate_limit_exceeded", message: "too many requests" } }`). The
  // pattern scan classifies such a body from its serialised text, so the code has to be
  // reachable from the same shape: a consumer switching on `result.code` would otherwise
  // read "unknown" for the most common provider error form.
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const nestedCode = readCode(nested as Record<string, unknown>);
    if (nestedCode !== undefined) return nestedCode;
  }
  return undefined;
}

export function detectQuotaExhaustion(input: unknown): QuotaDetectionResult {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Error) {
    text = `${input.name}: ${input.message}`;
  } else {
    // A non-string, non-Error object is scanned as JSON. A circular structure (Fetch/SDK
    // errors that keep a reference to their request or response can carry one) makes
    // JSON.stringify throw, and every other input shape returns a verdict — so the failure is
    // swallowed here rather than propagated into the caller's error path.
    try {
      text = JSON.stringify(input ?? "");
    } catch {
      text = String(input);
    }
  }
  const code = extractCode(input);
  const isAuth = AUTH_PATTERNS.some((pattern) => pattern.test(text));
  const isQuota = RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
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
    // A window the provider spelled out is honoured as-is, including one that parses to 0:
    // "Resets in 0h0m0s" means the limit is already expired, and 0 is a real verdict here,
    // not an absent one (`parseResetDuration` distinguishes them). The header fields below
    // stay strict-positive — a bare numeric 0 is not a window the provider spelled out, and
    // the caller still needs something to sleep.
    resetMs = parseDurationToMs(resetText);
  }

  if (resetMs === undefined) {
    const retryAfterMatch = RETRY_AFTER_RE.exec(text);
    if (retryAfterMatch?.[1]) {
      const sec = Number(retryAfterMatch[1]);
      if (!Number.isNaN(sec) && sec > 0) {
        resetMs = sec * 1000;
        resetText = `${sec}s`;
      }
    }
  }

  if (resetMs === undefined) {
    const secMatch = SECONDS_RESET_RE.exec(text);
    if (secMatch?.[1]) {
      const sec = Number(secMatch[1]);
      if (!Number.isNaN(sec) && sec > 0) {
        resetMs = sec * 1000;
        resetText = `${sec}s`;
      }
    }
  }

  if (resetMs === undefined) {
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
