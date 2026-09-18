/**
 * Escape-sequence and timestamp handling for captured CI log lines.
 *
 * Provenance: the phase logs in a CI evidence bundle prefix every captured stdout/stderr line with the capture
 * timestamp in square brackets and leave the child process's raw terminal escape bytes in place. The visual
 * regression phase log, for instance, emits Playwright's progress output with dim/bold/color SGR codes plus the
 * cursor-control codes (`ESC[1A`, `ESC[2K`) that made the live progress line overwrite itself, so a stored line
 * can carry two escape sequences before the first printable character. Nothing downstream can parse a progress
 * line until those are gone, and the timestamp prefix has to come off first or it becomes part of the text.
 */

/** Control Sequence Introducer: `ESC[` … one final byte in the range 0x40–0x7E (letters, `@` and `` ` ``). */
const ANSI_CSI = /\x1b\[[0-9;?<=>]*[A-Za-z@`]/g;

/**
 * Strip CSI escape sequences from a string. Covers all SGR color/style codes (`ESC[2m`, `ESC[33;1m`, `ESC[0m`),
 * the cursor-movement and erase codes (`ESC[1A`, `ESC[2K`) and any other CSI sequence a child may emit.
 * Non-CSI escapes (OSC titles, single-shift codes) are not touched — none appear in the captured logs.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

/** Strip CSI escapes from every line, leaving line count and non-escape content unchanged. */
export function stripAnsiFromLines(lines: string[]): string[] {
  return lines.map((line) => stripAnsi(line));
}

/** Capture timestamp that prefixes each captured line, e.g. `[2026-09-11T13:24:46.6322442+00:00] `. */
const LOG_TIMESTAMP = /^\[(\d{4}-\d{2}-\d{2}T[0-9:.+\-Zz]+)\][ \t]?/;

/** The pieces of one captured line after the capture-timestamp prefix is removed. */
export interface LogLineTimestamp {
  /** The timestamp as written inside the brackets, or `undefined` when the line carries no prefix. */
  timestamp: string | undefined;
  /** The remainder of the line, escapes still included. */
  text: string;
}

/**
 * Remove the `[ISO-8601]` capture-timestamp prefix from one line. Escapes are left in the text — the caller
 * strips them separately so a reader can tell "what the child printed" from "when it was captured".
 */
export function stripLogTimestamp(line: string): LogLineTimestamp {
  const match = LOG_TIMESTAMP.exec(line);
  if (!match) return { timestamp: undefined, text: line };
  return { timestamp: match[1], text: line.slice(match[0].length) };
}

/**
 * Full per-line cleanup for captured stdout/stderr: drop the capture timestamp, then strip escapes.
 * Returns the printable text the child process actually wrote.
 */
export function cleanLogLine(line: string): string {
  return stripAnsi(stripLogTimestamp(line).text);
}

/** `cleanLogLine` over a whole captured stream. */
export function cleanLogLines(lines: string[]): string[] {
  return lines.map((line) => cleanLogLine(line));
}
