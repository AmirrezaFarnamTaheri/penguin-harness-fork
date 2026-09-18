/**
 * Browser profile presets.
 *
 * The plan's Tier 4 deliverable: three complete, internally-consistent identities a session can
 * launch with, each combining the navigator/screen/WebGL/TLS layers the other modules produce.
 *
 * Consistency is the constraint these presets exist to satisfy. A detector cross-checks fields
 * against each other, not just against a database: Mobile Safari iOS 17 must not report
 * `hardwareConcurrency: 16` with `platform: Win32`, and an Enterprise Firefox on Linux must not
 * offer Chrome's UA-CH brand list. Every field below was chosen to agree with the others in the
 * same preset, and the tests assert the cross-field invariants rather than only the field values.
 */

import type { BrowserFingerprint } from "./fingerprint-randomizer.js";
import type { TlsFingerprintProfile } from "./tls-fingerprint-profile.js";
import type { WebGLIdentity } from "./webgl-parameter-override.js";
import { buildTlsFingerprintProfile } from "./tls-fingerprint-profile.js";

export type ProfileId = "desktop-chrome-win11" | "mobile-safari-ios17" | "enterprise-firefox-linux";

export interface BrowserProfilePreset {
  id: ProfileId;
  label: string;
  deviceClass: "desktop" | "mobile";
  browser: "chrome" | "safari" | "firefox";
  /** Operating system the preset claims to run on. */
  os: string;
  /** Full user agent string. */
  userAgent: string;
  /** `navigator.platform`. */
  platform: string;
  /** UA-CH high-entropy hints; empty for browsers that do not send Client Hints. */
  userAgentData?: {
    architecture: string;
    bitness: string;
    mobile: boolean;
    model: string;
    platformVersion: string;
    uaFullVersion: string;
    brands: ReadonlyArray<{ brand: string; version: string }>;
  };
  /** Accept-Language header matching the preset's locale. */
  acceptLanguage: string;
  /** Timezone matching the locale. */
  timezone: string;
  /** Screen / viewport geometry. */
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    devicePixelRatio: number;
  };
  /** navigator hardware fields. */
  hardware: {
    hardwareConcurrency: number;
    deviceMemory: number;
  };
  /** WebGL identity; the vendor/renderer must be plausible for the claimed OS. */
  webgl: WebGLIdentity;
  /** TLS ClientHello profile for the claimed browser. */
  tls: TlsFingerprintProfile;
  /** Extra Chromium launch arguments that make the preset's claim true (e.g. force-device-scale-factor). */
  launchArgs: readonly string[];
  /** Emoji-free short note for a cockpit tooltip. */
  note: string;
}

/**
 * Desktop Chrome on Windows 11. The reference profile: Chrome sends UA-CH brand data, so the
 * high-entropy hints are populated and must agree with the UA string's major version.
 */
export const DESKTOP_CHROME_WIN11: BrowserProfilePreset = {
  id: "desktop-chrome-win11",
  label: "Desktop Chrome · Windows 11",
  deviceClass: "desktop",
  browser: "chrome",
  os: "win32",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  platform: "Win32",
  userAgentData: {
    architecture: "x86",
    bitness: "64",
    mobile: false,
    model: "",
    platformVersion: "15.0.0",
    uaFullVersion: "131.0.6778.86",
    brands: [
      { brand: "Not.A/Brand", version: "8" },
      { brand: "Chromium", version: "131.0.0.0" },
      { brand: "Google Chrome", version: "131.0.0.0" },
    ],
  },
  acceptLanguage: "en-US,en;q=0.9",
  timezone: "America/New_York",
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, devicePixelRatio: 1 },
  hardware: { hardwareConcurrency: 8, deviceMemory: 8 },
  webgl: {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    version: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
    shadingLanguageVersion: "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
  },
  tls: buildTlsFingerprintProfile("chrome", 0),
  launchArgs: ["--force-device-scale-factor=1", "--disable-features=AutomationControlled"],
  note: "Reference desktop profile; sends UA-CH high-entropy hints.",
};

/**
 * Mobile Safari on iOS 17. Safari does NOT send UA-CH, so `userAgentData` is deliberately absent
 * — injecting a brand list here would be a stronger bot signal than the phone's real fingerprint.
 * The UA is the desktop-pattern-free mobile form, the platform is the iPhone identifier, and the
 * DPR is 3 because every iPhone since the X reports 3.
 */
export const MOBILE_SAFARI_IOS17: BrowserProfilePreset = {
  id: "mobile-safari-ios17",
  label: "Mobile Safari · iOS 17",
  deviceClass: "mobile",
  browser: "safari",
  os: "ios",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
  acceptLanguage: "en-US,en;q=0.9",
  timezone: "America/New_York",
  screen: { width: 393, height: 852, availWidth: 393, availHeight: 852, devicePixelRatio: 3 },
  hardware: { hardwareConcurrency: 6, deviceMemory: 8 },
  // iOS WebKit reports a Metal-backed ANGLE renderer, not a desktop Direct3D one.
  webgl: {
    vendor: "Apple Inc.",
    renderer: "Apple GPU",
    version: "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
    shadingLanguageVersion: "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)",
  },
  tls: buildTlsFingerprintProfile("safari", 0),
  launchArgs: ["--force-device-scale-factor=3", "--enable-touch-events"],
  note: "No UA-CH brand list — iOS Safari does not send Client Hints.",
};

/**
 * Enterprise Firefox on Linux. The managed-image profile: ESR-style UA, no UA-CH, an X11 screen
 * geometry typical of a corporate laptop docked to a 16:10 panel, and the Mesa software-backed
 * GL string an enterprise image's llvmpipe fallback actually reports.
 */
export const ENTERPRISE_FIREFOX_LINUX: BrowserProfilePreset = {
  id: "enterprise-firefox-linux",
  label: "Enterprise Firefox · Linux",
  deviceClass: "desktop",
  browser: "firefox",
  os: "linux",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  platform: "Linux x86_64",
  acceptLanguage: "de-DE,de;q=0.9,en-US;q=0.7",
  timezone: "Europe/Berlin",
  screen: { width: 1680, height: 1050, availWidth: 1680, availHeight: 1027, devicePixelRatio: 1 },
  hardware: { hardwareConcurrency: 4, deviceMemory: 8 },
  webgl: {
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
    version: "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
    shadingLanguageVersion: "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)",
  },
  tls: buildTlsFingerprintProfile("firefox", 0),
  launchArgs: ["--force-device-scale-factor=1"],
  note: "Managed-image profile; no UA-CH, X11 geometry, Mesa GL.",
};

/** All presets keyed by id, for lookup by a session spec. */
export const BROWSER_PROFILE_PRESETS: Readonly<Record<ProfileId, BrowserProfilePreset>> = {
  "desktop-chrome-win11": DESKTOP_CHROME_WIN11,
  "mobile-safari-ios17": MOBILE_SAFARI_IOS17,
  "enterprise-firefox-linux": ENTERPRISE_FIREFOX_LINUX,
};

export const DEFAULT_BROWSER_PROFILE: ProfileId = "desktop-chrome-win11";

export function getBrowserProfile(id: ProfileId): BrowserProfilePreset {
  const preset = BROWSER_PROFILE_PRESETS[id];
  if (!preset) throw new Error(`Unknown browser profile preset: ${id}`);
  return preset;
}

/**
 * Cross-field consistency problems. A detector compares fields pairwise; these are the pairs that
 * most commonly expose a synthetic profile, checked here so a preset cannot ship self-contradicting.
 */
export function validateBrowserProfile(preset: BrowserProfilePreset): string[] {
  const problems: string[] = [];

  if (preset.deviceClass === "mobile" && preset.platform === "Win32") {
    problems.push("mobile preset claims a Win32 platform");
  }
  if (preset.deviceClass === "mobile" && preset.screen.devicePixelRatio < 2) {
    problems.push("mobile preset has a sub-retina devicePixelRatio");
  }
  if (preset.deviceClass === "desktop" && preset.screen.width < 1024) {
    problems.push("desktop preset has a sub-1024 screen width");
  }

  // UA-CH must be claimed at all before its contents can be consistent. A Safari or Firefox
  // preset advertising a brand list is wrong regardless of what the versions say, so this check
  // runs first and reports the structural problem rather than a downstream version mismatch.
  if (preset.userAgentData) {
    if (preset.browser === "safari" || preset.browser === "firefox") {
      problems.push(`${preset.browser} preset claims a UA-CH brand list it would not send`);
    }
  }

  if (preset.userAgentData) {
    const uaMajor = /(?:Chrome|Firefox|Version)\/(\d+)\./.exec(preset.userAgent)?.[1];
    const brandMajor = preset.userAgentData.brands
      .find((brand) => brand.brand === "Google Chrome" || brand.brand === "Chromium")
      ?.version.split(".")[0];
    if (uaMajor && brandMajor && uaMajor !== brandMajor) {
      problems.push(`UA major version ${uaMajor} disagrees with UA-CH brand version ${brandMajor}`);
    }
    if (preset.userAgentData.mobile !== (preset.deviceClass === "mobile")) {
      problems.push("UA-CH mobile flag disagrees with the preset's device class");
    }
  }

  // The TLS family must match the claimed browser.
  if (preset.tls.family !== preset.browser) {
    problems.push(
      `TLS profile family ${preset.tls.family} does not match browser ${preset.browser}`,
    );
  }

  // WebGL renderer must be plausible on the claimed OS.
  const renderer = preset.webgl.renderer ?? "";
  if (preset.os === "win32" && /OpenGL|Mesa/.test(renderer)) {
    problems.push("Windows preset claims a Mesa/OpenGL renderer");
  }
  if (preset.os === "linux" && /Direct3D/.test(renderer)) {
    problems.push("Linux preset claims a Direct3D renderer");
  }

  // Accept-Language's primary tag must agree with the timezone's region or the pair is a giveaway.
  const localeRegion = preset.acceptLanguage.split(",")[0]!.split("-")[1];
  if (localeRegion === "US" && !/America\//.test(preset.timezone)) {
    problems.push(`en-US locale paired with a non-American timezone ${preset.timezone}`);
  }

  return problems;
}

/**
 * Projects a preset onto the generator's fingerprint shape, so the same injection path serves
 * presets and generated identities.
 */
export function presetToFingerprint(
  preset: BrowserProfilePreset,
  seed: number,
): BrowserFingerprint {
  return {
    deviceClass: preset.deviceClass,
    navigator: {
      platform: preset.platform,
      hardwareConcurrency: preset.hardware.hardwareConcurrency,
      deviceMemory: preset.hardware.deviceMemory,
      languages: [preset.acceptLanguage.split(",")[0]!],
      architecture: preset.userAgentData?.architecture ?? "x86",
      bitness: preset.userAgentData?.bitness ?? "64",
      model: preset.userAgentData?.model ?? "",
      platformVersion: preset.userAgentData?.platformVersion ?? "15.0.0",
      uaFullVersion: preset.userAgentData?.uaFullVersion ?? "131.0.6778.86",
      brands: preset.userAgentData?.brands ?? [],
    },
    screen: preset.screen,
    webgl: preset.webgl,
    timezone: preset.timezone,
    seed,
  };
}
