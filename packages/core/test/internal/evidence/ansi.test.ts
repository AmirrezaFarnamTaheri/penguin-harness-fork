/**
 * Behavior tests for the escape-sequence and timestamp handling of captured CI log lines. The fixtures below
 * are lines taken from a captured visual-regression phase log, which writes a capture timestamp, then the test
 * runner's SGR codes and the cursor-control codes that made the live progress line overwrite itself.
 */
import { describe, expect, it } from "vitest";

import {
  cleanLogLine,
  cleanLogLines,
  stripAnsi,
  stripAnsiFromLines,
  stripLogTimestamp,
} from "../../../src/internal/evidence/ansi.js";

const ESC = "\u001b";

describe("stripAnsi", () => {
  it("removes dim and color SGR codes", () => {
    expect(
      stripAnsi(
        `${ESC}[2mRunning ${ESC}[22m31${ESC}[2m tests using ${ESC}[22m1${ESC}[2m worker${ESC}[22m`,
      ),
    ).toBe("Running 31 tests using 1 worker");
  });

  it("removes multi-parameter SGR codes such as bright color", () => {
    expect(stripAnsi(`${ESC}[33;1m${ESC}[0m warning`)).toBe(" warning");
  });

  it("removes cursor-control codes that a stored line accumulates", () => {
    expect(
      stripAnsi(`${ESC}[1A${ESC}[2K[10/31] e2e\\screenshots.spec.ts:273:1 › settings panel`),
    ).toBe("[10/31] e2e\\screenshots.spec.ts:273:1 › settings panel");
  });

  it("leaves text without escapes untouched", () => {
    expect(stripAnsi("Scope: all 18 workspace projects")).toBe("Scope: all 18 workspace projects");
  });

  it("leaves the escape-free characters of a percent-formatted console line untouched", () => {
    expect(stripAnsi("BROWSER CONSOLE: verbose [DOM] Password field %o")).toBe(
      "BROWSER CONSOLE: verbose [DOM] Password field %o",
    );
  });
});

describe("stripAnsiFromLines", () => {
  it("strips each line independently and preserves line count", () => {
    const lines = [`${ESC}[2mone${ESC}[22m`, "two", `${ESC}[32mdone${ESC}[39m`];
    expect(stripAnsiFromLines(lines)).toEqual(["one", "two", "done"]);
    expect(stripAnsiFromLines(lines)).toHaveLength(3);
  });
});

describe("stripLogTimestamp", () => {
  it("removes an ISO-8601 capture prefix and reports it", () => {
    const { timestamp, text } = stripLogTimestamp(
      "[2026-09-11T13:24:46.6322442+00:00] Running 31 tests",
    );
    expect(timestamp).toBe("2026-09-11T13:24:46.6322442+00:00");
    expect(text).toBe("Running 31 tests");
  });

  it("leaves the escapes that follow the timestamp for a later pass", () => {
    const { text } = stripLogTimestamp(
      `[2026-09-11T13:24:46.6357375+00:00] ${ESC}[1A${ESC}[2K[1/31] case`,
    );
    expect(text).toBe(`${ESC}[1A${ESC}[2K[1/31] case`);
  });

  it("reports no timestamp for a line the child wrote without a prefix", () => {
    expect(stripLogTimestamp("Lockfile is up to date, resolution step is skipped")).toEqual({
      timestamp: undefined,
      text: "Lockfile is up to date, resolution step is skipped",
    });
  });

  it("does not mistake a bracketed run id for a capture timestamp", () => {
    const { timestamp, text } = stripLogTimestamp(
      "[WebServer] (!) Some chunks are larger than 500 kB",
    );
    expect(timestamp).toBeUndefined();
    expect(text).toBe("[WebServer] (!) Some chunks are larger than 500 kB");
  });
});

describe("cleanLogLine", () => {
  it("removes the capture timestamp and every escape in one pass", () => {
    expect(
      cleanLogLine(
        `[2026-09-11T13:24:46.6357375+00:00] ${ESC}[1A${ESC}[2K[1/31] e2e\\screenshots.spec.ts:152:1 › main workspace`,
      ),
    ).toBe("[1/31] e2e\\screenshots.spec.ts:152:1 › main workspace");
  });

  it("is applied to a whole captured stream by cleanLogLines", () => {
    expect(
      cleanLogLines([
        `[2026-09-11T13:22:38.6037550+00:00] Scope: all 18 workspace projects`,
        `[2026-09-11T13:22:38.6120964+00:00] Packages: ${ESC}[32m+536${ESC}[39m`,
      ]),
    ).toEqual(["Scope: all 18 workspace projects", "Packages: +536"]);
  });
});
