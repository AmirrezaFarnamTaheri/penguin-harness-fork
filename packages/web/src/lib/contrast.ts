/**
 * Contrast arithmetic (F8) — one implementation of WCAG 2.x relative luminance and contrast ratio,
 * shared by the components that need to *decide* a color and by the tests that need to *check* it.
 *
 * Before this module the same formula existed twice: once in prose in a component header and once
 * as a private helper inside a test file. That split is how a fixable failure survives review —
 * the test can measure a color the component no longer uses, and the component can carry a comment
 * whose numbers nobody recomputes.
 *
 * What the module adds beyond the formula:
 *
 *   - **Alpha compositing.** A color with alpha is not a color; it is a color *over something*.
 *     The historical focus ring (`rgb(107 114 128 / 0.4)`) measured 1.70:1 on white because its
 *     composite — #c4c7cc — was never computed by hand. {@link composite} does it in sRGB space,
 *     which is what browsers do for these values.
 *   - **Role-based requirements.** {@link requiredRatio} encodes the rule the card states: 4.5:1
 *     for ordinary text, 3:1 where large-text criteria apply, 3:1 for non-text (icons, focus
 *     rings, chart fills) — and `null` for genuinely disabled controls, whose exemption is
 *     recorded explicitly rather than being silently treated as a pass.
 *   - **A single verdict shape.** {@link evaluateContrast} returns ratio + requirement + pass, so
 *     a test failure prints the numbers instead of an unexplained boolean.
 *
 * Parsing is deliberately small and strict: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`
 * with 0–255 channels and 0–1 alpha. Anything else returns null, and callers must decide what an
 * unparseable color means — this module never guesses.
 */

export interface Rgba {
  /** 0–255 per channel. */
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

/** Roles the UI actually has, each with the WCAG 2.2 AA requirement it is held to. */
export type ContrastRole =
  "text" | "large-text" | "icon" | "focus-ring" | "chart-fill" | "disabled-text";

/**
 * The requirement per role, or `null` where the criterion does not apply.
 *
 * `disabled-text` is the deliberate `null`: WCAG 1.4.3/1.4.11 exempt disabled controls, so the
 * honest statement is "not applicable" — not "passes", and not a number invented to make a table
 * look complete. Callers must handle the null explicitly (see {@link evaluateContrast}).
 */
export function requiredRatio(role: ContrastRole): number | null {
  switch (role) {
    case "text":
      return 4.5;
    case "large-text":
    case "icon":
    case "focus-ring":
    case "chart-fill":
      return 3;
    case "disabled-text":
      return null;
  }
}

/** Parses one of the supported color spellings; null when the value is not one of them. */
export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const expand = (part: string): number => parseInt(part.length === 1 ? part + part : part, 16);
    if (digits.length <= 4) {
      return {
        r: expand(digits[0]!),
        g: expand(digits[1]!),
        b: expand(digits[2]!),
        a: digits.length === 4 ? expand(digits[3]!) / 255 : 1,
      };
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  const functional = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!functional) return null;
  const parts = functional[1]!.split(/[,/\s]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channels: number[] = [];
  for (const part of parts.slice(0, 3)) {
    const number = Number(part.replace("%", ""));
    if (!Number.isFinite(number)) return null;
    // Percentages are resolved against 255; bare numbers must be 0–255.
    const clamped = part.endsWith("%") ? (number / 100) * 255 : number;
    if (clamped < 0 || clamped > 255) return null;
    channels.push(clamped);
  }
  let alpha = 1;
  if (parts.length === 4) {
    const raw = parts[3]!;
    const number = Number(raw.replace("%", ""));
    if (!Number.isFinite(number)) return null;
    alpha = raw.endsWith("%") ? number / 100 : number;
    if (alpha < 0 || alpha > 1) return null;
  }
  return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: alpha };
}

/** Composites `foreground` over `background` in sRGB space — what the browser actually paints. */
export function composite(foreground: Rgba, background: Rgba): Rgba {
  const a = foreground.a + background.a * (1 - foreground.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const blend = (f: number, b: number): number =>
    (f * foreground.a + b * background.a * (1 - foreground.a)) / a;
  return {
    r: blend(foreground.r, background.r),
    g: blend(foreground.g, background.g),
    b: blend(foreground.b, background.b),
    a,
  };
}

/** WCAG 2.x relative luminance of an opaque color (alpha is resolved by {@link toHex} first). */
export function relativeLuminance(color: Rgba | string): number | null {
  const parsed = typeof color === "string" ? parseColor(color) : color;
  if (parsed === null) return null;
  // A translucent color has no luminance on its own; callers must composite it first. Returning
  // the luminance of the un-blended channels would silently measure a color nobody sees.
  if (parsed.a < 1) return null;
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(parsed.r) + 0.7152 * linear(parsed.g) + 0.0722 * linear(parsed.b);
}

/** `#rrggbb` for an opaque color, rounding channels; alpha is dropped (composite first). */
export function toHex(color: Rgba): string {
  const channel = (value: number): string =>
    Math.min(255, Math.max(0, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/**
 * Contrast ratio between two colors, each composited over `base` when translucent.
 *
 * `base` is what an alpha color is painted over (the card, the page). Opaque colors ignore it,
 * so a caller with two opaque hexes can omit it — the default white is then never consulted.
 */
export function contrastRatio(
  foreground: string | Rgba,
  background: string | Rgba,
  base: string | Rgba = "#ffffff",
): number | null {
  const fg = typeof foreground === "string" ? parseColor(foreground) : foreground;
  const bg = typeof background === "string" ? parseColor(background) : background;
  const under = typeof base === "string" ? parseColor(base) : base;
  if (fg === null || bg === null || under === null) return null;
  const resolvedBg = bg.a < 1 ? composite(bg, under) : bg;
  const resolvedFg = fg.a < 1 ? composite(fg, resolvedBg) : fg;
  const light = relativeLuminance(resolvedFg);
  const dark = relativeLuminance(resolvedBg);
  if (light === null || dark === null) return null;
  const [hi, lo] = light >= dark ? [light, dark] : [dark, light];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastVerdict {
  /** null when a color could not be parsed (never silently 0). */
  ratio: number | null;
  /** null for roles the criterion does not apply to (disabled controls). */
  required: number | null;
  /** null when the requirement does not apply; false when it applies and is not met. */
  passes: boolean | null;
  foreground: string;
  background: string;
  role: ContrastRole;
}

/**
 * One measurement with its verdict. `base` is only needed when either color has alpha.
 */
export function evaluateContrast(
  foreground: string,
  background: string,
  role: ContrastRole,
  base?: string,
): ContrastVerdict {
  const ratio = contrastRatio(foreground, background, base);
  const required = requiredRatio(role);
  return {
    ratio,
    required,
    passes: ratio === null || required === null ? null : ratio >= required,
    foreground,
    background,
    role,
  };
}

/** A one-line, human-readable rendering of a verdict, for test failure messages and receipts. */
export function describeContrast(verdict: ContrastVerdict): string {
  const ratio = verdict.ratio === null ? "unparseable" : `${verdict.ratio.toFixed(2)}:1`;
  const requirement = verdict.required === null ? "n/a (exempt)" : `needs ${verdict.required}:1`;
  const outcome = verdict.passes === null ? "—" : verdict.passes ? "pass" : "FAIL";
  return `${verdict.role}: ${verdict.foreground} on ${verdict.background} = ${ratio}, ${requirement} → ${outcome}`;
}
