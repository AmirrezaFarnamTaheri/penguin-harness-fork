import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type LogLevel = "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  sessionId?: string;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  sessionId?: string;
  [field: string]: unknown;
}

type LogSink = (line: string, level?: LogLevel) => void;

interface ProcessLogState {
  context: AsyncLocalStorage<LogContext>;
  unhandledRejections: number;
  rejectionBuckets: Array<{ second: number; count: number }>;
}

const STATE_KEY = Symbol.for("penguin.server.structured-logger.v1");
const registry = globalThis as unknown as Record<PropertyKey, ProcessLogState | undefined>;
const state =
  registry[STATE_KEY] ??
  (registry[STATE_KEY] = {
    context: new AsyncLocalStorage<LogContext>(),
    unhandledRejections: 0,
    rejectionBuckets: [],
  });
if (!Array.isArray(state.rejectionBuckets) || state.rejectionBuckets.length !== 60) {
  state.rejectionBuckets = Array.from({ length: 60 }, () => ({ second: -1, count: 0 }));
}

const MAX_MESSAGE_LENGTH = 1200;
const MAX_RECORD_LENGTH = 4096;
const MAX_FIELD_STRING_LENGTH = 512;
const SENSITIVE_ENV_NAME =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|PASSWD|CREDENTIAL|AUTHORIZATION|PRIVATE[_-]?KEY)/i;
// Any key ending in `token` (token, authToken, x-auth-token, session_token) carries a credential;
// counters such as `tokenCount` or `maxTokens` do not end in `token` and stay readable.
const SENSITIVE_FIELD_NAME =
  /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SECRET|PASSWORD|PASSPHRASE|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE|PRIVATE[_-]?KEY)|TOKEN$/i;

function knownSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        SENSITIVE_ENV_NAME.test(name) && typeof value === "string" && value.length >= 4,
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function redact(text: string): string {
  let result = text;
  for (const secret of knownSecretValues()) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/(\b(?:authorization\s*[:=]\s*)?bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:api[_-]?key|(?:access|refresh|auth|session|id|csrf)?[_-]?token|client[_-]?secret|password|passphrase|passwd|secret|credential|private[_-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function safeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redact(value).slice(0, MAX_FIELD_STRING_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return undefined;
  if (value instanceof Error) {
    return {
      name: redact(value.name || "Error").slice(0, 80),
      message: redact(value.message).slice(0, MAX_FIELD_STRING_LENGTH),
    };
  }
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth <= 0) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.slice(0, 16).map((item) => safeValue(item, depth - 1, seen));
  const result: Record<string, unknown> = {};
  try {
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      if (/^(?:stack|authorization|cookie|set-cookie)$/i.test(key)) continue;
      if (SENSITIVE_FIELD_NAME.test(key)) {
        result[redact(key).slice(0, 80)] = "[REDACTED]";
        continue;
      }
      const safe = safeValue(item, depth - 1, seen);
      if (safe !== undefined) result[redact(key).slice(0, 80)] = safe;
    }
  } catch {
    return "[unavailable]";
  }
  return result;
}

function boundedRecord(record: StructuredLogRecord): string {
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") <= MAX_RECORD_LENGTH) return json;
  return JSON.stringify({
    timestamp: record.timestamp,
    level: record.level,
    message: redact(record.message).slice(0, 256),
    ...(record.requestId ? { requestId: record.requestId } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    event: "log_record_truncated",
  });
}

export interface StructuredLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Adapter for existing line-oriented component callbacks. */
  line(message: string, level?: LogLevel): void;
}

export function createStructuredLogger(options: {
  sink: LogSink;
  emergencySink?: LogSink;
  now?: () => Date;
}): StructuredLogger {
  const emergencySink = options.emergencySink ?? ((line) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const context = state.context.getStore();
    try {
      const normalizedFields = safeValue(fields ?? {}, 3, new WeakSet()) as Record<string, unknown>;
      const record: StructuredLogRecord = {
        ...normalizedFields,
        timestamp: now().toISOString(),
        level,
        message: redact(message).slice(0, MAX_MESSAGE_LENGTH),
        ...(context?.requestId ? { requestId: context.requestId } : {}),
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
      };
      options.sink(boundedRecord(record), level);
    } catch {
      try {
        emergencySink(
          boundedRecord({
            timestamp: new Date().toISOString(),
            level: "error",
            message: "Structured logger sink failed.",
            ...(context?.requestId ? { requestId: context.requestId } : {}),
            ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
            event: "logger_sink_failed",
          }),
          "error",
        );
      } catch {
        // Logging must never recurse through a failing sink or destabilize request handling.
      }
    }
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    line: (message, level = "info") => write(level, message),
  };
}

export const serverLogger = createStructuredLogger({
  sink: (line, level) => {
    const output = level === "warn" || level === "error" ? process.stderr : process.stdout;
    output.write(`${line}\n`);
  },
});

export function withLogContext<T>(context: LogContext, callback: () => T): T {
  return state.context.run(context, callback);
}

export function requestLogContext(
  request: Request,
): Required<Pick<LogContext, "requestId">> & LogContext {
  const supplied = request.headers.get("x-request-id")?.trim();
  const requestId =
    supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) && redact(supplied) === supplied
      ? supplied
      : randomUUID();
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/\/api\/sessions\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return { requestId };
  try {
    const sessionId = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9._~-]{1,128}$/.test(sessionId) && redact(sessionId) === sessionId
      ? { requestId, sessionId }
      : { requestId };
  } catch {
    return { requestId };
  }
}

export function incrementUnhandledRejectionCount(): number {
  if (state.unhandledRejections < Number.MAX_SAFE_INTEGER) state.unhandledRejections++;
  const second = Math.floor(Date.now() / 1000);
  const bucket = state.rejectionBuckets[second % 60]!;
  if (bucket.second !== second) {
    bucket.second = second;
    bucket.count = 0;
  }
  if (bucket.count < Number.MAX_SAFE_INTEGER) bucket.count++;
  return state.unhandledRejections;
}

/** Total and rolling 60-second rate, backed by a fixed-size per-second counter ring. */
export function unhandledRejectionMetrics(nowMs = Date.now()): {
  total: number;
  lastMinute: number;
  perMinute: number;
} {
  const currentSecond = Math.floor(nowMs / 1000);
  const lastMinute = state.rejectionBuckets.reduce(
    (total, bucket) =>
      currentSecond - bucket.second >= 0 && currentSecond - bucket.second < 60
        ? Math.min(Number.MAX_SAFE_INTEGER, total + bucket.count)
        : total,
    0,
  );
  return { total: state.unhandledRejections, lastMinute, perMinute: lastMinute };
}

/** Error summaries intentionally omit stacks: stacks can contain request data or credentials. */
export function safeErrorSummary(reason: unknown): { name: string; message: string } {
  let error: Error;
  try {
    error = reason instanceof Error ? reason : new Error(String(reason));
  } catch {
    error = new Error("Non-Error rejection reason could not be converted safely.");
  }
  return {
    name: redact(error.name || "Error").slice(0, 80),
    message: redact(error.message).slice(0, MAX_FIELD_STRING_LENGTH),
  };
}
