/**
 * The effective authentication mode, as one pure decision.
 *
 * Where the server listens determines who can reach it, and that is what decides whether a
 * request has to prove anything. The process bound to `127.0.0.1` is reachable only from this
 * machine (its operator already holds the data root); the process bound to `0.0.0.0` or to a LAN
 * address is reachable from the network. The bind address is configuration, never a request
 * header: `x-forwarded-for`, `x-forwarded-host` and `x-forwarded-proto` are caller-supplied, and
 * a request must not be able to talk itself into a weaker mode. That is why this module's only
 * inputs are the configured policy and the configured host, and why {@link AuthPolicy.isPublicPath}
 * takes a path — never a header, peer address or socket.
 *
 * The three configured policies and their resolution:
 *
 * | `PENGUIN_AUTH_MODE`  | Bind                         | Effective          |
 * | -------------------- | ---------------------------- | ------------------ |
 * | `auto` (explicit)    | loopback, `PENGUIN_AUTH_TRUST_LOOPBACK=1` | `off` |
 * | `auto` (explicit)    | loopback, no explicit trust  | `all-except-health` |
 * | `auto` (explicit)    | LAN / unspecified (`0.0.0.0`, `::`, any host) | `all-except-health` |
 * | `off`                | any                          | `off`              |
 * | `all-except-health`  | any                          | `all-except-health` |
 * | anything else        | any                          | rejected at config resolution |
 *
 * What the effective modes mean for a request:
 *
 * - `off` — authentication is not required. Identity is still resolved when the caller presents a
 *   credential (Bearer token or session cookie), so a signed-in browser keeps its own identity;
 *   a request with no credential is served as the built-in admin through the boot's own local
 *   operator grant ({@link AuthService.localApiToken}). When no such grant exists the request is
 *   refused like any other unauthenticated one — missing configuration fails closed. Nothing is
 *   "exempt" in this mode: the gate still runs, it simply never rejects (a request that skipped
 *   identity resolution would leave handlers without a user, which is how this was caught).
 * - `all-except-health` — authentication is required for everything except the health probes,
 *   which is the shipped default: the web app has to be able to ask "is this server alive?"
 *   before anyone has signed in, and nothing else is public.
 *
 * A loopback connection is NOT proof of data-root ownership, which is why `auto` needs the
 * second, explicit opt-in before it lifts authentication on a loopback bind: on a multi-user
 * machine any local user can open a connection to `127.0.0.1`, and under `off` an anonymous
 * request is served as the built-in admin (which can, among other things, load platform code
 * through the hot-update route). `PENGUIN_AUTH_TRUST_LOOPBACK=1` is the operator saying "this
 * machine's loopback is trusted" — the same class of statement as `PENGUIN_TRUST_PROXY`, and
 * equally never inferred from a request. Without it, `auto` on loopback is simply the gated
 * mode, so the worst case of leaving it unset is a sign-in prompt rather than an open admin.
 *
 * The default configured value is `all-except-health`, not `auto`. Flipping the default to `auto`
 * would silently drop authentication for every existing loopback deployment (and change the login
 * flow and its fixtures); that promotion is recorded in the I4 receipt with its reopen condition
 * rather than taken here. `auto` is fully implemented and tested for the deployments that opt in.
 */
import type { ServerConfig } from "../config.js";

/** The three values `PENGUIN_AUTH_MODE` accepts. */
export type ConfiguredAuthMode = "auto" | "off" | "all-except-health";

/** What the server actually enforces after the bind address is taken into account. */
export type EffectiveAuthMode = "off" | "all-except-health";

/** How the configured listen address is classified. `unspecified` is a bind that every
 * interface answers — LAN-reachable, and therefore never treated as loopback. */
export type BindClass = "loopback" | "lan" | "unspecified";

/** Everything the decision needs, so it can be recorded and asserted as a row. */
export interface AuthModeDecision {
  configured: ConfiguredAuthMode;
  host: string;
  bindClass: BindClass;
  effective: EffectiveAuthMode;
  requiresAuth: boolean;
  /**
   * Whether an explicit `PENGUIN_AUTH_TRUST_LOOPBACK=1` let a loopback bind resolve `auto` to
   * `off`. False everywhere else, including for an explicit `off` — the flag is only about
   * whether the *bind* may be trusted, never about overriding a configured mode.
   */
  loopbackTrusted: boolean;
}

/** The trust inputs a caller may supply. Both default to "not trusted". */
export interface AuthModeOptions {
  /**
   * Explicit operator statement that this machine's loopback is trusted
   * (`PENGUIN_AUTH_TRUST_LOOPBACK=1`). Without it, `auto` on loopback stays gated.
   */
  trustLoopback?: boolean;
}

/** Parses `PENGUIN_AUTH_TRUST_LOOPBACK`. Unset/blank/`0`/`false` are "no"; a typo throws. */
export function parseTrustLoopback(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "0" || value === "false" || value === "no") return false;
  if (value === "1" || value === "true" || value === "yes") return true;
  throw new Error(`Invalid PENGUIN_AUTH_TRUST_LOOPBACK=${raw} (expected 1/true/yes or 0/false/no)`);
}

/** The request-time view of a decision: what the gate consults, and nothing else. */
export interface AuthPolicy {
  decision: AuthModeDecision;
  /** Paths served without authentication under this mode, tried as prefixes. */
  publicPaths: readonly string[];
  /**
   * True when this path may be served unauthenticated. Only the path is consulted: headers,
   * cookies and peer addresses cannot widen the exemption.
   */
  isPublicPath(pathname: string): boolean;
}

/**
 * The only public endpoints of `all-except-health`: the probes themselves, enumerated exactly as
 * healthRoutes serves them. Deliberately not a `/api/health/*` prefix: a prefix would widen the
 * exemption to any future route mounted under it, and matching is done on the normalized path so
 * `/api/health/../me` cannot borrow the exemption and land on a protected route.
 */
export const HEALTH_PUBLIC_PATHS: readonly string[] = [
  "/health",
  "/health/ready",
  "/health/metrics",
  "/api/health",
  "/api/health/ready",
  "/api/health/metrics",
];

/** Loopback spellings. Anything else — including `0.0.0.0` and `::` — is not loopback. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "127.0.0.1:0"]);

/** Wildcard binds: every interface answers, so the process is network-reachable. */
const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

export function classifyBind(host: string): BindClass {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(normalized)) return "loopback";
  if (UNSPECIFIED_HOSTS.has(normalized)) return "unspecified";
  // A specific non-loopback address or name (a LAN IP, `eth0`, a hostname) is LAN-reachable.
  return "lan";
}

/**
 * Parses `PENGUIN_AUTH_MODE`. Missing/blank is the default (`all-except-health`); anything else
 * unrecognized is an error rather than a fallback, because guessing a weaker mode from a typo
 * would be exactly the silent downgrade this module exists to prevent.
 */
export function parseConfiguredAuthMode(
  raw: string | undefined,
  fallback: ConfiguredAuthMode = "all-except-health",
): ConfiguredAuthMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "auto" || value === "off" || value === "all-except-health") return value;
  throw new Error(`Invalid PENGUIN_AUTH_MODE=${raw} (expected auto, off or all-except-health)`);
}

/**
 * The one pure resolution: configured policy + trusted bind address + explicit loopback trust →
 * effective mode. `auto` lifts authentication on loopback only when the operator has said that
 * loopback is trustworthy; a loopback socket by itself proves nothing about who is on the other
 * end of it.
 */
export function resolveAuthMode(
  configured: ConfiguredAuthMode,
  host: string,
  options: AuthModeOptions = {},
): AuthModeDecision {
  const bindClass = classifyBind(host);
  const trustLoopback = options.trustLoopback === true;
  const effective: EffectiveAuthMode =
    configured === "auto"
      ? bindClass === "loopback" && trustLoopback
        ? "off"
        : "all-except-health"
      : configured;
  return {
    configured,
    host,
    bindClass,
    effective,
    requiresAuth: effective !== "off",
    loopbackTrusted: trustLoopback && bindClass === "loopback",
  };
}

/**
 * The request-time policy for a decision. `off` publishes no paths because nothing is gated;
 * `all-except-health` publishes exactly the probes.
 */
export function authPolicyFor(
  configured: ConfiguredAuthMode,
  host: string,
  options: AuthModeOptions = {},
): AuthPolicy {
  const decision = resolveAuthMode(configured, host, options);
  // Under `off` the gate is not lifted, only its rejection: see the mode table above. So the
  // exempt set is the probes under the gated mode, and empty otherwise.
  const publicPaths = decision.requiresAuth ? HEALTH_PUBLIC_PATHS : [];
  return {
    decision,
    publicPaths,
    isPublicPath(pathname: string): boolean {
      if (!decision.requiresAuth) return false;
      return publicPaths.includes(normalizeRequestPath(pathname));
    },
  };
}

/**
 * The path as the router sees it, for exemption matching. Dot segments are resolved first, so a
 * request spelled `/api/health/../me` is judged as `/api/me` — the exemption is a property of the
 * endpoint, never of a spelling.
 */
function normalizeRequestPath(pathname: string): string {
  const path = pathname.split("?")[0] ?? "";
  try {
    return new URL(path, "http://policy.invalid").pathname;
  } catch {
    return path;
  }
}

/** The policy of a resolved server configuration; the app builds it exactly once. */
export function authPolicyFromConfig(
  config: Pick<ServerConfig, "authMode" | "host"> &
    Partial<Pick<ServerConfig, "authTrustLoopback">>,
): AuthPolicy {
  return authPolicyFor(config.authMode, config.host, {
    trustLoopback: config.authTrustLoopback ?? false,
  });
}
