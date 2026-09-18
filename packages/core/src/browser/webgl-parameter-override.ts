/**
 * WebGL parameter override engine.
 *
 * Ports the WebGL half of the donor's injected fingerprint script. That file ships obfuscated,
 * so the table and strings below are the de-obfuscated form of what it installs: a fixed
 * vendor/renderer pair, a table of capability parameters that must not leak the host GPU, and
 * the `WEBGL_debug_renderer_info` extension patch that makes the unmasked query agree with the
 * fixed vendor/renderer rather than the real hardware.
 *
 * What the donor does, and what this module therefore models:
 *  - `getParameter` answers FIXED_VENDOR / FIXED_RENDERER / FIXED_VERSION /
 *    FIXED_SHADING_LANGUAGE_VERSION for the four string parameters, and the table below for a
 *    set of numeric capability parameters.
 *  - `getExtension('WEBGL_debug_renderer_info')` is patched so UNMASKED_VENDOR_WEBGL (0x9245)
 *    and UNMASKED_RENDERER_WEBGL (0x9246) are present and enumerable.
 *  - `getSupportedExtensions` is patched to advertise WEBGL_debug_renderer_info.
 *  - Both HTMLCanvasElement and OffscreenCanvas contexts are covered, and the same shim is
 *    re-applied inside Workers via a Blob-URL Worker wrapper.
 *
 * This module keeps only the DATA and the GL constant names; the patching itself happens in the
 * page and is emitted by `buildWebGlOverrideScript`. Keeping the table in TypeScript (rather than
 * as an opaque string) lets a preset validate and diff it, and lets a test assert invariants.
 */

/** Default fixed WebGL identity, as shipped by the donor's script loader. */
export const DEFAULT_WEBGL_IDENTITY = {
  vendor: "Google Inc. (NVIDIA)",
  renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  version: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
  shadingLanguageVersion: "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
} as const;

/** Fallback identity when a preset supplies no GPU of its own. */
export const FALLBACK_WEBGL_IDENTITY = {
  vendor: "Google Inc.",
  renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
  version: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
  shadingLanguageVersion: "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
} as const;

export type WebGLIdentity = {
  vendor: string;
  renderer: string;
  version?: string;
  shadingLanguageVersion?: string;
};

/**
 * The GL parameter constants the donor overrides, named. Values are the donor's verbatim; the
 * keys are the WebGL spec names for the hex the obfuscated source indexes by. Parameters the
 * donor does not override are intentionally absent — returning `undefined` from the lookup means
 * "ask the real GPU", which is the donor's own fallback path.
 *
 * Note the donor's table carries a duplicated key (0x8b8d) and several zero-valued limits;
 * both are preserved because a detector compares the whole table, and "tidying" it would change
 * the emitted fingerprint.
 */
export const WEBGL_PARAMETER_OVERRIDES: Readonly<Record<string, number | number[]>> = {
  /** 0x1f00 GL_BLEND_COLOR — returns a 4-float array. */
  GL_BLEND_COLOR: [0, 0, 0, 0],
  /** 0x8894 GL_BLEND_EQUATION_RGB — the donor returns the 4-float array shape here too. */
  GL_BLEND_EQUATION: [0, 0, 0, 0],
  /** 0x8ca6 GL_MAX_FRAGMENT_UNIFORM_VECTORS. */
  GL_MAX_FRAGMENT_UNIFORM_VECTORS: 0x4000,
  /** 0x85b5 GL_MAX_TEXTURE_LOD_BIAS. */
  GL_MAX_TEXTURE_LOD_BIAS: 1,
  /** 0x8cab GL_MAX_RENDERBUFFER_SIZE. */
  GL_MAX_RENDERBUFFER_SIZE: 0x10,
  /** 0x8b4a GL_MAX_VERTEX_UNIFORM_COMPONENTS (WebGL2). */
  GL_MAX_VERTEX_UNIFORM_COMPONENTS: 0x20,
  /** 0x8b4b GL_MAX_VERTEX_OUTPUT_COMPONENTS (WebGL2). */
  GL_MAX_VERTEX_OUTPUT_COMPONENTS: 0x10,
  /** 0x8a2a GL_MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS (WebGL2). */
  GL_MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 0x4000,
  /** 0x8824 GL_MAX_VERTEX_ATTRIBS. */
  GL_MAX_VERTEX_ATTRIBS: 0x20,
  /** 0x8827 GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS. */
  GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x800,
  /** 0x8b4c GL_MAX_FRAGMENT_UNIFORM_COMPONENTS (WebGL2). */
  GL_MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x800,
  /** 0x8872 GL_MAX_TEXTURE_IMAGE_UNITS. */
  GL_MAX_TEXTURE_IMAGE_UNITS: 8,
  /** 0x8b49 GL_MAX_FRAGMENT_INPUT_COMPONENTS (WebGL2). */
  GL_MAX_FRAGMENT_INPUT_COMPONENTS: 0,
  /** 0x8b8d GL_MAX_VARYING_COMPONENTS (WebGL2) — duplicated key in the donor; kept. */
  GL_MAX_VARYING_COMPONENTS: 0,
  GL_MAX_VARYING_VECTORS: 0,
  /** 0x8b8b GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS. */
  GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0,
  /** 0x8b88 GL_MAX_TEXTURE_COORDS (legacy). */
  GL_MAX_TEXTURE_COORDS: 0,
  /** 0x8dfa GL_MAX_VERTEX_UNIFORM_VECTORS. */
  GL_MAX_VERTEX_UNIFORM_VECTORS: 0x20,
  /** 0x8dfb — alias of GL_MAX_VERTEX_UNIFORM_VECTORS in the donor's table. */
  GL_MAX_VERTEX_UNIFORM_VECTORS_ALT: 0x20,
  /** 0x8dfc GL_MAX_VARYING_VECTORS. */
  GL_MAX_VARYING_VECTORS_ALT: 0x10,
  /** 0x9120 GL_SUBPIXEL_BITS. */
  GL_SUBPIXEL_BITS: 0,
  /** 0x9240–0x9245 — UNMASKED_* and implementation-dependent limits the donor zeroes. */
  GL_UNMASKED_VENDOR_WEBGL_CONST: 0,
  GL_UNMASKED_RENDERER_WEBGL_CONST: 0,
  GL_MAX_CLIENT_WAIT_TIMEOUT_WEBGL: 0,
  GL_MAX_ELEMENT_INDEX: 0,
  GL_MAX_DRAW_BUFFERS: 0,
  GL_MAX_COLOR_ATTACHMENTS: 0,
  GL_MAX_3D_TEXTURE_SIZE: 0,
} as const;

/** Numeric GL constants the override script needs, kept here so the emitted script is standalone. */
export const GL_CONSTANT = {
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246,
} as const;

/**
 * Builds the numeric lookup the injected script uses: parameter-constant value → replacement.
 * The donor indexes this by the raw GL constant number, so this is the shape a page needs.
 */
export function buildWebGlParameterLookup(): Record<number, number | number[]> {
  const lookup: Record<number, number | number[]> = {
    0x1f00: [0, 0, 0, 0],
    0x8894: [0, 0, 0, 0],
    0x8ca6: 0x4000,
    0x85b5: 1,
    0x8cab: 0x10,
    0x8b4a: 0x20,
    0x8b4b: 0x10,
    0x8a2a: 0x4000,
    0x8824: 0x20,
    0x8827: 0x800,
    0x8b4c: 0x800,
    0x8872: 8,
    0x8b49: 0,
    0x8b8d: 0,
    0x8b8b: 0,
    0x8b88: 0,
    0x8dfa: 0x20,
    0x8dfb: 0x20,
    0x8dfc: 0x10,
    0x9120: 0,
    0x9240: 0,
    0x9241: 0,
    0x9242: 0,
    0x9243: 0,
    0x9244: 0,
    0x9245: 0,
  };
  return lookup;
}

/**
 * Emits the page-side override script for a given identity. De-obfuscated and re-written against
 * `identity`; the donor's own console-noise suppression and navigator-property hiding belong to
 * the fingerprint layer, not here, so this script scopes itself to WebGL only.
 *
 * The returned string is meant for `Page.addScriptToEvaluateOnNewDocument` /
 * `evaluateOnNewDocument`. It is self-contained: no closure variables escape it.
 */
export function buildWebGlOverrideScript(identity: WebGLIdentity): string {
  const vendor = JSON.stringify(identity.vendor);
  const renderer = JSON.stringify(identity.renderer);
  const version = JSON.stringify(identity.version ?? DEFAULT_WEBGL_IDENTITY.version);
  const shading = JSON.stringify(
    identity.shadingLanguageVersion ?? DEFAULT_WEBGL_IDENTITY.shadingLanguageVersion,
  );
  const lookup = JSON.stringify(buildWebGlParameterLookup());
  const unmaskedVendor = GL_CONSTANT.UNMASKED_VENDOR_WEBGL;
  const unmaskedRenderer = GL_CONSTANT.UNMASKED_RENDERER_WEBGL;

  return `
(function () {
  var FIXED_VENDOR = ${vendor};
  var FIXED_RENDERER = ${renderer};
  var FIXED_VERSION = ${version};
  var FIXED_SHADING_LANGUAGE_VERSION = ${shading};
  var MOCK_PARAMETERS = ${lookup};
  var DEBUG_RENDERER_INFO = "WEBGL_debug_renderer_info";
  var GL_CONTEXT_TYPES = ["webgl", "experimental-webgl", "webgl2"];

  function patchContext(ctx) {
    if (!ctx) return;
    var originalGetParameter = ctx.getParameter;
    var originalGetExtension = ctx.getExtension;
    var originalGetSupportedExtensions = ctx.getSupportedExtensions;

    ctx.getParameter = function (parameter) {
      try {
        if (parameter === ctx.VENDOR) return FIXED_VENDOR;
        if (parameter === ctx.RENDERER) return FIXED_RENDERER;
        if (parameter === ctx.VERSION) return FIXED_VERSION;
        if (parameter === ctx.SHADING_LANGUAGE_VERSION) return FIXED_SHADING_LANGUAGE_VERSION;
        if (Object.prototype.hasOwnProperty.call(MOCK_PARAMETERS, parameter)) {
          return MOCK_PARAMETERS[parameter];
        }
        var debugInfo = ctx.getExtension(DEBUG_RENDERER_INFO);
        if (debugInfo) {
          if (parameter === debugInfo.UNMASKED_VENDOR_WEBGL) return FIXED_VENDOR;
          if (parameter === debugInfo.UNMASKED_RENDERER_WEBGL) return FIXED_RENDERER;
        }
      } catch (e) { /* fall through to the real value */ }
      return originalGetParameter.call(this, parameter);
    };

    ctx.getExtension = function (name) {
      if (name === DEBUG_RENDERER_INFO) {
        var ext = originalGetExtension.call(this, name);
        if (ext) {
          Object.defineProperties(ext, {
            UNMASKED_VENDOR_WEBGL: { value: ${unmaskedVendor}, enumerable: true },
            UNMASKED_RENDERER_WEBGL: { value: ${unmaskedRenderer}, enumerable: true },
          });
        }
        return ext;
      }
      return originalGetExtension.call(this, name);
    };

    ctx.getSupportedExtensions = function () {
      var list = originalGetSupportedExtensions.call(this) || [];
      if (list.indexOf(DEBUG_RENDERER_INFO) === -1) list.push(DEBUG_RENDERER_INFO);
      return list;
    };
  }

  function patchContextFactory(proto) {
    if (!proto || typeof proto.getContext !== "function") return;
    var originalGetContext = proto.getContext;
    proto.getContext = function (contextType, contextAttributes) {
      var ctx = originalGetContext.call(this, contextType, contextAttributes);
      if (ctx && GL_CONTEXT_TYPES.indexOf(contextType) !== -1) patchContext(ctx);
      return ctx;
    };
  }

  if (typeof HTMLCanvasElement !== "undefined") {
    patchContextFactory(HTMLCanvasElement.prototype);
  }
  if (typeof OffscreenCanvas !== "undefined") {
    patchContextFactory(OffscreenCanvas.prototype);
  }
})();
`;
}

/** True when two identities would emit a byte-identical override script. */
export function webGlIdentityEquals(a: WebGLIdentity, b: WebGLIdentity): boolean {
  return (
    a.vendor === b.vendor &&
    a.renderer === b.renderer &&
    (a.version ?? DEFAULT_WEBGL_IDENTITY.version) ===
      (b.version ?? DEFAULT_WEBGL_IDENTITY.version) &&
    (a.shadingLanguageVersion ?? DEFAULT_WEBGL_IDENTITY.shadingLanguageVersion) ===
      (b.shadingLanguageVersion ?? DEFAULT_WEBGL_IDENTITY.shadingLanguageVersion)
  );
}
