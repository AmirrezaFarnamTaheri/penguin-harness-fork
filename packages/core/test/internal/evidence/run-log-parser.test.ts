/**
 * Behavior tests for the captured phase log reader and its progress-line grammar. The fixtures are the envelope
 * and stdout of the observed visual review bundle's phase log: ten header lines, an output group holding stdout
 * and stderr, a result envelope with a duration in seconds, and Playwright progress lines carrying the capture
 * timestamp and the runner's escape codes.
 */
import { describe, expect, it } from "vitest";

import {
  parsePhaseLog,
  parseProgressLine,
  phaseProgressLines,
  phaseSection,
  phaseStderrLines,
  phaseStdoutLines,
} from "../../../src/internal/evidence/run-log-parser.js";

const ESC = "\u001b";

/** Header the observed phases write, followed by an output group and a result envelope. */
const ENVELOPE = [
  "phase: Run visual regression suite",
  "command: C:\\Program Files\\nodejs\\pnpm.CMD exec playwright test --config playwright.visual.config.ts --update-snapshots=missing",
  "working_directory: D:\\a\\Scriptor\\Scriptor",
  "started_utc: 2026-09-11T13:22:42.4424048+00:00",
  "workflow: Visual review",
  "job: visual-review",
  "run_id: 34603822218",
  "run_attempt: 1",
  "runner: Windows/X64",
  "pid: 9104",
  "--- output ---",
  "--- stdout ---",
].join("\r\n");

/** Result envelope the observed phases close with. */
const RESULT = [
  "--- result ---",
  "finished_utc: 2026-09-11T13:24:46.7165514+00:00",
  "duration_seconds: 124.274",
  "exit_code: 0",
  "timed_out: False",
].join("\r\n");

const ts = (time: string) => `[2026-09-11T13:24:46.${time}+00:00] `;

/** A few stdout lines in the shape the captured log carries them: timestamped and escaped. */
const STDOUT = [
  `${ts("6322442")}${ESC}[2mRunning ${ESC}[22m31${ESC}[2m tests using ${ESC}[22m1${ESC}[2m worker${ESC}[22m`,
  `${ts("6357375")}${ESC}[1A${ESC}[2K[1/31] e2e\\screenshots.spec.ts:152:1 › main workspace — light mode`,
  `${ts("6757234")}${ESC}[1A${ESC}[2K[10/31] e2e\\screenshots.spec.ts:273:1 › settings panel`,
  `${ts("6768041")}${ESC}[2m${ESC}[2me2e\\screenshots.spec.ts:273:1 › settings panel${ESC}[22m`,
  `${ts("6768042")}BROWSER CONSOLE: verbose [DOM] Password field is not contained in a form %o`,
  `${ts("7019646")}${ESC}[32m  31 passed${ESC}[39m${ESC}[2m (2.0m)${ESC}[22m`,
].join("\r\n");

/** Web-server output the phase captured on stderr, behind its own delimiter. */
const STDERR = [
  "--- stderr ---",
  `${ts("7043938")}${ESC}[2m[WebServer] ${ESC}[22m(!) Some chunks are larger than 500 kB. Consider:`,
].join("\r\n");

describe("parsePhaseLog", () => {
  const log = parsePhaseLog([ENVELOPE, STDOUT, STDERR, RESULT].join("\r\n"));

  it("reads the phase header", () => {
    expect(log.header.phase).toBe("Run visual regression suite");
    expect(log.header.pid).toBe(9104);
    expect(log.header.runAttempt).toBe(1);
  });

  it("keeps the command and working directory with their backslashes intact", () => {
    expect(log.header.command).toBe(
      "C:\\Program Files\\nodejs\\pnpm.CMD exec playwright test --config playwright.visual.config.ts --update-snapshots=missing",
    );
    expect(log.header.workingDirectory).toBe("D:\\a\\Scriptor\\Scriptor");
  });

  it("keeps every header line the phase wrote", () => {
    expect(log.header.entries.map((entry) => entry.key)).toEqual([
      "phase",
      "command",
      "working_directory",
      "started_utc",
      "workflow",
      "job",
      "run_id",
      "run_attempt",
      "runner",
      "pid",
    ]);
  });

  it("nests stdout and stderr inside the output group and reports both", () => {
    expect(log.sections.map((section) => `${section.name}@${section.depth}`)).toEqual([
      "output@0",
      "stdout@1",
      "stderr@1",
      "result@0",
    ]);
  });

  it("reads the result envelope with the duration as a number of seconds", () => {
    expect(log.result).toEqual({
      entries: [
        { key: "finished_utc", value: "2026-09-11T13:24:46.7165514+00:00" },
        { key: "duration_seconds", value: "124.274" },
        { key: "exit_code", value: "0" },
        { key: "timed_out", value: "False" },
      ],
      finishedUtc: "2026-09-11T13:24:46.7165514+00:00",
      durationSeconds: 124.274,
      exitCode: 0,
      timedOut: false,
    });
  });

  it("strips the timestamp and the escapes from every captured stdout line", () => {
    expect(phaseStdoutLines(log)).toEqual([
      "Running 31 tests using 1 worker",
      "[1/31] e2e\\screenshots.spec.ts:152:1 › main workspace — light mode",
      "[10/31] e2e\\screenshots.spec.ts:273:1 › settings panel",
      "e2e\\screenshots.spec.ts:273:1 › settings panel",
      "BROWSER CONSOLE: verbose [DOM] Password field is not contained in a form %o",
      "  31 passed (2.0m)",
    ]);
  });

  it("strips the escapes from the stderr the web server wrote", () => {
    expect(phaseStderrLines(log)).toEqual([
      "[WebServer] (!) Some chunks are larger than 500 kB. Consider:",
    ]);
  });

  it("reports no stderr section for a phase whose child wrote none", () => {
    const withoutStderr = parsePhaseLog([ENVELOPE, STDOUT, RESULT].join("\r\n"));
    expect(phaseSection(withoutStderr, "stderr")).toBeUndefined();
    expect(phaseStderrLines(withoutStderr)).toEqual([]);
  });

  it("reports no result envelope when the log has none", () => {
    const withoutResult = parsePhaseLog([ENVELOPE, STDOUT].join("\r\n"));
    expect(withoutResult.result).toBeUndefined();
  });

  it("reads a phase that never opened an output group", () => {
    const bare = parsePhaseLog(
      ["phase: Install runtime", "--- stdout ---", "Downloading runtime"].join("\r\n"),
    );
    expect(phaseSection(bare, "stdout")?.lines).toEqual(["Downloading runtime"]);
  });
});

describe("parseProgressLine", () => {
  it("reads the plan line the runner opens with, singular or plural", () => {
    expect(parseProgressLine("Running 31 tests using 1 worker")).toEqual({
      kind: "plan",
      tests: 31,
      workers: 1,
    });
    expect(parseProgressLine("Running 4 tests using 3 workers")).toEqual({
      kind: "plan",
      tests: 4,
      workers: 3,
    });
  });

  it("reads a running line with its index, total, location and title", () => {
    expect(parseProgressLine("[10/31] e2e\\screenshots.spec.ts:273:1 › settings panel")).toEqual({
      kind: "running",
      index: 10,
      total: 31,
      file: "e2e\\screenshots.spec.ts",
      line: 273,
      column: 1,
      title: "settings panel",
    });
  });

  it("reads a title that contains the describe separator itself", () => {
    expect(
      parseProgressLine(
        "[22/31] e2e\\visual-review.spec.ts:157:3 › visual review states › inspector preview mode",
      ),
    ).toEqual({
      kind: "running",
      index: 22,
      total: 31,
      file: "e2e\\visual-review.spec.ts",
      line: 157,
      column: 3,
      title: "visual review states › inspector preview mode",
    });
  });

  it("reads the index-free line a finished test prints", () => {
    expect(parseProgressLine("e2e\\screenshots.spec.ts:273:1 › settings panel")).toEqual({
      kind: "test",
      file: "e2e\\screenshots.spec.ts",
      line: 273,
      column: 1,
      title: "settings panel",
    });
  });

  it("reads a summary line of passed tests with its duration label", () => {
    expect(parseProgressLine("  31 passed (2.0m)")).toEqual({
      kind: "summary",
      counts: { passed: 31, failed: undefined, flaky: undefined, skipped: undefined },
      durationLabel: "2.0m",
    });
  });

  it("reads a summary line that mixes outcomes", () => {
    expect(parseProgressLine("  3 failed, 28 passed, 1 flaky (1.2m)")).toEqual({
      kind: "summary",
      counts: { passed: 28, failed: 3, flaky: 1, skipped: undefined },
      durationLabel: "1.2m",
    });
  });

  it("reads a summary line with no duration label", () => {
    expect(parseProgressLine("  2 skipped").kind).toBe("summary");
  });

  it("reads a browser console line with its level", () => {
    expect(
      parseProgressLine(
        "BROWSER CONSOLE: verbose [DOM] Password field is not contained in a form %o",
      ),
    ).toEqual({
      kind: "console",
      level: "verbose",
      text: "[DOM] Password field is not contained in a form %o",
    });
  });

  it("treats anything else the child printed as other text", () => {
    expect(parseProgressLine("Lockfile is up to date, resolution step is skipped")).toEqual({
      kind: "other",
      text: "Lockfile is up to date, resolution step is skipped",
    });
  });
});

describe("phaseProgressLines", () => {
  it("classifies every cleaned stdout line of a phase", () => {
    const kinds = phaseProgressLines(parsePhaseLog([ENVELOPE, STDOUT, RESULT].join("\r\n"))).map(
      (line) => line.kind,
    );
    expect(kinds).toEqual(["plan", "running", "running", "test", "console", "summary"]);
  });
});
