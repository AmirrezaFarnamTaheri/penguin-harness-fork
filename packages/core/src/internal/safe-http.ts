/**
 * SSRF-Safe HTTP Client and URL Validator.
 *
 * Protects autonomous HTTP fetches from loopback, private, link-local, reserved, and metadata
 * destinations. DNS is validated once and the transport is bound to the exact validated address.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as http from "node:http";
import * as https from "node:https";

export interface SafeHttpOptions {
  maxBytes?: number;
  timeoutMs?: number;
  allowLocalhost?: boolean;
  allowedHosts?: string[];
  maxRedirects?: number;
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

function parseIpv4Bytes(ip: string): Uint8Array | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return Uint8Array.from(bytes);
}

/** Parse every legal IPv6 spelling into the same 16-byte representation. */
function parseIpv6Bytes(input: string): Uint8Array | null {
  let ip = normalizeHostname(input);
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex);
  if (isIP(ip) !== 6) return null;

  // Convert an embedded dotted-quad tail (for example ::ffff:127.0.0.1) into two hextets
  // before expanding ::, so representation differences cannot affect classification.
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Bytes(tail);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const double = ip.indexOf("::");
  if (double !== -1 && double !== ip.lastIndexOf("::")) return null;
  const parseSide = (text: string): number[] | null => {
    if (!text) return [];
    const parts = text.split(":");
    const out: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  let words: number[];
  if (double >= 0) {
    const left = parseSide(ip.slice(0, double));
    const right = parseSide(ip.slice(double + 2));
    if (!left || !right || left.length + right.length >= 8) return null;
    words = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  } else {
    const parsed = parseSide(ip);
    if (!parsed || parsed.length !== 8) return null;
    words = parsed;
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index++) {
    bytes[index * 2] = words[index]! >> 8;
    bytes[index * 2 + 1] = words[index]! & 0xff;
  }
  return bytes;
}

function isAllZero(bytes: Uint8Array, endExclusive = bytes.length): boolean {
  for (let index = 0; index < endExclusive; index++) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function embeddedIpv4(bytes: Uint8Array): Uint8Array | null {
  // IPv4-compatible ::a.b.c.d and IPv4-mapped ::ffff:a.b.c.d are both normalized to their
  // embedded IPv4 policy. :: and ::1 are handled separately before this helper is used.
  const compatible = isAllZero(bytes, 12);
  const mapped = isAllZero(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (compatible || mapped) return bytes.slice(12);

  // 6to4 embeds an IPv4 destination in bytes 2..5. Treat the embedded address conservatively.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6);
  return null;
}

function ipv4BytesPrivateOrReserved(bytes: Uint8Array): boolean {
  const [a, b, c] = bytes as unknown as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

export function isPrivateOrReservedIPv4(ip: string): boolean {
  const bytes = parseIpv4Bytes(ip);
  return bytes ? ipv4BytesPrivateOrReserved(bytes) : true;
}

export function isPrivateOrReservedIPv6(ip: string): boolean {
  const bytes = parseIpv6Bytes(ip);
  if (!bytes) return true;

  // Unspecified and loopback.
  if (isAllZero(bytes)) return true;
  if (isAllZero(bytes, 15) && bytes[15] === 1) return true;

  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8.
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;

  // Discard-only 100::/64 and documentation 2001:db8::/32.
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && isAllZero(bytes.slice(2), 6)) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;

  const embedded = embeddedIpv4(bytes);
  return embedded ? ipv4BytesPrivateOrReserved(embedded) : false;
}

function isLoopbackIp(ip: string): boolean {
  const normalized = normalizeHostname(ip);
  const v4 = parseIpv4Bytes(normalized);
  if (v4) return v4[0] === 127;
  const v6 = parseIpv6Bytes(normalized);
  if (!v6) return false;
  if (isAllZero(v6, 15) && v6[15] === 1) return true;
  const embedded = embeddedIpv4(v6);
  return embedded?.[0] === 127;
}

export function isSafeIpAddress(ip: string, allowLocalhost: boolean): boolean {
  const normalized = normalizeHostname(ip);
  if (allowLocalhost && isLoopbackIp(normalized)) return true;
  const version = isIP(normalized);
  if (version === 4) return !isPrivateOrReservedIPv4(normalized);
  if (version === 6) return !isPrivateOrReservedIPv6(normalized);
  return false;
}

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
    throw new Error(
      `SafeHttp: Unsupported protocol '${parsed.protocol}'. Only http: and https: are allowed.`,
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) throw new Error("SafeHttp: URL has empty hostname");

  const allowed = new Set((options.allowedHosts ?? []).map(normalizeHostname));
  const explicitlyAllowed = allowed.has(hostname);
  const isLocalName =
    hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".localhost");
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

  if (addresses.length === 0)
    throw new Error(`SafeHttp: DNS lookup returned no addresses for '${hostname}'`);

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
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
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
  if (body !== null && !headers.has("content-length"))
    out["content-length"] = String(body.byteLength);
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
          const error = new Error(
            `SafeHttp: Response body exceeded maximum limit of ${maxBytes} bytes`,
          );
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

    const request =
      target.protocol === "https:"
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

export async function safeFetch(
  inputUrl: string,
  init?: RequestInit,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResponse> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 3;
  const userAgent =
    options.userAgent ??
    "PenguinHarness/1.0 (+https://github.com/prismshadow/penguin-harness-fork)";

  if (init?.signal?.aborted)
    throw new Error(`SafeHttp: Request aborted before start for '${inputUrl}'`);

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
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);

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
        if (!location)
          throw new Error(`SafeHttp: Redirect response ${response.status} missing Location header`);
        if (redirectsRemaining <= 0)
          throw new Error(`SafeHttp: Exceeded maximum redirect limit of ${maxRedirects}`);

        const nextTarget = new URL(location, safeTarget);
        if (nextTarget.origin !== safeTarget.origin) stripOriginBoundCredentials(headers);

        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
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
    if (timedOut)
      throw new Error(`SafeHttp: Request timed out after ${timeoutMs}ms for '${inputUrl}'`);
    if (callerAborted) throw new Error(`SafeHttp: Request aborted by caller for '${inputUrl}'`);
    throw error;
  } finally {
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", onCallerAbort);
  }
}
