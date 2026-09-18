import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  DIM_FACTOR,
  PALETTE_COUNT,
  PaletteIndex,
  applySgr,
  buildPalette,
  createCellStyle,
  dimColor,
  packedToCss,
  packedToHex,
  parseSgrRun,
  resolveColor,
  stripAnsi,
  styleToCss,
} from "../../src/terminal/ansi-color";

describe("ansi color", () => {
  it("exposes the palette index constants of the source emulator", () => {
    expect(PALETTE_COUNT).toBe(269);
    expect(PaletteIndex.BLACK).toBe(0);
    expect(PaletteIndex.WHITE).toBe(7);
    expect(PaletteIndex.BRIGHT_WHITE).toBe(15);
    expect(PaletteIndex.FOREGROUND).toBe(256);
    expect(PaletteIndex.BACKGROUND).toBe(257);
    expect(PaletteIndex.CURSOR).toBe(258);
    expect(PaletteIndex.DIM_BLACK).toBe(259);
    expect(PaletteIndex.BRIGHT_FOREGROUND).toBe(267);
    expect(PaletteIndex.DIM_FOREGROUND).toBe(268);
    expect(DEFAULT_THEME.background).toBe(0x1d1f21);
    expect(DEFAULT_THEME.foreground).toBe(0xc5c8c6);
    expect(DIM_FACTOR).toBeCloseTo(0.66);
  });

  it("builds the 269-entry palette", () => {
    const palette = buildPalette();
    expect(palette.length).toBe(PALETTE_COUNT);
    expect(palette[PaletteIndex.BLACK]).toBe(DEFAULT_THEME.black);
    expect(palette[PaletteIndex.RED]).toBe(DEFAULT_THEME.red);
    expect(palette[PaletteIndex.BRIGHT_WHITE]).toBe(DEFAULT_THEME.brightWhite);
    expect(palette[PaletteIndex.FOREGROUND]).toBe(DEFAULT_THEME.foreground);
    expect(palette[PaletteIndex.BACKGROUND]).toBe(DEFAULT_THEME.background);
    // The cursor slot reserves the foreground colour.
    expect(palette[PaletteIndex.CURSOR]).toBe(DEFAULT_THEME.foreground);
    // Colour cube: indices 16..231, `channel * 40 + 55` per axis with 0 staying 0.
    expect(palette[16]).toBe(0x000000);
    expect(palette[17]).toBe(95);
    expect(palette[21]).toBe(255);
    expect(palette[22]).toBe(95 << 8);
    expect(palette[231]).toBe(0xffffff);
    // Grayscale ramp: indices 232..255, `i * 10 + 8`.
    expect(palette[232]).toBe(0x080808);
    expect(palette[232 + 5]).toBe((5 * 10 + 8) * 0x010101);
    expect(palette[255]).toBe(0xeeeeee);
  });

  it("dims colours per channel", () => {
    expect(dimColor(0xffffff)).toBe(0xa8a8a8);
    expect(dimColor(0x000000)).toBe(0);
    // White * 0.66 rounds to 168 per channel.
    expect(dimColor(0xff0000) >> 16).toBe(Math.round(255 * DIM_FACTOR));
    // The dim slots are the base theme colours scaled by the factor.
    const palette = buildPalette();
    expect(palette[PaletteIndex.DIM_RED]).toBe(dimColor(DEFAULT_THEME.red));
    expect(palette[PaletteIndex.DIM_FOREGROUND]).toBe(dimColor(DEFAULT_THEME.foreground));
  });

  it("formats packed colours for css", () => {
    expect(packedToHex(0xff8800)).toBe("#ff8800");
    expect(packedToCss(0xff8800)).toBe("rgb(255, 136, 0)");
  });

  it("resolves palette indices and direct colours", () => {
    const palette = buildPalette();
    expect(resolveColor(PaletteIndex.RED, palette, false)).toBe(DEFAULT_THEME.red);
    // True-colour values pass through, masked to 24 bits.
    expect(resolveColor(0xffff0000, palette, true)).toBe(0xff0000);
    // Out-of-range indices fall back to the foreground.
    expect(resolveColor(9999, palette, false)).toBe(DEFAULT_THEME.foreground);
    expect(resolveColor(-1, palette, false)).toBe(DEFAULT_THEME.foreground);
  });

  it("applies the sgr attribute table", () => {
    const style = createCellStyle();
    expect(style).toMatchObject({
      foreground: PaletteIndex.FOREGROUND,
      background: PaletteIndex.BACKGROUND,
    });
    // An empty parameter list resets everything.
    applySgr(style, [1, 3]);
    expect(style.bold).toBe(true);
    expect(style.italic).toBe(true);
    applySgr(style, []);
    expect(style.bold).toBe(false);
    expect(style.italic).toBe(false);
    // Every attribute the source emulator's reference grids cover.
    applySgr(style, [2, 4, 5, 7, 9]);
    expect(style).toMatchObject({
      faint: true,
      underline: true,
      blink: true,
      inverse: true,
      strikethrough: true,
    });
    applySgr(style, [22, 24, 25, 27, 29]);
    expect(style).toMatchObject({
      faint: false,
      underline: false,
      blink: false,
      inverse: false,
      strikethrough: false,
    });
  });

  it("applies the sgr colour sequences", () => {
    const style = createCellStyle();
    // 8-colour foreground and background.
    applySgr(style, [31, 42]);
    expect(style.foreground).toBe(1);
    expect(style.background).toBe(2);
    expect(style.directColor).toBe(false);
    // 256-colour selection.
    applySgr(style, [38, 5, 196]);
    expect(style.foreground).toBe(196);
    expect(style.directColor).toBe(false);
    applySgr(style, [48, 5, 17]);
    expect(style.background).toBe(17);
    // 24-bit selection packs to 0xRRGGBB with the direct flag set.
    applySgr(style, [38, 2, 255, 0, 128]);
    expect(style.foreground).toBe(0xff0080);
    expect(style.directColor).toBe(true);
    applySgr(style, [48, 2, 1, 2, 3]);
    expect(style.background).toBe(0x010203);
    // The bright aixterr bright colour range maps to indices 8..15.
    applySgr(style, [97]);
    expect(style.foreground).toBe(15);
    expect(style.directColor).toBe(false);
    applySgr(style, [107]);
    expect(style.background).toBe(15);
    // 39/49 restore the defaults and clear the direct flag.
    applySgr(style, [39, 49]);
    expect(style.foreground).toBe(PaletteIndex.FOREGROUND);
    expect(style.background).toBe(PaletteIndex.BACKGROUND);
    expect(style.directColor).toBe(false);
  });

  it("tolerates truncated colour sequences", () => {
    const style = createCellStyle();
    // `38` with no mode byte is skipped, not applied.
    applySgr(style, [38]);
    expect(style.foreground).toBe(PaletteIndex.FOREGROUND);
    // An unknown mode is skipped too.
    applySgr(style, [38, 9, 1]);
    expect(style.foreground).toBe(PaletteIndex.FOREGROUND);
    // Out-of-range components clamp rather than wrap.
    applySgr(style, [38, 2, 999, 0, 0]);
    expect(style.foreground).toBe(0xff0000);
  });

  it("tokenises a styled run by sgr sequence", () => {
    const tokens = parseSgrRun("a\u001b[31mb\u001b[1mc");
    // A leading token covers the initial style.
    expect(tokens).toHaveLength(3);
    expect(tokens[1]!.offset).toBe(1);
    expect(tokens[1]!.style.foreground).toBe(1);
    expect(tokens[2]!.offset).toBe(2);
    expect(tokens[2]!.style.bold).toBe(true);
    // `ESC[m` is the empty reset.
    const reset = parseSgrRun("\u001b[mx", { ...createCellStyle(), bold: true });
    expect(reset[1]!.style.bold).toBe(false);
    // Non-sgr escapes are skipped without emitting a token.
    const skipped = parseSgrRun("\u001b[2Jx");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.offset).toBe(0);
  });

  it("strips escape sequences and keeps the style map aligned", () => {
    const styled = stripAnsi("\u001b[31mred\u001b[0m!");
    expect(styled.text).toBe("red!");
    expect(styled.tokens).toHaveLength(3);
    expect(styled.tokens[0]!.style.foreground).toBe(PaletteIndex.FOREGROUND);
    expect(styled.tokens[1]!.style.foreground).toBe(1);
    expect(styled.tokens[1]!.offset).toBe(0);
    expect(styled.tokens[2]!.style.foreground).toBe(PaletteIndex.FOREGROUND);
    expect(styled.tokens[2]!.offset).toBe(3);
    // Non-sgr CSI sequences are removed but do not change the style.
    expect(stripAnsi("\u001b[2Jclear").text).toBe("clear");
    expect(stripAnsi("\u001b[?25lhidden").text).toBe("hidden");
    // OSC sequences (title setting) terminate at BEL.
    expect(stripAnsi("\u001b]0;my title\u0007body").text).toBe("body");
    // And at the ST terminator (ESC \).
    expect(stripAnsi("\u001b]0;t\u001b\\body").text).toBe("body");
    // Unstyled text is untouched.
    expect(stripAnsi("plain").text).toBe("plain");
  });

  it("renders a cell style as inline css", () => {
    const palette = buildPalette();
    const style = { ...createCellStyle(), foreground: PaletteIndex.RED };
    const css = styleToCss(style, palette);
    expect(css).toContain("color: rgb(204, 102, 102)");
    expect(css).toContain("background-color: rgb(29, 31, 33)");
    const decorated = styleToCss({ ...style, bold: true, italic: true, underline: true }, palette);
    expect(decorated).toContain("font-weight: 700");
    expect(decorated).toContain("font-style: italic");
    expect(decorated).toContain("text-decoration: underline");
    // True-colour styles resolve to their packed value.
    const direct = styleToCss(
      { ...createCellStyle(), foreground: 0xff0080, directColor: true },
      palette,
    );
    expect(direct).toContain("color: rgb(255, 0, 128)");
  });
});
