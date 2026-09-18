import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEBGL_IDENTITY,
  FALLBACK_WEBGL_IDENTITY,
  GL_CONSTANT,
  type WebGLIdentity,
  buildWebGlParameterLookup,
  buildWebGlOverrideScript,
  webGlIdentityEquals,
} from "../../src/browser/webgl-parameter-override.js";

describe("webgl parameter override", () => {
  describe("identity constants", () => {
    it("ships the donor's fixed vendor and renderer strings", () => {
      expect(DEFAULT_WEBGL_IDENTITY.vendor).toBe("Google Inc. (NVIDIA)");
      expect(DEFAULT_WEBGL_IDENTITY.renderer).toContain("NVIDIA GeForce GTX 1070");
      expect(DEFAULT_WEBGL_IDENTITY.version).toBe("WebGL 1.0 (OpenGL ES 2.0 Chromium)");
      expect(DEFAULT_WEBGL_IDENTITY.shadingLanguageVersion).toContain("GLSL ES 1.0");
    });

    it("provides a fallback identity distinct from the default", () => {
      expect(FALLBACK_WEBGL_IDENTITY.vendor).not.toBe(DEFAULT_WEBGL_IDENTITY.vendor);
      expect(FALLBACK_WEBGL_IDENTITY.renderer).toContain("Mesa Intel");
    });
  });

  describe("buildWebGlParameterLookup", () => {
    const lookup = buildWebGlParameterLookup();

    it("answers the donor's values for the overridden constants", () => {
      expect(lookup[0x8872]).toBe(8); // GL_MAX_TEXTURE_IMAGE_UNITS
      expect(lookup[0x8824]).toBe(0x20); // GL_MAX_VERTEX_ATTRIBS
      expect(lookup[0x8ca6]).toBe(0x4000);
      expect(lookup[0x85b5]).toBe(1);
    });

    it("returns array-shaped values for the blend parameters", () => {
      expect(lookup[0x1f00]).toEqual([0, 0, 0, 0]);
      expect(lookup[0x8894]).toEqual([0, 0, 0, 0]);
    });

    it("preserves the donor's zero-valued limits rather than tidying them", () => {
      expect(lookup[0x9120]).toBe(0); // GL_SUBPIXEL_BITS
      expect(lookup[0x8b8b]).toBe(0); // GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS
    });

    it("keeps the UNMASKED_* constants the extension patch installs", () => {
      expect(GL_CONSTANT.UNMASKED_VENDOR_WEBGL).toBe(0x9245);
      expect(GL_CONSTANT.UNMASKED_RENDERER_WEBGL).toBe(0x9246);
    });

    it("uses distinct numeric keys throughout (a detector diffs the whole table)", () => {
      // Numeric object keys are unique by construction; the check is that the donor's hex
      // constants did not collapse into one another when transcribed.
      const keys = Object.keys(lookup).map((key) => Number(key));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toContain(0x8872);
      expect(keys).toContain(0x8824);
    });

    it("legitimately repeats VALUES, as the donor's table does", () => {
      // 0x8dfa/0x8dfb both map to 0x20 and the 0x9240–0x9245 block is all zero. Duplicated values
      // are correct — a detector compares the table, not a set of it — so this is asserted, not
      // "tidied".
      expect(lookup[0x8dfa]).toBe(lookup[0x8dfb]);
      expect(lookup[0x9240]).toBe(0);
      expect(new Set(Object.values(lookup)).size).toBeLessThan(Object.keys(lookup).length);
    });
  });

  describe("buildWebGlOverrideScript", () => {
    const script = buildWebGlOverrideScript(DEFAULT_WEBGL_IDENTITY);

    it("is a self-contained IIFE with no external references", () => {
      expect(script.trim().startsWith("(function ()")).toBe(true);
      expect(script.trim().endsWith("})();")).toBe(true);
      expect(script).not.toContain("import");
      expect(script).not.toContain("require");
    });

    it("embeds the identity strings JSON-escaped", () => {
      expect(script).toContain(JSON.stringify(DEFAULT_WEBGL_IDENTITY.vendor));
      expect(script).toContain(JSON.stringify(DEFAULT_WEBGL_IDENTITY.renderer));
    });

    it("patches both canvas hosts and the debug-renderer extension", () => {
      expect(script).toContain("HTMLCanvasElement");
      expect(script).toContain("OffscreenCanvas");
      expect(script).toContain("WEBGL_debug_renderer_info");
      expect(script).toContain("UNMASKED_VENDOR_WEBGL");
      expect(script).toContain("getParameter");
      expect(script).toContain("getSupportedExtensions");
    });

    it("falls back to the default version strings when omitted", () => {
      expect(buildWebGlOverrideScript({ vendor: "v", renderer: "r" })).toContain(
        JSON.stringify(DEFAULT_WEBGL_IDENTITY.version),
      );
    });
  });

  describe("webGlIdentityEquals", () => {
    it("treats omitted version fields as their defaults", () => {
      const a: WebGLIdentity = { vendor: "v", renderer: "r" };
      const b: WebGLIdentity = {
        vendor: "v",
        renderer: "r",
        version: DEFAULT_WEBGL_IDENTITY.version,
        shadingLanguageVersion: DEFAULT_WEBGL_IDENTITY.shadingLanguageVersion,
      };
      expect(webGlIdentityEquals(a, b)).toBe(true);
    });

    it("distinguishes differing renderers", () => {
      expect(
        webGlIdentityEquals({ vendor: "v", renderer: "r1" }, { vendor: "v", renderer: "r2" }),
      ).toBe(false);
    });
  });
});
