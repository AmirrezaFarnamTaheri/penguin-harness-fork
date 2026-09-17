/**
 * Offline landing benchmark integrity gate. Run with Node >=24:
 *   node scripts/verify-benchmark-data.mjs
 *   node --test scripts/verify-benchmark-data.test.mjs
 *
 * Scope: BenchResult values and consistency with the two introducing-penguinharness
 * publication tables. Those tables are secondary claims, NOT measurement evidence.
 * The current BenchResult schema has no provenance, and README.md's roadmap still
 * lists public release of the benchmark suite as unfinished. Neither a repeated
 * table nor its GDPevo background link proves these runs or their official pricing.
 * This gate therefore fails closed until real run/scoring/usage/pricing artifacts
 * are supplied and an adapter for their actual schema is implemented. There is no
 * --skip-provenance flag or invented evidence schema that can manufacture a pass.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Current suite denominators: benchmark-data.ts header, publication methodology,
// and packages/landing/test/benchmark-data.test.ts. These are claims, not run proof.
const SUITES = { DATA_BENCH: 15, CODE_BENCH: 40 * 2 };
// HarnessKind and the published product names; models are compared to publications,
// not pinned to a guessed vendor version or a wall-clock freshness threshold.
const FRAMEWORKS = { penguin: "PenguinHarness", claude: "Claude Code", codex: "OpenAI Codex" };
const PUBLICATIONS = ["en", "zh"].map(
  (locale) => `packages/landing/content/blog/introducing-penguinharness.${locale}.md`,
);
const METRICS = ["accuracyPct", "tokensM", "costUsd"];
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
  const fail = (code, location, message) => errors.push({ code, location, message });
  const validRows = new Map();
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
      validRows.set(`${suite}:${row.framework}`, { row, location });
    }
    for (const kind of Object.keys(FRAMEWORKS)) {
      if (!seen.has(kind)) fail("INVALID_ATTRIBUTION", suite, `Missing ${FRAMEWORKS[kind]}.`);
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
    if (tables.length !== Object.keys(SUITES).length) {
      fail(
        "INVALID_PUBLICATION",
        path,
        "Expected the data-analysis and coding benchmark tables, in that order.",
      );
      continue;
    }
    for (const [index, suite] of Object.keys(SUITES).entries()) {
      const table = tables[index];
      const names = table.map((cells) => cells[0]);
      if (
        table.length !== Object.keys(FRAMEWORKS).length ||
        new Set(names).size !== names.length ||
        !Object.values(FRAMEWORKS).every((name) => names.includes(name))
      ) {
        fail(
          "INVALID_PUBLICATION",
          `${path}:${suite}`,
          "Missing, duplicate or unknown framework rows.",
        );
      }
      for (const cells of table) {
        if (
          cells.length !== 5 ||
          !cells[1] ||
          !cells.slice(2).every((value) => /^\d+\.\d{2}$/.test(value))
        ) {
          fail(
            "INVALID_PUBLICATION",
            `${path}:${suite}`,
            "Expected framework/model and three two-decimal metric cells.",
          );
          continue;
        }
        const result = validRows.get(`${suite}:${cells[0]}`);
        if (!result) continue; // Missing/invalid landing rows already reported above.
        const { row, location } = result;
        if (row.model !== cells[1])
          fail(
            "PUBLICATION_MISMATCH",
            `${location}.model`,
            `${path} attributes ${cells[0]} to ${cells[1]}, not ${String(row.model)}.`,
          );
        for (const [metricIndex, field] of METRICS.entries()) {
          if (Number.isFinite(row[field]) && row[field].toFixed(2) !== cells[metricIndex + 2]) {
            fail(
              "PUBLICATION_MISMATCH",
              `${location}.${field}`,
              `${path} publishes ${cells[metricIndex + 2]}, not ${row[field].toFixed(2)}.`,
            );
          }
        }
      }
    }
  }
  for (const suite of Object.keys(SUITES)) {
    fail(
      "MISSING_PROVENANCE",
      suite,
      "No claim-linked run outcomes/scoring, model attribution, token usage or dated pricing artifacts in the current schema. Matching blog tables and the GDPevo background citation are not proof; supply source artifacts before this gate can pass.",
    );
  }
  return errors;
}

async function main() {
  try {
    // Node's native TS stripping imports actual exports (including constant model
    // references), rather than regex-extracting arrays or looking for keywords.
    const data = await import("../packages/landing/src/lib/benchmark-data.ts");
    const publications = PUBLICATIONS.map((path) => ({
      path,
      text: readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
    }));
    const errors = validateBenchmarkData(data, publications);
    for (const { code, location, message } of errors)
      console.error(`[${code}] ${location}: ${message}`);
    if (errors.length) {
      console.error(`Benchmark integrity BLOCKED (${errors.length} errors); no results certified.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[INPUT_ERROR] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
