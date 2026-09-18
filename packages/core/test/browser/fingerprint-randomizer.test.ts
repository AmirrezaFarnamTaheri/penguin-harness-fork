import { describe, expect, it } from "vitest";

import {
  type BrowserFingerprint,
  type FingerprintGeneratorOptions,
  fingerprintsEqual,
  generateFingerprint,
  relaxScreenConstraints,
} from "../../src/browser/fingerprint-randomizer.js";

describe("fingerprint randomizer", () => {
  describe("relaxScreenConstraints", () => {
    it("yields the requested box then unconstrained", () => {
      const requested = { minWidth: 1920, minHeight: 1080, maxWidth: 1920, maxHeight: 1080 };
      const tiers = relaxScreenConstraints(requested);
      expect(tiers).toEqual([requested, undefined]);
    });

    it("returns a single unconstrained tier when nothing is requested", () => {
      expect(relaxScreenConstraints(undefined)).toEqual([undefined]);
    });

    it("inserts a widened tier before dropping the box entirely", () => {
      const requested = { minWidth: 5000, minHeight: 5000, maxWidth: 1000, maxHeight: 1000 };
      const tiers = relaxScreenConstraints(requested);
      expect(tiers).toHaveLength(3);
      expect(tiers[1]).toEqual({ ...requested, minWidth: 0, minHeight: 0 });
      expect(tiers[2]).toBeUndefined();
    });
  });

  describe("generateFingerprint", () => {
    it("is reproducible from a seed", () => {
      const options: FingerprintGeneratorOptions = { seed: 1234 };
      expect(generateFingerprint(options)).toEqual(generateFingerprint(options));
    });

    it("differs between seeds", () => {
      expect(generateFingerprint({ seed: 1 })).not.toEqual(generateFingerprint({ seed: 2 }));
    });

    it("reports the seed it was generated from", () => {
      expect(generateFingerprint({ seed: 77 }).seed).toBe(77);
    });

    it("honours the device class for screen geometry", () => {
      const desktop = generateFingerprint({ seed: 3, deviceClass: "desktop" });
      const mobile = generateFingerprint({ seed: 3, deviceClass: "mobile" });
      expect(desktop.screen.width).toBeGreaterThan(mobile.screen.width);
      expect(mobile.screen.devicePixelRatio).toBeGreaterThanOrEqual(2);
      expect(desktop.deviceClass).toBe("desktop");
      expect(mobile.deviceClass).toBe("mobile");
    });

    it("only populates a model on mobile", () => {
      expect(generateFingerprint({ seed: 3, deviceClass: "desktop" }).navigator.model).toBe("");
      expect(
        generateFingerprint({ seed: 3, deviceClass: "mobile" }).navigator.model.length,
      ).toBeGreaterThan(0);
    });

    it("satisfies a satisfiable screen box", () => {
      const fingerprint = generateFingerprint({
        seed: 9,
        screen: { minWidth: 1920, minHeight: 1080, maxWidth: 1920, maxHeight: 1080 },
      });
      expect(fingerprint.screen.width).toBe(1920);
      expect(fingerprint.screen.height).toBe(1080);
    });

    it("falls back to an unconstrained screen when the box is unsatisfiable", () => {
      const fingerprint = generateFingerprint({
        seed: 9,
        screen: { minWidth: 4000, minHeight: 4000, maxWidth: 5000, maxHeight: 5000 },
      });
      expect(fingerprint.screen.width).toBeGreaterThan(0);
      expect(fingerprint.screen.height).toBeGreaterThan(0);
    });

    it("keeps navigator fields consistent with the claimed platform", () => {
      const fingerprint = generateFingerprint({ seed: 4, operatingSystem: "darwin" });
      expect(fingerprint.navigator.platform).toBe("MacIntel");
      expect(fingerprint.webgl.renderer).toContain("Apple");
    });

    it("derives the languages from the requested locale", () => {
      const fingerprint = generateFingerprint({ seed: 4, locale: "de-DE" });
      expect(fingerprint.navigator.languages).toEqual(["de-DE", "de"]);
      expect(fingerprint.timezone).toBe("Europe/Berlin");
    });

    it("pairs an en-US locale with an American timezone", () => {
      expect(generateFingerprint({ seed: 4, locale: "en-US" }).timezone).toBe("America/New_York");
    });

    it("emits a Chrome brand list whose versions agree with uaFullVersion", () => {
      const fingerprint = generateFingerprint({ seed: 6 });
      const chrome = fingerprint.navigator.brands.find((brand) => brand.brand === "Google Chrome");
      expect(chrome?.version).toBe(fingerprint.navigator.uaFullVersion);
      expect(fingerprint.navigator.uaFullVersion).toMatch(/^\d{3}\.0\.0\.0$/);
    });

    it("carries a plausible hardwareConcurrency and deviceMemory", () => {
      const fingerprint: BrowserFingerprint = generateFingerprint({ seed: 6 });
      expect([4, 6, 8, 12, 16]).toContain(fingerprint.navigator.hardwareConcurrency);
      expect([4, 8, 16]).toContain(fingerprint.navigator.deviceMemory);
    });
  });

  describe("fingerprintsEqual", () => {
    it("treats the same seed as equal without deep comparison", () => {
      expect(
        fingerprintsEqual(generateFingerprint({ seed: 5 }), generateFingerprint({ seed: 5 })),
      ).toBe(true);
    });

    it("distinguishes different seeds that produce different identities", () => {
      const a = generateFingerprint({ seed: 1 });
      const b = generateFingerprint({ seed: 2 });
      expect(fingerprintsEqual(a, b)).toBe(
        JSON.stringify({ ...a, seed: undefined }) === JSON.stringify({ ...b, seed: undefined }),
      );
    });
  });
});
