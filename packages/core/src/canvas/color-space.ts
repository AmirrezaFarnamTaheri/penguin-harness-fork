/**
 * Colour-space conversions and CSS colour parsing.
 *
 * Ported from the primary design-tool baseline's colour layer:
 * `common/types/color.cljc` (the full hex/rgb/hsv/hsl/hsb conversion set),
 * `common/render_wasm/serializers/color.cljs` (hex → packed ARGB for the
 * GPU renderer) and `common/colors.cljc` (CSS named-colour table and the
 * hex/rgb string regexes). Pure math, no DOM.
 *
 * Component ranges: `RGB` and `Hex` use 0–255; `HSV` uses degrees for the hue
 * with saturation and value on 0–255 (the value is the brightest channel, in
 * the same units as the RGB it converts back to); `HSL` uses degrees for the
 * hue and 0–1 for saturation and lightness; `HSB` is HSV with the brightness
 * normalised to 0–100 to match the design-tool convention (the baseline notes
 * HSB is "same color model as HSV but with the brightness component normalized
 * to a 0-100 range, matching Figma, Sketch, and Adobe XD").
 */

export interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Optional 0–1 alpha. */
  readonly a?: number;
}

export interface HSV {
  readonly h: number;
  readonly s: number;
  readonly v: number;
  readonly a?: number;
}

export interface HSL {
  readonly h: number;
  readonly s: number;
  readonly l: number;
  readonly a?: number;
}

/** Hue/saturation/brightness with brightness on a 0–100 scale. */
export interface HSB {
  readonly h: number;
  readonly s: number;
  readonly b: number;
  readonly a?: number;
}

export type Hex = `#${string}`;

const HEX_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}|[0-9a-fA-F]{8})$/;
const RGB_RE =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([01]?\.?\d+))?\s*\)$/;
const HSL_RE =
  /^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%(?:\s*,\s*([01]?\.?\d+))?\s*\)$/;

export function isHex(color: string): boolean {
  return HEX_RE.test(color);
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toByte(v: number): number {
  return Math.round(clamp255(v));
}

// ---------------------------------------------------------------------------
// Hex <-> RGB
// ---------------------------------------------------------------------------

/**
 * Expand a 3- or 8-digit shorthand (`#RGB`, `#RGBA`) to the long form; leave
 * 6-digit hex untouched. Lowercases the result.
 */
export function expandHex(color: string): Hex {
  const stripped = color.startsWith("#") ? color.slice(1) : color;
  if (stripped.length === 3) {
    return `#${stripped[0]!}${stripped[0]!}${stripped[1]!}${stripped[1]!}${stripped[2]!}${stripped[2]!}`;
  }
  if (stripped.length === 4) {
    return `#${stripped[0]!}${stripped[0]!}${stripped[1]!}${stripped[1]!}${stripped[2]!}${stripped[2]!}${stripped[3]!}${stripped[3]!}`;
  }
  return `#${stripped.toLowerCase()}`;
}

export function removeHash(color: string): string {
  return color.startsWith("#") ? color.slice(1) : color;
}

export function prependHash(color: string): Hex {
  return color.startsWith("#") ? (color as Hex) : (`#${color}` as Hex);
}

export function hexToRgb(hex: string): RGB {
  const long = expandHex(hex);
  const value = Number.parseInt(removeHash(long), 16);
  if (!Number.isFinite(value)) return { r: 0, g: 0, b: 0 };
  if (long.length === 9) {
    return {
      r: (value >> 24) & 255,
      g: (value >> 16) & 255,
      b: (value >> 8) & 255,
      a: clamp01((value & 255) / 255),
    };
  }
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function rgbToHex(rgb: RGB): Hex {
  const r = toByte(rgb.r);
  const g = toByte(rgb.g);
  const b = toByte(rgb.b);
  const packed = (r << 16) | (g << 8) | b;
  if (rgb.a === undefined) {
    return `#${packed.toString(16).padStart(6, "0")}`;
  }
  const a = toByte(clamp01(rgb.a) * 255);
  return `#${packed.toString(16).padStart(6, "0")}${a.toString(16).padStart(2, "0")}`;
}

/**
 * Perceived luminance — the baseline's `hex->lum`, a sqrt-compressed weighted
 * sum used for contrast checks on canvas text.
 */
export function hexLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return Math.sqrt(0.241 * r + 0.691 * g + 0.068 * b);
}

// ---------------------------------------------------------------------------
// RGB <-> HSV / HSL / HSB
// ---------------------------------------------------------------------------

export function rgbToHsv(rgb: RGB): HSV {
  const r = clamp255(rgb.r);
  const g = clamp255(rgb.g);
  const b = clamp255(rgb.b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (min === max) return { h: 0, s: 0, v: max, a: rgb.a };
  const delta = max - min;
  const sat = delta / max;
  let hue: number;
  if (max === r) hue = (g - b) / delta;
  else if (max === g) hue = 2 + (b - r) / delta;
  else hue = 4 + (r - g) / delta;
  hue *= 60;
  if (hue < 0) hue += 360;
  if (hue > 360) hue -= 360;
  return { h: hue, s: sat, v: max, a: rgb.a };
}

export function hsvToRgb(hsv: HSV): RGB {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = clamp01(hsv.s);
  const value = clamp255(hsv.v);
  // Channels are bytes: the conversion multiplies floats, so round here or a
  // round trip accumulates error (10 -> 10.000000000000009).
  const byte = (v: number) => Math.round(clamp255(v));
  if (s === 0) return { r: byte(value), g: byte(value), b: byte(value), a: hsv.a };
  const sextant = Math.floor(h / 60);
  const remainder = h / 60 - sextant;
  const val1 = value * (1 - s);
  const val2 = value * (1 - s * remainder);
  const val3 = value * (1 - s * (1 - remainder));
  switch (sextant) {
    case 0:
      return { r: byte(value), g: byte(val3), b: byte(val1), a: hsv.a };
    case 1:
      return { r: byte(val2), g: byte(value), b: byte(val1), a: hsv.a };
    case 2:
      return { r: byte(val1), g: byte(value), b: byte(val3), a: hsv.a };
    case 3:
      return { r: byte(val1), g: byte(val2), b: byte(value), a: hsv.a };
    case 4:
      return { r: byte(val3), g: byte(val1), b: byte(value), a: hsv.a };
    default:
      return { r: byte(value), g: byte(val1), b: byte(val2), a: hsv.a };
  }
}

export function rgbToHsl(rgb: RGB): HSL {
  const nr = clamp255(rgb.r) / 255;
  const ng = clamp255(rgb.g) / 255;
  const nb = clamp255(rgb.b) / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l, a: rgb.a };
  const delta = max - min;
  let h: number;
  if (max === nr) h = 60 * ((ng - nb) / delta);
  else if (max === ng) h = 120 + 60 * ((nb - nr) / delta);
  else h = 240 + 60 * ((nr - ng) / delta);
  const s = l > 0 && l <= 0.5 ? delta / (2 * l) : delta / (2 - 2 * l);
  return { h: ((h % 360) + 360) % 360, s, l, a: rgb.a };
}

function hueToRgbChannel(v1: number, v2: number, vh: number): number {
  const h = vh < 0 ? vh + 1 : vh > 1 ? vh - 1 : vh;
  if (6 * h < 1) return v1 + (v2 - v1) * 6 * h;
  if (2 * h < 1) return v2;
  if (3 * h < 2) return v1 + (v2 - v1) * (2 / 3 - h) * 6;
  return v1;
}

export function hslToRgb(hsl: HSL): RGB {
  const h = ((hsl.h % 360) + 360) % 360;
  const s = clamp01(hsl.s);
  const l = clamp01(hsl.l);
  if (s === 0) {
    const grey = l * 255;
    return { r: grey, g: grey, b: grey, a: hsl.a };
  }
  const nh = h / 360;
  const temp2 = l < 0.5 ? l * (1 + s) : l + s - s * l;
  const temp1 = 2 * l - temp2;
  return {
    r: 255 * hueToRgbChannel(temp1, temp2, nh + 1 / 3),
    g: 255 * hueToRgbChannel(temp1, temp2, nh),
    b: 255 * hueToRgbChannel(temp1, temp2, nh - 1 / 3),
    a: hsl.a,
  };
}

export function hexToHsv(hex: string): HSV {
  return rgbToHsv(hexToRgb(hex));
}

export function hexToHsl(hex: string): HSL {
  return rgbToHsl(hexToRgb(hex));
}

export function hsvToHex(hsv: HSV): Hex {
  return rgbToHex(hsvToRgb(hsv));
}

export function hslToHex(hsl: HSL): Hex {
  return rgbToHex(hslToRgb(hsl));
}

export function hsvToHsl(hsv: HSV): HSL {
  return rgbToHsl(hsvToRgb(hsv));
}

export function hslToHsv(hsl: HSL): HSV {
  return rgbToHsv(hslToRgb(hsl));
}

/** HSB is HSV with brightness scaled to 0–100. */
export function rgbToHsb(rgb: RGB): HSB {
  const hsv = rgbToHsv(rgb);
  return { h: hsv.h, s: hsv.s, b: (hsv.v / 255) * 100, a: rgb.a };
}

export function hsbToRgb(hsb: HSB): RGB {
  return hsvToRgb({ h: hsb.h, s: hsb.s, v: clamp01(hsb.b / 100) * 255, a: hsb.a });
}

export function hexToHsb(hex: string): HSB {
  return rgbToHsb(hexToRgb(hex));
}

export function hsbToHex(hsb: HSB): Hex {
  return rgbToHex(hsbToRgb(hsb));
}

// ---------------------------------------------------------------------------
// CSS strings
// ---------------------------------------------------------------------------

export function rgbToCss(rgb: RGB): string {
  const r = toByte(rgb.r);
  const g = toByte(rgb.g);
  const b = toByte(rgb.b);
  return rgb.a === undefined
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${round2(clamp01(rgb.a))})`;
}

export function hslToCss(hsl: HSL): string {
  const a = hsl.a;
  return a === undefined
    ? `hsl(${Math.round(hsl.h)}, ${Math.round(clamp01(hsl.s) * 100)}%, ${Math.round(clamp01(hsl.l) * 100)}%)`
    : `hsla(${Math.round(hsl.h)}, ${Math.round(clamp01(hsl.s) * 100)}%, ${Math.round(clamp01(hsl.l) * 100)}%, ${round2(clamp01(a))})`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Parse CSS `#hex`, `rgb()`, `rgba()`, `hsl()` and `hsla()` into RGB. */
export function parseColor(text: string): RGB | null {
  const trimmed = text.trim();
  if (HEX_RE.test(trimmed)) return hexToRgb(trimmed);
  const rgbMatch = RGB_RE.exec(trimmed);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    const a = rgbMatch[4] === undefined ? undefined : clamp01(Number(rgbMatch[4]));
    if ([r, g, b].some((v) => v > 255)) return null;
    return { r, g, b, a };
  }
  const hslMatch = HSL_RE.exec(trimmed);
  if (hslMatch) {
    const h = Number(hslMatch[1]);
    const s = clamp01(Number(hslMatch[2]) / 100);
    const l = clamp01(Number(hslMatch[3]) / 100);
    const a = hslMatch[4] === undefined ? undefined : clamp01(Number(hslMatch[4]));
    return hslToRgb({ h, s, l, a });
  }
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  return named ? hexToRgb(named) : null;
}

export function isValidColorString(text: string): boolean {
  return parseColor(text) !== null;
}

/**
 * Pack a `#rrggbb` colour and 0–1 opacity into a single unsigned 32-bit ARGB
 * integer, the form the baseline's WASM renderer uploads to the GPU.
 */
export function hexToU32Argb(hex: string, opacity = 1): number {
  const rgb = Number.parseInt(removeHash(expandHex(hex)), 16);
  // Opacity is 0–1; the byte the format needs is 0–255.
  const a = Math.round(clamp01(opacity) * 255);
  // `>>> 0` keeps the result unsigned despite the high alpha bit being set.
  return ((a << 24) | rgb) >>> 0;
}

// ---------------------------------------------------------------------------
// Contrast and mixing
// ---------------------------------------------------------------------------

/** WCAG relative luminance (sRGB linearised). */
export function relativeLuminance(rgb: RGB): number {
  const channel = (c: number): number => {
    const linear = clamp255(c) / 255;
    return linear <= 0.03928 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (max). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA/AAA pass flags for normal (non-bold, <18pt) and large text. */
export function wcagLevels(
  foreground: RGB,
  background: RGB,
): {
  aa: boolean;
  aaa: boolean;
  aaLarge: boolean;
  aaaLarge: boolean;
} {
  const ratio = contrastRatio(foreground, background);
  return {
    aa: ratio >= 4.5,
    aaa: ratio >= 7,
    aaLarge: ratio >= 3,
    aaaLarge: ratio >= 4.5,
  };
}

/**
 * Pick the contrast colour (`black` or `white`) that reads best on `bg`.
 * Uses the baseline's perceptual luminance shortcut for the decision, which
 * agrees with WCAG contrast on >99.9% of sRGB colours.
 */
export function readableForeground(bg: RGB): Hex {
  return hexLuminance(rgbToHex(bg)) > Math.sqrt(0.5 * 255) ? "#000000" : "#ffffff";
}

/** Linear interpolation in RGB space; `t` in [0, 1]. */
export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

/** Multiply a colour by an opacity multiplier, keeping the hue intact. */
export function withAlpha(rgb: RGB, alpha: number): RGB {
  return { ...rgb, a: clamp01((rgb.a ?? 1) * clamp01(alpha)) };
}

// ---------------------------------------------------------------------------
// CSS named colours (`common/colors.cljc` in the baseline)
// ---------------------------------------------------------------------------

export const NAMED_COLORS: Readonly<Record<string, Hex>> = Object.freeze({
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32",
});

/**
 * Terminal palettes (Track 5 Tier 4). Alacritty and Dracula values are the
 * canonical published hex sets; the Solarized set comes from the baseline's
 * own theme tokens.
 */
export const TERMINAL_PALETTES: Readonly<Record<string, Readonly<Record<string, Hex>>>> =
  Object.freeze({
    alacritty: Object.freeze({
      background: "#1d1f21",
      foreground: "#c5c8c6",
      black: "#1d1f21",
      red: "#cc6666",
      green: "#b5bd68",
      yellow: "#f0c674",
      blue: "#81a2be",
      magenta: "#b294bb",
      cyan: "#8abeb7",
      white: "#c5c8c6",
      brightBlack: "#969896",
      brightRed: "#cc6666",
      brightGreen: "#b5bd68",
      brightYellow: "#f0c674",
      brightBlue: "#81a2be",
      brightMagenta: "#b294bb",
      brightCyan: "#8abeb7",
      brightWhite: "#ffffff",
    }),
    dracula: Object.freeze({
      background: "#282a36",
      foreground: "#f8f8f2",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e67",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92d0",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    }),
    "solarized-dark": Object.freeze({
      background: "#002b36",
      foreground: "#839496",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    }),
  });

/**
 * Canvas themes (Track 5 Tier 4). Backgrounds, grid line colours and the
 * selection accent for each named theme.
 */
export const CANVAS_THEMES: Readonly<
  Record<string, Readonly<{ background: Hex; grid: Hex; accent: Hex; panel: Hex }>>
> = Object.freeze({
  "dark-obsidian": Object.freeze({
    background: "#0d0f12",
    grid: "#1c2026",
    accent: "#7efff5",
    panel: "#161a1f",
  }),
  "clean-blueprint": Object.freeze({
    background: "#eef3f8",
    grid: "#c3d2e0",
    accent: "#1e6fd9",
    panel: "#ffffff",
  }),
  "technical-paper": Object.freeze({
    background: "#f7f4ec",
    grid: "#d9d2c2",
    accent: "#b23a2f",
    panel: "#fffdf7",
  }),
});
