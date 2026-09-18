/**
 * Behavior tests for the phase summary table. The fixture is the five-column table of the observed visual
 * review bundle, with its right-aligned numeric columns and its log cell holding a filename inside a code span.
 */
import { describe, expect, it } from "vitest";

import {
  allRowsHaveResult,
  COMMAND_SUMMARY_FAIL,
  COMMAND_SUMMARY_PASS,
  formatDurationLabel,
  parseCommandSummary,
} from "../../../src/internal/evidence/command-summary-parser.js";

/** The observed bundle's table, with the duration column carrying the phase durations as the runner timed them. */
const SUMMARY = [
  "| Phase | Result | Duration | Exit | Log |",
  "|---|---:|---:|---:|---|",
  "| Install frozen pnpm dependency graph | PASS | 7.4s | 0 | `install-frozen-pnpm-dependency-graph.log` |",
  "| Install Playwright FFmpeg runtime | PASS | 2.7s | 0 | `install-playwright-ffmpeg-runtime.log` |",
  "| Run visual regression suite | PASS | 124.3s | 0 | `run-visual-regression-suite.log` |",
].join("\r\n");

describe("parseCommandSummary", () => {
  it("reads the observed bundle's table", () => {
    const summary = parseCommandSummary(SUMMARY);
    expect(summary.columns).toEqual(["Phase", "Result", "Duration", "Exit", "Log"]);
    expect(summary.separator).toBe("|---|---:|---:|---:|---|");
    expect(summary.rows).toHaveLength(3);
  });

  it("parses a phase name, verdict, duration, exit code and log filename", () => {
    const row = parseCommandSummary(SUMMARY).rows[0];
    expect(row).toEqual({
      phase: "Install frozen pnpm dependency graph",
      result: "PASS",
      durationSeconds: 7.4,
      exitCode: 0,
      log: "install-frozen-pnpm-dependency-graph.log",
      cells: [
        "Install frozen pnpm dependency graph",
        "PASS",
        "7.4s",
        "0",
        "`install-frozen-pnpm-dependency-graph.log`",
      ],
    });
  });

  it("reads a duration in the hundreds of seconds", () => {
    expect(parseCommandSummary(SUMMARY).rows[2]?.durationSeconds).toBe(124.3);
  });

  it("reports the verdicts the observed bundles spell", () => {
    expect(COMMAND_SUMMARY_PASS).toBe("PASS");
    expect(COMMAND_SUMMARY_FAIL).toBe("FAIL");
  });

  it("reports when every row carries a given verdict", () => {
    const summary = parseCommandSummary(SUMMARY);
    expect(allRowsHaveResult(summary, COMMAND_SUMMARY_PASS)).toBe(true);
    expect(allRowsHaveResult(summary, COMMAND_SUMMARY_FAIL)).toBe(false);
  });

  it("formats a duration the way the table writes it", () => {
    expect(formatDurationLabel(7.386)).toBe("7.4s");
    expect(formatDurationLabel(124.274)).toBe("124.3s");
  });

  it("collects a row whose duration is not a number-with-s as null and keeps its text", () => {
    const summary = parseCommandSummary(
      [
        "| Phase | Result | Duration | Exit | Log |",
        "|---|---|---|---|---|",
        "| Broken phase | FAIL | unknown | 1 | `broken.log` |",
      ].join("\n"),
    );
    expect(summary.rows[0]?.durationSeconds).toBe(null);
    expect(summary.rows[0]?.exitCode).toBe(1);
  });

  it("collects a row whose log cell has no code span as null", () => {
    const summary = parseCommandSummary(
      [
        "| Phase | Result | Duration | Exit | Log |",
        "|---|---|---|---|---|",
        "| No log phase | PASS | 1s | 0 | see output |",
      ].join("\n"),
    );
    expect(summary.rows[0]?.log).toBe(null);
  });

  it("quarantines a row that does not have one cell per column", () => {
    const summary = parseCommandSummary(
      [
        "| Phase | Result | Duration | Exit | Log |",
        "|---|---|---|---|---|",
        "| Install frozen pnpm dependency graph | PASS |",
        "| Run visual regression suite | PASS | 124.3s | 0 | `run-visual-regression-suite.log` |",
      ].join("\n"),
    );
    expect(summary.rows).toHaveLength(1);
    expect(summary.malformedRows).toEqual(["| Install frozen pnpm dependency graph | PASS |"]);
  });

  it("keeps prose around the table as outside lines", () => {
    const summary = parseCommandSummary(
      ["Capture complete.", "", SUMMARY, "", "Three phases ran."].join("\r\n"),
    );
    expect(summary.outsideTable).toEqual(["Capture complete.", "Three phases ran."]);
    expect(summary.rows).toHaveLength(3);
  });

  it("parses a table whose separator row is absent", () => {
    const summary = parseCommandSummary(["| Phase | Result |", "| Install | PASS |"].join("\n"));
    expect(summary.separator).toBe(null);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]?.phase).toBe("Install");
  });

  it("treats an empty document as an empty table", () => {
    const summary = parseCommandSummary("");
    expect(summary.columns).toEqual([]);
    expect(summary.rows).toEqual([]);
    expect(summary.outsideTable).toEqual([]);
    expect(allRowsHaveResult(summary, COMMAND_SUMMARY_PASS)).toBe(false);
  });
});
