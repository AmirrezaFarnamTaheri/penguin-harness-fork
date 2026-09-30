/**
 * Unified HTTP error: `{error: {code, message}}` response body,
 * with message in English.
 *
 * Routes and services express business errors via throw HttpError; app-level onError
 * uniformly converges these into a JSON response, with unknown errors converged to 500
 * (never leaking internal details to the client).
 */
import type { Context } from "hono";
import type { ErrorBody } from "../api/types.js";

export type HttpErrorKind = "expected" | "unexpected";

export interface HttpErrorOptions {
  /** Override the status-based default for an error whose recovery semantics differ. */
  kind?: HttpErrorKind;
  /** Stable frontend translation key; defaults to the key derived from `code`. */
  i18nKey?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options: HttpErrorOptions = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.kind = options.kind ?? (status >= 500 ? "unexpected" : "expected");
    this.i18nKey = options.i18nKey?.trim() || `errors.byCode.${code}`;
  }

  readonly kind: HttpErrorKind;
  readonly i18nKey: string;

  /** English fallback retained for clients without a translation for `i18nKey`. */
  get english(): string {
    return this.message;
  }
}

export function errorBody(code: string, message: string, i18nKey?: string): ErrorBody {
  return { error: { code, message, ...(i18nKey ? { i18nKey } : {}) } };
}

/**
 * Model missing a credential: the provider SDK throws this at **client-construction
 * time** (hit by both creating a Session and resuming a Session); the original message
 * is full of environment variable names, meaningless to a user — uniformly replaced
 * with a single actionable sentence. The frontend produces localized text by code
 * (message is only a fallback); see web's lib/api-error.ts.
 */
export function isMissingCredential(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /missing credentials|api[_ ]?key/i.test(message);
}

export function modelCredentialMissing(modelId: string): HttpError {
  return new HttpError(
    400,
    "model_credential_missing",
    `Model ${modelId} has no API key yet. Configure it on the Models page first.`,
  );
}

/** app.onError handler: maps HttpError through as-is; everything else is logged and converged to 500. */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    return c.json(errorBody(err.code, err.english, err.i18nKey), err.status as 400);
  }
  // Unknown error: print the stack for diagnosis, but never expose details externally.
  console.error(`[server] Unhandled exception: ${err.stack ?? err.message}`);
  return c.json(errorBody("internal", "Internal server error.", "errors.byCode.internal"), 500);
}
