/**
 * Colors for token buckets (the same blue hue family), used by the cost
 * center's stacked chart and the trace observation's component bars — keeping
 * "cacheRead lightest / cacheWrite mid / output darkest" as one consistent
 * meaning site-wide.
 *
 * **One hex per theme, not one hex for both.** WCAG 1.4.11 (Non-text Contrast)
 * asks 3:1 between a graphical object and the background it has to be read
 * against, and these are the fills of stacked bars, a hover bubble's swatches
 * and a legend's swatches — all sitting on the chart card. A single value
 * cannot serve both themes: 3:1 against white caps relative luminance at 0.30,
 * while 3:1 against the dark card needs at least 0.1121, and the old palette sat
 * on the wrong side of the first bar in light mode.
 *
 * The arithmetic (WCAG 2.x relative luminance, computed rather than eyeballed;
 * `test/usage-token-colors.test.ts` re-checks every one of these numbers):
 *   L = 0.2126·R + 0.7152·G + 0.0722·B, each channel c = c/12.92 when
 *   c ≤ 0.04045 else ((c + 0.055)/1.055)^2.4;  ratio = (L1+0.05)/(L2+0.05).
 *   L(#ffffff) = 1.0000  →  3:1 needs L ≤ 0.3000
 *   L(#0d0d0d) = 0.0040  →  3:1 needs L ≥ 0.1121
 * The card backgrounds are the ones the cost center declares: `bg-white`, and
 * `dark:bg-gray-900` — which is **#0d0d0d**, not #111827, because styles.css
 * overrides the whole neutral gray scale inside `.dark`.
 *
 *   bucket      light      L       vs white    dark       L       vs #0d0d0d
 *   cacheRead   #0b93d9    0.2595  3.39:1      #bae6fd   0.7412  14.65:1
 *   cacheWrite  #0380b4    0.1875  4.42:1      #38bdf8   0.4401   9.07:1
 *   output      #036ba4    0.1322  5.76:1      #0284c7   0.2064   4.75:1
 *
 * Lightness ordering (the meaning) is preserved inside each theme, and so is the
 * stack order that reads from it (darkest at the bottom, chart-geom's
 * STACK_ORDER). The dark trio keeps today's perceptual spacing between adjacent
 * segments (1.68:1 and 2.13:1 in relative luminance, against 1.66:1 / 2.16:1
 * before); the light trio is necessarily tighter (1.38:1 / 1.42:1) because the
 * 0.30 luminance ceiling leaves only that much room to spread three steps in.
 */

/** The three token buckets the palette names — the keys of every map below. */
export type TokenBucketName = "cacheRead" | "cacheWrite" | "output";

/** A bucket's color in each theme. Select with tokenColors(dark), never by hand. */
export interface TokenColorPair {
  light: string;
  dark: string;
}

/** The card the chart colors are read against, in each theme (see the header). */
export const TOKEN_CARD_BG = { light: "#ffffff", dark: "#0d0d0d" } as const;

/** The theme-aware palette: one pair per bucket. Resolve it with tokenColors(). */
export const TOKEN_COLOR_THEMES: Record<TokenBucketName, TokenColorPair> = {
  cacheRead: { light: "#0b93d9", dark: "#bae6fd" },
  cacheWrite: { light: "#0380b4", dark: "#38bdf8" },
  output: { light: "#036ba4", dark: "#0284c7" },
};

/** The three colors for one resolved theme, as a plain lookup by bucket. */
export function tokenColors(dark: boolean): Record<TokenBucketName, string> {
  return {
    cacheRead: dark ? TOKEN_COLOR_THEMES.cacheRead.dark : TOKEN_COLOR_THEMES.cacheRead.light,
    cacheWrite: dark ? TOKEN_COLOR_THEMES.cacheWrite.dark : TOKEN_COLOR_THEMES.cacheWrite.light,
    output: dark ? TOKEN_COLOR_THEMES.output.dark : TOKEN_COLOR_THEMES.output.light,
  };
}

/**
 * The light values, as a flat string map.
 *
 * This is the palette for callers that cannot see the theme — `TokenDonut` in
 * components/ui, which draws these straight into SVG `stroke` attributes. So
 * the light values are deliberately also legible on the dark card (every one is
 * ≥ 3:1 on #0d0d0d as well as on white, see the table above), which is what
 * keeps that theme-blind caller correct in both themes rather than merely
 * acceptable in one. Charts that can read the theme should call tokenColors()
 * instead; this map stays only so that one caller keeps working.
 */
export const TOKEN_COLORS: Record<TokenBucketName, string> = {
  cacheRead: TOKEN_COLOR_THEMES.cacheRead.light,
  cacheWrite: TOKEN_COLOR_THEMES.cacheWrite.light,
  output: TOKEN_COLOR_THEMES.output.light,
};
