/**
 * OAuth 2.0 PKCE token exchange for the Universal Tool Mesh.
 *
 * Ports the working PKCE flow from the vibe-tools lineage's Linear `connect` command
 * (random 32-byte verifier, S256 challenge, loopback redirect catcher, URL-encoded token
 * exchange) and folds in the connection-state machine from the composio lineage
 * (INITIALIZING → INITIATED → ACTIVE | FAILED | EXPIRED) so a caller can tell a pending
 * authorization from a usable token.
 *
 * PKCE exists so a public client can prove it owns an authorization without ever sending
 * the secret over the wire. The mesh is exactly such a client: it holds the verifier and
 * redeems the code. The verifier/challenge pair is derived with real SHA-256, matching
 * RFC 7636's `S256` method — `plain` is refused, because it reduces PKCE to a nonce.
 *
 * Node built-ins only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** The RFC 7636 challenge method this module implements, exclusively. */
export const PKCE_METHOD = "S256" as const;
export const PKCE_VERIFIER_BYTES = 32;

/** A handshake this old is not redeemable — the code has expired with it. */
const TEN_MINUTES = 10 * 60 * 1000;

/** Connection lifecycle, from the composio lineage's `ConnectionStatuses`. */
export const CONNECTION_STATUS = {
  INITIALIZING: "INITIALIZING",
  INITIATED: "INITIATED",
  ACTIVE: "ACTIVE",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  INACTIVE: "INACTIVE",
  REVOKED: "REVOKED",
} as const;
export type ConnectionStatus = (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

/** The states a PKCE handshake moves through; ACTIVE is the only one that can serve a call. */
export const PKCE_FLOW_STATUS = {
  ...CONNECTION_STATUS,
} as const;
export type PkceFlowStatus = ConnectionStatus;

/**
 * Base64url without padding, per RFC 7636 Appendix A. `Buffer.toString("base64url")` on
 * Node 16+ is the same transformation; this is a thin, explicit alias so the encoding is
 * visible at every use site.
 */
export function base64url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64url");
}

/**
 * Generates a code verifier: 32 random bytes, base64url-encoded (43 characters).
 * `randomBytes` is the CSPRNG — `Math.random()` would make the verifier predictable and
 * the whole point of PKCE would be lost.
 */
export function generateCodeVerifier(bytes: number = PKCE_VERIFIER_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 32) {
    throw new Error("PKCE verifier must be at least 32 bytes of entropy");
  }
  return randomBytes(bytes).toString("base64url");
}

/**
 * Derives the S256 challenge: `BASE64URL(SHA256(ASCII(verifier)))`.
 * This is the RFC 7636 transform; the verifier is never sent to the authorization server.
 */
export function deriveCodeChallenge(verifier: string): string {
  if (!verifier) throw new Error("PKCE verifier must be non-empty");
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A freshly generated pair, ready to embed in an authorization URL. */
export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: typeof PKCE_METHOD;
}

export function generatePkcePair(bytes?: number): PkcePair {
  const codeVerifier = generateCodeVerifier(bytes);
  return {
    codeVerifier,
    codeChallenge: deriveCodeChallenge(codeVerifier),
    codeChallengeMethod: PKCE_METHOD,
  };
}

/**
 * Unencrypted state held while a handshake is in flight. Only the verifier is sensitive;
 * the store keeps it because the token exchange needs it, and the exchange is the one
 * operation that can redeem the authorization code.
 */
export interface PkceSession {
  readonly id: string;
  readonly providerId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly startedAt: number;
  status: PkceFlowStatus;
}

export interface PkceProviderConfig {
  readonly providerId: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly redirectUri: string;
  /** Default scopes when the caller does not pass an explicit list. */
  readonly defaultScopes?: readonly string[];
  /** Extra params a provider demands (Apple's `response_mode`, Slack's `user_scope`...). */
  readonly extraAuthParams?: Record<string, string>;
  /**
   * Send the client secret in the body rather than the `Authorization: Basic` header.
   * Apple and a handful of others require it; the default matches RFC 6749's preference.
   */
  readonly secretInBody?: boolean;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string | readonly string[];
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly sessionId: string;
  readonly state: string;
}

/** Builds the authorization URL with PKCE, state, and the provider's own param quirks. */
export function buildAuthorizationUrl(config: PkceProviderConfig, session: PkceSession): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state: session.state,
    scope: session.scopes.join(" "),
    code_challenge: deriveCodeChallenge(session.codeVerifier),
    code_challenge_method: PKCE_METHOD,
  });
  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    params.set(key, value);
  }
  return `${config.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Starts a PKCE handshake: allocates a session (verifier + state), and returns the URL a
 * browser must visit. The session is `INITIALIZING` until a code lands.
 */
export function startPkceSession(
  config: PkceProviderConfig,
  scopes?: readonly string[],
): PkceSession {
  if (!config.providerId) throw new Error("PKCE provider config requires a providerId");
  if (!config.clientId) throw new Error(`PKCE provider '${config.providerId}' has no clientId`);
  if (!config.redirectUri)
    throw new Error(`PKCE provider '${config.providerId}' has no redirectUri`);

  return {
    id: randomUUID(),
    providerId: config.providerId,
    state: randomUUID().replace(/-/g, ""),
    codeVerifier: generateCodeVerifier(),
    redirectUri: config.redirectUri,
    scopes: scopes && scopes.length > 0 ? scopes : (config.defaultScopes ?? []),
    startedAt: Date.now(),
    status: CONNECTION_STATUS.INITIALIZING,
  };
}

/**
 * Builds the token-exchange body for an authorization code grant, exactly as the
 * vibe-tools lineage does it: URL-encoded form, with the verifier that proves ownership.
 */
export function buildTokenExchangeBody(
  config: PkceProviderConfig,
  session: PkceSession,
  code: string,
): URLSearchParams {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    redirect_uri: session.redirectUri,
    code_verifier: session.codeVerifier,
  });
  if (config.clientSecret && config.secretInBody) {
    params.set("client_secret", config.clientSecret);
  }
  return params;
}

/** Builds a refresh-token grant body, for {@link refreshTokens}. */
export function buildRefreshBody(
  config: PkceProviderConfig,
  refreshToken: string,
  scopes?: readonly string[],
): URLSearchParams {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  if (config.clientSecret && config.secretInBody) {
    params.set("client_secret", config.clientSecret);
  }
  if (scopes && scopes.length > 0) params.set("scope", scopes.join(" "));
  return params;
}

export class PkceError extends Error {
  constructor(
    readonly code:
      | "state_mismatch"
      | "missing_code"
      | "provider_error"
      | "token_exchange_failed"
      | "invalid_token_response"
      | "expired_session"
      | "no_refresh_token"
      | "not_active",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PkceError";
  }
}

/**
 * Validates an OAuth token response. A response without an `access_token` is not a token
 * response, whatever the HTTP status said.
 */
export function validateTokenResponse(body: unknown): TokenResponse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new PkceError("invalid_token_response", "Token endpoint returned a non-object body");
  }
  const value = body as Record<string, unknown>;
  if (typeof value.access_token !== "string" || value.access_token.length === 0) {
    const error =
      typeof value.error === "string"
        ? `${value.error}${typeof value.error_description === "string" ? `: ${value.error_description}` : ""}`
        : "Token endpoint response has no access_token";
    throw new PkceError("invalid_token_response", error);
  }
  return {
    access_token: value.access_token,
    ...(typeof value.token_type === "string" ? { token_type: value.token_type } : {}),
    ...(typeof value.expires_in === "number" ? { expires_in: value.expires_in } : {}),
    ...(typeof value.refresh_token === "string" ? { refresh_token: value.refresh_token } : {}),
    ...(typeof value.id_token === "string" ? { id_token: value.id_token } : {}),
    ...(value.scope !== undefined ? { scope: value.scope as string | string[] } : {}),
  };
}

/** Converts a token response into the absolute epoch-ms expiry the store persists. */
export function tokenExpiry(response: TokenResponse, now: number = Date.now()): number | undefined {
  if (typeof response.expires_in !== "number" || !Number.isFinite(response.expires_in)) {
    return undefined;
  }
  return now + Math.max(0, response.expires_in) * 1000;
}

/**
 * Basic auth header value for a confidential client: `Basic base64(client:secret)`.
 * Exported so the transport stays in one place and callers never assemble it ad hoc.
 */
export function basicAuthHeader(config: PkceProviderConfig): string | undefined {
  if (!config.clientSecret || config.secretInBody) return undefined;
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
}

/** The fetch-shaped transport the exchanger uses; injected so tests do not need the network. */
export type TokenTransport = (
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
) => Promise<{ status: number; json(): Promise<unknown> }>;

const JSON_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * Exchanges an authorization code for tokens. This is the operation PKCE protects: the
 * code by itself is useless without the verifier, and the verifier has not left this
 * process. `state` is checked against the session before anything is sent, so a forged
 * redirect cannot trade on a victim's in-flight handshake.
 */
export async function exchangeCodeForTokens(
  config: PkceProviderConfig,
  session: PkceSession,
  callback: { code?: string; state?: string; error?: string; errorDescription?: string },
  transport: TokenTransport,
  now: number = Date.now(),
): Promise<TokenResponse> {
  if (session.status === CONNECTION_STATUS.ACTIVE) {
    throw new PkceError("not_active", "Session already has tokens");
  }
  if (session.status === CONNECTION_STATUS.EXPIRED || now - session.startedAt > TEN_MINUTES) {
    session.status = CONNECTION_STATUS.EXPIRED;
    throw new PkceError("expired_session", "PKCE session expired before the code arrived");
  }
  if (callback.error) {
    session.status = CONNECTION_STATUS.FAILED;
    throw new PkceError(
      "provider_error",
      `Authorization denied: ${callback.error}${callback.errorDescription ? ` — ${callback.errorDescription}` : ""}`,
    );
  }
  if (!callback.code) throw new PkceError("missing_code", "Authorization callback has no code");
  if (callback.state !== session.state) {
    session.status = CONNECTION_STATUS.FAILED;
    throw new PkceError("state_mismatch", "Authorization callback state does not match session");
  }

  session.status = CONNECTION_STATUS.INITIATED;
  const headers: Record<string, string> = {
    "content-type": JSON_CONTENT_TYPE,
    accept: "application/json",
  };
  const basic = basicAuthHeader(config);
  if (basic) headers.authorization = basic;

  const response = await transport(
    config.tokenEndpoint,
    buildTokenExchangeBody(config, session, callback.code),
    headers,
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    session.status = CONNECTION_STATUS.FAILED;
    throw new PkceError(
      "token_exchange_failed",
      `Token endpoint returned a non-JSON body (status ${response.status}): ${(error as Error).message}`,
    );
  }
  try {
    const tokens = validateTokenResponse(body);
    session.status = CONNECTION_STATUS.ACTIVE;
    return tokens;
  } catch (error) {
    session.status = CONNECTION_STATUS.FAILED;
    if (error instanceof PkceError && error.code === "invalid_token_response") {
      throw new PkceError(
        "token_exchange_failed",
        `Token exchange failed (status ${response.status}): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Refreshes an access token from a refresh token. Rotation-aware: when the provider issues
 * a new refresh token (Google does), the caller must persist the replacement, and the old
 * one is already dead.
 */
export async function refreshTokens(
  config: PkceProviderConfig,
  refreshToken: string,
  transport: TokenTransport,
  scopes?: readonly string[],
): Promise<TokenResponse> {
  if (!refreshToken) throw new PkceError("no_refresh_token", "No refresh token available");

  const headers: Record<string, string> = {
    "content-type": JSON_CONTENT_TYPE,
    accept: "application/json",
  };
  const basic = basicAuthHeader(config);
  if (basic) headers.authorization = basic;

  const response = await transport(
    config.tokenEndpoint,
    buildRefreshBody(config, refreshToken, scopes),
    headers,
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new PkceError(
      "token_exchange_failed",
      `Refresh returned a non-JSON body (status ${response.status}): ${(error as Error).message}`,
    );
  }
  try {
    return validateTokenResponse(body);
  } catch (error) {
    if (error instanceof PkceError && error.code === "invalid_token_response") {
      throw new PkceError(
        "token_exchange_failed",
        `Token refresh failed (status ${response.status}): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Parses an OAuth redirect callback URL into the fields the exchanger needs. Errors are
 * values, not exceptions, so a loopback handler can report them without a try/catch at
 * every branch.
 */
export function parseCallbackUrl(
  url: string,
  redirectBase: string,
): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
} {
  const parsed = new URL(url, redirectBase);
  const params = parsed.searchParams;
  const error = params.get("error") ?? undefined;
  const code = params.get("code") ?? undefined;
  const state = params.get("state") ?? undefined;
  const errorDescription = params.get("error_description") ?? params.get("error_uri") ?? undefined;
  if (!error && !code) return {};
  return {
    ...(code !== undefined ? { code } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(errorDescription !== undefined ? { errorDescription } : {}),
  };
}

export interface LoopbackReceiverOptions {
  /** Port to bind; 0 lets the OS choose one, which is what tests want. */
  port?: number;
  /** Path the provider redirects to, without the query string. Default `/callback`. */
  path?: string;
  /** How long to wait for a redirect before giving up. Default 120s. */
  timeoutMs?: number;
  /** Loopback address to bind. Default `127.0.0.1`; `::1` for IPv6-only hosts. */
  host?: string;
}

/**
 * A live loopback receiver. The URI is available the instant the socket is bound, so a
 * caller can put it in an authorization URL *before* the handshake starts — which is the
 * only order that works, since the provider echoes it back verbatim.
 */
export interface LoopbackReceiver {
  /** The absolute URI to hand the provider as `redirect_uri`. */
  readonly redirectUri: string;
  /** The bound port; useful when `port` was left at 0. */
  readonly port: number;
  /** Resolves with the parsed callback, or rejects on timeout/teardown. */
  waitForCallback(): Promise<LoopbackCallbackResult>;
  /** Stops listening and releases the port. Safe to call more than once. */
  close(): void;
}

export interface LoopbackCallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Starts a loopback HTTP server that catches the authorization redirect. This is the
 * vibe-tools lineage's approach and it is the right one for a desktop agent: no
 * deep-link registration, no browser extension, just a port that lives for one handshake.
 *
 * The server answers the browser immediately and then closes, so the user's tab is not
 * left spinning while the mesh redeems the code. A single handshake per receiver is
 * enforced — a second request after the first is a 404, because the socket is gone.
 *
 * The factory is async because `server.listen()` is: a socket's address only exists once
 * `listening` fires, so awaiting it here is what makes {@link LoopbackReceiver.redirectUri}
 * a real bound port rather than a placeholder. That ordering — URI in hand before the
 * authorization URL is built — is the whole reason the receiver exists.
 */
export async function startLoopbackReceiver(
  options: LoopbackReceiverOptions = {},
): Promise<LoopbackReceiver> {
  const callbackPath = options.path ?? "/callback";
  const host = options.host ?? "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? 120_000;

  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let pending: ((result: LoopbackCallbackResult) => void) | undefined;
  let failure: (error: Error) => void;

  const callback = new Promise<LoopbackCallbackResult>((resolve, reject) => {
    pending = resolve;
    failure = reject;
  });
  // A caller that never waits must not turn a teardown rejection into an unhandled warning.
  callback.catch(() => {});

  const server = createServer((req, res) => {
    const requestUrl = req.url ?? "/";
    if (!requestUrl.startsWith(callbackPath)) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const parsed = parseCallbackUrl(requestUrl, `http://${host}`);
    const ok = parsed.error === undefined;
    res.statusCode = ok ? 200 : 400;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      ok
        ? "<html><body><h1>Authorized</h1><p>You can close this tab.</p></body></html>"
        : `<html><body><h1>Authorization failed</h1><p>${escapeHtml(parsed.error ?? "unknown error")}</p></body></html>`,
    );
    // Resolve after the response is flushed, so the browser actually sees it.
    setImmediate(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      pending?.(parsed);
    });
  });

  server.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    failure(error);
  });

  // Bind, then wait for the socket to actually be listening before reading its address.
  // `server.listen()` returns before the bind completes, so `server.address()` called
  // immediately after is null on every platform that matters — awaiting `listening` is the
  // only way `redirectUri` below is the port the provider will redirect to.
  const requestedPort = options.port ?? 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(requestedPort, host);
    });
  } catch (error) {
    server.close();
    throw new PkceError(
      "token_exchange_failed",
      `Could not bind loopback ${host}:${requestedPort}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new PkceError("token_exchange_failed", "Loopback receiver bound no address");
  }
  const boundPort = address.port;

  if (requestedPort !== 0 && requestedPort !== boundPort) {
    server.close();
    throw new PkceError("token_exchange_failed", `Could not bind loopback port ${requestedPort}`);
  }

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    failure(new PkceError("expired_session", `Loopback callback timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    redirectUri: `http://${host}:${boundPort}${callbackPath}`,
    port: boundPort,
    waitForCallback: () => callback,
    close: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      failure(
        new PkceError("expired_session", "Loopback receiver closed before a callback landed"),
      );
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
