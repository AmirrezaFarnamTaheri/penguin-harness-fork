import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyToolOutput } from "../../src/environment/output-compression/detect.js";
import { compressOutput } from "../../src/environment/output-compression/strategies.js";
import type { OutputKind } from "../../src/environment/output-compression/strategies.js";
import { TruncatedToolOutputArchive } from "../../src/environment/truncated-tool-output-archive.js";
import { Environment } from "../../src/environment/environment.js";
import { BUILTIN_TOOL_FACTORIES } from "../../src/environment/tools/registry.js";
import { EXEC_COMMAND_NAME } from "../../src/environment/tools/exec-command.js";
import { partialToolCallOutput, toolCall } from "../../src/omnimessage/index.js";
import type { OmniMessage } from "../../src/omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../src/interfaces/index.js";

/**
 * Tool-output compression: the safety properties, and the numbers that justify shipping.
 *
 * The order of the tests below is the order of the rules. A failing run keeps its failures
 * (the rule that makes every other rule safe), a green run collapses to a count, duplicates
 * collapse with an accurate count, a compressed result can be recalled byte for byte, an
 * unrecognised output is untouched, and the recall store cannot grow without limit. The
 * measurement tests at the end pin the wins, so a change that quietly removes one fails here
 * rather than in someone's context window.
 */

const BUDGET = 16000;

// ---------------------------------------------------------------------------
// Fixtures, shaped from real captured output
// ---------------------------------------------------------------------------

/** A real `vitest run` over 11 files / 322 tests, trimmed of the parts that carry no structure. */
const PASSING_VITEST = [
  " RUN  v4.1.11 D:/repo/packages/core",
  ...Array.from({ length: 220 }, (_, i) => ` ✓ test/thing-${i}.test.ts (${i + 1} tests) ${i}ms`),
  ...Array.from({ length: 90 }, (_, i) => `     ✓ case ${i} is fine ${i}ms`),
  "",
  " Test Files  11 passed (11)",
  "      Tests  308 passed | 14 skipped (322)",
  "   Duration  47.94s",
  "",
].join("\n");

/**
 * A real failing `vitest run`: the `×` line, the `FAIL` header, the assertion, the diff and the
 * code frame. `THING` is the per-block index, so repeated blocks stay individually identifiable.
 */
const FAILING_VITEST_BLOCK = [
  "",
  " FAIL  test/thing-THING.test.ts > thing-THING > breaks",
  "AssertionError: expected { a: 1, b: 2 } to deeply equal { a: 1, b: 3 }",
  "",
  "- Expected",
  "+ Received",
  "",
  "  {",
  '    "a": 1,',
  '-   "b": 3,',
  '+   "b": 2,',
  "  }",
  "",
  " ❯ test/thing-THING.test.ts:9:28",
  "     7|   });",
  '     8|   it("breaks", () => {',
  "     9|     expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 3 });",
  "       |                            ^",
  "    10|   });",
];

/** One failing block, repeated across a large suite, with passing lines in between. */
function largeFailingRun(blocks: number, passingPerBlock: number): string {
  const out: string[] = [" RUN  v4.1.11 D:/repo/packages/core"];
  for (let b = 0; b < blocks; b += 1) {
    for (let p = 0; p < passingPerBlock; p += 1) {
      out.push(` ✓ test/thing-${p}.test.ts > case ${p} passes ${p}ms`);
    }
    out.push(` × test/thing-${b}.test.ts > case ${b} breaks ${b}ms (retry x2)`);
    out.push(...FAILING_VITEST_BLOCK.map((line) => line.replaceAll("THING", String(b))));
  }
  out.push(
    "",
    ` Test Files  ${blocks} failed | 11 passed (${blocks + 11})`,
    `      Tests  ${blocks} failed | 2200 passed (${2200 + blocks})`,
    "   Duration  62.4s",
    "",
  );
  return out.join("\n");
}

function logLines(repeats: number, uniques: number): string {
  const out: string[] = [];
  for (let i = 0; i < repeats; i += 1) {
    out.push("2026-09-27T19:00:00Z INFO  [pool] connection established peer=10.0.0.4");
  }
  for (let i = 0; i < uniques; i += 1) {
    out.push(`2026-09-27T19:00:0${i % 9}Z DEBUG [pool] entering poll cycle tick=${i}`);
  }
  out.push("2026-09-27T19:00:02Z ERROR [pool] upstream timeout after 30000ms url=https://svc/q");
  return out.join("\n");
}

/** Real `git log` medium format, with the stat block RTK-style filters strip. */
function gitLog(commits: number): string {
  const out: string[] = [];
  for (let i = 0; i < commits; i += 1) {
    out.push(`commit ${(i + 1).toString(16).padStart(40, "0")}`);
    out.push(`Author: Dev ${i} <dev${i}@example.com>`);
    out.push(`Date:   Mon Sep ${i + 1} 12:00:00 2026 +0000`);
    out.push("");
    out.push(`    Fix the ${i}th thing`);
    out.push("");
    out.push("    A longer body paragraph that nobody reads and that costs real tokens.");
    out.push("");
    for (let f = 0; f < 4; f += 1) {
      out.push(` src/file-${f}.ts | ${f + 1} +-`);
    }
    out.push(` 4 files changed, ${commits} insertions(+), ${commits} deletions(-)`);
    out.push("");
  }
  return out.join("\n");
}

const compress = (kind: OutputKind, text: string, maxChars = BUDGET) =>
  compressOutput({ kind, text, maxChars });

// ---------------------------------------------------------------------------

describe("classification: pass-through by default", () => {
  it("classifies only the output types it has measured strategies for", () => {
    const cases: [string, OutputKind | null][] = [
      ["git log --oneline -n 50", "git-log"],
      ["cd sub && git status", "git-status"],
      ["git diff HEAD~1", "git-diff"],
      ["pnpm vitest run", "test-runner"],
      ["npx jest --ci", "test-runner"],
      ["python -m pytest -q", "test-runner"],
      ["go test ./...", "test-runner"],
      ["cargo test --all", "test-runner"],
      ["npm test", "test-runner"],
      ["pnpm run test:unit", "test-runner"],
      ["npm run lint", "lint"],
      ["oxlint --deny-warnings src", "lint"],
      ["tsc --noEmit", "lint"],
      ["tail -200 app.log", "log-dedup"],
      ["cat build.log", "log-dedup"],
      ['cat "C:\\Program Files\\logs\\build.log"', "log-dedup"],
      ['echo "pnpm test && git status"', null],
      ["echo 'git log | cat app.log'", null],
      ['git log --pretty="%s | %an" && echo "literal && text"', "git-log"],
    ];
    for (const [cmd, expected] of cases) {
      expect(classifyToolOutput("exec_command", { cmd }), cmd).toBe(expected);
    }
  });

  it("classifies nothing it has not measured — the pass-through rule", () => {
    const unrecognised = [
      "ls -la",
      "echo hi",
      "curl https://example.com",
      "cat package.json",
      "git push origin main",
      "pnpm run build",
      "docker ps",
      "kubectl get pods",
      "cargo build --release",
      "pwd",
    ];
    for (const cmd of unrecognised) {
      expect(classifyToolOutput("exec_command", { cmd }), cmd).toBeNull();
    }
    // A non-log file read is never deduplicated, however repetitive its content.
    expect(classifyToolOutput("read_file", { file_path: "src/repeated.ts" })).toBeNull();
    expect(classifyToolOutput("read_file", { file_path: "logs/app.log" })).toBe("log-dedup");
    // A tool that produces output this module has no strategy for.
    expect(classifyToolOutput("environment_info", {})).toBeNull();
    expect(classifyToolOutput("exec_command", {})).toBeNull();
  });

  it("leaves no gap between 'classified' and 'compressed'", () => {
    // The pass-through rule is a chain: no classification means no collector, which means the
    // deltas are never withheld, which means the text the tool produced is the text the model
    // gets. Asserted here at the classification end and, below, at Environment's end.
    expect(classifyToolOutput("exec_command", { cmd: "cat build/report.json" })).toBeNull();
    expect(classifyToolOutput("exec_command", { cmd: "cat build.log" })).toBe("log-dedup");
    expect(classifyToolOutput("exec_command", { cmd: "git log --format=%H" })).toBe("git-log");
  });
});

// ---------------------------------------------------------------------------

describe("test runners: failures are never compressed away", () => {
  it("collapses a passing run to its own tally", () => {
    const result = compress("test-runner", PASSING_VITEST);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    // The run's own numbers survive verbatim, which is the only thing a model needs from a
    // green run.
    expect(result.text).toContain("Test Files  11 passed (11)");
    expect(result.text).toContain("Tests  308 passed | 14 skipped (322)");
    // Per-test lines are gone, and the result says so rather than pretending to be the run.
    expect(result.text).not.toContain("test/thing-7.test.ts");
    expect(result.text).toMatch(/passing lines collapsed/);
  });

  it("keeps every failure, its assertion diff and its code frame intact", () => {
    const source = largeFailingRun(6, 20);
    const result = compress("test-runner", source);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    for (let b = 0; b < 6; b += 1) {
      expect(result.text).toContain(`FAIL  test/thing-${b}.test.ts > thing-${b} > breaks`);
      expect(result.text).toContain("AssertionError: expected { a: 1, b: 2 } to deeply equal");
    }
    // The diff and the code frame, byte for byte.
    expect(result.text).toContain('-   "b": 3,');
    expect(result.text).toContain('+   "b": 2,');
    expect(result.text).toContain("     9|     expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 3 });");
  });

  it("leads with the failure count, so a budget cut cannot hide how many failed", () => {
    // Large enough that the budget forces a cut. The tally must be the first thing read, and
    // the cut must land between failure blocks rather than inside one.
    const result = compress("test-runner", largeFailingRun(40, 30));
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    expect(result.text.length).toBeLessThanOrEqual(BUDGET);
    expect(result.text).toContain("40 failed | 2200 passed (2240)");
    expect(result.text.startsWith(" Test Files  40 failed")).toBe(true);
    // Whatever survived, it ends on a complete block and admits what is missing.
    expect(result.text).toMatch(/more test-runner lines not shown\]$/);
    // No block may be cut in half: every `FAIL` header in the result has its assertion with it.
    const headers = result.text.match(/^ FAIL  /gm) ?? [];
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(result.text).toContain("AssertionError");
    }
  });

  it("does not mistake a suite that only mentions failure for a failing one", () => {
    // Real case that broke the first implementation: a *passing* test named "…reports failed"
    // made the run look red, so it took the failure path and barely compressed at all.
    const source = [
      " RUN  v4.1.11 D:/repo/packages/core",
      ...Array.from(
        { length: 200 },
        (_, i) => ` ✓ test/x.test.ts > case ${i} reports failed as expected ${i}ms`,
      ),
      "",
      " Test Files  1 passed (1)",
      "      Tests  200 passed (200)",
      "",
    ].join("\n");
    const result = compress("test-runner", source);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    expect(result.text).toContain("Tests  200 passed (200)");
    expect(result.text).not.toContain("FAIL");
  });

  it("passes a short or unrecognisable test output through untouched", () => {
    const crash = "Error: Cannot find module 'vitest'\n  at resolve (node:internal/modules:1:1)";
    expect(compress("test-runner", crash)).toBeNull();
    expect(compress("test-runner", "not a test run at all")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("deduplication", () => {
  it("collapses repeated log lines with an accurate count", () => {
    const source = logLines(600, 200);
    const result = compress("log-dedup", source);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    // One copy, carrying the true number of occurrences.
    expect(result.text.split("connection established peer=10.0.0.4").length - 1).toBe(1);
    expect(result.text).toContain("connection established peer=10.0.0.4 ×600");
    // The header carries both totals and leads, so a budget cut cannot take the count away.
    // 801 lines in: 600 copies of one line, 200 unique ticks, one error. 202 unique out, and
    // 599 lines folded into their representative's count.
    expect(result.text).toMatch(
      /^\[log deduplicated: 801 lines → 202 unique, 599 duplicate lines collapsed\]/,
    );
    // Every unique line survives, including the last one, and the error that sent anyone here.
    expect(result.text).toContain("entering poll cycle tick=199");
    expect(result.text).toContain("ERROR [pool] upstream timeout after 30000ms");
    // Deduplication alone must still respect the budget, and admit what it left behind.
    const crowded = compress("log-dedup", logLines(600, 400));
    if (crowded === null) throw new Error("expected a result");
    expect(crowded.text.length).toBeLessThanOrEqual(BUDGET);
    expect(crowded.text).toMatch(/more log-dedup lines not shown\]$/);
  });

  it("handles read_file's `cat -n` gutter, where identical lines are never byte-identical", () => {
    const source = logLines(400, 250)
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
      .join("\n");
    const result = compress("log-dedup", source);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    expect(result.text).toContain("connection established peer=10.0.0.4 ×400");
    expect(result.text).toMatch(/the repeats' numbers are in the recall copy/);
  });

  it("refuses a file that is not log-shaped, however repetitive it is", () => {
    const source = Array.from({ length: 500 }, () => "const x = 1;").join("\n");
    expect(compress("log-dedup", source)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("git output", () => {
  it("keeps hash, author and subject and drops the rest of a git log", () => {
    const source = gitLog(120);
    const result = compress("git-log", source);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    // One line per commit: abbreviated hash, author name (not address), subject, stat tally.
    expect(result.text).toContain("000000000000 — Dev 0 — Fix the 0th thing — 4 files changed");
    expect(result.text).toContain("Fix the 43th thing");
    // The per-commit noise a model never asked for.
    expect(result.text).not.toContain("Date:   Mon Sep");
    expect(result.text).not.toContain("example.com");
    expect(result.text).not.toContain("src/file-2.ts |");
    expect(result.text).not.toContain("A longer body paragraph");
    // The stat tally is one line and high-signal, so it stays on the commit's own line.
    expect(result.text).toContain("120 insertions(+), 120 deletions(-)");
    // One line per commit, and the commit cap is stated.
    expect(result.text.split("\n").filter((l) => l.includes("Fix the")).length).toBeLessThanOrEqual(
      81,
    );
  });

  it("groups a dirty tree by state instead of listing every path", () => {
    const lines = ["On branch feature/x", "Your branch is up to date with 'origin/feature/x'"];
    for (let i = 0; i < 40; i += 1) lines.push(` M src/module-${i}.ts`);
    for (let i = 0; i < 25; i += 1) lines.push(`?? scratch/note-${i}.md`);
    lines.push(
      "",
      "no changes added to commit",
      '  (use "git add <file>..." to update what will be committed)',
    );
    const result = compress("git-status", lines.join("\n"));
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    expect(result.text).toContain("M (40)");
    expect(result.text).toContain("?? (25)");
    // Within the first 12, the rest is counted rather than listed.
    expect(result.text).toContain("+28 more");
    expect(result.text).not.toContain("On branch feature/x");
  });

  it("keeps a diff's hunks byte-exact and cuts only between files", () => {
    const files = Array.from({ length: 20 }, (_, f) =>
      [
        `diff --git a/src/f${f}.ts b/src/f${f}.ts`,
        `index ${f}abc..${f}def 100644`,
        "--- a/src/f" + f + ".ts",
        "+++ b/src/f" + f + ".ts",
        `@@ -${f},7 +${f},7 @@ export function f${f}() {`,
        `  const keep${f} = ${f};`,
        `-  const gone${f} = ${f};`,
        `+  const added${f} = ${f};`,
        " }",
      ].join("\n"),
    ).join("\n");
    const result = compress("git-diff", files);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    // Every hunk that survives is complete: header, counts, and both sides.
    const hunks = result.text.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g) ?? [];
    expect(hunks.length).toBeGreaterThan(0);
    for (const hunk of hunks) expect(result.text).toContain(hunk);
    // The last hunk is never left dangling: the result ends on a file boundary or the marker.
    expect(result.text).toMatch(/(\}\n\[|\}\n 20 files|\[)/);
  });

  it("refuses a diff too small to be worth compressing", () => {
    const small = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(compress("git-diff", small)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("lint output", () => {
  /** Real oxlint diagnostic, in the half-width miette renderer. */
  const block = (n: number) =>
    [
      "",
      `  x eslint(no-console): Unexpected console statement.`,
      `   ,-[src/app${n}.ts:${n}:3]`,
      ` ${n} |   console.log("debug");`,
      `   :   ^^^^^^^^^^^`,
      "   `----",
      "  help: Delete this console statement.",
    ].join("\n");

  it("strips the drawing and keeps every diagnostic, location and code frame", () => {
    const source =
      Array.from({ length: 40 }, (_, i) => block(i)).join("\n") +
      "\n\nFound 0 warnings and 40 errors.\nFinished in 129ms on 40 files with 3 rules using 16 threads.\n";
    const result = compress("lint", source);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    // Every finding is still individually addressable — the whole point of a lint run.
    for (let n = 0; n < 40; n += 1) {
      if (!result.text.includes(`src/app${n}.ts:${n}:3`)) {
        // The budget may cut whole findings; it must never split one.
        continue;
      }
      expect(result.text).toContain("eslint(no-console): Unexpected console statement.");
    }
    // The drawing is gone, the `path:line:col` is not.
    expect(result.text).not.toContain(",-[");
    expect(result.text).not.toContain("`----");
    expect(result.text).toMatch(/^src\/app\d+\.ts:\d+:\d+$/m);
    // The boilerplate summary is dropped.
    expect(result.text).not.toContain("using 16 threads");
  });

  it("does not deduplicate two findings that merely look alike", () => {
    // Regression guard: collapsing repeated `N │ source` and caret lines across findings leaves
    // carets with no source, which is a broken report. Repetition in a linter is a work item.
    const source =
      Array.from({ length: 40 }, () => block(0)).join("\n") +
      "\n\nFound 0 warnings and 40 errors.\nFinished in 129ms on 40 files.\n";
    const result = compress("lint", source);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a result");
    // All 40 findings are still individually present, and each keeps its own code frame.
    expect(result.text.match(/Unexpected console statement/g)?.length).toBe(40);
    expect(result.text.match(/src\/app0\.ts:0:3/g)?.length).toBe(40);
    expect(result.text.match(/console\.log\("debug"\)/g)?.length).toBe(40);
  });

  it("passes through a clean two-line lint summary", () => {
    expect(
      compress("lint", "Found 0 warnings and 0 errors.\nFinished in 543ms on 46 files."),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("win gate: a strategy that does not measurably help does not ship", () => {
  it("declines every strategy when the saving is below the note's own cost", () => {
    const fortyBytesOfSaving = "a".repeat(5000);
    // ~90% smaller, but under the 400-character floor: the announcement would cost more than
    // the text it replaced.
    expect(compress("lint", fortyBytesOfSaving, 5000)).toBeNull();
    // A result that cannot fit the budget is declined even when it is smaller.
    const log = logLines(500, 200);
    expect(compress("log-dedup", log, 100)).toBeNull();
  });

  it("reports the win honestly, in characters rather than invented tokens", () => {
    const source = PASSING_VITEST;
    const result = compress("test-runner", source);
    if (result === null) throw new Error("expected a result");
    expect(result.originalChars).toBe(source.length);
    expect(result.text.length).toBeLessThan(source.length);
    // hidden_lines is every line the model did not see — the same figure rtk reports.
    expect(result.hiddenLines).toBe(result.originalLines - result.keptLines);
    expect(result.hiddenLines).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------

describe("the recall store", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "penguin-compression-recall-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("returns the full output byte for byte, and says so in the result the model sees", async () => {
    const archive = new TruncatedToolOutputArchive({ rootDir: path.join(tmp, "output") });
    const source = largeFailingRun(4, 15);
    const result = compress("test-runner", source);
    if (result === null) throw new Error("expected a result");

    const saved = await archive.saveRecallEntry("exec_command", source);
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("expected a saved entry");

    const recalled = await archive.recall(saved.id);
    expect(recalled.status).toBe("ok");
    if (recalled.status !== "ok") throw new Error("expected the entry to be recallable");
    // Byte-identical: this is the property that makes compression lossless-in-principle.
    expect(recalled.text).toBe(source);
    expect(Buffer.from(recalled.text, "utf8").equals(Buffer.from(source, "utf8"))).toBe(true);
    // And the file on disk really is the text, at the path the note advertises.
    expect(await readFile(recalled.path, "utf8")).toBe(source);
  });

  it("is content-addressed, so the same output twice costs one entry", async () => {
    const archive = new TruncatedToolOutputArchive({ rootDir: path.join(tmp, "output") });
    const source = largeFailingRun(2, 12);
    const first = await archive.saveRecallEntry("exec_command", source);
    const second = await archive.saveRecallEntry("exec_command", source);
    expect(first.status === "saved" && second.status === "saved" && first.id).toBe(
      second.status === "saved" ? second.id : "",
    );
    expect(archive.recallStats().entries).toBe(1);
    if (first.status === "saved") {
      expect(second.status === "saved" ? second.reused : false).toBe(true);
    }
  });

  it("is bounded by entry count, by bytes, and by age — and reports what it dropped", async () => {
    let clock = 1_000;
    const archive = new TruncatedToolOutputArchive({
      rootDir: path.join(tmp, "output"),
      recallLimits: { maxEntries: 3, maxTotalBytes: 10_000_000, maxEntryAgeMs: 5_000 },
      now: () => clock,
    });

    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const saved = await archive.saveRecallEntry(
        "exec_command",
        `entry number ${i} ${"x".repeat(500)}`,
      );
      if (saved.status !== "saved") throw new Error("expected a saved entry");
      ids.push(saved.id);
      clock += 100;
    }
    const stats = archive.recallStats();
    expect(stats.entries).toBe(3);
    expect(stats.entries).toBeLessThanOrEqual(stats.maxEntries);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxTotalBytes);
    expect(stats.dropped.length).toBeGreaterThan(0);
    expect(stats.dropped[0]?.reason).toBe("count");
    // The oldest went first, and the newest are still recallable.
    for (const id of ids.slice(3)) {
      expect((await archive.recall(id)).status).toBe("ok");
    }
    expect((await archive.recall(ids[0]!)).status).toBe("dropped");

    // Age bound: after the window passes, even the survivors go.
    clock += 10_000;
    const aged = await archive.saveRecallEntry("exec_command", "a fresh entry after the window");
    expect(aged.status).toBe("saved");
    const after = archive.recallStats();
    expect(after.entries).toBe(1);
    expect(after.dropped.some((d) => d.reason === "expired")).toBe(true);

    // Nothing was dropped silently: the files are gone from disk with the index entries.
    for (const id of ids) {
      const recalled = await archive.recall(id);
      if (recalled.status === "ok") {
        await expect(stat(recalled.path)).rejects.toThrow();
      }
    }
  });

  it("bounds its own drop log, so diagnostics cannot become the leak", async () => {
    const archive = new TruncatedToolOutputArchive({
      rootDir: path.join(tmp, "output"),
      recallLimits: { maxEntries: 1, maxTotalBytes: 10_000_000, maxEntryAgeMs: 60_000 },
    });
    for (let i = 0; i < 100; i += 1) {
      await archive.saveRecallEntry("exec_command", `entry ${i} ${"y".repeat(200)}`);
    }
    const stats = archive.recallStats();
    expect(stats.entries).toBe(1);
    expect(stats.dropped.length).toBeLessThanOrEqual(32);
  });

  it("enforces the aggregate byte limit and keeps the newest fitting entry", async () => {
    const archive = new TruncatedToolOutputArchive({
      rootDir: path.join(tmp, "output"),
      recallLimits: { maxEntries: 20, maxTotalBytes: 1_000, maxEntryAgeMs: 60_000 },
    });
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const saved = await archive.saveRecallEntry("exec_command", `${index}:${"x".repeat(699)}`);
      if (saved.status !== "saved") throw new Error("expected a saved entry");
      ids.push(saved.id);
    }

    const stats = archive.recallStats();
    expect(stats.bytes).toBeLessThanOrEqual(1_000);
    expect(stats.entries).toBe(1);
    expect(stats.dropped.filter((entry) => entry.reason === "bytes").length).toBe(2);
    expect((await archive.recall(ids[0]!)).status).toBe("dropped");
    expect((await archive.recall(ids[1]!)).status).toBe("dropped");
    expect((await archive.recall(ids[2]!)).status).toBe("ok");
  });

  it("reports an unknown id as missing rather than inventing content", async () => {
    const archive = new TruncatedToolOutputArchive({ rootDir: path.join(tmp, "output") });
    expect((await archive.recall("deadbeefcafe")).status).toBe("missing");
  });

  it("never stores a credential shape in the clear", async () => {
    const archive = new TruncatedToolOutputArchive({ rootDir: path.join(tmp, "output") });
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    const saved = await archive.saveRecallEntry(
      "exec_command",
      `token ${secret} ${"filler ".repeat(200)}`,
    );
    if (saved.status !== "saved") throw new Error("expected a saved entry");
    const onDisk = await readFile(saved.path, "utf8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain("<redacted>");
  });
});

// ---------------------------------------------------------------------------

describe("Environment: the tool-result path end to end", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "penguin-compression-env-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  /**
   * Swaps exec_command's factory for one that emits a fixed payload, then runs a call through
   * Environment exactly as a real one arrives. Overriding BUILTIN_TOOL_FACTORIES is how
   * environment.test.ts drives the same path, and it is the only way to reach Environment's
   * finalization without spawning a real shell.
   */
  async function runFakeTool(opts: {
    cmd: string;
    output: string;
    note?: string;
    maxOutputLength?: number;
    withScratchpad: boolean;
  }): Promise<{ complete: string; streamed: string; stopReason: string | undefined }> {
    const original = BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME];
    BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME] = (definition) => ({
      name: EXEC_COMMAND_NAME,
      definition,
      async *execute(_args, ctx) {
        yield partialToolCallOutput({
          eventType: "delta",
          output: opts.output,
          toolCallId: ctx.toolCallId,
        });
        // Shaped like exec_command's own return: a non-zero exit reports both a stop reason and
        // the marker, and Environment keeps the marker outside the compression budget.
        if (opts.note === undefined) return {};
        return { stopReason: "fatal" as const, note: opts.note };
      },
    });
    try {
      const env = new Environment({
        workspaceDir: tmp,
        toolConfig: {
          customTools: [
            {
              name: EXEC_COMMAND_NAME,
              description: "probe",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
              ...(opts.maxOutputLength === undefined
                ? {}
                : { maxOutputLength: opts.maxOutputLength }),
            } as ToolDefinitionConfig,
          ],
          mcpServers: [],
        },
        ...(opts.withScratchpad ? { sessionScratchpadDir: path.join(tmp, "scratch") } : {}),
      });
      const messages: OmniMessage[] = [];
      for await (const message of env.executeTool({
        toolCall: toolCall({
          name: EXEC_COMMAND_NAME,
          arguments: JSON.stringify({ cmd: opts.cmd }),
          toolCallId: "call-1",
        }),
      })) {
        messages.push(message);
      }
      const last = messages[messages.length - 1]!.payload as {
        output: string;
        stop_reason?: string;
      };
      // The frontend rebuilds the card from the deltas; Environment guarantees they concatenate
      // to the complete message. Assert that here rather than trusting it.
      const deltas = messages
        .filter((m) => {
          const p = m.payload as { type?: string; event_type?: string };
          return p.type === "partial_tool_call_output" && p.event_type === "delta";
        })
        .map((m) => (m.payload as { output?: string }).output ?? "")
        .join("");
      return { complete: last.output, streamed: deltas, stopReason: last.stop_reason };
    } finally {
      if (original === undefined) delete BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME];
      else BUILTIN_TOOL_FACTORIES[EXEC_COMMAND_NAME] = original;
    }
  }

  it("compresses a test run, carries a recall id, and the id recalls the original", async () => {
    const source = largeFailingRun(5, 25);
    const result = await runFakeTool({
      cmd: "pnpm vitest run",
      output: source,
      withScratchpad: true,
    });

    // The model sees a summary, and is told that it is one.
    expect(result.complete).toContain("output compressed");
    expect(result.complete).toContain("a summary, not the full output");
    expect(result.complete).toMatch(/recall id [0-9a-f]{12}/);
    // …and still sees every failure it needs to act on.
    for (let b = 0; b < 5; b += 1) {
      expect(result.complete).toContain(`FAIL  test/thing-${b}.test.ts`);
    }
    // Streamed concatenation is still the complete message: the invariant Environment guarantees
    // for every tool call, compressed or not.
    expect(result.streamed).toBe(result.complete);
    // The advertised path exists and holds the unfiltered original, byte for byte.
    const handle = result.complete.match(/recall id [0-9a-f]{12}: (\S+)/);
    if (handle === null) throw new Error("expected a recall path in the note");
    expect(await readFile(handle[1]!, "utf8")).toBe(source);
  });

  it("keeps the tool's own exit-code note outside the compressed text", async () => {
    const result = await runFakeTool({
      cmd: "vitest run",
      output: largeFailingRun(3, 20),
      note: "[exit code: 1]",
      withScratchpad: true,
    });
    // The failure signal survives twice over: in the summary and in the tool's own marker,
    // which Environment appends outside the compression budget.
    expect(result.complete).toContain("[exit code: 1]");
    expect(result.stopReason).toBe("fatal");
  });

  it("streams an unrecognised command's output unchanged, even past the budget", async () => {
    const source = Array.from({ length: 900 }, (_, i) => `unclassified output line ${i}`).join(
      "\n",
    );
    const result = await runFakeTool({
      cmd: "cat build.log",
      output: source,
      maxOutputLength: 500,
      withScratchpad: true,
    });
    // Truncation, not compression: the existing head/tail contract, with the recovery file.
    expect(result.complete).toContain("[output truncated: kept first");
    expect(result.complete).not.toContain("output compressed");
    const archived = result.complete.match(/\[output archived[^:]*: ([^\]]+)\]/);
    if (archived === null) throw new Error("expected an archive path in the note");
    expect(await readFile(archived[1]!, "utf8")).toBe(source);
  });

  it("does not compress at all without a scratchpad to recall from", async () => {
    // A standalone SDK embedder has nowhere to put the original, so a summary it cannot expand
    // would be data destruction. The honest answer there is the uncompressed path.
    const source = largeFailingRun(4, 25);
    const result = await runFakeTool({
      cmd: "vitest run",
      output: source,
      withScratchpad: false,
    });
    expect(result.complete).not.toContain("output compressed");
    expect(result.complete).toBe(source);
  });
});
