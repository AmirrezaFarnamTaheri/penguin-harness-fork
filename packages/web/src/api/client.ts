/**
 * fetch wrapper: JSON request/response, unified errors -> ApiError,
 * same-origin cookie auth (credentials: same-origin; CSRF relies on SameSite=Lax + JSON
 * Content-Type, see server README).
 *
 * When the session becomes invalid (server 401, e.g. database rebuilt, cookie expired),
 * notifies AuthProvider to clear the current user, letting the route guard redirect to the
 * login page — instead of each page popping its own "unauthorized" error.
 */
import { s } from "../lib/strings";

/** Unified API error: carries the HTTP status code and server error code (server error body {error:{code,message}}). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Session-invalidation callback (registered by AuthProvider; not triggered by 401s from the login/register endpoints themselves). */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** 401/409 from auth endpoints themselves are business failures (e.g. wrong password) and must not trigger a global logout. */
function isAuthEndpoint(path: string): boolean {
  return path.startsWith("/api/auth/");
}

export interface ApiFetchOptions {
  /** AuthProvider handles identity failures with its own request generation check. */
  handleUnauthorized?: boolean;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON request body (auto-serialized with Content-Type: application/json). */
  body?: unknown;
  /** Query parameters (undefined values are skipped). */
  query?: Record<string, string | number | undefined>;
}

/** Response metadata a caller may need alongside the parsed body. */
export interface ApiFetchMeta {
  /**
   * The server's own clock at the moment it produced the response, read from the HTTP `Date`
   * header; null when absent or unparseable. Lets a caller measure a server-side interval
   * entirely in server time — differencing it against a server-supplied timestamp cancels any
   * client/server clock offset, which a local `Date.now()` cannot do. Whole-second precision
   * (RFC 9110 fixes the header's format), so treat it as ±1s. `Date` is CORS-safelisted, so it
   * is readable cross-origin too.
   */
  serverNowMs: number | null;
}

/**
 * Makes an API request; non-2xx responses uniformly throw ApiError; a 204 or an empty body
 * resolves `undefined` — the signature says so. A route whose contract promises a body
 * should go through {@link apiFetchJson}, which turns a missing body into an ApiError
 * instead of handing back an `undefined` the caller will destructure into a TypeError.
 */
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T | undefined> {
  return (await apiFetchWithMeta<T>(path, options)).data;
}

/** {@link apiFetch} plus the response metadata in {@link ApiFetchMeta}; identical in every other respect. */
export async function apiFetchWithMeta<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<{ data: T | undefined } & ApiFetchMeta> {
  let url = path;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      ...(options.body !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options.body),
          }
        : {}),
    });
  } catch {
    throw new ApiError(0, "network_error", s().errors.networkError);
  }

  if (!response.ok) {
    let code = "http_error";
    let message: string = s().common.unknownError;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body: fall back to the default message.
    }
    if (response.status === 401 && !isAuthEndpoint(path) && options.handleUnauthorized !== false)
      onUnauthorized?.();
    throw new ApiError(response.status, code, message);
  }

  const headerDate = Date.parse(response.headers.get("date") ?? "");
  const serverNowMs = Number.isFinite(headerDate) ? headerDate : null;

  if (response.status === 204) return { data: undefined, serverNowMs };
  const text = await response.text();
  if (!text) return { data: undefined, serverNowMs };
  return { data: JSON.parse(text) as T, serverNowMs };
}

/**
 * {@link apiFetch} for a route whose contract promises a body: a 204 or an empty body is an
 * `ApiError("empty_body")` naming the path, never an `undefined` typed as `T`. The UI's
 * callers destructure on the next line (`const { agents } = …`), so an empty body would
 * otherwise reach a property read the type system cannot see — the call sites that read a
 * body use this, and the ones that don't (a DELETE's 204) stay on {@link apiFetch}.
 */
export async function apiFetchJson<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { data } = await apiFetchWithMeta<T>(path, options);
  if (data === undefined) {
    throw new ApiError(
      0,
      "empty_body",
      `Empty response body for ${options.method ?? "GET"} ${path}`,
    );
  }
  return data;
}

/** {@link apiFetchJson} plus the response metadata in {@link ApiFetchMeta}; identical in every other respect. */
export async function apiFetchJsonWithMeta<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<{ data: T } & ApiFetchMeta> {
  const meta = await apiFetchWithMeta<T>(path, options);
  if (meta.data === undefined) {
    throw new ApiError(
      0,
      "empty_body",
      `Empty response body for ${options.method ?? "GET"} ${path}`,
    );
  }
  return meta as { data: T } & ApiFetchMeta;
}
