import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GREASE_CODEPOINTS,
  type TlsFingerprintProfile,
  buildTlsFingerprintProfile,
  buildCipherSuiteList,
  serializeJa3Record,
  serializeJa4Record,
  validateTlsFingerprintProfile,
} from "../../src/browser/tls-fingerprint-profile.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("tls fingerprint profile", () => {
  describe("buildCipherSuiteList", () => {
    it("places a GREASE codepoint at the head", () => {
      const list = buildCipherSuiteList("chrome", 3);
      const grease = GREASE_CODEPOINTS[3]!;
      expect(list[0]).toBe(grease);
      expect(list.slice(1)).not.toContain(grease);
    });

    it("lists TLS 1.3 suites before TLS 1.2 suites", () => {
      const list = buildCipherSuiteList("chrome", 0).slice(1);
      const firstTls12 = list.findIndex((suite) => suite < 0x1300);
      const lastTls13 = list
        .map((suite, index) => (suite >= 0x1300 && suite <= 0x1305 ? index : -1))
        .reduce((a, b) => Math.max(a, b));
      expect(firstTls12).toBeGreaterThan(lastTls13);
    });

    it("differs between browser families", () => {
      const chrome = buildCipherSuiteList("chrome", 0);
      const firefox = buildCipherSuiteList("firefox", 0);
      expect(chrome).not.toEqual(firefox);
    });

    it("contains no duplicates", () => {
      for (const family of ["chrome", "firefox", "safari"] as const) {
        const list = buildCipherSuiteList(family, 0);
        expect(new Set(list).size).toBe(list.length);
      }
    });

    it("includes the standardized TLS 1.3 suites", () => {
      const list = buildCipherSuiteList("chrome", 0);
      expect(list).toContain(0x1301);
      expect(list).toContain(0x1302);
      expect(list).toContain(0x1303);
    });
  });

  describe("buildTlsFingerprintProfile", () => {
    it("carries the family through to the profile", () => {
      expect(buildTlsFingerprintProfile("firefox").family).toBe("firefox");
    });

    it("greases the cipher, extension and group lists consistently", () => {
      const profile = buildTlsFingerprintProfile("chrome", 5);
      const grease = GREASE_CODEPOINTS[5]!;
      expect(profile.cipherSuites[0]).toBe(grease);
      expect(profile.extensions[0]).toBe(grease);
      expect(profile.supportedGroups[0]).toBe(grease);
    });

    it("dedupes the extension list", () => {
      const profile = buildTlsFingerprintProfile("chrome");
      expect(new Set(profile.extensions).size).toBe(profile.extensions.length);
    });

    it("keeps the ALPN preference order", () => {
      expect(buildTlsFingerprintProfile("chrome").alpn).toEqual(["h2", "http/1.1"]);
    });
  });

  describe("serializeJa3Record", () => {
    it("joins the five fields with the record version and hex-pads values", () => {
      const record = serializeJa3Record(buildTlsFingerprintProfile("chrome"));
      const fields = record.split(",");
      expect(fields).toHaveLength(5);
      expect(fields[0]).toBe("771");
      expect(fields[1]).toContain("1301");
      expect(fields[1]).toContain("-");
      // Every hex group is four characters wide.
      for (const group of [fields[1]!, fields[2]!, fields[3]!].flatMap((field) =>
        field.split("-"),
      )) {
        expect(group).toHaveLength(4);
      }
      expect(fields[4]).toBe("0");
    });

    it("is stable for a stable profile", () => {
      expect(serializeJa3Record(buildTlsFingerprintProfile("chrome"))).toBe(
        serializeJa3Record(buildTlsFingerprintProfile("chrome")),
      );
    });

    it("differs between families", () => {
      expect(serializeJa3Record(buildTlsFingerprintProfile("chrome"))).not.toBe(
        serializeJa3Record(buildTlsFingerprintProfile("safari")),
      );
    });
  });

  describe("serializeJa4Record", () => {
    it("renders the t_q_d_h1_h2 shape with truncated hashes", () => {
      const record = serializeJa4Record(buildTlsFingerprintProfile("chrome"), sha256Hex);
      const fields = record.split("_");
      expect(fields).toHaveLength(5);
      expect(fields[0]).toBe("t13");
      expect(fields[1]).toBe("d");
      expect(fields[2]).toHaveLength(2);
      expect(fields[3]).toHaveLength(12);
      expect(fields[4]).toHaveLength(12);
    });

    it("flips the SNI field to i when the name is absent", () => {
      const profile = buildTlsFingerprintProfile("chrome");
      expect(serializeJa4Record(profile, sha256Hex, true).split("_")[1]).toBe("d");
      expect(serializeJa4Record(profile, sha256Hex, false).split("_")[1]).toBe("i");
    });

    it("hashes deterministically for the same profile", () => {
      expect(serializeJa4Record(buildTlsFingerprintProfile("chrome"), sha256Hex)).toBe(
        serializeJa4Record(buildTlsFingerprintProfile("chrome"), sha256Hex),
      );
    });
  });

  describe("validateTlsFingerprintProfile", () => {
    it("accepts every built profile", () => {
      for (const family of ["chrome", "firefox", "safari"] as const) {
        expect(validateTlsFingerprintProfile(buildTlsFingerprintProfile(family))).toEqual([]);
      }
    });

    it("flags a duplicate cipher suite", () => {
      const profile: TlsFingerprintProfile = buildTlsFingerprintProfile("chrome");
      const duplicated: TlsFingerprintProfile = {
        ...profile,
        cipherSuites: [...profile.cipherSuites, profile.cipherSuites[1]!],
      };
      expect(validateTlsFingerprintProfile(duplicated)[0]).toContain("duplicate cipher suite");
    });

    it("flags a missing GREASE codepoint", () => {
      const profile = buildTlsFingerprintProfile("chrome");
      const stripped: TlsFingerprintProfile = {
        ...profile,
        cipherSuites: profile.cipherSuites.slice(1),
      };
      const problems = validateTlsFingerprintProfile(stripped);
      expect(problems.some((problem) => problem.includes("GREASE"))).toBe(true);
    });

    it("flags an empty cipher list", () => {
      const profile = buildTlsFingerprintProfile("chrome");
      expect(validateTlsFingerprintProfile({ ...profile, cipherSuites: [] })[0]).toContain(
        "cipher suite list is empty",
      );
    });
  });

  describe("GREASE codepoints", () => {
    it("are the RFC 8701 repeated-nibble values", () => {
      expect(GREASE_CODEPOINTS[0]).toBe(0x0a0a);
      expect(GREASE_CODEPOINTS[15]).toBe(0xfafa);
      expect(GREASE_CODEPOINTS).toHaveLength(16);
    });
  });
});
