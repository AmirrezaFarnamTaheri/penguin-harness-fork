/**
 * ANSI SGR (Select Graphic Rendition) parsing and the 256-colour terminal
 * palette.
 *
 * Ported from the Rust terminal emulator's colour layer
 * (`app/src/terminal/color.rs`): the 269-entry colour list (16 named ANSI
 * colours, the 216-entry colour cube, the 24-entry grayscale ramp, and the
 * fixed slots for foreground/background/cursor/dim/bright), the `DIM_FACTOR`
 * automatic dim colour computation, and the index constants that address
 * them.
 *
 * SGR parsing handles 8-colour, 256-colour (`38;5;n`) and 24-bit
 * (`38;2;r;g;b`) sequences for both foreground and background, which the
 * reference emulator's `vim_24bitcolors_bce` reference grid exercises.
 */

export interface CellStyle {
  /** 0–268 palette index, or a packed 0xRRGGBB value for true-colour. */
  foreground: number;
  background: number;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  inverse: boolean;
  blink: boolean;
  /** True when `foreground`/`background` hold 0xRRGGBB rather than an index. */
  directColor: boolean;
}

export function createCellStyle(): CellStyle {
  return {
    foreground: PaletteIndex.FOREGROUND,
    background: PaletteIndex.BACKGROUND,
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    strikethrough: false,
    inverse: false,
    blink: false,
    directColor: false,
  };
}

export function cloneCellStyle(style: CellStyle): CellStyle {
  return { ...style };
}

/**
 * Palette slots. The reference emulator's `COUNT` is 269: the first 16 are
 * the named ANSI colours, 16..231 the colour cube, 232..255 the grayscale
 * ramp, then fixed slots for the theme foreground/background/cursor, eight
 * dim colours, the bright foreground and the dim foreground.
 */
export const PaletteIndex = {
  BLACK: 0,
  RED: 1,
  GREEN: 2,
  YELLOW: 3,
  BLUE: 4,
  MAGENTA: 5,
  CYAN: 6,
  WHITE: 7,
  BRIGHT_BLACK: 8,
  BRIGHT_RED: 9,
  BRIGHT_GREEN: 10,
  BRIGHT_YELLOW: 11,
  BRIGHT_BLUE: 12,
  BRIGHT_MAGENTA: 13,
  BRIGHT_CYAN: 14,
  BRIGHT_WHITE: 15,
  FOREGROUND: 256,
  BACKGROUND: 257,
  CURSOR: 258,
  DIM_BLACK: 259,
  DIM_RED: 260,
  DIM_GREEN: 261,
  DIM_YELLOW: 262,
  DIM_BLUE: 263,
  DIM_MAGENTA: 264,
  DIM_CYAN: 265,
  DIM_WHITE: 266,
  BRIGHT_FOREGROUND: 267,
  DIM_FOREGROUND: 268,
} as const;

/** Total entry count, matching the reference emulator's `COUNT`. */
export const PALETTE_COUNT = 269;

/** Automatic dim colours are the base colour multiplied by this factor. */
export const DIM_FACTOR = 0.66;

/** 0xRRGGBB for the default dark theme the reference emulator ships. */
export const DEFAULT_THEME = {
  background: 0x1d1f21,
  foreground: 0xc5c8c6,
  black: 0x1d1f21,
  red: 0xcc6666,
  green: 0xb5bd68,
  yellow: 0xf0c674,
  blue: 0x81a2be,
  magenta: 0xb294bb,
  cyan: 0x8abeb7,
  white: 0xc5c8c6,
  brightBlack: 0x969896,
  brightRed: 0xcc6666,
  brightGreen: 0xb5bd68,
  brightYellow: 0xf0c674,
  brightBlue: 0x81a2be,
  brightMagenta: 0xb294bb,
  brightCyan: 0x8abeb7,
  brightWhite: 0xffffff,
} as const;

export interface ThemeColors {
  background: number;
  foreground: number;
  black: number;
  red: number;
  green: number;
  yellow: number;
  blue: number;
  magenta: number;
  cyan: number;
  white: number;
  brightBlack: number;
  brightRed: number;
  brightGreen: number;
  brightYellow: number;
  brightBlue: number;
  brightMagenta: number;
  brightCyan: number;
  brightWhite: number;
}

/** Per-channel dimming: multiply each channel by `DIM_FACTOR`. */
export function dimColor(color: number, factor = DIM_FACTOR): number {
  const r = Math.round(((color >> 16) & 255) * factor);
  const g = Math.round(((color >> 8) & 255) * factor);
  const b = Math.round((color & 255) * factor);
  return (r << 16) | (g << 8) | b;
}

/**
 * Build the full 269-entry palette from a theme. The colour cube fills
 * indices 16..231 with `component = 0 ? 0 : channel * 40 + 55` per axis — the
 * xterm formula — and the grayscale ramp fills 232..255 with `i * 10 + 8`.
 */
export function buildPalette(theme: ThemeColors = DEFAULT_THEME): Uint32Array {
  const list = new Uint32Array(PALETTE_COUNT);

  list[PaletteIndex.BLACK] = theme.black;
  list[PaletteIndex.RED] = theme.red;
  list[PaletteIndex.GREEN] = theme.green;
  list[PaletteIndex.YELLOW] = theme.yellow;
  list[PaletteIndex.BLUE] = theme.blue;
  list[PaletteIndex.MAGENTA] = theme.magenta;
  list[PaletteIndex.CYAN] = theme.cyan;
  list[PaletteIndex.WHITE] = theme.white;

  list[PaletteIndex.BRIGHT_BLACK] = theme.brightBlack;
  list[PaletteIndex.BRIGHT_RED] = theme.brightRed;
  list[PaletteIndex.BRIGHT_GREEN] = theme.brightGreen;
  list[PaletteIndex.BRIGHT_YELLOW] = theme.brightYellow;
  list[PaletteIndex.BRIGHT_BLUE] = theme.brightBlue;
  list[PaletteIndex.BRIGHT_MAGENTA] = theme.brightMagenta;
  list[PaletteIndex.BRIGHT_CYAN] = theme.brightCyan;
  list[PaletteIndex.BRIGHT_WHITE] = theme.brightWhite;
  list[PaletteIndex.BRIGHT_FOREGROUND] = theme.foreground;

  list[PaletteIndex.FOREGROUND] = theme.foreground;
  list[PaletteIndex.BACKGROUND] = theme.background;
  // The reference emulator reserves a slot for the cursor colour.
  list[PaletteIndex.CURSOR] = theme.foreground;

  list[PaletteIndex.DIM_FOREGROUND] = dimColor(theme.foreground);
  list[PaletteIndex.DIM_BLACK] = dimColor(theme.black);
  list[PaletteIndex.DIM_RED] = dimColor(theme.red);
  list[PaletteIndex.DIM_GREEN] = dimColor(theme.green);
  list[PaletteIndex.DIM_YELLOW] = dimColor(theme.yellow);
  list[PaletteIndex.DIM_BLUE] = dimColor(theme.blue);
  list[PaletteIndex.DIM_MAGENTA] = dimColor(theme.magenta);
  list[PaletteIndex.DIM_CYAN] = dimColor(theme.cyan);
  list[PaletteIndex.DIM_WHITE] = dimColor(theme.white);

  // Colour cube: 6x6x6, indices 16..231.
  let index = 16;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        list[index++] = (cubeChannel(r) << 16) | (cubeChannel(g) << 8) | cubeChannel(b);
      }
    }
  }

  // Grayscale ramp: 24 steps, indices 232..255.
  for (let i = 0; i < 24; i++) {
    const value = i * 10 + 8;
    list[index++] = (value << 16) | (value << 8) | value;
  }

  return list;
}

function cubeChannel(channel: number): number {
  return channel === 0 ? 0 : channel * 40 + 55;
}

/** CSS `#rrggbb` for a packed 0xRRGGBB colour. */
export function packedToHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** CSS `rgb(r, g, b)` for a packed colour — used by the DOM renderer. */
export function packedToCss(color: number): string {
  return `rgb(${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255})`;
}

/**
 * Resolve a 256-colour index to packed RGB through a palette. True-colour
 * values (`directColor` styles) are returned untouched.
 */
export function resolveColor(color: number, palette: Uint32Array, direct: boolean): number {
  if (direct) return color & 0xffffff;
  if (color < 0 || color >= palette.length) return palette[PaletteIndex.FOREGROUND]!;
  return palette[color]!;
}

// ---------------------------------------------------------------------------
// SGR parsing
// ---------------------------------------------------------------------------

export interface SgrToken {
  /** Style after this token applies. */
  style: CellStyle;
  /** Character offset in the run where this style takes effect. */
  offset: number;
}

/**
 * Split a run of styled text into `(offset, style)` tokens, one per SGR
 * escape sequence encountered plus a leading token for the initial style.
 * Handles `ESC[` … `m` with any number of `;`-separated parameters,
 * including the empty form `ESC[m` which means reset.
 */
export function parseSgrRun(text: string, initial: CellStyle = createCellStyle()): SgrToken[] {
  const tokens: SgrToken[] = [{ style: initial, offset: 0 }];
  let style = cloneCellStyle(initial);
  let offset = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "\u001b" || text[i + 1] !== "[") {
      i += 1;
      offset += 1;
      continue;
    }
    let j = i + 2;
    let params = "";
    while (j < text.length && "0123456789;".includes(text[j]!)) {
      params += text[j];
      j += 1;
    }
    if (j >= text.length || text[j] !== "m") {
      // Not an SGR sequence; skip the introducer and keep scanning.
      i += 2;
      continue;
    }
    applySgr(style, params.length === 0 ? [] : params.split(";").map(Number));
    tokens.push({ style: cloneCellStyle(style), offset });
    i = j + 1;
  }
  return tokens;
}

/**
 * Apply one SGR parameter list to a style, in place. This is the table from
 * ECMA-48 / the xterm manual, including the colour-selection sequences the
 * reference emulator's reference grids cover.
 */
export function applySgr(style: CellStyle, params: number[]): void {
  if (params.length === 0) {
    Object.assign(style, createCellStyle());
    return;
  }
  let i = 0;
  while (i < params.length) {
    const param = params[i] ?? 0;
    switch (param) {
      case 0:
        Object.assign(style, createCellStyle());
        break;
      case 1:
        style.bold = true;
        break;
      case 2:
        style.faint = true;
        break;
      case 3:
        style.italic = true;
        break;
      case 4:
        style.underline = true;
        break;
      case 5:
        style.blink = true;
        break;
      case 7:
        style.inverse = true;
        break;
      case 9:
        style.strikethrough = true;
        break;
      case 21:
      case 22:
        style.bold = false;
        style.faint = false;
        break;
      case 23:
        style.italic = false;
        break;
      case 24:
        style.underline = false;
        break;
      case 25:
        style.blink = false;
        break;
      case 27:
        style.inverse = false;
        break;
      case 29:
        style.strikethrough = false;
        break;
      case 30:
      case 31:
      case 32:
      case 33:
      case 34:
      case 35:
      case 36:
      case 37:
        style.foreground = param - 30;
        style.directColor = false;
        break;
      case 38: {
        const color = parseColorParameter(params, i);
        if (color) {
          style.foreground = color.value;
          style.directColor = color.direct;
        }
        i = color ? color.nextIndex : i + 1;
        break;
      }
      case 39:
        style.foreground = PaletteIndex.FOREGROUND;
        style.directColor = false;
        break;
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
        style.background = param - 40;
        style.directColor = false;
        break;
      case 48: {
        const color = parseColorParameter(params, i);
        if (color) {
          style.background = color.value;
          style.directColor = color.direct;
        }
        i = color ? color.nextIndex : i + 1;
        break;
      }
      case 49:
        style.background = PaletteIndex.BACKGROUND;
        style.directColor = false;
        break;
      case 90:
      case 91:
      case 92:
      case 93:
      case 94:
      case 95:
      case 96:
      case 97:
        style.foreground = param - 90 + 8;
        style.directColor = false;
        break;
      case 100:
      case 101:
      case 102:
      case 103:
      case 104:
      case 105:
      case 106:
      case 107:
        style.background = param - 100 + 8;
        style.directColor = false;
        break;
      default:
        break;
    }
    i += 1;
  }
}

/** Parse `38;5;n` / `48;5;n` / `38;2;r;g;b` / `48;2;r;g;b` starting at `index`. */
function parseColorParameter(
  params: number[],
  index: number,
): { value: number; direct: boolean; nextIndex: number } | null {
  const mode = params[index + 1];
  if (mode === 5) {
    const n = Math.max(0, Math.min(255, params[index + 2] ?? 0));
    return { value: n, direct: false, nextIndex: index + 2 };
  }
  if (mode === 2) {
    const r = clamp255(params[index + 2] ?? 0);
    const g = clamp255(params[index + 3] ?? 0);
    const b = clamp255(params[index + 4] ?? 0);
    return { value: (r << 16) | (g << 8) | b, direct: true, nextIndex: index + 4 };
  }
  return null;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Strip every ANSI escape sequence from `text`, returning the visible
 * characters and a map from output offset to the style active there. The
 * cockpit uses this to render blocks as styled DOM without a full terminal
 * emulator.
 */
export interface StrippedText {
  text: string;
  tokens: SgrToken[];
}

export function stripAnsi(text: string, initial: CellStyle = createCellStyle()): StrippedText {
  const tokens: SgrToken[] = [{ style: initial, offset: 0 }];
  let style = cloneCellStyle(initial);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code !== 0x1b) {
      out += text[i];
      i += 1;
      continue;
    }
    // CSI: ESC [ ... final byte in 0x40..0x7e
    if (text[i + 1] === "[") {
      let j = i + 2;
      while (
        j < text.length &&
        ((text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) ||
          (text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f))
      ) {
        j += 1;
      }
      if (j < text.length) j += 1;
      const sequence = text.slice(i, j);
      if (sequence.endsWith("m")) {
        const params = sequence.slice(2, -1);
        applySgr(style, params.length === 0 ? [] : params.split(";").map(Number));
        tokens.push({ style: cloneCellStyle(style), offset: out.length });
      }
      i = j;
      continue;
    }
    // OSC: ESC ] ... BEL or ST (ESC \)
    if (text[i + 1] === "]") {
      let j = i + 2;
      while (j < text.length && text[j] !== "\u0007") {
        if (text[j] === "\u001b" && text[j + 1] === "\\") {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    // Two-byte escape (ESC X) and single ESC.
    i += text[i + 1] !== undefined ? 2 : 1;
  }
  return { text: out, tokens };
}

/** Render packed/styled colours for a DOM span's inline style. */
export function styleToCss(style: CellStyle, palette: Uint32Array): string {
  const fg = resolveColor(style.foreground, palette, style.directColor);
  const bg = resolveColor(style.background, palette, style.directColor);
  const declarations = [`color: ${packedToCss(fg)}`, `background-color: ${packedToCss(bg)}`];
  if (style.bold) declarations.push("font-weight: 700");
  if (style.faint) declarations.push("opacity: 0.66");
  if (style.italic) declarations.push("font-style: italic");
  if (style.underline) declarations.push("text-decoration: underline");
  if (style.strikethrough) declarations.push("text-decoration: line-through");
  if (style.blink) declarations.push("animation: terminal-blink 1s step-start infinite");
  return declarations.join("; ");
}
