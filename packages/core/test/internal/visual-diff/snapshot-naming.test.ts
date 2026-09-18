import { describe, expect, it } from "vitest";

import {
  anonymousSnapshotCaseName,
  baselineCaseKey,
  formatBaselinePath,
  formatTestOutputDirName,
  parseBaselinePath,
  parseTestOutputDirName,
  sanitizeForFilePath,
  trimLongString,
} from "../../../src/internal/visual-diff/snapshot-naming.js";

/**
 * The naming module exists because a visual-regression harness that pairs an actual image
 * with the wrong baseline reports a regression that never happened. Every test below pins a
 * name Playwright actually produces, so a change that breaks the pairing fails here rather
 * than in a CI screenshot.
 */
describe("snapshot naming", () => {
  describe("sanitizeForFilePath", () => {
    it("collapses disallowed character runs to a single dash", () => {
      expect(sanitizeForFilePath("MCP sharing and sync")).toBe("MCP-sharing-and-sync");
      // A run of disallowed characters becomes ONE dash, not one per character.
      expect(sanitizeForFilePath("a/b")).toBe("a-b");
      expect(sanitizeForFilePath("key: value")).toBe("key-value");
      expect(sanitizeForFilePath("a   b")).toBe("a-b");
    });

    it("maps every character outside the allowed range to a dash, underscore included", () => {
      // The ported character class is 0x00-0x2C, 0x2E-0x2F, 0x3A-0x40, 0x5B-0x60, 0x7B-0x7F.
      // 0x5F is `_`, so an underscore becomes a dash — a detail worth pinning, because a
      // sanitizer that preserved underscores would name a different directory than Playwright.
      expect(sanitizeForFilePath("canvas-2_win")).toBe("canvas-2-win");
      expect(sanitizeForFilePath("canvas-2-win")).toBe("canvas-2-win");
      // Only letters, digits, dash and underscore-adjacent allowed points survive; the dot and
      // slash are both disallowed.
      expect(sanitizeForFilePath("a.b")).toBe("a-b");
    });

    it("handles an empty string without throwing", () => {
      expect(sanitizeForFilePath("")).toBe("");
    });
  });

  describe("trimLongString", () => {
    it("returns a name that fits unchanged", () => {
      const name = "short-name";
      expect(trimLongString(name, 100)).toBe(name);
      expect(trimLongString(name, name.length)).toBe(name);
    });

    it("truncates a name that does not fit, keeping head and tail", () => {
      const name = "visual-review-visual-review-states-MCP-sharing-and-sync-inventory";
      const trimmed = trimLongString(name, 60);
      expect(trimmed.length).toBe(60);
      expect(trimmed.startsWith(name.slice(0, 26))).toBe(true);
      expect(trimmed.endsWith(name.slice(-27))).toBe(true);
    });

    it("splices a deterministic hash so two differently-truncated names cannot collide", () => {
      const name = "visual-review-visual-review-states-MCP-sharing-and-sync-inventory";
      // The documented Playwright output, reproduced byte for byte including the hash.
      expect(trimLongString(name, 60)).toBe(
        "visual-review-visual-revie-2bc42--sharing-and-sync-inventory",
      );
      // Same input always yields the same hash.
      expect(trimLongString(name, 60)).toBe(trimLongString(name, 60));
    });

    it("gives different long names different hashes", () => {
      const a = "visual-review-visual-review-states-MCP-sharing-and-sync-inventory";
      const b = "visual-review-visual-review-states-MCP-sharing-and-sync-inventory-X";
      expect(trimLongString(a, 60)).not.toBe(trimLongString(b, 60));
    });
  });

  describe("parseBaselinePath", () => {
    it("splits a platform-suffixed baseline into case and platform", () => {
      const parsed = parseBaselinePath("e2e/screenshots.spec.ts-snapshots/canvas-win32.png");
      expect(parsed?.directory).toBe("e2e/screenshots.spec.ts-snapshots");
      expect(parsed?.specStem).toBe("screenshots.spec.ts");
      expect(parsed?.name.caseName).toBe("canvas");
      expect(parsed?.name.platform).toBe("win32");
      expect(parsed?.name.extension).toBe(".png");
    });

    it("reads a platform-free baseline as one case name", () => {
      const parsed = parseBaselinePath("e2e/screenshots.spec.ts-snapshots/workspace-light.png");
      // `light` is not a platform Playwright writes, so the whole stem is the case.
      expect(parsed?.name.caseName).toBe("workspace-light");
      expect(parsed?.name.platform).toBeUndefined();
    });

    it("accepts windows separators", () => {
      const parsed = parseBaselinePath("e2e\\screenshots.spec.ts-snapshots\\canvas-darwin.png");
      expect(parsed?.specStem).toBe("screenshots.spec.ts");
      expect(parsed?.name.caseName).toBe("canvas");
      expect(parsed?.name.platform).toBe("darwin");
    });

    it("rejects a path outside a snapshots directory", () => {
      expect(parseBaselinePath("e2e/screenshots.spec.ts/canvas-win32.png")).toBeUndefined();
      expect(parseBaselinePath("canvas-win32.png")).toBeUndefined();
    });

    it("rejects a file with no extension", () => {
      expect(parseBaselinePath("e2e/screenshots.spec.ts-snapshots/canvas-win32")).toBeUndefined();
    });

    it("supports extensions of more than one dot", () => {
      const parsed = parseBaselinePath("e2e/screenshots.spec.ts-snapshots/canvas-win32.tar.gz");
      expect(parsed?.name.extension).toBe(".gz");
      expect(parsed?.name.caseName).toBe("canvas-win32.tar");
    });
  });

  describe("formatBaselinePath", () => {
    it("builds a baseline path from its parts", () => {
      expect(formatBaselinePath("screenshots.spec.ts", "canvas", "win32")).toBe(
        "screenshots.spec.ts-snapshots/canvas-win32.png",
      );
      expect(formatBaselinePath("screenshots.spec.ts", "canvas")).toBe(
        "screenshots.spec.ts-snapshots/canvas.png",
      );
    });

    it("round-trips through parseBaselinePath", () => {
      const path = formatBaselinePath("screenshots.spec.ts", "workspace-light", "linux", ".webp");
      const parsed = parseBaselinePath(path);
      expect(parsed?.specStem).toBe("screenshots.spec.ts");
      expect(parsed?.name.caseName).toBe("workspace-light");
      expect(parsed?.name.platform).toBe("linux");
      expect(parsed?.name.extension).toBe(".webp");
    });
  });

  describe("baselineCaseKey", () => {
    it("keys a baseline by case alone, so one case keeps one baseline per platform", () => {
      expect(baselineCaseKey({ caseName: "canvas", platform: "win32", extension: ".png" })).toBe(
        "canvas",
      );
      expect(baselineCaseKey({ caseName: "canvas", platform: "darwin", extension: ".png" })).toBe(
        "canvas",
      );
    });
  });

  describe("parseTestOutputDirName", () => {
    it("parses a truncated name, recovering the hash and the surviving title tail", () => {
      const parsed = parseTestOutputDirName(
        "visual-review-visual-revie-2bc42--sharing-and-sync-inventory",
      );
      expect(parsed?.specPath).toBe("visual-review-visual-revie");
      expect(parsed?.titleSlug).toBe("sharing-and-sync-inventory");
      expect(parsed?.truncated).toBe(true);
      expect(parsed?.hash).toBe("2bc42");
      expect(parsed?.retry).toBeUndefined();
      expect(parsed?.repeatEachIndex).toBeUndefined();
    });

    it("parses an un-truncated name at its last dash", () => {
      const parsed = parseTestOutputDirName("e2e-short-spec-canvas-renders");
      expect(parsed?.specPath).toBe("e2e-short-spec-canvas");
      expect(parsed?.titleSlug).toBe("renders");
      expect(parsed?.truncated).toBe(false);
      expect(parsed?.hash).toBeUndefined();
    });

    it("strips a retry suffix from the right before parsing the title", () => {
      const parsed = parseTestOutputDirName("spec-case-retry1");
      expect(parsed?.titleSlug).toBe("case");
      expect(parsed?.specPath).toBe("spec");
      expect(parsed?.retry).toBe(1);
    });

    it("strips a repeat-each suffix after the retry suffix", () => {
      const parsed = parseTestOutputDirName("spec-case-retry1-repeat2");
      expect(parsed?.titleSlug).toBe("case");
      expect(parsed?.retry).toBe(1);
      expect(parsed?.repeatEachIndex).toBe(2);
    });

    it("keeps a title path that ends in a number when no retry suffix is present", () => {
      // `-retry` must be followed by digits and end the name; a title ending in "retry" is not one.
      const parsed = parseTestOutputDirName("spec-case-retry");
      expect(parsed?.titleSlug).toBe("retry");
      expect(parsed?.retry).toBeUndefined();
    });

    it("rejects a name with no dash", () => {
      expect(parseTestOutputDirName("nodashes")).toBeUndefined();
    });
  });

  describe("formatTestOutputDirName", () => {
    it("names a short test's output directory without truncation", () => {
      expect(
        formatTestOutputDirName({
          specPath: "e2e/short.spec",
          titlePath: ["canvas", "renders"],
        }),
      ).toBe("e2e-short-spec-canvas-renders");
    });

    it("reproduces Playwright's truncated name for a long title, hash included", () => {
      // The observed bundle name, reproduced from the parts Playwright had.
      expect(
        formatTestOutputDirName({
          specPath: "visual-review/visual-review-states",
          titlePath: ["MCP", "sharing", "and", "sync", "inventory"],
        }),
      ).toBe("visual-review-visual-revie-2bc42--sharing-and-sync-inventory");
    });

    it("appends project, retry and repeat-each suffixes after the name", () => {
      expect(
        formatTestOutputDirName({
          specPath: "e2e/short.spec",
          titlePath: ["case"],
          projectId: "chromium",
          retry: 1,
          repeatEachIndex: 2,
        }),
      ).toBe("e2e-short-spec-case-chromium-retry1-repeat2");
    });

    it("omits the project id when the run had one project", () => {
      expect(formatTestOutputDirName({ specPath: "e2e/short.spec", titlePath: ["case"] })).toBe(
        "e2e-short-spec-case",
      );
    });

    it("round-trips through parseTestOutputDirName for a truncated name", () => {
      const formatted = formatTestOutputDirName({
        specPath: "visual-review/visual-review-states",
        titlePath: ["MCP", "sharing", "and", "sync", "inventory"],
      });
      const parsed = parseTestOutputDirName(formatted);
      expect(parsed?.truncated).toBe(true);
      expect(parsed?.hash).toBe("2bc42");
      expect(parsed?.titleSlug).toBe("sharing-and-sync-inventory");
    });
  });

  describe("anonymousSnapshotCaseName", () => {
    it("derives a case name from the title path and the call index", () => {
      expect(anonymousSnapshotCaseName(["canvas", "renders"], 0)).toBe("canvas-renders-0");
      expect(anonymousSnapshotCaseName(["canvas"], 3)).toBe("canvas-3");
    });

    it("truncates a long derived name the way an anonymous snapshot is truncated", () => {
      const derived = anonymousSnapshotCaseName(
        ["visual", "review", "states", "MCP", "sharing", "and", "sync", "inventory"],
        12,
      );
      // The sanitizer also applies here, so the trailing index is separated by a dash.
      expect(derived).toMatch(/-12$/);
      // A truncated name is bounded, not unbounded.
      expect(derived.length).toBeLessThanOrEqual(100);
    });
  });
});
