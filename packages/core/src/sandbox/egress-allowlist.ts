/**
 * Egress allow-list — the network boundary the in-memory tier escalates against.
 *
 * Ported in full from the donors' in-memory bash implementation's network
 * allow-list module, which is the most complete statement of this boundary in any
 * of the five archives. Its central design decision is that the allow-list is
 * matched at the *fetch layer* — after parsing, after redirect handling — so no
 * amount of manipulating the input string can move a request out from under the
 * check. The two halves of that are here:
 *
 * 1. **Origin-exact, path-segment-boundary matching.** Origins must match
 *    byte-for-byte; a path-scoped entry matches only at a `/` boundary, never on a
 *    raw string prefix, so `https://good.com.evil.com/` and `https://good.comx/`
 *    both fail.
 * 2. **Rejection of ambiguous path syntax.** Any path whose meaning could change
 *    under a proxy or application server's canonicalization is refused *for
 *    path-scoped entries*: backslashes, semicolons, malformed percent escapes, and
 *    the encoded forms of `/`, `.`, `\`, `;`. Decoding iterates a bounded number of
 *    passes so a doubly-encoded traversal cannot slip through a decode stack, and
 *    a trailing `%` is rejected at the end because something upstream may decode
 *    one more time than we do.
 *
 * The SSRF half is the private-address table: every IPv4 and IPv6 range that
 * resolves to something the caller did not mean to reach — loopback, RFC 1918,
 * link-local, CGNAT, the RFC 2544 benchmarking range, the RFC 6890 and 5737
 * special-use blocks, `0.0.0.0/8`, `240.0.0.0/4` — plus the IPv6 forms that embed
 * IPv4 (`::ffff:`, NAT64, 6to4), because a literal `127.0.0.1` is the easy case and
 * `[::ffff:127.0.0.1]` is the case that gets an allow-list review merged.
 */

export type AllowedUrlEntry = string | { url: string };

/** Parses a URL, returning null for anything the WHATWG parser rejects. */
export function parseUrl(
  urlString: string,
): { origin: string; pathname: string; href: string } | null {
  try {
    const url = new URL(urlString);
    return { origin: url.origin, pathname: url.pathname, href: url.href };
  } catch {
    return null;
  }
}

/** Normalize an allow-list entry into its origin and path prefix. */
export function normalizeAllowListEntry(entry: string): {
  origin: string;
  pathPrefix: string;
} | null {
  const parsed = parseUrl(entry);
  if (!parsed) return null;
  return { origin: parsed.origin, pathPrefix: parsed.pathname };
}

/** Maximum decode passes before an ambiguous path is declared ambiguous. */
const MAX_PATH_DECODE_PASSES = 3;

/**
 * Reject path forms whose meaning can change after common proxy or application-server
 * canonicalization. Path-scoped entries are authority boundaries, so invalid escapes
 * and nested encodings fail closed: a request that cannot be shown to be unambiguous
 * is not sent.
 */
function hasAmbiguousPathSyntax(pathname: string): boolean {
  let candidate = pathname;

  for (let pass = 0; pass < MAX_PATH_DECODE_PASSES; pass++) {
    if (candidate.includes("\\") || candidate.includes(";")) return true;
    if (/%(?![0-9a-f]{2})/i.test(candidate)) return true;

    const normalized = candidate.toLowerCase();
    if (
      normalized.includes("%2f") ||
      normalized.includes("%2e") ||
      normalized.includes("%5c") ||
      normalized.includes("%3b")
    ) {
      return true;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }

  // Do not let an upstream with a deeper decode stack reinterpret a path.
  return candidate.includes("%");
}

function matchesPathPrefix(pathname: string, pathPrefix: string): boolean {
  if (pathPrefix === "/" || pathPrefix === "") return true;
  if (pathPrefix.endsWith("/")) return pathname.startsWith(pathPrefix);
  return pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

/**
 * Whether a URL matches one allow-list entry.
 *
 * Rules:
 * 1. Origins must match exactly.
 * 2. Path-scoped entries match on path *segment* boundaries, not raw string prefix.
 * 3. Ambiguous encoded separators (%2f, %5c, %2e, %3b) are rejected for path-scoped
 *    entries, so a request cannot encode its way past a directory boundary.
 * 4. An entry with no path (or just `/`) allows every path on that origin.
 */
export function matchesAllowListEntry(url: string, allowedEntry: string): boolean {
  const parsedUrl = parseUrl(url);
  if (!parsedUrl) return false;

  const normalizedEntry = normalizeAllowListEntry(allowedEntry);
  if (!normalizedEntry) return false;

  if (parsedUrl.origin !== normalizedEntry.origin) return false;

  if (
    normalizedEntry.pathPrefix !== "/" &&
    normalizedEntry.pathPrefix !== "" &&
    hasAmbiguousPathSyntax(parsedUrl.pathname)
  ) {
    return false;
  }

  return matchesPathPrefix(parsedUrl.pathname, normalizedEntry.pathPrefix);
}

function entryToUrl(entry: AllowedUrlEntry): string {
  return typeof entry === "string" ? entry : entry.url;
}

/**
 * Whether a URL is allowed by any entry in the allow-list. An empty list denies
 * everything — the network is off by default, and a caller wanting network access
 * must spell out where to.
 */
export function isUrlAllowed(url: string, allowedUrlPrefixes: AllowedUrlEntry[]): boolean {
  if (!allowedUrlPrefixes || allowedUrlPrefixes.length === 0) return false;
  return allowedUrlPrefixes.some((entry) => matchesAllowListEntry(url, entryToUrl(entry)));
}

/**
 * Check if a hostname is a private/loopback address. Only string format — no DNS
 * resolution — which is deliberate: resolving would introduce a TOCTOU window
 * between the check and the connect. The DNS pinning layer that closes that window
 * is the caller's business; this function answers "is this *spelled* private".
 */
export function isPrivateIp(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isPrivateIpv4(ipv4);

  const ipv6 = parseIpv6(normalized);
  if (ipv6) return isPrivateIpv6(ipv6);

  return false;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse one IPv4 component, accepting the octal and hexadecimal forms the kernel
 * also accepts: `0177.0.0.1`, `0x7f.1`, and `2130706433` all mean 127.0.0.1, so all
 * three must be recognized to be rejected.
 */
function parseIpComponent(part: string): number | null {
  if (!part) return null;

  let base = 10;
  let digits = part;

  if (digits.startsWith("0x") || digits.startsWith("0X")) {
    base = 16;
    digits = digits.slice(2);
  } else if (digits.length > 1 && digits.startsWith("0")) {
    base = 8;
  }

  if (!digits) return null;
  if (base === 16 && !/^[0-9a-fA-F]+$/.test(digits)) return null;
  if (base === 10 && !/^\d+$/.test(digits)) return null;
  if (base === 8 && !/^[0-7]+$/.test(digits)) return null;

  const value = Number.parseInt(digits, base);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const nums = parts.map((p) => parseIpComponent(p));
  if (nums.some((n) => n === null)) return null;

  const values = nums as number[];
  if (parts.length === 1) {
    const n = values[0]!;
    if (n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  if (parts.length === 2) {
    const [a, b] = values as [number, number];
    if (a > 0xff || b > 0xffffff) return null;
    return [a, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff];
  }
  if (parts.length === 3) {
    const [a, b, c] = values as [number, number, number];
    if (a > 0xff || b > 0xff || c > 0xffff) return null;
    return [a, b, (c >>> 8) & 0xff, c & 0xff];
  }
  const [a, b, c, d] = values as [number, number, number, number];
  if (a > 0xff || b > 0xff || c > 0xff || d > 0xff) return null;
  return [a, b, c, d];
}

function parseIpv6(hostname: string): number[] | null {
  let host = hostname;
  let ipv4Tail: [number, number, number, number] | null = null;

  if (host.includes(".")) {
    const lastColon = host.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4Part = host.slice(lastColon + 1);
    const parsedV4 = parseIpv4(v4Part);
    if (!parsedV4) return null;
    ipv4Tail = parsedV4;
    host = host.slice(0, lastColon);
  }

  const doubleColonCount = host.includes("::") ? host.split("::").length - 1 : 0;
  if (doubleColonCount > 1) return null;

  const [leftRaw, rightRaw] = host.split("::");
  const leftParts = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const rightParts = rightRaw ? rightRaw.split(":").filter(Boolean) : [];

  const parseHextet = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    return Number.parseInt(part, 16);
  };

  const left = leftParts.map(parseHextet);
  const right = rightParts.map(parseHextet);
  if (left.some((n) => n === null) || right.some((n) => n === null)) return null;

  const tailLength = ipv4Tail ? 2 : 0;
  const explicitLength = left.length + right.length + tailLength;

  let zerosToInsert = 0;
  if (doubleColonCount === 1) {
    zerosToInsert = 8 - explicitLength;
    if (zerosToInsert < 0) return null;
  } else if (explicitLength !== 8) {
    return null;
  }

  const hextets = [
    ...(left as number[]),
    ...new Array(zerosToInsert).fill(0),
    ...(right as number[]),
  ];

  if (ipv4Tail) {
    hextets.push((ipv4Tail[0] << 8) | ipv4Tail[1]);
    hextets.push((ipv4Tail[2] << 8) | ipv4Tail[3]);
  }

  return hextets.length === 8 ? hextets : null;
}

function isPrivateIpv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking (RFC 2544)
  if (a === 192 && b === 0 && ip[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments (RFC 6890)
  if (a === 192 && b === 0 && ip[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
  if (a === 198 && b === 51 && ip[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
  if (a === 203 && b === 0 && ip[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
  if (a >= 240) return true; // 240.0.0.0/4 reserved (RFC 1112)
  return false;
}

function isPrivateIpv6(hextets: number[]): boolean {
  const allZero = hextets.every((h) => h === 0);
  if (allZero) return true; // :: unspecified

  const isLoopback = hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
  if (isLoopback) return true; // ::1 loopback

  if ((hextets[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((hextets[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local

  // IPv4-mapped ::ffff:x.x.x.x — the classic SSRF bypass, so the embedded address
  // is re-checked against the IPv4 table rather than trusted to be public.
  const isMapped =
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff;
  if (isMapped) {
    const mapped: [number, number, number, number] = [
      (hextets[6]! >>> 8) & 0xff,
      hextets[6]! & 0xff,
      (hextets[7]! >>> 8) & 0xff,
      hextets[7]! & 0xff,
    ];
    return isPrivateIpv4(mapped);
  }

  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true; // 2001:db8::/32 documentation (RFC 3849)

  // 64:ff9b::/96 NAT64 well-known prefix (RFC 6052): embedded IPv4 in the low 32 bits.
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    const embedded: [number, number, number, number] = [
      (hextets[6]! >>> 8) & 0xff,
      hextets[6]! & 0xff,
      (hextets[7]! >>> 8) & 0xff,
      hextets[7]! & 0xff,
    ];
    return isPrivateIpv4(embedded);
  }

  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 0x0001) {
    return true; // 64:ff9b:1::/48 NAT64 local-use (RFC 8215)
  }

  // 2002::/16 6to4 (RFC 3056): embedded IPv4 in bits 16–47.
  if (hextets[0] === 0x2002) {
    const embedded: [number, number, number, number] = [
      (hextets[1]! >>> 8) & 0xff,
      hextets[1]! & 0xff,
      (hextets[2]! >>> 8) & 0xff,
      hextets[2]! & 0xff,
    ];
    return isPrivateIpv4(embedded);
  }

  return false;
}

/**
 * Validate an allow-list configuration. Each entry must be a full origin (scheme +
 * host), optionally followed by a path prefix. Returns one message per bad entry —
 * not a throw — because an allow-list with one typo in it should report the typo,
 * not silently fall back to denying everything.
 */
export function validateAllowList(allowedUrlPrefixes: readonly AllowedUrlEntry[]): string[] {
  const errors: string[] = [];

  for (const rawEntry of allowedUrlPrefixes) {
    if (typeof rawEntry !== "string") {
      if (
        rawEntry === null ||
        typeof rawEntry !== "object" ||
        !("url" in rawEntry) ||
        typeof (rawEntry as { url?: unknown }).url !== "string"
      ) {
        errors.push(
          'Invalid allow-list entry: must be a string URL or an object with a "url" string property',
        );
        continue;
      }
    }

    const entry = entryToUrl(rawEntry);
    const parsed = parseUrl(entry);
    if (!parsed) {
      errors.push(
        `Invalid URL in allow-list: "${entry}" - must be a valid URL with scheme and host (e.g., "https://example.com")`,
      );
      continue;
    }

    const url = new URL(entry);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`Only http and https URLs are allowed in allow-list: "${entry}"`);
      continue;
    }
    if (!url.hostname) {
      errors.push(`Allow-list entry must include a hostname: "${entry}"`);
      continue;
    }
    if (url.pathname !== "/" && url.pathname !== "" && hasAmbiguousPathSyntax(url.pathname)) {
      errors.push(`Allow-list entry contains ambiguous path separators: "${entry}"`);
      continue;
    }
    if (url.search || url.hash) {
      errors.push(`Query strings and fragments are ignored in allow-list entries: "${entry}"`);
    }
  }

  return errors;
}

/**
 * Full egress decision for a URL: allowed by the allow-list AND not spelled as a
 * private address. Both conditions are required, because either alone leaks: an
 * allow-list with a private host passes the first and fails the second, and a
 * public-looking hostname with no allow-list entry passes the second and fails the
 * first.
 */
export interface EgressDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly url: string;
  readonly privateAddress: boolean;
}

export function decideEgress(url: string, allowList: AllowedUrlEntry[]): EgressDecision {
  const parsed = parseUrl(url);
  if (!parsed) {
    return { allowed: false, reason: "unparseable URL", url, privateAddress: false };
  }
  if (isPrivateIp(new URL(parsed.href).hostname)) {
    return {
      allowed: false,
      reason: "target resolves to a private or special-use address",
      url: parsed.href,
      privateAddress: true,
    };
  }
  if (!isUrlAllowed(parsed.href, allowList)) {
    return {
      allowed: false,
      reason: "target is not on the egress allow-list",
      url: parsed.href,
      privateAddress: false,
    };
  }
  return {
    allowed: true,
    reason: "allowed by egress allow-list",
    url: parsed.href,
    privateAddress: false,
  };
}
