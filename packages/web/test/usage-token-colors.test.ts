/**
 * The Token bucket palette's non-text contrast (WCAG 2.2 SC 1.4.11), checked
 * instead of asserted: the numbers in token-colors' header comment are produced
 * by the same WCAG relative-luminance formula this file implements, so a palette
 * edit that quietly drops a swatch below 3:1 fails here rather than shipping.
 *
 * The two backgrounds are the ones the cost center's chart cards declare —
 * `bg-white`, and `dark:bg-gray-900`, which is **#0d0d0d** and not #111827
 * because styles.css overrides the neutral gray scale inside `.dark`.
 *
 * The cache-hit-rate curve lives on the same card but is named as Tailwind
 * classes rather than a hex, so it is read back out of its source and resolved
 * through the amber scale. That is a text check by nature: it pins the shades
 * that were audited, and changing HIT_RATE_TEXT / HIT_RATE_SWATCH fails it until
 * the new shades are measured here too.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TOKEN_CARD_BG,
  TOKEN_COLOR_THEMES,
  TOKEN_COLORS,
  tokenColors,
  type TokenBucketName,
} from "../src/lib/token-colors";

/** WCAG 2.x relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const BUCKETS: TokenBucketName[] = ["cacheRead", "cacheWrite", "output"];
/** SC 1.4.11 asks 3:1 for a graphical object needed to understand the content. */
const MIN_RATIO = 3;

/** Tailwind's amber scale (the only shades the hit-rate curve is allowed to name). */
const AMBER: Record<string, string> = {
  300: "#fcd34d",
  400: "#fbbf24",
  500: "#f59e0b",
  600: "#d97706",
  700: "#b45309",
  800: "#92400e",
};

function chartsSource(): string {
  return readFileSync(
    fileURLToPath(new URL("../src/features/usage/usage-charts.tsx", import.meta.url)),
    "utf8",
  );
}

/** The `text-amber-N` / `bg-amber-N` shades a `dark:`-paired class string names, in order (light, dark). */
function amberShades(className: string): [string, string] {
  const shades = [...className.matchAll(/(?:text|bg)-amber-(\d{3})/g)].map((m) => m[1]!);
  expect(shades, `expected one light and one dark amber in "${className}"`).toHaveLength(2);
  return [AMBER[shades[0]!]!, AMBER[shades[1]!]!];
}

describe("token palette non-text contrast", () => {
  it("every bucket clears 3:1 against the card it is drawn on, in the theme it is drawn in", () => {
    for (const bucket of BUCKETS) {
      expect(
        contrast(TOKEN_COLOR_THEMES[bucket].light, TOKEN_CARD_BG.light),
        `${bucket} light`,
      ).toBeGreaterThanOrEqual(MIN_RATIO);
      expect(
        contrast(TOKEN_COLOR_THEMES[bucket].dark, TOKEN_CARD_BG.dark),
        `${bucket} dark`,
      ).toBeGreaterThanOrEqual(MIN_RATIO);
    }
  });

  it("the flat theme-blind map is legible on BOTH cards, so the donut that reads it cannot fail in either theme", () => {
    for (const bucket of BUCKETS) {
      expect(
        contrast(TOKEN_COLORS[bucket], TOKEN_CARD_BG.light),
        `${bucket} flat vs white`,
      ).toBeGreaterThanOrEqual(MIN_RATIO);
      expect(
        contrast(TOKEN_COLORS[bucket], TOKEN_CARD_BG.dark),
        `${bucket} flat vs dark`,
      ).toBeGreaterThanOrEqual(MIN_RATIO);
    }
  });

  it("tokenColors(dark) picks each theme's own hex, and the flat map is the light half of it", () => {
    expect(tokenColors(false)).toEqual(TOKEN_COLORS);
    expect(tokenColors(true)).toEqual({
      cacheRead: TOKEN_COLOR_THEMES.cacheRead.dark,
      cacheWrite: TOKEN_COLOR_THEMES.cacheWrite.dark,
      output: TOKEN_COLOR_THEMES.output.dark,
    });
  });

  it("keeps 'cacheRead lightest / cacheWrite mid / output darkest' inside each theme — the meaning the file exists for", () => {
    for (const theme of ["light", "dark"] as const) {
      const [read, write, output] = BUCKETS.map((b) => luminance(TOKEN_COLOR_THEMES[b][theme])) as [
        number,
        number,
        number,
      ];
      expect(read, `cacheRead is the lightest in ${theme}`).toBeGreaterThan(write);
      expect(write, `cacheWrite is between in ${theme}`).toBeGreaterThan(output);
    }
  });

  it("keeps adjacent stack segments 1.25:1 apart in luminance, so a segment's edge is visible inside one bar", () => {
    for (const theme of ["light", "dark"] as const) {
      const [read, write, output] = BUCKETS.map((b) => luminance(TOKEN_COLOR_THEMES[b][theme])) as [
        number,
        number,
        number,
      ];
      // The stack runs bottom-up output → cacheWrite → cacheRead, so these are the two boundaries a reader has to see.
      expect(read / write, `cacheRead vs cacheWrite in ${theme}`).toBeGreaterThanOrEqual(1.25);
      expect(write / output, `cacheWrite vs output in ${theme}`).toBeGreaterThanOrEqual(1.25);
    }
  });
});

describe("cache-hit-rate curve contrast", () => {
  const source = chartsSource();

  it.each([
    ["HIT_RATE_TEXT", /const HIT_RATE_TEXT = "([^"]+)"/],
    ["HIT_RATE_SWATCH", /const HIT_RATE_SWATCH = "([^"]+)"/],
  ])("%s clears 3:1 on the card in each theme it is paired for", (_name, pattern) => {
    const match = source.match(pattern);
    expect(match, "the constant must exist with a plain class string").not.toBeNull();
    const [light, dark] = amberShades(match![1]!);
    expect(contrast(light, TOKEN_CARD_BG.light), `hit rate light on white`).toBeGreaterThanOrEqual(
      MIN_RATIO,
    );
    expect(contrast(dark, TOKEN_CARD_BG.dark), `hit rate dark on #0d0d0d`).toBeGreaterThanOrEqual(
      MIN_RATIO,
    );
  });

  it("the curve and its legend swatch name the same pair, so a legend item and the line it names are the same color", () => {
    const shades = (name: string) => source.match(new RegExp(`const ${name} = "([^"]+)"`))![1]!;
    // Both halves: the light and the dark shade, not just the one that reads first.
    const asSwatch = shades("HIT_RATE_TEXT").replaceAll("text-", "bg-");
    expect(shades("HIT_RATE_SWATCH")).toBe(asSwatch);
  });
});
