import { describe, expect, it } from "vitest";
import {
  feedUrlOverride,
  updatePrereleaseConfig,
  updateSourceConfig,
  updateSupport,
} from "../src/update-support.js";

describe("updatePrereleaseConfig", () => {
  it.each([false, true])("preserves the updater default (%s) when unset or blank", (current) => {
    for (const raw of [undefined, "", "   "]) {
      expect(updatePrereleaseConfig({ PENGUIN_UPDATE_ALLOW_PRERELEASE: raw }, current)).toEqual({
        allowPrerelease: current,
        invalidPrerelease: false,
      });
    }
  });

  it.each([false, true])("explicit settings override the updater default (%s)", (current) => {
    expect(updatePrereleaseConfig({ PENGUIN_UPDATE_ALLOW_PRERELEASE: " 1 " }, current)).toEqual({
      allowPrerelease: true,
      invalidPrerelease: false,
    });
    expect(updatePrereleaseConfig({ PENGUIN_UPDATE_ALLOW_PRERELEASE: " 0 " }, current)).toEqual({
      allowPrerelease: false,
      invalidPrerelease: false,
    });
  });

  it.each([false, true])(
    "reports invalid settings without changing the default (%s)",
    (current) => {
      for (const raw of ["true", "false", "canary", "stable", "2", "-1"]) {
        expect(updatePrereleaseConfig({ PENGUIN_UPDATE_ALLOW_PRERELEASE: raw }, current)).toEqual({
          allowPrerelease: current,
          invalidPrerelease: true,
        });
      }
    },
  );
});

describe("updateSupport", () => {
  it("supports packaged macOS and Windows builds", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(updateSupport({ isPackaged: true, platform, env: {} })).toEqual({ supported: true });
    }
  });

  it("supports Linux only when running as an AppImage", () => {
    const env = { APPIMAGE: "/opt/PenguinHarness.AppImage" };
    expect(updateSupport({ isPackaged: true, platform: "linux", env })).toEqual({
      supported: true,
    });
    // A deb install has no APPIMAGE: updating around dpkg would desync the two.
    expect(updateSupport({ isPackaged: true, platform: "linux", env: {} })).toEqual({
      supported: false,
      reason: "linux-not-appimage",
    });
  });

  it("never updates a dev run, whatever the platform", () => {
    expect(
      updateSupport({ isPackaged: false, platform: "darwin", env: { APPIMAGE: "/x" } }),
    ).toEqual({ supported: false, reason: "dev" });
  });
});

describe("feedUrlOverride", () => {
  it("accepts http(s) URLs and normalizes them", () => {
    expect(feedUrlOverride({ PENGUIN_UPDATE_FEED_URL: "http://127.0.0.1:8080/feed" })).toBe(
      "http://127.0.0.1:8080/feed",
    );
    expect(feedUrlOverride({ PENGUIN_UPDATE_FEED_URL: " https://example.com/u " })).toBe(
      "https://example.com/u",
    );
  });

  it("ignores unset, blank, non-http and unparseable values", () => {
    expect(feedUrlOverride({})).toBeNull();
    expect(feedUrlOverride({ PENGUIN_UPDATE_FEED_URL: "   " })).toBeNull();
    expect(feedUrlOverride({ PENGUIN_UPDATE_FEED_URL: "file:///etc/passwd" })).toBeNull();
    expect(feedUrlOverride({ PENGUIN_UPDATE_FEED_URL: "not a url" })).toBeNull();
  });
});

describe("updateSourceConfig", () => {
  it("defaults to auto with the speed probe on", () => {
    expect(updateSourceConfig({})).toEqual({
      source: "auto",
      probe: true,
      invalidSource: false,
      invalidProbe: false,
    });
  });

  it("accepts every source and the probe switch, trimming whitespace", () => {
    expect(updateSourceConfig({ PENGUIN_UPDATE_SOURCE: " oss " })).toMatchObject({
      source: "oss",
      invalidSource: false,
    });
    expect(updateSourceConfig({ PENGUIN_UPDATE_SOURCE: "github" })).toMatchObject({
      source: "github",
      invalidSource: false,
    });
    expect(updateSourceConfig({ PENGUIN_UPDATE_SOURCE: "auto" })).toMatchObject({
      source: "auto",
      invalidSource: false,
    });
    expect(updateSourceConfig({ PENGUIN_UPDATE_SPEED_PROBE: "1" })).toMatchObject({
      probe: true,
      invalidProbe: false,
    });
    expect(updateSourceConfig({ PENGUIN_UPDATE_SPEED_PROBE: " 0 " })).toMatchObject({
      probe: false,
      invalidProbe: false,
    });
  });

  it("treats unsupported values as defaults and flags them", () => {
    expect(
      updateSourceConfig({ PENGUIN_UPDATE_SOURCE: "mirror", PENGUIN_UPDATE_SPEED_PROBE: "2" }),
    ).toEqual({ source: "auto", probe: true, invalidSource: true, invalidProbe: true });
  });
});
