/**
 * SSRF-Safe HTTP Client and URL Validator.
 * Ported and synthesized from nanobot-main pkg/safehttp, moon-bridge, and web-search security protocols.
 *
 * Protects agent harnesses from Server-Side Request Forgery (SSRF), preventing autonomous
 * agents from probing localhost, cloud instance metadata endpoints (169.254.169.254),
 * or private corporate intranet networks when fetching web resources or executing tools.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as http from "node:http";
import * as https from "node:https";

export interface SafeHttpOptions {
  /** Maximum response body size in bytes (default: 2 MB). */
  maxBytes?: number;
  /** End-to-end request timeout in milliseconds (default: 15000). */
  timeoutMs?: number;
  /** Whether to allow loopback/localhost requests (e.g. for local SearXNG/Ollama). Default: false. */
  allowLocalhost?: boolean;
  /** Whitelist of specific hostnames or IP addresses exempt from private IP blocks. */
  allowedHosts?: string[];
  /** Maximum number of HTTP redirects to follow (default: 3). */
  maxRedirects?: number;
  /** Custom User-Agent header (default: "PenguinHarness/1.0"). */
  userAgent?: string;
}

export interface SafeHttpResponse {
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
  buffer: () => Promise<Buffer>;
}

interface BoundHttpResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().trim();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

/**
 * Checks if an IPv4 address belongs to a private, loopback, link-local, or reserved range.
 */
export function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }

  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224 && a <= 239) return true;
  if (a >= 240) return true;
  return false;
}

/**
 * Checks if an IPv6 address belongs to a private, loopback, or link-local range.
 */
export function isPrivateOrReservedIPv6(ip: string): boolean {
  const lower = normalizeHostname(ip);
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("ff")) return true;

  if (lower.startsWith("::ffff:")) {
    const ipv4 = lower.slice(7);
    if (isIP(ipv4) === 4) {
      return isPrivateOrReservedIPv4(ipv4);
    }
  }

  return false;
}

/**
 * Validates whether an IP address is considered safe from SSRF.
 */
export function isSafeIpAddress(ip: string, allowLocalhost: boolean): boolean {
  const normalized = normalizeHostname(ip);
  const version = isIP(normalized);
  if (version === 4) {
    if (allowLocalhost && normalized.startsWith("127.")) {
      return true;
    }
    return !isPrivateOrReservedIPv4(normalized);
  }
  if (version === 6) {
    if (allowLocalhost && (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1")) {
      return true;
    }
    return !isPrivateOrReservedIPv6(normalized);
  }
  return false;
}

/**
 * Validates a target URL against SSRF rules. The returned address is the exact address that
 * safeFetch binds the transport to, avoiding a second hostname lookup at connection time.
 */
export async function validateSafeUrl(
  rawUrl: string,
  options: SafeHttpOptions = {},
): Promise<{ url: URL; resolvedIp: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SafeHttp: Invalid URL '${rawUrl}'`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`SafeHttp: Unsupported protocol '${parsed.protocol}'. Only http: and https: are allowed.`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new Error("SafeHttp: URL has empty hostname");
  }

  const allowed = new Set((options.allowedHosts ?? []).map(normalizeHostname));
  const explicitlyAllowed = allowed.has(hostname);
  const isLocalName = hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".localhost");
  if (isLocalName && !options.allowLocalhost && !explicitlyAllowed) {
    throw new Error(`SafeHttp: Access to localhost '${hostname}' is blocked by SSRF policy`);
  }

  let addresses: string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await lookup(hostname, { all: true, verbatim: true });
      addresses = resolved.map((entry) => normalizeHostname(entry.address));
    } catch (err) {
      throw new Error(`SafeHttp: DNS lookup failed for '${hostname}': ${String(err)}`);
    }
  }

  if (addresses.length === 0) {
    throw new Error(`SafeHttp: DNS lookup returned no addresses for '${hostname}'`);
  }

  if (!explicitlyAllowed) {
    for (const address of addresses) {
      if (!isSafeIpAddress(address, !!options.allowLocalhost)) {
        throw new Error(
          `SafeHttp: Blocked SSRF destination '${hostname}' resolving to private/reserved IP '${address}'`,
        );
      }
    }
  }

  return { url: parsed, resolvedIp: addresses[0]! };
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function headersToNode(headers: Headers, target: URL, body: Buffer | null): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  out.host = target.host;
  if (body !== null && !headers.has("content-length")) {
    out["content-length"] = String(body.byteLength);
  }
  return out;
}

function stripOriginBoundCredentials(headers: Headers): void {
  const exact = new Set([
    "authorization",
    "cookie",
    "cookie2",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-auth-token",
  ]);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (
      exact.has(lower) ||
      /(?:^|[-_])(token|secret|credential|api[-_]?key)(?:$|[-_])/.test(lower)
    ) {
      headers.delete(name);
    }
  }
}

function dropEntityHeaders(headers: Headers): void {
  for (const name of ["content-length", "content-type", "content-encoding", "transfer-encoding"]) {
    headers.delete(name);
  }
}

function requestBoundAddress(
  target: URL,
  resolvedIp: string,
  method: string,
  headers: Headers,
  body: Buffer | null,
  signal: AbortSignal,
  maxBytes: number,
): Promise<BoundHttpResponse> {
  return new Promise<BoundHttpResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const hostname = normalizeHostname(target.hostname);
    const common: http.RequestOptions = {
      protocol: target.protocol,
      hostname: resolvedIp,
      port: target.port ? Number(target.port) : undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers: headersToNode(headers, target, body),
      signal,
    };

    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const onResponse = (response: http.IncomingMessage) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, String(value));
        }
      }

      const declared = responseHeaders.get("content-length");
      if (declared) {
        const length = Number.parseInt(declared, 10);
        if (!Number.isNaN(length) && length > maxBytes) {
          const error = new Error(
            `SafeHttp: Response Content-Length (${length} bytes) exceeds limit of ${maxBytes} bytes`,
          );
          response.destroy(error);
          fail(error);
          return;
        }
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > maxBytes) {
          const error = new Error(`SafeHttp: Response body exceeded maximum limit of ${maxBytes} bytes`);
          response.destroy(error);
          fail(error);
          return;
        }
        chunks.push(buffer);
      });
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders,
          body: Buffer.concat(chunks),
        });
      });
    };

    const request = target.protocol === "https:"
      ? https.request(
          {
            ...common,
            servername: isIP(hostname) === 0 ? hostname : undefined,
          },
          onResponse,
        )
      : http.request(common, onResponse);

    request.on("error", fail);
    if (body !== null) request.end(body);
    else request.end();
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Executes an SSRF-safe HTTP request with bounded response size, one end-to-end deadline,
 * redirect credential isolation, and a transport bound to the address that was validated.
 */
export async function safeFetch(
  inputUrl: string,
  init?: RequestInit,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResponse> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 3;
  const userAgent = options.userAgent ?? "PenguinHarness/1.0 (+https://github.com/prismshadow/penguin-harness-fork)";

  if (init?.signal?.aborted) {
    throw new Error(`SafeHttp: Request aborted before start for '${inputUrl}'`);
  }

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  init?.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const template = new Request(inputUrl, init);
    let method = template.method.toUpperCase();
    const headers = new Headers(template.headers);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", userAgent);
    }

    let body: Buffer | null = null;
    if (template.body !== null) {
      const bytes = await raceWithAbort(template.arrayBuffer(), controller.signal);
      body = Buffer.from(bytes);
    }

    let currentUrl = inputUrl;
    let redirectsRemaining = maxRedirects;

    while (true) {
      const { url: safeTarget, resolvedIp } = await raceWithAbort(
        validateSafeUrl(currentUrl, options),
        controller.signal,
      );

      const response = await requestBoundAddress(
        safeTarget,
        resolvedIp,
        method,
        headers,
        body,
        controller.signal,
        maxBytes,
      );

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`SafeHttp: Redirect response ${response.status} missing Location header`);
        }
        if (redirectsRemaining <= 0) {
          throw new Error(`SafeHttp: Exceeded maximum redirect limit of ${maxRedirects}`);
        }

        const nextTarget = new URL(location, safeTarget);
        if (nextTarget.origin !== safeTarget.origin) {
          stripOriginBoundCredentials(headers);
        }

        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          if (method !== "HEAD") {
            method = "GET";
            body = null;
            dropEntityHeaders(headers);
          }
        }

        redirectsRemaining--;
        currentUrl = nextTarget.toString();
        continue;
      }

      const finalBody = response.body;
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        url: safeTarget.toString(),
        text: async () => finalBody.toString("utf-8"),
        json: async <T = unknown>() => JSON.parse(finalBody.toString("utf-8")) as T,
        buffer: async () => Buffer.from(finalBody),
      };
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`SafeHttp: Request timed out after ${timeoutMs}ms for '${inputUrl}'`);
    }
    if (callerAborted) {
      throw new Error(`SafeHttp: Request aborted by caller for '${inputUrl}'`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", onCallerAbort);
  }
}
