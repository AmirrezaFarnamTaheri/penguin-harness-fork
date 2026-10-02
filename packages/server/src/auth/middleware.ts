/**
 * Auth middleware: `Authorization: Bearer <local API token>` -> the built-in admin, or
 * session cookie -> auth_sessions row -> user; either way the user is injected into c.var.
 *
 * The Bearer path authenticates the boot's local API token (`<root>/api-token`, see
 * auth/api-token.ts) as the admin — the CLI's and agents' machine-local credential; it
 * applies to every route behind this middleware, SSE endpoints included (the CLI
 * consumes SSE via fetch with headers). A Bearer header that does not match fails the
 * request rather than falling back to the cookie: silently downgrading a wrong explicit
 * credential would mask misconfiguration.
 *
 * Accessing a protected API while logged out -> 401 `{error:{code:"unauthorized"}}`.
 * CSRF: SameSite=Lax plus a Content-Type an HTML form cannot forge (see jsonOnlyWrites).
 * That guard stays for Bearer requests too — the CLI always sends application/json.
 *
 * I4: WHETHER a credential is required is not decided here — it comes from the single pure
 * resolver in auth/auth-mode.ts, passed in as an {@link AuthPolicy}. This function only applies
 * that decision, and the decision's inputs are the configured policy and the configured bind
 * address; nothing on the request (a header, a cookie, a forwarded-for value, a peer address)
 * can change the mode or widen the public-path exemption. Under `all-except-health` a public
 * path (the probes) skips the gate; under `off` a request with no credential is served as the
 * built-in admin through the boot's local operator grant, and is refused when that grant does
 * not exist rather than inventing one.
 */
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HttpError } from "../http/errors.js";
import type { UserRow } from "../db/repos/users.js";
import type { AuthService, SessionVia } from "./service.js";
import { authPolicyFromConfig, type AuthPolicy } from "./auth-mode.js";
import type { ServerConfig } from "../config.js";

/** Session cookie name. */
export const SESSION_COOKIE = "penguin_session";

/**
 * Session cookie attributes, shared by every path that sets one. `maxAge` comes from the
 * service that issues the sessions, never written here: the ROW carries the authoritative
 * expiry, and a cookie that expired first would log someone out mid-session.
 */
export function cookieOptions(
  c: { req: { url: string; header(name: string): string | undefined } },
  ttlMs: number,
  trustProxy: boolean,
) {
  // `x-forwarded-proto` is caller-supplied and untrusted unless the deployment opts in
  // (config.trustProxy — the same gate hmr/routes.ts uses, and for the same reason). Trusting
  // it on a plain-HTTP bind would let anyone reaching the port get a Secure cookie back, which
  // the browser then refuses to send over that connection: a sign-in that never takes.
  const proto = trustProxy
    ? (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", ""))
    : new URL(c.req.url).protocol.replace(":", "");
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
    ...(proto === "https" ? { secure: true } : {}),
  };
}

/** Hono env: variables injected by the auth middleware. */
export type AppEnv = {
  Variables: {
    user: UserRow;
    /** How the current session was established — see {@link SessionVia}. */
    sessionVia: SessionVia;
  };
};

/** Gets the current user (available after authMiddleware). */
export function currentUser(c: { var: { user: UserRow } }): UserRow {
  return c.var.user;
}

export function authMiddleware(
  auth: AuthService,
  trustProxy: boolean,
  policy: AuthPolicy,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // I4: the exemption is read from the policy (built once from config), not from the request.
    // Under `off` nothing is exempt — the gate still runs so a user is always in `c.var`, it
    // simply falls through to the local-operator grant instead of rejecting.
    if (policy.decision.requiresAuth && policy.isPublicPath(c.req.path)) {
      await next();
      return;
    }
    // Bearer first: an explicit credential on the request outranks ambient cookies, and
    // a wrong one is an error, never a silent fallback (see the module doc).
    const bearer = bearerToken(c.req.header("authorization"));
    if (bearer !== null) {
      const viaToken = auth.authenticateApiToken(bearer);
      if (!viaToken) {
        throw new HttpError(401, "unauthorized", "Invalid API token.");
      }
      c.set("user", viaToken.user);
      c.set("sessionVia", viaToken.via);
      await next();
      return;
    }
    const token = getCookie(c, SESSION_COOKIE);
    const authed = token ? auth.authenticateWithMeta(token) : null;
    if (!authed) {
      // A cookie that WAS supplied and did not authenticate is a rejection, not an invitation to
      // try something else: falling through to the operator grant would serve an expired
      // session's request as the admin, silently attributing its writes to the wrong identity
      // (the Bearer branch rejects a bad token for the same reason). The grant is only for a
      // request that presented nothing at all.
      if (token) {
        throw new HttpError(401, "unauthorized", "Not signed in or the sign-in has expired.");
      }
      // I4 `off`: the local-operator grant. The process holds this boot's own API token (it
      // wrote it to <root>/api-token), so on a trusted bind an anonymous request is the
      // operator — the same authority the Bearer path encodes, without the round trip. A
      // deployment whose boot minted no token refuses exactly like any other anonymous
      // request: configuration is missing, so nothing is granted.
      const grant = policy.decision.effective === "off" ? auth.localApiToken() : null;
      const operator = grant === null ? null : auth.authenticateApiToken(grant);
      if (operator === null) {
        throw new HttpError(401, "unauthorized", "Not signed in or the sign-in has expired.");
      }
      c.set("user", operator.user);
      c.set("sessionVia", operator.via);
      await next();
      return;
    }
    // Sliding renewal: the session's expiry was topped up in place, so refresh the cookie's
    // own max-age to match. The token value is unchanged — same session, longer life.
    if (authed.renewed && token) {
      setCookie(c, SESSION_COOKIE, token, cookieOptions(c, auth.sessionTtlMs, trustProxy));
    }
    c.set("user", authed.user);
    c.set("sessionVia", authed.via);
    await next();
  };
}

/** The token of an `Authorization: Bearer <token>` header (scheme matched case-insensitively); null for any other shape. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m === null ? null : m[1]!.trim();
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defense: a write must carry one of these Content-Types, none of which an HTML form can
 * forge (a form is limited to x-www-form-urlencoded, multipart/form-data, text/plain). json is
 * the API default; gzip and octet-stream are the hot-update web push's artifact transport
 * (src/hmr). A write with NO Content-Type and an empty body is let through — a form always
 * sends a form-type one.
 */
const ALLOWED_WRITE_CONTENT_TYPES = [
  "application/json",
  "application/gzip",
  "application/octet-stream",
];

export const jsonOnlyWrites: MiddlewareHandler = async (c, next) => {
  if (WRITE_METHODS.has(c.req.method)) {
    const contentType = c.req.header("content-type")?.toLowerCase();
    if (contentType && !ALLOWED_WRITE_CONTENT_TYPES.some((t) => contentType.startsWith(t))) {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Write requests only accept application/json (or, for the hot-update web push, a gzip artifact).",
      );
    }
  }
  await next();
};

/**
 * The I4 policy for a resolved configuration. Exported so the app (and only the app) derives the
 * policy once and hands the same object to every gate it mounts.
 */
export function configAuthPolicy(config: Pick<ServerConfig, "authMode" | "host">): AuthPolicy {
  return authPolicyFromConfig(config);
}
