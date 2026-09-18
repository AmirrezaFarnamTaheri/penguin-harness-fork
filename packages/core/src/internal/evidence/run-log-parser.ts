/**
 * Parse a captured phase log: the header/sections/result envelope plus the test-runner progress lines inside it.
 *
 * Provenance: each captured log in a CI evidence bundle is a shell phase, not a raw transcript. A fixed envelope
 * opens it — ten key/value lines naming the phase, the command, the working directory and the run that captured
 * it — followed by delimiter-marked sections. The sections nest: `--- output ---` opens the phase's output and
 * holds `--- stdout ---` and, when the child wrote one, `--- stderr ---`; `--- result ---` closes the log with
 * the finish time, the duration in seconds, the exit code and a `timed_out` flag. The install phases write no
 * `--- stderr ---` section at all, so a reader that assumes one is there will fail on the clean phases.
 *
 * Inside stdout, each captured line carries the capture timestamp and the child's escape bytes, so the progress
 * lines are only reachable through the ANSI and timestamp helpers in `./ansi.ts`. What is left is the test
 * runner's own progress grammar: a `Running N tests using M workers` plan line, `[n/total] file:line:column ›
 * title` as each test starts, the same `file:line:column › title` without an index once the test finished, and a
 * trailing `N passed (duration)` summary. The separator between location and title is ` › ` and a title can
 * itself contain ` › ` when a test lives in a `describe` block, so the location is anchored on the trailing
 * `line:column` pair and everything after the *first* separator is the title.
 */

import { cleanLogLine, stripAnsi, stripLogTimestamp } from "./ansi.js";

/** A key/value line of the log envelope, in the snake_case form it is written in. */
export interface PhaseEnvelopeEntry {
  key: string;
  value: string;
}

/** The opening envelope of a phase log, with the fields the observed logs always state. */
export interface PhaseHeader {
  entries: PhaseEnvelopeEntry[];
  phase: string | undefined;
  command: string | undefined;
  workingDirectory: string | undefined;
  startedUtc: string | undefined;
  workflow: string | undefined;
  job: string | undefined;
  runId: string | undefined;
  runAttempt: number | undefined;
  runner: string | undefined;
  pid: number | undefined;
}

/** The closing envelope of a phase log. */
export interface PhaseResult {
  entries: PhaseEnvelopeEntry[];
  finishedUtc: string | undefined;
  /** Duration in seconds as the log writes it, e.g. `124.274`. */
  durationSeconds: number | undefined;
  exitCode: number | undefined;
  timedOut: boolean | undefined;
}

/** One delimiter-marked section. `depth` records the nesting: `output` and `result` are at the top level. */
export interface PhaseSection {
  name: string;
  depth: number;
  /** Raw lines as captured, timestamps and escapes included. */
  lines: string[];
}

/** A captured phase log. */
export interface PhaseLog {
  header: PhaseHeader;
  sections: PhaseSection[];
  result: PhaseResult | undefined;
}

/** Delimiter line, e.g. `--- stdout ---`. */
const SECTION_DELIMITER = /^-{2,}\s*([a-z_]+)\s*-{2,}$/;

/** A header or result key/value line, e.g. `duration_seconds: 124.274`. */
const ENVELOPE_LINE = /^([a-z_]+):\s*(.*)$/;

function parseEnvelope(lines: string[]): { entries: PhaseEnvelopeEntry[]; consumed: number } {
  const entries: PhaseEnvelopeEntry[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (SECTION_DELIMITER.test(line)) break;
    const match = ENVELOPE_LINE.exec(line);
    if (!match) break;
    entries.push({ key: match[1] ?? "", value: match[2] ?? "" });
    index += 1;
  }
  return { entries, consumed: index };
}

function envelopeValue(entries: PhaseEnvelopeEntry[], key: string): string | undefined {
  for (const entry of entries) if (entry.key === key) return entry.value;
  return undefined;
}

/** Parse a captured phase log. Sections that are absent are simply absent, never synthesized as empty. */
export function parsePhaseLog(text: string): PhaseLog {
  const lines = text.split(/\r?\n/);

  const headerParsed = parseEnvelope(lines);
  const headerEntries = headerParsed.entries;
  const header: PhaseHeader = {
    entries: headerEntries,
    phase: envelopeValue(headerEntries, "phase"),
    command: envelopeValue(headerEntries, "command"),
    workingDirectory: envelopeValue(headerEntries, "working_directory"),
    startedUtc: envelopeValue(headerEntries, "started_utc"),
    workflow: envelopeValue(headerEntries, "workflow"),
    job: envelopeValue(headerEntries, "job"),
    runId: envelopeValue(headerEntries, "run_id"),
    runAttempt: toNumber(envelopeValue(headerEntries, "run_attempt")),
    runner: envelopeValue(headerEntries, "runner"),
    pid: toNumber(envelopeValue(headerEntries, "pid")),
  };

  let index = headerParsed.consumed;
  const sections: PhaseSection[] = [];
  // `output` is the wrapper a phase opens around its child streams; `active` is the stream lines land in now.
  let group: PhaseSection | undefined;
  let active: PhaseSection | undefined;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const delimiter = SECTION_DELIMITER.exec(line);
    if (delimiter) {
      const name = delimiter[1] ?? "";
      // `result` closes the group rather than joining it, so it sits at the top level like `output` does.
      const section: PhaseSection = {
        name,
        depth: group === undefined || name === "result" ? 0 : 1,
        lines: [],
      };
      sections.push(section);
      if (name === "output") {
        // `output` opens the group and holds every line its children hold, delimiters included.
        group = section;
        active = undefined;
      } else if (name === "result") {
        // `result` closes the group again and is a sibling of it, not a child of it.
        group = undefined;
        active = section;
      } else {
        // `stdout` and `stderr` replace each other as the group's active child.
        active = section;
      }
      if (group !== undefined && section.depth > 0) group.lines.push(line);
      index += 1;
      continue;
    }

    const target = active ?? group ?? sections[sections.length - 1];
    if (target !== undefined) target.lines.push(line);
    if (group !== undefined && active !== undefined && active !== group) group.lines.push(line);
    index += 1;
  }

  const resultSection = sections.find((section) => section.name === "result");
  const resultParsed =
    resultSection === undefined ? { entries: [], consumed: 0 } : parseEnvelope(resultSection.lines);
  const resultEntries = resultParsed.entries;
  const result: PhaseResult | undefined =
    resultEntries.length === 0
      ? undefined
      : {
          entries: resultEntries,
          finishedUtc: envelopeValue(resultEntries, "finished_utc"),
          durationSeconds: toNumber(envelopeValue(resultEntries, "duration_seconds")),
          exitCode: toNumber(envelopeValue(resultEntries, "exit_code")),
          timedOut: toBoolean(envelopeValue(resultEntries, "timed_out")),
        };

  return { header, sections, result };
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "True" || value === "true") return true;
  if (value === "False" || value === "false") return false;
  return undefined;
}

/** The named section, or `undefined` when this phase log does not have one. */
export function phaseSection(log: PhaseLog, name: string): PhaseSection | undefined {
  for (const section of log.sections) if (section.name === name) return section;
  return undefined;
}

/** Captured stdout text lines, timestamps and escapes stripped, in capture order. */
export function phaseStdoutLines(log: PhaseLog): string[] {
  const section = phaseSection(log, "stdout");
  if (section === undefined) return [];
  return section.lines.map((line) => cleanLogLine(line)).filter((line) => line.length > 0);
}

/** Captured stderr text lines, timestamps and escapes stripped. Empty for phases whose child wrote no stderr. */
export function phaseStderrLines(log: PhaseLog): string[] {
  const section = phaseSection(log, "stderr");
  if (section === undefined) return [];
  return section.lines.map((line) => cleanLogLine(line)).filter((line) => line.length > 0);
}

/** A test-runner progress line, classified by which piece of runner grammar it is. */
export type ProgressLine =
  | { kind: "plan"; tests: number; workers: number }
  | {
      kind: "running";
      index: number;
      total: number;
      file: string;
      line: number;
      column: number;
      title: string;
    }
  | { kind: "test"; file: string; line: number; column: number; title: string }
  | { kind: "summary"; counts: TestSummaryCounts; durationLabel: string | undefined }
  | { kind: "console"; level: string; text: string }
  | { kind: "other"; text: string };

/** Test tallies from a summary line; only the outcomes the runner actually wrote are present. */
export interface TestSummaryCounts {
  passed: number | undefined;
  failed: number | undefined;
  flaky: number | undefined;
  skipped: number | undefined;
}

/** `Running 31 tests using 1 worker`, with the worker noun singular or plural as the runner writes it. */
const PLAN_LINE = /^Running (\d+) tests? using (\d+) workers?$/;

/** `[3/31] e2e\screenshots.spec.ts:177:1 › editor with split preview`. */
const RUNNING_LINE = /^\[(\d+)\/(\d+)\]\s+(.+):(\d+):(\d+)\s+›\s+(.+)$/;

/** `e2e\screenshots.spec.ts:273:1 › settings panel` — the dimmed form a finished test prints. */
const TEST_LINE = /^(.+):(\d+):(\d+)\s+›\s+(.+)$/;

/** `  31 passed (2.0m)`, or `3 failed, 28 passed (1.2m)` on a run with failures. */
const SUMMARY_LINE = /^\s*((?:\d+ (?:passed|failed|flaky|skipped)(?:, )?)+)(?:\s*\(([^)]+)\))?\s*$/;

/** One outcome tally inside a summary line. */
const SUMMARY_TALLY = /(\d+) (passed|failed|flaky|skipped)/g;

/** `BROWSER CONSOLE: verbose [DOM] ...` — a page console message relayed into the runner output. */
const CONSOLE_LINE = /^BROWSER CONSOLE:\s*(?:(verbose|info|warning|error|debug)\s+)?(.*)$/;

/**
 * Parse one cleaned progress line. The caller is expected to have removed the capture timestamp and the escape
 * bytes already — `phaseProgressLines` does that for a whole log; `cleanLogLine` does it for one line.
 */
export function parseProgressLine(text: string): ProgressLine {
  const plan = PLAN_LINE.exec(text);
  if (plan) return { kind: "plan", tests: Number(plan[1]), workers: Number(plan[2]) };

  const running = RUNNING_LINE.exec(text);
  if (running) {
    return {
      kind: "running",
      index: Number(running[1]),
      total: Number(running[2]),
      file: running[3] ?? "",
      line: Number(running[4]),
      column: Number(running[5]),
      title: running[6] ?? "",
    };
  }

  const test = TEST_LINE.exec(text);
  if (test) {
    return {
      kind: "test",
      file: test[1] ?? "",
      line: Number(test[2]),
      column: Number(test[3]),
      title: test[4] ?? "",
    };
  }

  const summary = SUMMARY_LINE.exec(text);
  if (summary) {
    const counts: TestSummaryCounts = {
      passed: undefined,
      failed: undefined,
      flaky: undefined,
      skipped: undefined,
    };
    const tallies = summary[1] ?? "";
    for (const tally of tallies.matchAll(SUMMARY_TALLY)) {
      const outcome = tally[2] as keyof TestSummaryCounts;
      counts[outcome] = Number(tally[1]);
    }
    return { kind: "summary", counts, durationLabel: summary[2] };
  }

  const console = CONSOLE_LINE.exec(text);
  if (console) return { kind: "console", level: console[1] ?? "info", text: console[2] ?? "" };

  return { kind: "other", text };
}

/** Parsed progress lines for a phase log's stdout, in capture order. */
export function phaseProgressLines(log: PhaseLog): ProgressLine[] {
  return phaseStdoutLines(log).map((line) => parseProgressLine(line));
}

/** Reusable pieces of the timestamp/escape cleanup, exported for callers that hold their own captured lines. */
export { cleanLogLine, stripAnsi, stripLogTimestamp };
