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

export interface SafeHttpOptions {
  /** Maximum response body size in bytes (default: 2 MB). */
  maxBytes?: number;
  /** Request timeout in milliseconds (default: 15000). */
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

/**
 * Checks if an IPv4 address belongs to a private, loopback, link-local, or reserved range.
 */
export function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed -> treat as blocked
  }

  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local, cloud metadata service e.g. AWS/GCP/Azure)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (reserved)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a private, loopback, or link-local range.
 */
export function isPrivateOrReservedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().trim();
  // Loopback ::1
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // Unspecified ::
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  // Unique local fc00::/7 (fc00... or fd00...)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // Link-local fe80::/10
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  // Multicast ff00::/8
  if (lower.startsWith("ff")) return true;

  // IPv4-mapped IPv6 ::ffff:192.168.1.1
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
  const version = isIP(ip);
  if (version === 4) {
    if (allowLocalhost && ip.startsWith("127.")) {
      return true;
    }
    return !isPrivateOrReservedIPv4(ip);
  }
  if (version === 6) {
    if (allowLocalhost && (ip === "::1" || ip === "0:0:0:0:0:0:0:1")) {
      return true;
    }
    return !isPrivateOrReservedIPv6(ip);
  }
  return false;
}

/**
 * Validates a target URL against SSRF rules, performing DNS lookup to verify IP safety.
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

  // 1. Protocol verification: strictly HTTP/HTTPS only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`SafeHttp: Unsupported protocol '${parsed.protocol}'. Only http: and https: are allowed.`);
  }

  // 2. Host check
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new Error("SafeHttp: URL has empty hostname");
  }

  // Check allowed hosts whitelist
  if (options.allowedHosts && options.allowedHosts.some((h) => h.toLowerCase() === hostname)) {
    return { url: parsed, resolvedIp: hostname };
  }

  // Disallow localhost unless explicitly permitted
  const isLocalName = hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".localhost");
  if (isLocalName) {
    if (!options.allowLocalhost) {
      throw new Error(`SafeHttp: Access to localhost '${hostname}' is blocked by SSRF policy`);
    }
  }

  // 3. DNS resolution & IP range validation
  let resolvedIp = hostname;
  if (isIP(hostname) === 0) {
    try {
      const res = await lookup(hostname, { all: false });
      resolvedIp = res.address;
    } catch (err) {
      throw new Error(`SafeHttp: DNS lookup failed for '${hostname}': ${String(err)}`);
    }
  }

  if (!isSafeIpAddress(resolvedIp, !!options.allowLocalhost)) {
    throw new Error(
      `SafeHttp: Blocked SSRF destination '${hostname}' resolving to private/reserved IP '${resolvedIp}'`,
    );
  }

  return { url: parsed, resolvedIp };
}

/**
 * Executes an SSRF-safe HTTP request with bounded response size, timeouts,
 * redirect safety checks, and private IP blocking.
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

  let currentUrl = inputUrl;
  let redirectsRemaining = maxRedirects;

  while (true) {
    // Validate target before making network connection
    const { url: safeTarget } = await validateSafeUrl(currentUrl, options);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Merge abort signals if caller provided one
    if (init?.signal) {
      init.signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const headers = new Headers(init?.headers);
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", userAgent);
      }

      const response = await fetch(safeTarget.toString(), {
        ...init,
        headers,
        redirect: "manual", // Handle redirects manually to re-verify target safety
        signal: controller.signal,
      });

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        if (!location) {
          throw new Error(`SafeHttp: Redirect response ${response.status} missing Location header`);
        }
        if (redirectsRemaining <= 0) {
          throw new Error(`SafeHttp: Exceeded maximum redirect limit of ${maxRedirects}`);
        }
        redirectsRemaining--;
        currentUrl = new URL(location, safeTarget).toString();
        continue;
      }

      // Check Content-Length header if provided
      const contentLengthHeader = response.headers.get("Content-Length");
      if (contentLengthHeader) {
        const cl = Number.parseInt(contentLengthHeader, 10);
        if (!Number.isNaN(cl) && cl > maxBytes) {
          throw new Error(
            `SafeHttp: Response Content-Length (${cl} bytes) exceeds limit of ${maxBytes} bytes`,
          );
        }
      }

      // Stream response with byte counting
      const bodyStream = response.body;
      let bodyBuffer: Buffer | null = null;

      const getBuffer = async (): Promise<Buffer> => {
        if (bodyBuffer) return bodyBuffer;
        if (!bodyStream) {
          bodyBuffer = Buffer.alloc(0);
          return bodyBuffer;
        }

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        const reader = bodyStream.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > maxBytes) {
                reader.cancel();
                throw new Error(`SafeHttp: Response body exceeded maximum limit of ${maxBytes} bytes`);
              }
              chunks.push(value);
            }
          }
        } finally {
          reader.releaseLock();
        }

        bodyBuffer = Buffer.concat(chunks);
        return bodyBuffer;
      };

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        url: safeTarget.toString(),
        text: async () => {
          const buf = await getBuffer();
          return buf.toString("utf-8");
        },
        json: async <T = unknown>() => {
          const buf = await getBuffer();
          return JSON.parse(buf.toString("utf-8")) as T;
        },
        buffer: getBuffer,
      };
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new Error(`SafeHttp: Request timed out after ${timeoutMs}ms for '${currentUrl}'`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
