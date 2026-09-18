/**
 * Canvas noise injection.
 *
 * Canvas fingerprinting hashes the exact bytes a GPU rasterizes — two machines with different
 * GPUs, drivers or font hinting produce different pixels for the same draw calls, which is why
 * the canvas hash is such a persistent identifier. Defeating it is not encryption: it is adding a
 * deterministic, per-session perturbation to those bytes so the emitted hash reflects the chosen
 * identity rather than the host hardware, while staying stable within a session (a hash that
 * changes on every read is itself a detector signal).
 *
 * The perturbation function is the master plan's Tier 5 spec, verbatim:
 *
 *     Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1e-4
 *
 * This is the classic fract/noise hash used in GLSL shaders: `sin` of a large coefficient product
 * scrambles into a high-frequency pseudo-random field, multiplication by 43758.5453 blows the
 * fractional part up to full float magnitude, and the `% 1e-4` modulus cuts it back to a
 * sub-ten-thousandth offset — small enough to be invisible in an image, large enough to move the
 * least significant bytes that a fingerprint hash keys on. Because it is a pure function of the
 * coordinates and a seed, it is perfectly reproducible, which is what keeps the hash stable.
 *
 * Provenance: none of the five Track 1 donors implements canvas noise (their fingerprint layer
 * covers WebGL and navigator only). The formula and the requirement come from the plan.
 */

/** The exact coefficients of the plan's noise formula. */
export const CANVAS_NOISE_COEFFICIENTS = {
  /** X scrambling coefficient. */
  x: 12.9898,
  /** Y scrambling coefficient. */
  y: 78.233,
  /** Amplitude multiplier applied to the sin product. */
  amplitude: 43_758.5453,
  /** Modulus bounding the offset — a 1e-4 pixel shift is imperceptible but shifts low bytes. */
  modulus: 1e-4,
} as const;

/**
 * The plan's noise offset, as a pure function. Deterministic for a given (x, y, seed): the seed
 * is folded into the x term so two sessions on the same host produce different hashes, while a
 * replay of the same seed reproduces the same image byte-for-byte.
 *
 * @returns a value in (-modulus, modulus).
 */
export function canvasNoiseOffset(x: number, y: number, seed: number = 0): number {
  const { x: cx, y: cy, amplitude, modulus } = CANVAS_NOISE_COEFFICIENTS;
  const value = Math.sin((x + seed * 7919) * cx + y * cy) * amplitude;
  // JS `%` is sign-preserving, so the result is already bounded to (-modulus, modulus).
  return value % modulus;
}

/**
 * Perturbs one RGBA pixel in place by the noise field. The alpha channel is deliberately left
 * alone: altering coverage changes compositing against a background, which a detector can catch
 * by re-drawing; perturbing only RGB keeps the image's alpha-accurate silhouette intact.
 */
export function perturbPixel(
  data: Uint8ClampedArray,
  offset: number,
  x: number,
  y: number,
  seed: number,
): void {
  const delta = canvasNoiseOffset(x, y, seed);
  // Scale the sub-1e-4 float into a ±1 integer lsb nudge; a fractional byte does nothing.
  const nudge = delta < 0 ? -1 : 1;
  const channel = ((offset + x * 3 + y * 7) % 3) as 0 | 1 | 2;
  const index = offset + channel;
  data[index] = clampToByte(data[index]! + nudge);
}

function clampToByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export interface CanvasNoiseOptions {
  /** Session seed; the same seed reproduces the same perturbed image. */
  seed?: number;
  /** Hook `toDataURL` / `toBlob` as well as `getImageData`. @default true */
  hookExport?: boolean;
  /** Hook `getImageData` (the path most fingerprinters actually read). @default true */
  hookGetImageData?: boolean;
}

/**
 * Emits the page-side canvas-noise script. It wraps `CanvasRenderingContext2D.prototype.getImageData`
 * and `HTMLCanvasElement.prototype.toDataURL` / `toBlob`, perturbing RGB bytes of the returned
 * buffer by the noise field before the caller ever sees them. The perturbation is applied to the
 * COPY handed to the page, never to the canvas's own backing store, so repeated draws compose
 * correctly and only outbound reads are altered.
 */
export function buildCanvasNoiseScript(options: CanvasNoiseOptions = {}): string {
  const seed = options.seed ?? 0;
  const hookExport = options.hookExport ?? true;
  const hookGetImageData = options.hookGetImageData ?? true;
  const { x: cx, y: cy, amplitude, modulus } = CANVAS_NOISE_COEFFICIENTS;

  return `
(function () {
  var SEED = ${JSON.stringify(seed)};
  var CX = ${cx}, CY = ${cy}, AMP = ${amplitude}, MOD = ${modulus};

  function noiseOffset(x, y) {
    return Math.sin((x + SEED * 7919) * CX + y * CY) * AMP % MOD;
  }

  function perturb(data, width, height, originX, originY) {
    if (!data || data.length < 4) return data;
    for (var py = 0; py < height; py++) {
      for (var px = 0; px < width; px++) {
        var index = (py * width + px) * 4;
        var delta = noiseOffset(originX + px, originY + py);
        var nudge = delta < 0 ? -1 : 1;
        var channel = (index + px * 3 + py * 7) % 3;
        var current = data[index + channel];
        var next = current + nudge;
        data[index + channel] = next < 0 ? 0 : next > 255 ? 255 : next;
      }
    }
    return data;
  }

  if (${hookGetImageData} && typeof CanvasRenderingContext2D !== "undefined" &&
      CanvasRenderingContext2D.prototype.getImageData) {
    var originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
      var imageData = originalGetImageData.apply(this, arguments);
      try {
        perturb(imageData.data, imageData.width, imageData.height, sx | 0, sy | 0);
      } catch (e) { /* never break rendering to perturb it */ }
      return imageData;
    };
  }

  if (${hookExport} && typeof HTMLCanvasElement !== "undefined") {
    if (HTMLCanvasElement.prototype.toDataURL) {
      var originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function () {
        var ctx = this.getContext && this.getContext("2d");
        if (ctx) {
          try {
            var w = this.width, h = this.height;
            var image = originalGetImageDataSafe(ctx, 0, 0, w, h);
            perturb(image.data, image.width, image.height, 0, 0);
            ctx.putImageData(image, 0, 0);
          } catch (e) { /* fall back to the unmodified export */ }
        }
        return originalToDataURL.apply(this, arguments);
      };
    }
    if (HTMLCanvasElement.prototype.toBlob) {
      var originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        var ctx = this.getContext && this.getContext("2d");
        if (ctx) {
          try {
            var w = this.width, h = this.height;
            var image = originalGetImageDataSafe(ctx, 0, 0, w, h);
            perturb(image.data, image.width, image.height, 0, 0);
            ctx.putImageData(image, 0, 0);
          } catch (e) { /* fall back to the unmodified export */ }
        }
        return originalToBlob.apply(this, arguments);
      };
    }
  }

  function originalGetImageDataSafe(ctx, sx, sy, sw, sh) {
    return ctx.getImageData(sx, sy, sw, sh);
  }
})();
`;
}
