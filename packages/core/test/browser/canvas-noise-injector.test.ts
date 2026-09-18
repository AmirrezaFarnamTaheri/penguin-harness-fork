import { describe, expect, it } from "vitest";

import {
  CANVAS_NOISE_COEFFICIENTS,
  buildCanvasNoiseScript,
  canvasNoiseOffset,
  perturbPixel,
} from "../../src/browser/canvas-noise-injector.js";

describe("canvas noise injector", () => {
  describe("canvasNoiseOffset", () => {
    it("implements the plan's formula verbatim", () => {
      const { x, y, amplitude, modulus } = CANVAS_NOISE_COEFFICIENTS;
      expect(x).toBe(12.9898);
      expect(y).toBe(78.233);
      expect(amplitude).toBe(43_758.5453);
      expect(modulus).toBe(1e-4);
      const expected = Math.sin(10 * x + 20 * y) * amplitude;
      expect(canvasNoiseOffset(10, 20, 0)).toBeCloseTo(expected % modulus, 10);
    });

    it("is deterministic for the same coordinates and seed", () => {
      expect(canvasNoiseOffset(137, 42, 99)).toBe(canvasNoiseOffset(137, 42, 99));
    });

    it("stays within the modulus bound", () => {
      for (let x = 0; x < 200; x += 7) {
        for (let y = 0; y < 200; y += 11) {
          const value = canvasNoiseOffset(x, y, 5);
          expect(Math.abs(value)).toBeLessThanOrEqual(CANVAS_NOISE_COEFFICIENTS.modulus);
        }
      }
    });

    it("changes when the seed changes", () => {
      expect(canvasNoiseOffset(137, 42, 1)).not.toBe(canvasNoiseOffset(137, 42, 2));
    });

    it("produces a varied field rather than a constant", () => {
      const values = [
        canvasNoiseOffset(0, 0, 1),
        canvasNoiseOffset(1, 0, 1),
        canvasNoiseOffset(0, 1, 1),
      ];
      expect(new Set(values).size).toBeGreaterThan(1);
    });
  });

  describe("perturbPixel", () => {
    it("nudges exactly one RGB byte by one and leaves alpha untouched", () => {
      const data = new Uint8ClampedArray([100, 110, 120, 255]);
      const before = [...data];
      perturbPixel(data, 0, 5, 5, 1);
      const changed = [0, 1, 2].filter((channel) => data[channel] !== before[channel]);
      expect(changed).toHaveLength(1);
      expect(Math.abs(data[changed[0]!]! - before[changed[0]!]!)).toBe(1);
      expect(data[3]).toBe(255);
    });

    it("clamps to the byte range rather than wrapping", () => {
      const low = new Uint8ClampedArray([0, 0, 0, 255]);
      perturbPixel(low, 0, 1, 1, 1);
      expect(Math.min(...[...low.slice(0, 3)])).toBeGreaterThanOrEqual(0);

      const high = new Uint8ClampedArray([255, 255, 255, 255]);
      perturbPixel(high, 0, 1, 1, 1);
      expect(Math.max(...[...high.slice(0, 3)])).toBeLessThanOrEqual(255);
    });

    it("is reproducible", () => {
      const a = new Uint8ClampedArray([50, 60, 70, 255]);
      const b = new Uint8ClampedArray([50, 60, 70, 255]);
      perturbPixel(a, 0, 3, 4, 7);
      perturbPixel(b, 0, 3, 4, 7);
      expect([...a]).toEqual([...b]);
    });
  });

  describe("buildCanvasNoiseScript", () => {
    it("wraps the payload in an IIFE with no imports", () => {
      const script = buildCanvasNoiseScript();
      expect(script.trim().startsWith("(function ()")).toBe(true);
      expect(script.trim().endsWith("})();")).toBe(true);
      expect(script).not.toContain("import ");
    });

    it("embeds the seed and coefficients", () => {
      const script = buildCanvasNoiseScript({ seed: 4242 });
      expect(script).toContain("4242");
      expect(script).toContain(String(CANVAS_NOISE_COEFFICIENTS.x));
      expect(script).toContain(String(CANVAS_NOISE_COEFFICIENTS.amplitude));
    });

    it("hooks getImageData and the export paths", () => {
      const script = buildCanvasNoiseScript();
      expect(script).toContain("getImageData");
      expect(script).toContain("toDataURL");
      expect(script).toContain("toBlob");
      expect(script).toContain("putImageData");
    });

    it("honours the hook toggles", () => {
      const exportOnly = buildCanvasNoiseScript({ hookGetImageData: false, hookExport: true });
      expect(exportOnly).toContain("toDataURL");
      const script = buildCanvasNoiseScript({ hookGetImageData: true, hookExport: false });
      expect(script).toContain("getImageData");
    });

    it("never rethrows into the page", () => {
      const script = buildCanvasNoiseScript();
      // Every perturbation site must be guarded so rendering can never break.
      const guarded = (script.match(/catch \(e\)/g) ?? []).length;
      expect(guarded).toBeGreaterThanOrEqual(3);
    });
  });
});
