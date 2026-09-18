/**
 * Request classification and URL pattern matching for the browser cluster's interception layer.
 *
 * Ports the donor's `utils/requests.ts` and the request-gating half of its CDP service: the ad
 * host blocklist, the image/video/range request detectors, the host and glob blocklists, and the
 * glob→regexp compiler behind them. These run on every request a page issues, so they are written
 * to classify without allocating more than necessary and to fail closed (an unparseable URL is
 * treated as a request that must NOT be blocked, because blocking on a parse error would break
 * legitimate pages; the security-critical `file://` gate is separate and blocks by design).
 */

/** Ad networks, trackers and analytics the cluster blocks when `blockAds` is set. */
export const AD_HOSTS: readonly string[] = [
  // Ad networks & services
  "doubleclick.net",
  "adservice.google.com",
  "googlesyndication.com",
  "google-analytics.com",
  "adnxs.com",
  "rubiconproject.com",
  "advertising.com",
  "adtechus.com",
  "quantserve.com",
  "scorecardresearch.com",
  "casalemedia.com",
  "moatads.com",
  "criteo.com",
  "amazon-adsystem.com",
  "serving-sys.com",
  "adroll.com",
  "chartbeat.com",
  "sharethrough.com",
  "indexww.com",
  "mediamath.com",
  "adsystem.com",
  "adservice.com",
  "ads-twitter.com",
  // Analytics & tracking
  "hotjar.com",
  "analytics.google.com",
  "mixpanel.com",
  "kissmetrics.com",
  "googletagmanager.com",
  "clarity.ms",
  "www.clarity.ms",
  "static.clarity.ms",
  // Ad exchanges
  "openx.net",
  "pubmatic.com",
  "bidswitch.net",
  "taboola.com",
  "outbrain.com",
  // Social tracking
  "connect.facebook.net",
  "platform.twitter.com",
  "ads.linkedin.com",
];

const RE_IMAGE_EXT = /\.(jpg|jpeg|png|webp|svg|ico)(\?.*)?$/i;
const RE_VIDEO_EXT = /\.(mp4|m4s|m3u8|ts|webm|gif)(\?.*)?$/i;
const RE_RANGE = /range=\d+-\d+/i;

/** A `URL` or null when the string is not a valid absolute URL. */
export function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when the host is an ad/tracking endpoint or a subdomain of one. */
export function isAdRequest(parsed: URL): boolean {
  const { hostname } = parsed;
  return AD_HOSTS.some((adHost) => hostname === adHost || hostname.endsWith(`.${adHost}`));
}

/** True when the path resolves to a raster/vector image. */
export function isImageRequest(parsed: URL): boolean {
  return RE_IMAGE_EXT.test(parsed.pathname);
}

/**
 * True when the request carries heavy media: a video container, or a byte-range pull from an
 * adaptive-video path (`/avf/` is the donor's marker for a media fragment). The range check is
 * what catches segmented HLS/DASH, whose playlist URL looks like plain text.
 */
export function isHeavyMediaRequest(parsed: URL): boolean {
  const { pathname, searchParams } = parsed;
  if (RE_VIDEO_EXT.test(pathname)) return true;
  const isRange = searchParams.has("range") || RE_RANGE.test(parsed.href);
  return isRange && pathname.includes("/avf/");
}

/** True when the host (or a subdomain of it) is on the caller's blocklist. */
export function isHostBlocked(parsed: URL, blockedHosts?: string[]): boolean {
  if (!blockedHosts?.length) return false;
  const { hostname } = parsed;
  return blockedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * Compiles glob patterns (`*` → `.*`, other regex metacharacters escaped) into anchored regexps.
 * Anchoring matters: without it `*evil.com*` would also match `not-evil.com.evil.com.attacker.net`.
 * A pattern that fails to compile falls back to a fully-escaped literal match rather than throwing
 * and taking the interception pipeline down with it.
 */
export function compileUrlPatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
        "i",
      );
    } catch {
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  });
}

/** True when the URL matches any compiled pattern. */
export function isUrlMatchingPatterns(url: string, compiledPatterns?: RegExp[]): boolean {
  if (!compiledPatterns?.length) return false;
  return compiledPatterns.some((regexp) => regexp.test(url));
}

/** Bandwidth-optimization toggles the interception layer applies per resource type. */
export interface OptimizeBandwidthOptions {
  blockImages?: boolean;
  blockMedia?: boolean;
  blockStylesheets?: boolean;
  blockHosts?: string[];
  blockUrlPatterns?: string[];
}

/** The resource-type label a CDP/puppeteer request carries. */
export type ResourceTypeLabel =
  | "document"
  | "stylesheet"
  | "image"
  | "media"
  | "font"
  | "script"
  | "xhr"
  | "fetch"
  | "websocket"
  | "manifest"
  | "other";

/**
 * The donor's full per-request decision. Returns the action to take and the reason, so a log line
 * or a cockpit card can say WHAT was blocked and WHY rather than only that it was.
 */
export interface RequestDecision {
  action: "allow" | "block";
  reason?: string;
}

/**
 * Decides whether a request should proceed. Pure: given the same URL, resource type and policy it
 * always answers the same way, which is what makes the interception layer testable without a
 * browser.
 */
export function classifyRequest(
  url: string,
  resourceType: ResourceTypeLabel,
  policy: {
    blockAds?: boolean;
    blockedHosts?: string[];
    compiledUrlPatterns?: RegExp[];
    optimize?: OptimizeBandwidthOptions;
  } = {},
): RequestDecision {
  const parsed = tryParseUrl(url);
  if (!parsed) {
    // Unparseable URLs are not blocked: blocking on a malformed string would break pages whose
    // requests a stricter parser rejects. The security-critical protocol gate is separate.
    return { action: "allow" };
  }

  if (policy.blockAds && isAdRequest(parsed)) {
    return { action: "block", reason: "ad-or-tracker host" };
  }

  if (
    isHostBlocked(parsed, policy.blockedHosts) ||
    isUrlMatchingPatterns(url, policy.compiledUrlPatterns)
  ) {
    return { action: "block", reason: "blocked host or URL pattern" };
  }

  const optimize = typeof policy.optimize === "object" ? policy.optimize : undefined;
  if (optimize) {
    if (optimize.blockImages && (resourceType === "image" || isImageRequest(parsed))) {
      return { action: "block", reason: "image blocked by bandwidth optimization" };
    }
    if (optimize.blockMedia && (resourceType === "media" || isHeavyMediaRequest(parsed))) {
      return { action: "block", reason: "media blocked by bandwidth optimization" };
    }
    if (optimize.blockStylesheets && resourceType === "stylesheet") {
      return { action: "block", reason: "stylesheet blocked by bandwidth optimization" };
    }
  }

  return { action: "allow" };
}

/**
 * The protocol gate the donor enforces separately from the policy above and BEFORE it. A page
 * reaching `file://` means the browser escaped its intended origin, so the donor closes the page
 * and ends the session rather than merely aborting the request — the only place the interception
 * layer escalates instead of filtering.
 */
export function isLocalFileSystemRequest(url: string): boolean {
  return url.startsWith("file://");
}
