import { describe, expect, it } from "vitest";
import {
  CANVAS_THEMES,
  NAMED_COLORS,
  TERMINAL_PALETTES,
  clamp255,
  contrastRatio,
  expandHex,
  hexLuminance,
  hexToHsb,
  hexToHsl,
  hexToHsv,
  hexToRgb,
  hexToU32Argb,
  hsbToHex,
  hsbToRgb,
  hslToCss,
  hslToHex,
  hslToHsv,
  hslToRgb,
  hsvToHex,
  hsvToHsl,
  hsvToRgb,
  isHex,
  isValidColorString,
  mixRgb,
  parseColor,
  prependHash,
  readableForeground,
  relativeLuminance,
  rgbToCss,
  rgbToHex,
  rgbToHsb,
  rgbToHsl,
  rgbToHsv,
  wcagLevels,
  withAlpha,
} from "../../src/canvas/color-space";

describe("color space", () => {
  it("expands shorthand hex and manages the hash", () => {
    expect(expandHex("#abc")).toBe("#aabbcc");
    expect(expandHex("#abcd")).toBe("#aabbccdd");
    expect(expandHex("#AbCdEf")).toBe("#abcdef");
    expect(expandHex("aabbcc")).toBe("#aabbcc");
    expect(isHex("#aabbcc")).toBe(true);
    expect(isHex("#abc")).toBe(true);
    expect(isHex("#aabbccdd")).toBe(true);
    // Five digits, no hash and malformed input are not hex.
    expect(isHex("#aabbc")).toBe(false);
    expect(isHex("aabbcc")).toBe(false);
    expect(isHex("#gggggg")).toBe(false);
    expect(prependHash("aabbcc")).toBe("#aabbcc");
    expect(prependHash("#aabbcc")).toBe("#aabbcc");
  });

  it("converts hex to rgb and back", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#f00")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb("#0000ff")).toEqual({ r: 0, g: 0, b: 255 });
    // 8-digit hex carries alpha in the low byte.
    expect(hexToRgb("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 0x80 / 255 });
    expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe("#ff0000");
    expect(rgbToHex({ r: 255, g: 0, b: 0, a: 0.5 })).toBe("#ff000080");
    // Out-of-range channels clamp, not wrap.
    expect(rgbToHex({ r: -10, g: 999, b: 0 })).toBe("#00ff00");
  });

  it("round-trips hex through rgb", () => {
    for (const hex of ["#000000", "#ffffff", "#3366aa", "#f0c674"]) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it("computes perceptual luminance", () => {
    // White is fully luminous, black not at all.
    expect(hexLuminance("#ffffff")).toBeCloseTo(Math.sqrt(255));
    expect(hexLuminance("#000000")).toBeCloseTo(0);
    // Green dominates the weighted sum.
    expect(hexLuminance("#00ff00")).toBeGreaterThan(hexLuminance("#0000ff"));
  });

  it("converts rgb to hsv and back", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 255 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 1, v: 255 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 255 });
    // Greys have no hue and no saturation.
    expect(rgbToHsv({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, v: 128 });
    // The hue wraps into [0, 360) for negative intermediate angles.
    expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBeCloseTo(240);
    for (const rgb of [
      { r: 255, g: 0, b: 0 },
      { r: 10, g: 200, b: 47 },
      { r: 90, g: 90, b: 200 },
    ]) {
      expect(hsvToRgb(rgbToHsv(rgb))).toEqual(rgb);
    }
    // Zero saturation maps any hue to a flat grey.
    expect(hsvToRgb({ h: 200, s: 0, v: 100 })).toEqual({ r: 100, g: 100, b: 100 });
  });

  it("converts rgb to hsl and back", () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, l: 0 });
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, l: 1 });
    for (const rgb of [
      { r: 255, g: 128, b: 0 },
      { r: 30, g: 90, b: 170 },
      { r: 200, g: 200, b: 40 },
    ]) {
      const round = hslToRgb(rgbToHsl(rgb));
      expect(round.r).toBeCloseTo(rgb.r);
      expect(round.g).toBeCloseTo(rgb.g);
      expect(round.b).toBeCloseTo(rgb.b);
    }
    // Zero saturation maps any hue to the lightness as a grey.
    expect(hslToRgb({ h: 120, s: 0, l: 0.4 }).r).toBeCloseTo(102);
  });

  it("bridges hsv and hsl", () => {
    const red = { r: 255, g: 0, b: 0 };
    expect(hsvToHsl(rgbToHsv(red))).toEqual(rgbToHsl(red));
    expect(hslToHsv(rgbToHsl(red))).toEqual(rgbToHsv(red));
  });

  it("treats hsb as hsv with a 0-100 brightness", () => {
    expect(rgbToHsb({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, b: 100 });
    expect(rgbToHsb({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, b: 100 * (128 / 255) });
    expect(hsbToRgb({ h: 0, s: 1, b: 100 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsbToHex({ h: 120, s: 1, b: 100 })).toBe("#00ff00");
    expect(hexToHsb("#ff0000")).toEqual({ h: 0, s: 1, b: 100 });
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 255 });
    expect(hexToHsl("#ff0000")).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(hsvToHex({ h: 240, s: 1, v: 255 })).toBe("#0000ff");
    expect(hslToHex({ h: 120, s: 1, l: 0.5 })).toBe("#00ff00");
  });

  it("parses css colour strings", () => {
    expect(parseColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("rgba(255, 0, 0, 0.5)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("hsla(0, 100%, 50%, 0.25)")).toMatchObject({ a: 0.25 });
    // Named colours resolve case-insensitively after trimming.
    expect(parseColor("  Red ")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("RED")).toEqual({ r: 255, g: 0, b: 0 });
    // Unparseable input yields null, not a throw.
    expect(parseColor("not a colour")).toBeNull();
    expect(parseColor("rgb(300, 0, 0)")).toBeNull();
    expect(parseColor("#aabbc")).toBeNull();
    expect(isValidColorString("#00ff00")).toBe(true);
    expect(isValidColorString("nope")).toBe(false);
  });

  it("packs colours for the gpu renderer", () => {
    // `>>> 0` keeps the high alpha bit unsigned.
    expect(hexToU32Argb("#ff0000", 1)).toBe(0xffff0000);
    expect(hexToU32Argb("#ff0000")).toBe(0xffff0000);
    expect(hexToU32Argb("#ff0000", 0)).toBe(0x00ff0000);
    expect(hexToU32Argb("#000000", 0.5)).toBe(0x80000000);
  });

  it("clamps channels", () => {
    expect(clamp255(-5)).toBe(0);
    expect(clamp255(300)).toBe(255);
    expect(clamp255(128)).toBe(128);
    // clamp01 is asserted in vector-primitives.test.ts — it lives there next to `clamp`,
    // and color-space now imports it rather than re-defining a duplicate export.
  });

  it("emits css strings", () => {
    expect(rgbToCss({ r: 255, g: 0, b: 0 })).toBe("rgb(255, 0, 0)");
    expect(rgbToCss({ r: 255, g: 0, b: 0, a: 0.5 })).toBe("rgba(255, 0, 0, 0.5)");
    expect(hslToCss({ h: 0, s: 1, l: 0.5 })).toBe("hsl(0, 100%, 50%)");
    expect(hslToCss({ h: 0, s: 1, l: 0.5, a: 0.25 })).toBe("hsla(0, 100%, 50%, 0.25)");
  });

  it("computes wcag contrast", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21);
    expect(contrastRatio({ r: 128, g: 128, b: 128 }, { r: 128, g: 128, b: 128 })).toBeCloseTo(1);
    const blackOnWhite = wcagLevels({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    expect(blackOnWhite).toEqual({ aa: true, aaa: true, aaLarge: true, aaaLarge: true });
    // Grey on white passes AA-large text but not AAA body text.
    const greyOnWhite = wcagLevels({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 });
    expect(greyOnWhite.aaLarge).toBe(true);
    expect(greyOnWhite.aaa).toBe(false);
  });

  it("picks a readable foreground and mixes colours", () => {
    expect(readableForeground({ r: 255, g: 255, b: 255 })).toBe("#000000");
    expect(readableForeground({ r: 0, g: 0, b: 0 })).toBe("#ffffff");
    const mid = mixRgb({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
    expect(mid.r).toBeCloseTo(127.5);
    expect(mid.g).toBeCloseTo(127.5);
    expect(mid.b).toBeCloseTo(127.5);
    // `t` outside [0, 1] clamps rather than extrapolating.
    expect(mixRgb({ r: 0, g: 0, b: 0 }, { r: 255, g: 0, b: 0 }, 5)).toEqual({ r: 255, g: 0, b: 0 });
    expect(withAlpha({ r: 10, g: 20, b: 30, a: 0.5 }, 0.5)!.a).toBeCloseTo(0.25);
    expect(withAlpha({ r: 10, g: 20, b: 30 }, 0.5)!.a).toBeCloseTo(0.5);
  });

  it("ships named colours and terminal/canvas palettes", () => {
    expect(NAMED_COLORS.red).toBe("#ff0000");
    expect(NAMED_COLORS["lightslategray"]).toBe("#778899");
    expect(Object.keys(NAMED_COLORS).length).toBeGreaterThan(140);
    expect(() => {
      // The table is frozen; theme overrides are not allowed.
      (NAMED_COLORS as Record<string, string>).red = "#0000ff";
    }).toThrow();
    expect(TERMINAL_PALETTES.alacritty!.background).toBe("#1d1f21");
    expect(TERMINAL_PALETTES.alacritty!.foreground).toBe("#c5c8c6");
    expect(TERMINAL_PALETTES.dracula!.red).toBe("#ff5555");
    expect(TERMINAL_PALETTES["solarized-dark"]!.background).toBe("#002b36");
    expect(CANVAS_THEMES["dark-obsidian"]!.accent).toBe("#7efff5");
    expect(CANVAS_THEMES["clean-blueprint"]!.panel).toBe("#ffffff");
    expect(CANVAS_THEMES["technical-paper"]!.grid).toBe("#d9d2c2");
  });
});
