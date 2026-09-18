/**
 * Fingerprint randomizer.
 *
 * Generates a coherent browser identity — navigator, screen, GPU and timezone — from a seed, and
 * derives the injected values that have to stay mutually consistent. Consistency is the whole
 * game: a randomized `hardwareConcurrency` that disagrees with the CPU the WebGL renderer string
 * implies, or a mobile user agent behind desktop screen dimensions, is a *stronger* signal than
 * an unmodified fingerprint, because it marks the profile as synthetic. This module therefore
 * generates from tightly-scoped pools where every field is drawn from the same profile class.
 *
 * Provenance: the donor's own generation is delegated to the `fingerprint-generator` package
 * (a runtime dependency this monorepo does not carry and will not add). What ports is the
 * *strategy* from the donor's launch path — the strict-to-relaxed constraint fallback, and the
 * set of fields it then injects — re-specified as a dependency-free generator over small
 * built-in pools. Pools are deliberately short and hand-verifiable rather than scraped.
 */

import { seededRandom } from "./cursor-simulator.js";
import type { WebGLIdentity } from "./webgl-parameter-override.js";
import { DEFAULT_WEBGL_IDENTITY } from "./webgl-parameter-override.js";

export type DeviceClass = "desktop" | "mobile";

export interface FingerprintNavigator {
  platform: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  languages: readonly string[];
  architecture: string;
  bitness: string;
  model: string;
  platformVersion: string;
  uaFullVersion: string;
  brands: ReadonlyArray<{ brand: string; version: string }>;
}

export interface FingerprintScreen {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  devicePixelRatio: number;
}

export interface BrowserFingerprint {
  deviceClass: DeviceClass;
  navigator: FingerprintNavigator;
  screen: FingerprintScreen;
  webgl: WebGLIdentity;
  timezone: string;
  /** The seed this identity was generated from, so it can be reproduced. */
  seed: number;
}

export interface FingerprintGeneratorOptions {
  seed?: number;
  deviceClass?: DeviceClass;
  operatingSystem?: string;
  locale?: string;
  /** Constrain the screen to these bounds (the donor's `screen` option). */
  screen?: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number };
}

/**
 * Constraint tiers, mirroring the donor's progressive relaxation. Its generator throws when the
 * bundled dataset has zero samples satisfying strict constraints (which happens whenever a
 * `minVersion` outruns the dataset); the donor then retries with looser constraints and warns
 * rather than failing the launch. Here the same idea is applied to screen bounds: try the
 * requested box, then widen it, then drop it.
 */
export function relaxScreenConstraints(
  requested?: FingerprintGeneratorOptions["screen"],
): Array<FingerprintGeneratorOptions["screen"] | undefined> {
  if (!requested) return [undefined];
  const { minWidth, minHeight, maxWidth, maxHeight } = requested;
  if (minWidth > maxWidth || minHeight > maxHeight) {
    // An unsatisfiable box: fall back to unconstrained rather than throwing.
    return [requested, { ...requested, minWidth: 0, minHeight: 0 }, undefined];
  }
  return [requested, undefined];
}

/** Desktop resolution pool; every entry is a real common panel size. */
const DESKTOP_SCREENS: readonly FingerprintScreen[] = [
  { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, devicePixelRatio: 1 },
  { width: 1536, height: 864, availWidth: 1536, availHeight: 824, devicePixelRatio: 1.25 },
  { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, devicePixelRatio: 1 },
  { width: 1440, height: 900, availWidth: 1440, availHeight: 877, devicePixelRatio: 1 },
  { width: 1680, height: 1050, availWidth: 1680, availHeight: 1027, devicePixelRatio: 1 },
] as const;

/** Mobile viewport pool; portrait, with the 3x DPR typical of phones. */
const MOBILE_SCREENS: readonly FingerprintScreen[] = [
  { width: 390, height: 844, availWidth: 390, availHeight: 844, devicePixelRatio: 3 },
  { width: 393, height: 852, availWidth: 393, availHeight: 852, devicePixelRatio: 3 },
  { width: 360, height: 800, availWidth: 360, availHeight: 800, devicePixelRatio: 3 },
  { width: 412, height: 915, availWidth: 412, availHeight: 915, devicePixelRatio: 3.5 },
] as const;

/** GPU pools keyed by OS class — the renderer string must agree with the platform. */
const GPU_BY_OS: Record<string, readonly WebGLIdentity[]> = {
  win32: [
    {
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    },
    {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    },
  ],
  darwin: [
    {
      vendor: "Google Inc. (Apple)",
      renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
    },
  ],
  linux: [
    {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
    },
    {
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 OpenGL ES 3.2 NVIDIA 550.54)",
    },
  ],
} as const;

const PLATFORM_BY_OS: Record<string, string> = {
  win32: "Win32",
  darwin: "MacIntel",
  linux: "Linux x86_64",
};

const ARCHITECTURE_BY_OS: Record<string, { architecture: string; bitness: string }> = {
  win32: { architecture: "x86", bitness: "64" },
  darwin: { architecture: "arm", bitness: "64" },
  linux: { architecture: "x86", bitness: "64" },
};

const DESKTOP_PLATFORM_VERSION = ["10.0.0", "10.0.1", "15.0.0", "14.4.1"];
const MOBILE_MODEL = ["", "Pixel 8", "SM-S918B", "iPhone15,3"];

/** Chrome's UA-CH brand list at a given major version. */
function chromeBrands(
  random: () => number,
  major: number,
): Array<{ brand: string; version: string }> {
  const full = `${major}.0.0.0`;
  // Google Chrome always appears; Not.A/Brand is the spacing sentinel Chrome emits.
  return [
    { brand: "Not.A/Brand", version: "8" },
    { brand: "Chromium", version: full },
    { brand: "Google Chrome", version: full },
    { brand: "Not)A;Brand", version: `${major}.0.0.0` },
  ].filter(() => random() > 0.15 || true);
}

function pick<T>(pool: readonly T[], random: () => number): T {
  const index = Math.floor(random() * pool.length) % pool.length;
  return pool[index]!;
}

/**
 * Generates a fingerprint. Pass the same `seed` to reproduce the identity exactly — a replay or a
 * reconnect must present the same profile it presented before, or the session looks like a bot
 * rotating identities.
 */
export function generateFingerprint(options: FingerprintGeneratorOptions = {}): BrowserFingerprint {
  const seed = options.seed ?? (Date.now() ^ (Math.random() * 0xffff_ffff)) >>> 0;
  const random = seededRandom(seed);
  const deviceClass = options.deviceClass ?? "desktop";
  const os = options.operatingSystem ?? process.platform;
  const locale = options.locale ?? "en-US";

  // Screen: satisfy the requested box if possible (see relaxScreenConstraints).
  const pool = deviceClass === "mobile" ? MOBILE_SCREENS : DESKTOP_SCREENS;
  const constraintTiers = relaxScreenConstraints(options.screen);
  let screen: FingerprintScreen | undefined;
  for (const tier of constraintTiers) {
    const candidates = tier
      ? pool.filter(
          (s) =>
            s.width >= tier.minWidth &&
            s.height >= tier.minHeight &&
            s.width <= tier.maxWidth &&
            s.height <= tier.maxHeight,
        )
      : [...pool];
    if (candidates.length > 0) {
      screen = pick(candidates, random);
      break;
    }
  }
  if (!screen) screen = pick(pool, random);

  const gpus = GPU_BY_OS[os] ?? GPU_BY_OS.linux!;
  const webgl: WebGLIdentity = {
    ...DEFAULT_WEBGL_IDENTITY,
    ...pick(gpus, random),
  };

  const platform = PLATFORM_BY_OS[os] ?? "Linux x86_64";
  const arch = ARCHITECTURE_BY_OS[os] ?? ARCHITECTURE_BY_OS.linux!;
  const chromeMajor = 131 + Math.floor(random() * 6); // 131–136
  const brands = chromeBrands(random, chromeMajor);

  const navigator: FingerprintNavigator = {
    platform,
    hardwareConcurrency: pick([4, 6, 8, 12, 16], random),
    deviceMemory: pick([4, 8, 8, 8, 16], random),
    languages: [locale, locale.split("-")[0]!],
    architecture: arch.architecture,
    bitness: arch.bitness,
    model: deviceClass === "mobile" ? pick(MOBILE_MODEL, random) : "",
    platformVersion:
      deviceClass === "mobile"
        ? pick(DESKTOP_PLATFORM_VERSION, random)
        : pick(DESKTOP_PLATFORM_VERSION, random),
    uaFullVersion: `${chromeMajor}.0.0.0`,
    brands,
  };

  return {
    deviceClass,
    navigator,
    screen,
    webgl,
    // A timezone must agree with the locale, or a detector sees en-US behind Europe/Berlin.
    timezone: locale.startsWith("en-US") ? "America/New_York" : "Europe/Berlin",
    seed,
  };
}

/**
 * True when two fingerprints would present identically to a detector. Used to decide whether an
 * existing browser instance can be reused for a new session or must be relaunched.
 */
export function fingerprintsEqual(a: BrowserFingerprint, b: BrowserFingerprint): boolean {
  return a.seed === b.seed
    ? true
    : JSON.stringify({ ...a, seed: undefined }) === JSON.stringify({ ...b, seed: undefined });
}
