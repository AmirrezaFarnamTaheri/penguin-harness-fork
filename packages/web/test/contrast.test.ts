/**
 * F8 — the contrast primitives, and the app's own measured color sites.
 *
 * Two kinds of case live here, deliberately separated:
 *
 *   1. **Primitives**: parsing, luminance, alpha compositing and the requirement table. These are
 *      pure arithmetic with hand-checkable values.
 *   2. **Sites**: the colors this app actually paints, measured against the background each one is
 *      painted on. Every row states its role, so a failure message says which criterion it broke.
 *      The two code-gutter rows were below the floor when this test was written (2.54:1 and
 *      2.78:1) and are pinned at their fixed values; the accompanying source check re-reads
 *      styles.css so a revert fails here rather than shipping.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composite,
  contrastRatio,
  describeContrast,
  evaluateContrast,
  parseColor,
  relativeLuminance,
  requiredRatio,
  toHex,
  type ContrastRole,
} from "../src/lib/contrast.js";
import { TOKEN_CARD_BG, TOKEN_COLOR_THEMES, tokenColors } from "../src/lib/token-colors.js";

const stylesCss = readFileSync(
  fileURLToPath(new URL("../src/styles.css", import.meta.url)),
  "utf8",
);

describe("contrast primitives (F8.2)", () => {
  it("parses the supported spellings and refuses everything else", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0d0d0d")).toEqual({ r: 13, g: 13, b: 13, a: 1 });
    expect(parseColor("#00000080")).toEqual({ r: 0, g: 0, b: 0, a: 128 / 255 });
    expect(parseColor("rgb(107, 114, 128)")).toEqual({ r: 107, g: 114, b: 128, a: 1 });
    expect(parseColor("rgba(107 114 128 / 0.4)")).toEqual({ r: 107, g: 114, b: 128, a: 0.4 });
    expect(parseColor("rgb(50%, 50%, 50%)")).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
      a: 1,
    });
    // Refusals: the caller must decide, never this module.
    for (const bad of [
      "",
      "gray",
      "#12345",
      "#gggggg",
      "rgb(300,0,0)",
      "rgba(1,2,3,2)",
      "hsl(0 0% 0%)",
    ])
      expect(parseColor(bad), bad).toBeNull();
  });

  it("computes WCAG relative luminance of the anchors", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 6);
    expect(relativeLuminance("#0d0d0d")!).toBeLessThan(0.005);
    // A translucent color has no luminance of its own — it must be composited first.
    expect(relativeLuminance("rgba(0,0,0,0.5)")).toBeNull();
  });

  it("composites alpha the way a browser paints it", () => {
    const blended = composite(parseColor("rgba(0, 0, 0, 0.5)")!, parseColor("#ffffff")!);
    expect(toHex(blended)).toBe("#808080");
    // The historical focus ring: gray-500 at 40% over white. This is the composite whose ratio
    // (1.70:1) nobody computed before the fix, which is why the old ring shipped.
    const ring = composite(parseColor("rgba(107, 114, 128, 0.4)")!, parseColor("#ffffff")!);
    expect(toHex(ring)).toBe("#c4c7cc");
    expect(contrastRatio(ring, "#ffffff")!).toBeCloseTo(1.7, 1);
    expect(evaluateContrast("rgba(107,114,128,0.4)", "#ffffff", "focus-ring").passes).toBe(false);
  });

  it("keeps alpha colors measured against what they are painted over", () => {
    // A 50% black scrim is a different color on each theme, and its contrast against the surface
    // it darkens says how visible the scrim itself is.
    const overLight = contrastRatio("rgba(0,0,0,0.5)", "#ffffff");
    const overDark = contrastRatio("rgba(0,0,0,0.5)", "#0d0d0d");
    expect(overLight).toBeCloseTo(3.95, 1); // #808080 on white: a clearly visible scrim
    // …and on the near-black dark card the same scrim changes almost nothing (1.04:1). That is
    // the honest measurement: the dark theme cannot rely on scrims for separation, which is why
    // its muted text carries its own contrast instead of being dimmed.
    expect(overDark).toBeCloseTo(1.04, 1);
    // Explicit base: white text on a 50% black scrim over white is white on #808080.
    expect(contrastRatio("#ffffff", "rgba(0,0,0,0.5)", "#ffffff")).toBeCloseTo(3.95, 1);
  });

  it("applies the requirement table, with disabled controls explicitly exempt", () => {
    expect(requiredRatio("text")).toBe(4.5);
    expect(requiredRatio("large-text")).toBe(3);
    expect(requiredRatio("icon")).toBe(3);
    expect(requiredRatio("focus-ring")).toBe(3);
    expect(requiredRatio("chart-fill")).toBe(3);
    // Not "0", not "passes": not applicable. A disabled-state claim has to say which it is.
    expect(requiredRatio("disabled-text")).toBeNull();
    const disabled = evaluateContrast("#9ca3af", "#ffffff", "disabled-text");
    expect(disabled.passes).toBeNull();
    expect(disabled.ratio).not.toBeNull();
  });

  it("reports unparseable input as unmeasurable rather than as zero", () => {
    const verdict = evaluateContrast("currentColor", "#ffffff", "text");
    expect(verdict.ratio).toBeNull();
    expect(verdict.passes).toBeNull();
    expect(describeContrast(verdict)).toContain("unparseable");
  });

  it("describes a verdict in one line, for failure messages", () => {
    expect(describeContrast(evaluateContrast("#ffffff", "#ffffff", "text"))).toBe(
      "text: #ffffff on #ffffff = 1.00:1, needs 4.5:1 → FAIL",
    );
  });
});

describe("measured color sites (F8.1/F8.3)", () => {
  /** [name, foreground, background, role, expected minimum ratio] */
  const SITES: [string, string, string, ContrastRole, number][] = [
    // Body and message text.
    ["body text, light", "#111827", "#ffffff", "text", 4.5],
    ["body text, dark", "#f3f4f6", "#000000", "text", 4.5],
    ["secondary text, light (gray-600)", "#4b5563", "#ffffff", "text", 4.5],
    ["secondary text, dark (gray-400 on gray-950)", "#9ca3af", "#000000", "text", 4.5],
    ["muted label, light (gray-500)", "#6b7280", "#ffffff", "text", 4.5],
    // The two measured failures, at their fixed values (see the source check below).
    ["code gutter line numbers, light (gray-500 on white)", "#6b7280", "#ffffff", "text", 4.5],
    ["code gutter line numbers, dark (gray-400 on gray-950)", "#9ca3af", "#000000", "text", 4.5],
    // Non-text: focus ring and the token chart fills.
    ["focus ring, light accent", "#111827", "#ffffff", "focus-ring", 3],
    ["focus ring, dark accent", "#f3f4f6", "#000000", "focus-ring", 3],
  ];

  it.each(SITES)("%s", (_name, fg, bg, role, minimum) => {
    const verdict = evaluateContrast(fg, bg, role);
    expect(verdict.ratio, describeContrast(verdict)).not.toBeNull();
    expect(verdict.ratio!, describeContrast(verdict)).toBeGreaterThanOrEqual(minimum);
  });

  it("keeps the token palette's chart fills above 3:1 in both themes", () => {
    for (const dark of [false, true]) {
      const colors = tokenColors(dark);
      const background = dark ? TOKEN_CARD_BG.dark : TOKEN_CARD_BG.light;
      for (const [bucket, color] of Object.entries(colors)) {
        const verdict = evaluateContrast(color, background, "chart-fill");
        expect(
          verdict.passes,
          `${bucket} ${dark ? "dark" : "light"}: ${describeContrast(verdict)}`,
        ).toBe(true);
      }
    }
    // The legacy single-hex map still resolves through the themed pairs, not around them.
    expect(TOKEN_COLOR_THEMES.output.light).toBe(tokenColors(false).output);
  });

  it("pins the fixed code-gutter colors in the stylesheet, so a revert fails here", () => {
    const gutterLight = /\.code-lines \.line::before\s*\{[^}]*@apply bg-white text-gray-(\d+)/.exec(
      stylesCss,
    );
    const gutterDark =
      /html\.dark \.code-lines \.line::before\s*\{[^}]*@apply bg-gray-950 text-gray-(\d+)/.exec(
        stylesCss,
      );
    expect(gutterLight, "light gutter rule present").not.toBeNull();
    expect(gutterDark, "dark gutter rule present").not.toBeNull();
    // gray-400 on white was 2.54:1; gray-500 is 4.83:1.
    expect(gutterLight![1]).toBe("500");
    // gray-600 on the pure-black dark base was 2.78:1; gray-400 is 8.27:1.
    expect(gutterDark![1]).toBe("400");
  });

  it("records the disabled-state exemption for the app's disabled buttons", () => {
    // Disabled controls are exempt (1.4.3/1.4.11). The measurement is still taken and recorded so
    // the exemption is a decision with numbers attached, not an untested claim.
    const disabled = evaluateContrast("#9ca3af", "#f3f4f6", "disabled-text");
    expect(disabled.ratio!).toBeGreaterThan(1);
    expect(disabled.passes).toBeNull();
  });
});
