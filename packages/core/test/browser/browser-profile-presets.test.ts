import { describe, expect, it } from "vitest";

import {
  type ProfileId,
  BROWSER_PROFILE_PRESETS,
  DEFAULT_BROWSER_PROFILE,
  DESKTOP_CHROME_WIN11,
  ENTERPRISE_FIREFOX_LINUX,
  MOBILE_SAFARI_IOS17,
  getBrowserProfile,
  presetToFingerprint,
  validateBrowserProfile,
} from "../../src/browser/browser-profile-presets.js";

const ALL_PRESETS: ReadonlyArray<[ProfileId, typeof DESKTOP_CHROME_WIN11]> = [
  ["desktop-chrome-win11", DESKTOP_CHROME_WIN11],
  ["mobile-safari-ios17", MOBILE_SAFARI_IOS17],
  ["enterprise-firefox-linux", ENTERPRISE_FIREFOX_LINUX],
];

describe("browser profile presets", () => {
  it("ships exactly the three plan-specified presets", () => {
    expect(Object.keys(BROWSER_PROFILE_PRESETS).sort()).toEqual([
      "desktop-chrome-win11",
      "enterprise-firefox-linux",
      "mobile-safari-ios17",
    ]);
  });

  it("is keyed consistently with the preset ids", () => {
    for (const [id, preset] of ALL_PRESETS) {
      expect(preset.id).toBe(id);
      expect(BROWSER_PROFILE_PRESETS[id]).toBe(preset);
    }
  });

  it("defaults to the desktop Chrome profile", () => {
    expect(DEFAULT_BROWSER_PROFILE).toBe("desktop-chrome-win11");
    expect(getBrowserProfile(DEFAULT_BROWSER_PROFILE)).toBe(DESKTOP_CHROME_WIN11);
  });

  it("throws on an unknown preset id rather than returning a partial", () => {
    expect(() => getBrowserProfile("unknown-profile" as ProfileId)).toThrow(
      /Unknown browser profile/,
    );
  });

  describe("field completeness", () => {
    it("populates every field on every preset", () => {
      for (const [, preset] of ALL_PRESETS) {
        expect(preset.userAgent.length).toBeGreaterThan(0);
        expect(preset.platform.length).toBeGreaterThan(0);
        expect(preset.acceptLanguage.length).toBeGreaterThan(0);
        expect(preset.timezone.length).toBeGreaterThan(0);
        expect(preset.screen.width).toBeGreaterThan(0);
        expect(preset.screen.height).toBeGreaterThan(0);
        expect(preset.hardware.hardwareConcurrency).toBeGreaterThan(0);
        expect(preset.hardware.deviceMemory).toBeGreaterThan(0);
        expect(preset.webgl.vendor.length).toBeGreaterThan(0);
        expect(preset.webgl.renderer.length).toBeGreaterThan(0);
        expect(preset.tls.cipherSuites.length).toBeGreaterThan(0);
        expect(preset.launchArgs.length).toBeGreaterThan(0);
      }
    });
  });

  describe("cross-field consistency", () => {
    it("validates clean for all three presets", () => {
      for (const [, preset] of ALL_PRESETS) {
        expect(validateBrowserProfile(preset)).toEqual([]);
      }
    });

    it("flags a mobile preset claiming Win32", () => {
      const broken = { ...MOBILE_SAFARI_IOS17, platform: "Win32" };
      expect(validateBrowserProfile(broken)[0]).toContain("Win32");
    });

    it("flags a mobile preset with a sub-retina devicePixelRatio", () => {
      const broken = {
        ...MOBILE_SAFARI_IOS17,
        screen: { ...MOBILE_SAFARI_IOS17.screen, devicePixelRatio: 1 },
      };
      expect(validateBrowserProfile(broken)[0]).toContain("devicePixelRatio");
    });

    it("flags a desktop preset with a sub-1024 width", () => {
      const broken = {
        ...DESKTOP_CHROME_WIN11,
        screen: { ...DESKTOP_CHROME_WIN11.screen, width: 800 },
      };
      expect(validateBrowserProfile(broken)[0]).toContain("width");
    });

    it("flags a UA/UA-CH major-version disagreement", () => {
      const broken: typeof DESKTOP_CHROME_WIN11 = {
        ...DESKTOP_CHROME_WIN11,
        userAgentData: {
          ...DESKTOP_CHROME_WIN11.userAgentData!,
          brands: [
            { brand: "Not.A/Brand", version: "8" },
            { brand: "Chromium", version: "200.0.0.0" },
            { brand: "Google Chrome", version: "200.0.0.0" },
          ],
        },
      };
      expect(validateBrowserProfile(broken)[0]).toContain("disagrees with UA-CH brand version");
    });

    it("flags a UA-CH mobile flag contradicting the device class", () => {
      const broken: typeof DESKTOP_CHROME_WIN11 = {
        ...DESKTOP_CHROME_WIN11,
        userAgentData: { ...DESKTOP_CHROME_WIN11.userAgentData!, mobile: true },
      };
      expect(validateBrowserProfile(broken)[0]).toContain("mobile flag");
    });

    it("flags a Safari or Firefox preset claiming a UA-CH brand list", () => {
      const broken: typeof ENTERPRISE_FIREFOX_LINUX = {
        ...ENTERPRISE_FIREFOX_LINUX,
        userAgentData: { ...DESKTOP_CHROME_WIN11.userAgentData! },
      };
      expect(validateBrowserProfile(broken)[0]).toContain("would not send");
    });

    it("flags a TLS family that does not match the browser", () => {
      const broken: typeof ENTERPRISE_FIREFOX_LINUX = {
        ...ENTERPRISE_FIREFOX_LINUX,
        tls: DESKTOP_CHROME_WIN11.tls,
      };
      expect(validateBrowserProfile(broken)[0]).toContain("does not match browser");
    });

    it("flags a Windows preset shipping a Mesa/OpenGL renderer", () => {
      const broken: typeof DESKTOP_CHROME_WIN11 = {
        ...DESKTOP_CHROME_WIN11,
        webgl: { ...ENTERPRISE_FIREFOX_LINUX.webgl },
      };
      expect(validateBrowserProfile(broken)[0]).toContain("Mesa/OpenGL");
    });

    it("flags a Linux preset shipping a Direct3D renderer", () => {
      const broken: typeof ENTERPRISE_FIREFOX_LINUX = {
        ...ENTERPRISE_FIREFOX_LINUX,
        webgl: { ...DESKTOP_CHROME_WIN11.webgl },
      };
      expect(validateBrowserProfile(broken)[0]).toContain("Direct3D");
    });

    it("flags an en-US locale behind a non-American timezone", () => {
      const broken = { ...DESKTOP_CHROME_WIN11, timezone: "Asia/Tokyo" };
      expect(validateBrowserProfile(broken)[0]).toContain("non-American timezone");
    });
  });

  describe("preset identities", () => {
    it("ships the reference Chrome/Win11 values", () => {
      expect(DESKTOP_CHROME_WIN11.browser).toBe("chrome");
      expect(DESKTOP_CHROME_WIN11.os).toBe("win32");
      expect(DESKTOP_CHROME_WIN11.platform).toBe("Win32");
      expect(DESKTOP_CHROME_WIN11.userAgent).toContain("Windows NT 10.0");
      expect(DESKTOP_CHROME_WIN11.userAgent).toContain("Chrome/131");
      expect(DESKTOP_CHROME_WIN11.webgl.renderer).toContain("Direct3D11");
      expect(DESKTOP_CHROME_WIN11.userAgentData?.brands.map((brand) => brand.brand)).toContain(
        "Google Chrome",
      );
    });

    it("ships an iOS 17 Safari profile with no UA-CH", () => {
      expect(MOBILE_SAFARI_IOS17.browser).toBe("safari");
      expect(MOBILE_SAFARI_IOS17.platform).toBe("iPhone");
      expect(MOBILE_SAFARI_IOS17.userAgent).toContain("iPhone OS 17_4_1");
      expect(MOBILE_SAFARI_IOS17.userAgentData).toBeUndefined();
      expect(MOBILE_SAFARI_IOS17.screen.devicePixelRatio).toBe(3);
      expect(MOBILE_SAFARI_IOS17.webgl.renderer).toBe("Apple GPU");
    });

    it("ships an enterprise Firefox/Linux profile with no UA-CH", () => {
      expect(ENTERPRISE_FIREFOX_LINUX.browser).toBe("firefox");
      expect(ENTERPRISE_FIREFOX_LINUX.platform).toBe("Linux x86_64");
      expect(ENTERPRISE_FIREFOX_LINUX.userAgent).toContain("Firefox/128.0");
      expect(ENTERPRISE_FIREFOX_LINUX.userAgentData).toBeUndefined();
      expect(ENTERPRISE_FIREFOX_LINUX.webgl.renderer).toContain("Mesa Intel");
    });
  });

  describe("presetToFingerprint", () => {
    it("projects every preset field onto the fingerprint shape", () => {
      const fingerprint = presetToFingerprint(DESKTOP_CHROME_WIN11, 42);
      expect(fingerprint.seed).toBe(42);
      expect(fingerprint.deviceClass).toBe(DESKTOP_CHROME_WIN11.deviceClass);
      expect(fingerprint.navigator.platform).toBe(DESKTOP_CHROME_WIN11.platform);
      expect(fingerprint.navigator.hardwareConcurrency).toBe(
        DESKTOP_CHROME_WIN11.hardware.hardwareConcurrency,
      );
      expect(fingerprint.screen).toEqual(DESKTOP_CHROME_WIN11.screen);
      expect(fingerprint.webgl).toEqual(DESKTOP_CHROME_WIN11.webgl);
      expect(fingerprint.timezone).toBe(DESKTOP_CHROME_WIN11.timezone);
    });

    it("carries the UA-CH brands when the browser sends them", () => {
      const fingerprint = presetToFingerprint(DESKTOP_CHROME_WIN11, 1);
      expect(fingerprint.navigator.brands).toBe(DESKTOP_CHROME_WIN11.userAgentData?.brands);
    });

    it("emits an empty brand list for browsers that send no Client Hints", () => {
      expect(presetToFingerprint(MOBILE_SAFARI_IOS17, 1).navigator.brands).toEqual([]);
    });
  });
});
