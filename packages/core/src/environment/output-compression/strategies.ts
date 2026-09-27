/**
 * Per-output-type compression strategies for the tool-result path.
 *
 * ## Why this exists
 *
 * A passing test run, a long `git log` and a log tail are the largest single line items an
 * agent loop pays for, and almost all of that text is a line the model will never act on. The
 * technique borrowed here is the one behind `rtk` (Apache-2.0): classify the output type and
 * apply one of four transforms — smart filtering, grouping, truncation, deduplication — instead
 * of shipping the raw stream. What is *not* borrowed is its architecture: RTK rewrites shell
 * commands so a separate binary re-runs them, which is why its documentation is largely about
 * install paths, PATH and Windows/WSL. Environment already owns the tool-result path, so the
 * same transform runs in-process, over our built-in tools, with no binary and no install story.
 *
 * ## The invariant every strategy here must keep
 *
 * **Compression may only delete text it can positively classify as non-signal. Anything it
 * cannot classify is kept verbatim, in order.** No strategy pattern-matches a *positive* list of
 * lines to keep and drops the rest — each one drops a narrow, explicitly enumerated set of noise
 * shapes and lets everything else through. That is what makes a compressed result safe to hand a
 * model: a failure line, a stack trace or a diagnostic is not something a strategy has to
 * recognise in order to survive, it is simply not noise.
 *
 * A consequence worth stating plainly: a strategy that cannot measure a win returns `null` and
 * the caller ships the text unchanged. Compression is an optimisation, never a policy.
 *
 * ## What each strategy measured, on real captured output
 *
 * Character counts against a 16 000-character budget — the module ships no tokenizer, so these
 * are not token counts and the ~1/4 estimate is not applied here. The last two columns are the
 * strategy's own runtime, warm, median of 20.
 *
 * | output                          | before  | after   | saved  | median |
 * |---------------------------------|--------:|--------:|-------:|-------:|
 * | `git log -n 200 --stat`          | 557 999 |  10 252 | 98.2 % | 6.4 ms |
 * | `vitest run` (322 tests, green)  |   9 262 |     204 | 97.8 % | 0.3 ms |
 * | `git diff HEAD` (17 files)       | 291 052 |  12 138 | 95.8 % | 2.0 ms |
 * | log tail (1 297 lines)           |  92 282 |  15 930 | 82.7 % | 1.2 ms |
 * | `read_file` on the same log      | 101 361 |  15 923 | 84.3 % | 1.7 ms |
 * | `vitest run` (144 failures)      |  63 268 |  15 921 | 74.8 % | 1.5 ms |
 * | `git status --porcelain`         |   2 908 |   1 032 | 64.5 % | 0.05 ms|
 * | `oxlint` (168 findings)          |  38 256 |  15 956 | 58.3 % | 1.1 ms |
 *
 * Two results are deliberately at zero, and both are the strategy working:
 *
 * - A **small failing run** (1 884 chars) is returned unchanged. Collapsing its three passing
 *   lines would not clear the 400-character floor, and the announcement note would cost more
 *   than the saving. So would a *small* lint run for the same reason.
 * - An **unrecognised output** is never a candidate; see the classifier in `detect.ts`.
 *
 * One transform was measured and rejected: reducing `git diff` **context** (dropping unchanged
 * lines to hit a target). It is the largest available win — context is most of a diff — and it
 * is refused because `@@ -a,b +c,d @@` counts describe the real hunk, so dropping lines inside
 * one makes the header a lie and a model applying the diff corrupts the file. The whole-file cap
 * below keeps every hunk byte-exact instead, and still measures 95.8 % on a wide diff.
 */

/** The output types this module knows how to compress. */
export type OutputKind =
  "test-runner" | "git-log" | "git-status" | "git-diff" | "lint" | "log-dedup";

/** One compression request: a classified output, the text, and the budget its replacement must fit. */
export interface CompressionRequest {
  kind: OutputKind;
  text: string;
  /** Hard cap on the replacement, in characters. Exceeding it means "do not compress". */
  maxChars: number;
}

/** What a strategy produced, plus the counts the model-visible note reports. */
export interface CompressionResult {
  kind: OutputKind;
  /** The replacement text handed to the model in place of the original. */
  text: string;
  originalChars: number;
  originalLines: number;
  /** Lines present in `text`; the rest were collapsed into markers. */
  keptLines: number;
  /** originalLines - keptLines. RTK reports the same figure as `hidden_lines`, and it must equal what recall can actually return. */
  hiddenLines: number;
}

/**
 * A replacement must be at least this much smaller to be worth the note that announces it, and
 * the note is real tokens the model pays for on every subsequent turn of the Session. 10% of a
 * 20 KiB result clears it; a 2 KiB result does not, which is exactly where a "compressed"
 * summary would cost more than the text it replaced.
 */
const MIN_WIN_RATIO = 0.1;

/** Smallest absolute saving, in characters, below which the announcement note outweighs the win. */
const MIN_WIN_CHARS = 400;

/**
 * Splits into lines and drops the empty element a trailing newline produces.
 *
 * CRLF is left on each line rather than stripped: the strategies match on line *shapes*, and a
 * trailing `\r` is matched by the `\s*` that ends most of them. Normalising here would change
 * every retained line, which is exactly what a lossless-in-principle transform must not do.
 */
function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Assembles a strategy's output line by line, applies the budget fit, and gates the result.
 *
 * The budget fit lives here rather than in each strategy so that "the replacement always fits the
 * caller's budget" is a property of the module instead of a habit. A strategy that keeps more
 * than fits does not have to choose between correctness and the limit: it hands over the extra
 * lines, they become a counted marker, and the recall copy is what holds them.
 *
 * `hiddenLines` is `originalLines - keptLines`, which is the same figure `rtk` reports as
 * `hidden_lines`: every line the model did not see. Because the recall copy holds the whole
 * original, that number is also exactly the number of lines recall can give back.
 */
function finish(
  request: CompressionRequest,
  lines: string[],
  originalLines: number,
  cutBefore?: (line: string) => boolean,
): CompressionResult | null {
  const fitted = fitToBudget(lines, request.maxChars, `${request.kind} lines not shown`, cutBefore);
  // A replacement that is nothing but the "left behind" marker carries no information: the
  // budget was too small to hold even one unit. Shipping it would cost the note and tell the
  // model nothing, so this counts as "no win" and the caller keeps the real text.
  if (fitted.length <= 1) return null;
  const replacement = fitted.join("\n");
  const saved = request.text.length - replacement.length;
  if (saved < MIN_WIN_CHARS || saved < request.text.length * MIN_WIN_RATIO) return null;
  return {
    kind: request.kind,
    text: replacement,
    originalChars: request.text.length,
    originalLines,
    keptLines: fitted.length,
    hiddenLines: Math.max(0, originalLines - fitted.length),
  };
}

/** Truncates a long run of kept lines into a counted marker plus the first `keep` of them. */
function capLines(lines: string[], keep: number, label: string): string[] {
  if (lines.length <= keep) return lines;
  const dropped = lines.length - keep;
  return [...lines.slice(0, keep), `[${dropped} more ${label}]`];
}

/**
 * Keeps as many leading lines as fit in `maxChars`, reserving room for the closing marker.
 *
 * This is the transform that makes a *retained* line set safe: deduplication can still leave more
 * unique content than the visible budget allows, and the answer there is not to keep dropping
 * lines by content — it is to stop keeping them and say how many were left. Everything past the
 * cut is in the recall copy, so the model can still ask for it.
 *
 * `cutBefore` matters as much as the limit. A cut that lands in the middle of a unit — between a
 * test's name and its traceback, between a diff's `diff --git` header and its hunks — hands the
 * model a fragment that looks whole. When a boundary predicate is given, the cut moves back to
 * the last such boundary that fits; the hard cut is only the fallback for text with no boundary
 * at all. In every case the marker states how many lines were left behind.
 */
function fitToBudget(
  lines: string[],
  maxChars: number,
  label: string,
  cutBefore?: (line: string) => boolean,
): string[] {
  const total = lines.length;
  if (lines.join("\n").length <= maxChars) return lines;
  // Reserve the marker's own worst case so the fit is guaranteed, not usually true.
  const budget = maxChars - 64;
  let used = 0;
  let hardCut = 0;
  let lastBoundary = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const cost = lines[i]!.length + 1;
    if (used + cost > budget) break;
    used += cost;
    hardCut = i + 1;
    if (cutBefore !== undefined && i > 0 && cutBefore(lines[i]!)) lastBoundary = i;
  }
  const kept = lines.slice(0, cutBefore === undefined ? hardCut : lastBoundary || hardCut);
  kept.push(`[${total - kept.length} more ${label}]`);
  return kept;
}

// ---------------------------------------------------------------------------
// Test runners — the largest win available, because a green run is pure waste
// ---------------------------------------------------------------------------

/**
 * Lines that assert a test PASSED. Narrow on purpose: anything not matched here is kept, so a
 * runner whose output format changes degrades to "no compression" rather than to "failures
 * deleted".
 *
 * The list is split by how trustworthy the marker is. A leading glyph (`✓`) is the runner's own
 * verdict and is taken at face value — a passing test may legitimately be *named* "aborts instead
 * of failed", and treating that name as evidence of failure would make the green-run path
 * unreachable on real suites. A word marker (`ok`, `PASS`, `--- PASS:`) is the runner's verdict
 * too, but appears mid-line, so it is checked against a leading failure token before being
 * trusted: a line that opens with `FAIL`/`not ok` is never a pass line, whatever it contains.
 */
const GLYPH_PASS_LINE = /^\s*[✓✔√]\s/;
const WORD_PASS_LINES: readonly RegExp[] = [
  /^ok\s/, // `go test`: ok  \tpkg\t0.5s · `ok  (n tests)` · cargo: `test name ... ok`
  /^---\s+PASS:/, // go test -v
  /^PASS(\s|$)/, // go test -v summary
  /^\s*\S+::\S+\s+PASSED/, // pytest node id
  /^=+\s*PASSED/, // django
  /^\.+\s+\[\s*100%\]$/, // pytest progress
  /^\s*[.sx]\s*$/, // rspec progress dots
];
/** A line that opens with a failure token is a failure, whatever else it contains. */
const LEADING_FAILURE = /^\s*(FAIL|FAILED|not ok|ERROR|error:|✗|×|panic:)/;
/** A blank line is pure formatting and joins a collapsed run. */
const BLANK_LINE = /^\s*$/;

function isPassLine(line: string): boolean {
  if (BLANK_LINE.test(line)) return true;
  if (LEADING_FAILURE.test(line)) return false;
  return GLYPH_PASS_LINE.test(line) || WORD_PASS_LINES.some((pattern) => pattern.test(line));
}

/**
 * Strong failure evidence: a run that shows any of this is a failing run.
 *
 * Deliberately anchored and specific. A loose `failed` search would be defeated by a passing test
 * named "…and reports failed", which is a common name — and a suite wrongly judged green is the
 * one outcome this whole strategy must never produce.
 */
const FAILURE_EVIDENCE =
  /^\s*(FAIL|FAILED|✗|×|not ok|ERROR|error:)|AssertionError|Traceback \(most recent call last\)|--- FAIL:|panic:|^# fail|test result: FAILED|\b\d+ failed\b/i;

/** The runner's own tally lines: the one thing worth keeping verbatim from a green run. */
const TEST_SUMMARY_PATTERNS: readonly RegExp[] = [
  /^ Test Files\s/,
  /^ *Tests\s+\d/,
  /^ *Snapshots\s/,
  /^ *Time\s/,
  /^ *Duration\s/,
  /^PASS\b/,
  /^ok\s+/,
  /^test result:/,
  /^# (tests|pass|fail|skipped|todo)/,
  /^Ran \d+ tests?/,
  /^OK \(/,
  /^OK$/,
  /^Tests:\s/,
  /^===?\s*(NAME|RUN|PAUSE|CONT)\s/,
  /^\s*\d+ passed/,
  /^All tests passed/,
  /^(no tests ran|Nothing to compile)/i,
];

function compressTestRunner(request: CompressionRequest): CompressionResult | null {
  const lines = toLines(request.text);
  if (lines.length < 20) return null;

  // Defence in depth: the command said "vitest", but the output must actually look like a test
  // run. A crash before any test output has neither tally lines nor any pass line, and is passed
  // through untouched rather than compressed into a confident-looking summary.
  const summaryLines = lines.filter((line) => TEST_SUMMARY_PATTERNS.some((p) => p.test(line)));
  const passCount = lines.reduce((n, line) => (isPassLine(line) ? n + 1 : n), 0);
  if (summaryLines.length === 0 || passCount < 10) return null;

  const hasFailure = lines.some((line) => FAILURE_EVIDENCE.test(line));

  if (!hasFailure) {
    // Green run: the per-test lines are the waste. Keep the runner's own tally block and say
    // plainly how much was collapsed, so a model cannot mistake a summary for a test list.
    const kept = capLines(summaryLines, 6, "summary lines omitted");
    return finish(
      request,
      [`[test run: ${passCount} passing lines collapsed]`, ...kept],
      lines.length,
    );
  }

  // Failed run: collapse runs of pass lines only. Every non-pass line — the FAIL headers, the
  // assertion diffs, the code frames, the stack traces — is emitted verbatim and in order, so
  // the failure signal cannot be summarised away.
  const out: string[] = [];
  let run = 0;
  const flush = (): void => {
    if (run === 0) return;
    out.push(run === 1 ? "[1 passing line collapsed]" : `[${run} passing lines collapsed]`);
    run = 0;
  };
  for (const line of lines) {
    if (isPassLine(line)) {
      run += 1;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  if (out.length === 0) return null;
  // The tally is lifted out of the body and put FIRST. A failing run's failure blocks are long,
  // and leaving the tally where the runner printed it — at the end — means the budget cut drops
  // it, leaving a model that knows "some tests failed" but not how many. "12 failed" has to be
  // the first thing it reads; the blocks after it are the detail, and recall holds the rest.
  const tally: string[] = [];
  const detail: string[] = [];
  for (const line of out) {
    if (TEST_SUMMARY_PATTERNS.some((pattern) => pattern.test(line))) tally.push(line);
    else detail.push(line);
  }
  return finish(request, [...tally, ...detail], lines.length, startsFailureBlock);
}

/**
 * True at the first line of each failing test's own report, so the budget cut lands between
 * failures and never inside one. `FAIL`/`not ok` are the anchors; the `×` glyph line is included
 * because on vitest it precedes the `FAIL` header for the same test.
 */
function startsFailureBlock(line: string): boolean {
  return /^\s*(FAIL\b|not ok|×|✗)/.test(line);
}

// ---------------------------------------------------------------------------
// git log — hash, author and subject
// ---------------------------------------------------------------------------

const COMMIT_HEADER = /^commit ([0-9a-f]{7,40})\s*$/;
const AUTHOR_LINE = /^Author:\s*(.*?)\s*$/;
const ONELINE_COMMIT = /^([0-9a-f]{7,40})\s+(\S.*)$/;
/**
 * Noise shapes, ordered by how often they occur in `git log --stat` output, because this loop
 * runs over every line of what is often a half-megabyte. The per-file stat row is checked first
 * and is anchored so it cannot backtrack: the obvious `.*\|\s+\d+` spelling costs an order of
 * magnitude more on exactly the line it is meant to match.
 */
const GIT_STAT_FILE = /^[^|]*\|\s*\d+\s*[+-]*\s*$/;
const GIT_STAT_SUMMARY = /^\s*\d+ files? changed/;
const GIT_BODY_INDENT = /^ {4,}\S/;
const GIT_HEADER_NOISE =
  /^(Merge:|Date:|index |---$|\+\+\+$|create mode |delete mode |similarity index |rename (from|to) |old mode |new mode )/;

/**
 * `git log` medium format, one commit per three or four kept fields.
 *
 * The subject is the line that is easy to get wrong. Git indents the subject by four spaces,
 * exactly as it indents the body, so "is it indented?" does not identify it — the *first*
 * indented line after the header does, and every indented line after that is body. Treating
 * indentation alone as body is how the first implementation of this strategy dropped every
 * subject it was supposed to keep.
 */
function compressGitLog(request: CompressionRequest): CompressionResult | null {
  const lines = toLines(request.text);
  if (lines.length < 12) return null;

  const out: string[] = [];
  let sawHeader = false;
  let hash: string | null = null;
  let author: string | null = null;
  let subject: string | null = null;
  /** Set once the subject line has been consumed, so later indented lines are recognised as body. */
  let subjectSeen = false;

  const flush = (): void => {
    if (hash === null) return;
    out.push([hash, author, subject].filter((part) => part !== null && part !== "").join(" — "));
    hash = null;
    author = null;
    subject = null;
    subjectSeen = false;
  };

  for (const line of lines) {
    const header = COMMIT_HEADER.exec(line);
    if (header !== null) {
      sawHeader = true;
      flush();
      hash = header[1]!.slice(0, 12);
      continue;
    }
    if (hash === null) {
      // `git log --oneline` and `--pretty=oneline`: one line per commit, no block to parse.
      const oneline = ONELINE_COMMIT.exec(line);
      if (oneline !== null && !GIT_HEADER_NOISE.test(line)) {
        sawHeader = true;
        out.push(`${oneline[1]!.slice(0, 12)} — ${oneline[2]!}`);
      }
      continue;
    }
    if (author === null) {
      const parsed = AUTHOR_LINE.exec(line);
      if (parsed !== null) {
        // `Name <email>` -> `Name`. The address is noise for a reader deciding what to read.
        author = parsed[1]!.replace(/\s*<[^>]*>\s*$/, "");
        continue;
      }
    }
    if (GIT_STAT_SUMMARY.test(line)) {
      // One line and high-signal ("312 files changed, 9 insertions"); the per-file stat rows it
      // summarises are not, and GIT_STAT_FILE drops them. Kept as the commit's own field so a
      // commit's identity and its size stay on one line.
      subject = `${subject ?? ""} — ${line.trim()}`.replace(/^ — /, "");
      continue;
    }
    if (GIT_STAT_FILE.test(line) || GIT_HEADER_NOISE.test(line)) continue;
    if (line.trim() === "") continue;
    if (GIT_BODY_INDENT.test(line)) {
      if (!subjectSeen) {
        subject = line.trim();
        subjectSeen = true;
      }
      // Every later indented line is body prose, which the hash+author+subject line cannot hold.
      continue;
    }
    // An unindented line outside a known header shape: a custom --pretty format. Do not guess.
    flush();
  }
  flush();

  if (!sawHeader || out.length === 0) return null;
  return finish(request, capLines(out, 80, "commits collapsed"), lines.length);
}

// ---------------------------------------------------------------------------
// git status — compact grouped stat
// ---------------------------------------------------------------------------

const PORCELAIN_LINE = /^([ MADRCU?!]{2})\s+(\S.*)$/;
const STATUS_SECTION =
  /^(Changes to be committed|Changes not staged for commit|Untracked files|Unmerged paths|Your branch|HEAD detached|Changes not staged)/;
const STATUS_NOISE =
  /^(\s*$|On branch |Your branch |HEAD detached|nothing to commit|no changes added|use "git |  \(use "git |$)/;

function compressGitStatus(request: CompressionRequest): CompressionResult | null {
  const lines = toLines(request.text);
  if (lines.length < 24) return null;

  const groups = new Map<string, string[]>();
  const order: string[] = [];
  let entries = 0;
  for (const line of lines) {
    const porcelain = PORCELAIN_LINE.exec(line);
    let code: string;
    let path: string;
    if (porcelain) {
      code = porcelain[1]!;
      path = porcelain[2]!;
    } else if (STATUS_SECTION.test(line) || STATUS_NOISE.test(line)) {
      continue;
    } else if (line.startsWith("\t") || line.trim() === "") {
      continue; // long-form file list rows and blanks
    } else {
      code = "  ";
      path = line.trim();
    }
    if (path === "") continue;
    let bucket = groups.get(code);
    if (!bucket) {
      bucket = [];
      groups.set(code, bucket);
      order.push(code);
    }
    bucket.push(path);
    entries += 1;
  }
  // A clean tree is two lines of prose; there is nothing here worth compressing.
  if (entries < 8) return null;

  const out: string[] = [];
  for (const code of order) {
    const bucket = groups.get(code)!;
    const shown = bucket.slice(0, 12);
    const rest = bucket.length - shown.length;
    const label = code.trim() === "" ? "other" : code.trim();
    out.push(
      rest > 0
        ? `${label} (${bucket.length}): ${shown.join(", ")} … +${rest} more`
        : `${label} (${bucket.length}): ${shown.join(", ")}`,
    );
  }
  return finish(request, out, lines.length);
}

// ---------------------------------------------------------------------------
// git diff — whole-file cap, never a hunk rewrite
// ---------------------------------------------------------------------------

const DIFF_FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const DIFF_STAT_LINE = /^\s*(\d+) files? changed/;
const DIFF_INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+/;

/**
 * Deliberately does **not** reduce diff context. `@@ -a,b +c,d @@` header counts describe the
 * real hunk; dropping "unchanged" lines to hit a token target would make those counts a lie, and
 * a model applying the diff to a file would corrupt it. The only thing removed is the `index
 * <old>..<new> <mode>` line, which the surrounding `diff --git` header already identifies.
 * Large diffs are bounded by *whole files*, so every hunk kept stays byte-exact.
 */
function compressGitDiff(request: CompressionRequest): CompressionResult | null {
  const lines = toLines(request.text);
  const fileStarts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (DIFF_FILE_HEADER.test(lines[i]!)) fileStarts.push(i);
  }
  // Fewer than four files cannot produce a win worth the note.
  if (fileStarts.length < 4) return null;

  const keepFiles = 8;
  const keep = fileStarts.slice(0, keepFiles);
  const boundary = keepFiles < fileStarts.length ? fileStarts[keepFiles]! : lines.length;
  const head = lines.slice(0, boundary).filter((line) => !DIFF_INDEX_LINE.test(line));
  const rest = lines.slice(boundary);
  const restFiles = fileStarts.length - keepFiles;
  const stat = rest.find((line) => DIFF_STAT_LINE.test(line));
  const note = `[${restFiles} more file${restFiles === 1 ? "" : "s"} not shown${stat ? ` — ${stat.trim()}` : ""}]`;
  // Cut only between files: a diff cut inside a file leaves hunks whose `@@` header no longer
  // describes what follows, which is worse than showing fewer files.
  return finish(request, [...head, note], lines.length, (line) => DIFF_FILE_HEADER.test(line));
}

// ---------------------------------------------------------------------------
// Linters — drop the art, never a diagnostic
// ---------------------------------------------------------------------------

// oxlint / biome / tsc box drawing, in both renderers oxlint ships: the full-width Unicode set
// (╭─[ … ╰────) and the half-width miette set (,-[ … `----). The `N │ source` and caret lines are
// NOT matched: they are the two lines a model actually needs to locate and fix the finding.
const LINT_LOCATION_ART = /^\s*[|,╭]\s*-+\[([^\]]*)\]\s*$/;
const LINT_CLOSING_ART = /^\s*[`╰]\s*-{2,}\s*$/;
const LINT_BARE_ART = /^[\s╭╰├╔╚╗╝│┃┌└┤┬┴┼─═║╬╠╣╥╨╦╩╪`|]+$/;
const LINT_NOISE =
  /^\s*(Finished in .*|Found \d+ warnings?.*|Found \d+ errors?.*|Checked \d+ files?.*|warnings?:? \d+.*|\s*)$/;
const LINT_DIAGNOSTIC = /^\s*(×|✗|x |⚠|error|warning|note:|help:)/i;

/**
 * Linters — strip the art, never a diagnostic.
 *
 * Two things this deliberately does **not** do:
 *
 * - It does not deduplicate. A linter's value is the *list*: two identical-looking `N │ source`
 *   or caret lines belong to two different findings in two different places, and collapsing them
 *   leaves a caret with no source line — a model handed that has been given a broken report.
 *   Unlike a repeated log line, a repeated linter line is not redundant; it is a separate work item.
 * - It does not drop the location line. `,-[src/app.ts:5:3]` is mostly drawing, but the
 *   `path:line:col` inside it is the one thing that says *where*, so it is unwrapped and kept.
 *
 * What is left is every diagnostic, every code frame and every help line, with the drawing removed
 * and the summary boilerplate dropped. That is the whole strategy, so its ceiling is low by design:
 * a linter's output is nearly all signal. Grouping it the way `rtk` does — one line per rule —
 * was rejected because the count of a rule does not tell a model which of the seven call sites to
 * change, and the whole point of the run is to change them.
 */
function compressLint(request: CompressionRequest): CompressionResult | null {
  const raw = request.text;
  // ANSI colour is a large share of a modern linter's bytes and carries no signal for a model.
  const stripped = raw.replaceAll(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const lines = toLines(stripped);
  if (lines.length < 20) return null;

  const out: string[] = [];
  for (const line of lines) {
    const location = LINT_LOCATION_ART.exec(line);
    if (location !== null) {
      // Unwrap, do not drop: the drawing is noise, the `path:line:col` inside it is not.
      out.push(location[1]!.trim());
      continue;
    }
    if (LINT_CLOSING_ART.test(line) || LINT_BARE_ART.test(line) || LINT_NOISE.test(line)) continue;
    out.push(line);
  }
  if (out.length === 0) return null;
  // A run with no recognisable diagnostic line is not linter output; pass it through.
  if (!out.some((line) => LINT_DIAGNOSTIC.test(line)) && !/Found \d+/.test(raw)) return null;

  // Cut only at a diagnostic header, so a finding is never separated from its own code frame.
  return finish(request, out, lines.length, (line) => /^\s*(×|✗|x |⚠)\s/.test(line));
}

// ---------------------------------------------------------------------------
// Log files — deduplicate repeats with an accurate count
// ---------------------------------------------------------------------------

/** A line that carries an ISO-ish timestamp or a syslog level at the front. */
const LOG_LINE =
  /^\s*(?:\[\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/;

/** A line carrying a severity anywhere in its first 64 characters. */
const LOG_LEVEL = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL|SEVERE)\b/;

/** Repeats below this count are not worth a marker — the marker would be longer than the line. */
const MIN_REPEATS = 3;

/**
 * `read_file` renders text `cat -n` style: a 6-column right-aligned line number, a tab, then the
 * content. Two log lines that are byte-identical on disk are therefore never byte-identical
 * here, so the gutter is stripped before counting. The collapsed form keeps each unique line's
 * *first* line number and marks it with `→`; the line numbers of the repeats themselves live in
 * the recall copy, which is why the header says so.
 */
const LINE_GUTTER = /^(\s*\d+)\t/;

interface GutteredLine {
  number: string;
  content: string;
}

function splitGutter(lines: string[]): { rows: GutteredLine[]; gutted: boolean } {
  const withNumbers = lines.filter((line) => LINE_GUTTER.test(line));
  // Every non-blank line must carry a gutter, or this is not a numbered listing.
  if (withNumbers.length < lines.length * 0.9) {
    return { rows: lines.map((content) => ({ number: "", content })), gutted: false };
  }
  return {
    rows: lines.map((line) => {
      const match = LINE_GUTTER.exec(line);
      return match === null
        ? { number: "", content: line }
        : { number: match[1]!, content: line.slice(match[0].length) };
    }),
    gutted: true,
  };
}

function compressLogDedup(request: CompressionRequest): CompressionResult | null {
  const lines = toLines(request.text);
  if (lines.length < 200) return null;
  const { rows, gutted } = splitGutter(lines);

  // Require the text to actually be a log: most lines timestamped, and at least one severity.
  const nonBlank = rows.filter((row) => row.content.trim() !== "");
  if (nonBlank.length === 0) return null;
  const logish = nonBlank.reduce((n, row) => (LOG_LINE.test(row.content) ? n + 1 : n), 0);
  if (logish < nonBlank.length * 0.6) return null;
  if (!nonBlank.some((row) => LOG_LEVEL.test(row.content.slice(0, 64)))) return null;

  const counts = new Map<string, number>();
  for (const row of nonBlank) counts.set(row.content, (counts.get(row.content) ?? 0) + 1);

  const out: string[] = [];
  let collapsed = 0;
  const emitted = new Set<string>();
  for (const row of nonBlank) {
    const n = counts.get(row.content)!;
    if (emitted.has(row.content)) continue;
    emitted.add(row.content);
    if (n < MIN_REPEATS) {
      out.push(gutted ? `${row.number}\t${row.content}` : row.content);
      continue;
    }
    collapsed += n - 1;
    out.push(gutted ? `${row.number}→${row.content} ×${n}` : `${row.content} ×${n}`);
  }
  // Both counts go in the header rather than in a trailing line: a log can still be over budget
  // after deduplication, and a cut at the tail would take a trailing summary with it.
  const guttedNote = gutted
    ? "; the line number shown is each line's first occurrence, the repeats' numbers are in the recall copy"
    : "";
  const header =
    `[log deduplicated: ${rows.length} lines → ${emitted.size} unique, ` +
    `${collapsed} duplicate lines collapsed${guttedNote}]`;
  return finish(request, [header, ...out], lines.length);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const STRATEGIES: Record<OutputKind, (request: CompressionRequest) => CompressionResult | null> = {
  "test-runner": compressTestRunner,
  "git-log": compressGitLog,
  "git-status": compressGitStatus,
  "git-diff": compressGitDiff,
  lint: compressLint,
  "log-dedup": compressLogDedup,
};

/**
 * Applies the strategy for `kind`, or returns `null` to mean "ship the text unchanged".
 * `null` is the common, correct answer: it covers an unrecognised shape, a result that did not
 * clear the win gate, and a replacement that would not fit the budget.
 */
export function compressOutput(request: CompressionRequest): CompressionResult | null {
  return STRATEGIES[request.kind](request);
}
