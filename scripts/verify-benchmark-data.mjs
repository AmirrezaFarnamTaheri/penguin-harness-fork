/**
 * Offline landing benchmark integrity gate. Run with Node >=24:
 *   node scripts/verify-benchmark-data.mjs
 *   node --test scripts/verify-benchmark-data.test.mjs
 *
 * Scope: validate archived BenchResult values and ensure public blog posts do not
 * publish those unverified figures as results.
 * The current BenchResult schema carries no provenance, and README.md's roadmap still
 * lists public release of the benchmark suite as unfinished. Neither a repeated
 * table nor its GDPevo background link proves these runs or their official pricing.
 *
 * Provenance is claim-linked evidence — raw run outcomes, scoring, model attribution,
 * token usage and dated pricing artifacts — in a schema this gate does not define,
 * because no such artifacts exist in the repository yet. So a suite has exactly two
 * states, and only one of them passes:
 *   - every row carries `provisional: true`: data is archived but uncertified. It is
 *     reported as a WARNING; the public prose and tables are separately checked.
 *   - anything else (no flag on some or all rows, or an ad-hoc `provenance` /
 *     `source` field, or a citation URL): FAILS CLOSED. Nothing a row carries today
 *     counts as provenance, deliberately — no invented evidence schema or arbitrary
 *     field can manufacture a pass. When the artifacts land, the check that recognizes
 *     them goes where the provisional flag is read, and a verified row stops needing it.
 *
 * PENGUIN_BENCH_DATA overrides the module the data is read from (an absolute path or
 * file URL), so the fail-closed arm can be exercised end to end against a candidate
 * copy; unset, the gate reads the real landing data.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Current suite denominators: benchmark-data.ts header, publication methodology,
// and packages/landing/test/benchmark-data.test.ts. These are claims, not run proof.
const SUITES = { DATA_BENCH: 15, CODE_BENCH: 40 * 2 };
// HarnessKind and the published product names; models are compared to publications,
// not pinned to a guessed vendor version or a wall-clock freshness threshold.
const FRAMEWORKS = { penguin: "PenguinHarness", claude: "Claude Code", codex: "OpenAI Codex" };
const PUBLICATIONS = ["en", "zh"].map(
  (locale) => `packages/landing/content/blog/introducing-penguinharness.${locale}.md`,
);
const WITHDRAWAL_NOTICES = { en: "we have removed those claims", zh: "因此已撤下" };
const METRICS = ["accuracyPct", "tokensM", "costUsd"];
// The schema is closed on purpose. This gate exists because nothing a row carries today
// certifies its numbers, so an unknown key is either a typo or an attempt to smuggle in
// unverified provenance — both block. A field that genuinely proves a run belongs in the
// provenance arm below, where the check that recognizes real artifacts will live; it is
// added to BenchResult and to this set in the same change, never by widening it silently.
const ALLOWED_KEYS = new Set([
  "kind",
  "framework",
  "model",
  "accuracyPct",
  "tokensM",
  "costUsd",
  "emphasized",
  "provisional",
]);
const HEADERS = [
  ["Framework", "Model", "Accuracy (%)", "Tokens (M)", "Cost ($)"],
  ["实验框架", "模型名称", "准确率（%）", "Token 用量（M）", "成本（$）"],
];

function publicationTables(text) {
  // Parse complete pipe tables, never execute publication content. An unsupported
  // format is an error, not a reason to omit checks. Other blog tables are ignored.
  const blocks = text.match(/(?:^\|[^\r\n]*\|[ \t]*(?:\r?\n|$))+/gm) ?? [];
  return blocks.flatMap((block) => {
    const rows = block
      .trim()
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim()),
      );
    if (!HEADERS.some((header) => JSON.stringify(rows[0]) === JSON.stringify(header))) return [];
    if (rows[1]?.length !== 5 || !rows[1].every((cell) => /^:?-+:?$/.test(cell)))
      throw new Error("invalid table separator");
    return [rows.slice(2)];
  });
}

/** Returns all diagnostics. No consistency-only result is called verification. */
export function validateBenchmarkData(data, publications) {
  const errors = [];
  // A diagnostic is a warning or a blocking error (the CLI prints warnings to stderr and
  // only errors set the exit code). Provenance state is a warning; everything this gate
  // reports about the numbers, the rows and the publications still blocks.
  const fail = (code, location, message) =>
    errors.push({ code, location, message, severity: "error" });
  const warn = (code, location, message) =>
    errors.push({ code, location, message, severity: "warning" });
  for (const [suite, outcomes] of Object.entries(SUITES)) {
    const rows = data?.[suite];
    if (!Array.isArray(rows) || rows.length !== Object.keys(FRAMEWORKS).length) {
      fail("INVALID_SUITE", suite, "Expected one result for each published framework.");
    }
    const seen = new Set();
    for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
      const location = `${suite}[${index}]`;
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        fail("INVALID_ROW", location, "Expected a BenchResult object.");
        continue;
      }
      if (
        !Object.hasOwn(FRAMEWORKS, row.kind) ||
        row.framework !== FRAMEWORKS[row.kind] ||
        seen.has(row.kind)
      ) {
        fail("INVALID_ATTRIBUTION", location, "Unknown, duplicated or mismatched kind/framework.");
      }
      seen.add(row.kind);
      for (const key of Object.keys(row)) {
        if (!ALLOWED_KEYS.has(key))
          fail(
            "UNKNOWN_FIELD",
            `${location}.${key}`,
            "Not part of the BenchResult schema — an unknown key cannot certify a number, and a provenance field only counts once the gate is taught to recognize it.",
          );
      }
      if (row.provisional !== undefined && typeof row.provisional !== "boolean")
        fail("INVALID_PROVISIONAL", `${location}.provisional`, "Expected a boolean flag.");
      if (typeof row.model !== "string" || !row.model.trim())
        fail("INVALID_ATTRIBUTION", `${location}.model`, "Expected a nonempty model name.");
      if (
        (row.emphasized !== undefined && typeof row.emphasized !== "boolean") ||
        (row.emphasized === true) !== (row.kind === "penguin")
      ) {
        fail(
          "INVALID_EMPHASIS",
          location,
          "Only PenguinHarness is emphasized in the published comparison.",
        );
      }
      for (const field of METRICS) {
        const value = row[field];
        if (!Number.isFinite(value) || value < 0 || (field === "accuracyPct" && value > 100)) {
          fail(
            "INVALID_METRIC",
            `${location}.${field}`,
            "Expected a finite nonnegative number; accuracy must be within 0–100.",
          );
        }
      }
      if (Number.isFinite(row.accuracyPct) && row.accuracyPct >= 0 && row.accuracyPct <= 100) {
        const passed = Math.round((row.accuracyPct * outcomes) / 100);
        if (Number(((passed / outcomes) * 100).toFixed(2)) !== row.accuracyPct) {
          fail(
            "ACCURACY_GRID",
            `${location}.accuracyPct`,
            `Not a two-decimal percentage of ${outcomes} outcomes.`,
          );
        }
      }
      if (row.kind === "penguin" && !(row.costUsd > 0))
        fail(
          "INVALID_RATIO",
          `${location}.costUsd`,
          "The published cost-ratio denominator must be positive.",
        );
    }
    for (const kind of Object.keys(FRAMEWORKS)) {
      if (!seen.has(kind)) fail("INVALID_ATTRIBUTION", suite, `Missing ${FRAMEWORKS[kind]}.`);
    }
    // Archived data stays explicitly provisional until claim-linked evidence exists.
    const objects = (Array.isArray(rows) ? rows : []).filter(
      (r) => r && typeof r === "object" && !Array.isArray(r),
    );
    if (objects.length > 0 && objects.every((r) => r.provisional === true)) {
      warn(
        "PROVISIONAL",
        suite,
        "Every row is archived as provisional: not certified by run outcomes, scoring, model attribution, token usage or dated pricing artifacts.",
      );
    } else {
      fail(
        "MISSING_PROVENANCE",
        suite,
        "Not certified, and not every row is flagged provisional: attach claim-linked run outcomes, scoring, model attribution, token usage and dated pricing artifacts before publishing these numbers.",
      );
    }
  }

  for (const path of PUBLICATIONS) {
    const matches = Array.isArray(publications)
      ? publications.filter((source) => source?.path === path)
      : [];
    if (matches.length !== 1 || typeof matches[0].text !== "string") {
      fail("INVALID_PUBLICATION", path, "Missing or duplicate local publication.");
      continue;
    }
    let tables;
    try {
      tables = publicationTables(matches[0].text);
    } catch (error) {
      fail("INVALID_PUBLICATION", path, error.message);
      continue;
    }
    const locale = path.endsWith(".zh.md") ? "zh" : "en";
    if (
      tables.length > 0 ||
      Object.values(data ?? {}).some(
        (rows) =>
          Array.isArray(rows) &&
          rows.some(
            (row) =>
              row &&
              METRICS.some(
                (field) =>
                  Number.isFinite(row[field]) && matches[0].text.includes(row[field].toFixed(2)),
              ),
          ),
      )
    ) {
      fail(
        "UNVERIFIED_PUBLICATION",
        path,
        "This publication contains comparative benchmark data without reproducible evidence.",
      );
    } else if (!matches[0].text.toLocaleLowerCase().includes(WITHDRAWAL_NOTICES[locale])) {
      fail(
        "MISSING_WITHDRAWAL_NOTICE",
        path,
        "State clearly that earlier comparative figures were withdrawn pending verification.",
      );
    }
  }
  return errors;
}

async function main() {
  try {
    // Node's native TS stripping imports actual exports (including constant model
    // references), rather than regex-extracting arrays or looking for keywords.
    // PENGUIN_BENCH_DATA swaps the module under test (an absolute path or file URL) so the
    // fail-closed arm can be exercised end to end against a candidate copy; unset, the gate
    // reads the real landing data it is the integrity check for.
    const override = process.env.PENGUIN_BENCH_DATA;
    const dataUrl = override
      ? override.startsWith("file:")
        ? new URL(override)
        : pathToFileURL(resolve(override))
      : new URL("../packages/landing/src/lib/benchmark-data.ts", import.meta.url);
    const data = await import(dataUrl.href);
    const publications = PUBLICATIONS.map((path) => ({
      path,
      text: readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
    }));
    const errors = validateBenchmarkData(data, publications);
    // Warnings are printed and never set the exit code; only errors block. The archived
    // values remain explicitly provisional until claim-linked artifacts are committed.
    const failures = errors.filter((diagnostic) => diagnostic.severity !== "warning");
    const warnings = errors.filter((diagnostic) => diagnostic.severity === "warning");
    for (const { code, location, message, severity } of errors)
      console.error(
        `[${severity === "warning" ? "WARN" : "FAIL"} ${code}] ${location}: ${message}`,
      );
    if (failures.length) {
      console.error(
        `Benchmark integrity BLOCKED (${failures.length} error${failures.length === 1 ? "" : "s"}); no results certified.`,
      );
      process.exitCode = 1;
    } else if (warnings.length) {
      console.log(
        `Benchmark data checked with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: archived values remain provisional and are not published.`,
      );
    } else {
      console.log("Benchmark data verified: every suite carries certified provenance.");
    }
  } catch (error) {
    console.error(`[INPUT_ERROR] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
