import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_BENCH, CODE_BENCH } from "../packages/landing/src/lib/benchmark-data.ts";
import { validateBenchmarkData } from "./verify-benchmark-data.mjs";

const publications = ["en", "zh"].map((locale) => ({
  path: `packages/landing/content/blog/introducing-penguinharness.${locale}.md`,
  text: readFileSync(
    new URL(
      `../packages/landing/content/blog/introducing-penguinharness.${locale}.md`,
      import.meta.url,
    ),
    "utf8",
  ),
}));
const fresh = () => structuredClone({ DATA_BENCH, CODE_BENCH });
const check = (data = fresh(), sources = publications) => validateBenchmarkData(data, sources);
// Provenance state is a warning now, not a consistency error: it is the state every suite
// in the repository is actually in. Everything below still has to hold without it.
const consistencyErrors = (errors) =>
  errors.filter((error) => error.code !== "PROVISIONAL" && error.code !== "MISSING_PROVENANCE");

// These are copies/mutations of the real schema, not synthetic benchmark outcomes.
test("archived values stay provisional and public posts explicitly withdraw comparisons", () => {
  const errors = check();
  assert.deepEqual(consistencyErrors(errors), []);
  assert.deepEqual(
    errors.map((error) => error.code),
    ["PROVISIONAL", "PROVISIONAL"],
  );
  assert.deepEqual(
    errors.map((error) => error.severity),
    ["warning", "warning"],
  );
  for (const suite of ["DATA_BENCH", "CODE_BENCH"]) {
    assert.ok(errors.some((error) => error.location === suite));
  }
});

for (const suite of ["DATA_BENCH", "CODE_BENCH"]) {
  for (const field of ["accuracyPct", "tokensM", "costUsd"]) {
    for (const value of [NaN, Infinity, -Infinity, -1, "1", null, undefined]) {
      test(`${suite}.${field} rejects ${String(value)} (${typeof value})`, () => {
        const data = fresh();
        data[suite][0][field] = value;
        assert.ok(
          check(data).some(
            (error) => error.code === "INVALID_METRIC" && error.location === `${suite}[0].${field}`,
          ),
        );
      });
    }
  }
}

test("rejects percentages above 100 and off the actual 15/80 outcome grids", () => {
  for (const [suite, value, code] of [
    ["DATA_BENCH", 101, "INVALID_METRIC"],
    ["DATA_BENCH", 66.68, "ACCURACY_GRID"],
    ["CODE_BENCH", 71.26, "ACCURACY_GRID"],
  ]) {
    const data = fresh();
    data[suite][0].accuracyPct = value;
    assert.ok(check(data).some((error) => error.code === code));
  }
});

test("zero cost cannot be the denominator of the published cost ratios", () => {
  const data = fresh();
  data.DATA_BENCH[0].costUsd = 0;
  assert.ok(check(data).some((error) => error.code === "INVALID_RATIO"));
});

test("rejects malformed, empty and missing suites and rows without throwing", () => {
  for (const value of [undefined, null, {}, [], [null], [1]]) {
    const data = fresh();
    data.DATA_BENCH = value;
    assert.notEqual(consistencyErrors(check(data)).length, 0);
  }
});

test("rejects duplicate, missing, unknown and misattributed frameworks", () => {
  const mutations = [
    (rows) => rows.push({ ...rows[0] }),
    (rows) => rows.pop(),
    (rows) => {
      rows[0].kind = "unknown";
    },
    (rows) => {
      rows[0].framework = "Claude Code";
    },
    (rows) => {
      rows[0].framework = "";
    },
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data.DATA_BENCH);
    assert.notEqual(consistencyErrors(check(data)).length, 0);
  }
});

test("refuses comparative tables or numbers in either public locale", () => {
  for (let index = 0; index < publications.length; index++) {
    const sources = structuredClone(publications);
    sources[index].text +=
      "\n| Framework | Model | Accuracy (%) | Tokens (M) | Cost ($) |\n|---|---|---:|---:|---:|\n| PenguinHarness | model | 66.67 | 1.00 | 1.00 |\n";
    assert.ok(check(fresh(), sources).some((error) => error.code === "UNVERIFIED_PUBLICATION"));
    sources[index].text = `${publications[index].text}\nUnverified result: 66.67%.`;
    assert.ok(check(fresh(), sources).some((error) => error.code === "UNVERIFIED_PUBLICATION"));
  }
});

test("requires both locale publications and their withdrawal notices", () => {
  for (const sources of [[], [{ path: "missing", text: "" }], publications.slice(0, 1)]) {
    assert.ok(check(fresh(), sources).some((error) => error.code === "INVALID_PUBLICATION"));
  }
  for (let index = 0; index < publications.length; index++) {
    const sources = structuredClone(publications);
    sources[index].text = sources[index].text.replace(
      index === 0 ? "we have removed those claims" : "因此已撤下",
      "withdrawal text removed",
    );
    assert.ok(check(fresh(), sources).some((error) => error.code === "MISSING_WITHDRAWAL_NOTICE"));
  }
});

test("accepts numeric boundaries without mistaking publication drift for invalid metrics", () => {
  for (const accuracyPct of [0, 100]) {
    const data = fresh();
    data.DATA_BENCH[0].accuracyPct = accuracyPct;
    data.DATA_BENCH[1].tokensM = 0;
    data.DATA_BENCH[1].costUsd = 0;
    assert.ok(
      !check(data).some((error) =>
        ["INVALID_METRIC", "ACCURACY_GRID", "INVALID_RATIO"].includes(error.code),
      ),
    );
  }
});

test("rejects invalid model and emphasis types", () => {
  for (const [field, value, code] of [
    ["model", " ", "INVALID_ATTRIBUTION"],
    ["model", 123, "INVALID_ATTRIBUTION"],
    ["emphasized", "true", "INVALID_EMPHASIS"],
    ["emphasized", false, "INVALID_EMPHASIS"],
  ]) {
    const data = fresh();
    data.DATA_BENCH[0][field] = value;
    assert.ok(check(data).some((error) => error.code === code));
  }
});

test("rejects duplicate sources and malformed benchmark tables", () => {
  const duplicate = [...publications, publications[0]];
  assert.ok(check(fresh(), duplicate).some((error) => error.code === "INVALID_PUBLICATION"));
  for (const table of [
    "| Framework | Model | Accuracy (%) | Tokens (M) | Cost ($) |\n|-----------:|---|---:|---:|---:|\n| PenguinHarness | model | 1.00 | 2.00 | 3.00 |",
    "| Framework | Model | Accuracy (%) | Tokens (M) | Cost ($) |\n|---|---|---:|---:|---:|\n| PenguinHarness | model | NaN | 2.00 | 3.00 |",
  ]) {
    const sources = structuredClone(publications);
    sources[0].text += `\n${table}\n`;
    assert.ok(check(fresh(), sources).some((error) => error.severity === "error"));
  }
});

test("does not bless arbitrary citations or extra provenance fields absent from the actual schema", () => {
  const data = fresh();
  data.DATA_BENCH[0].source = "https://example.invalid/unverified";
  data.DATA_BENCH[0].provenance = { verified: true };
  // The smuggled fields are blocking, and the suite loses its provisional warning only if a
  // row stops being flagged — the citation never converts into a pass of any kind.
  const errors = check(data);
  assert.deepEqual(
    errors.filter((error) => error.code === "UNKNOWN_FIELD").map((error) => error.location),
    ["DATA_BENCH[0].source", "DATA_BENCH[0].provenance"],
  );
  assert.deepEqual(
    errors.filter((error) => error.severity === "error").map((error) => error.code),
    ["UNKNOWN_FIELD", "UNKNOWN_FIELD"],
  );
});

// The real data is the safe state this gate is in today: every row flagged provisional, and
// the public posts withdrawn. Run from outside the repository cwd to prove module resolution is not
// accidentally cwd-dependent.
test("CLI passes on the real landing data with a disclosed provisional warning, also outside the repository cwd", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./verify-benchmark-data.mjs", import.meta.url))],
    {
      cwd: new URL("../packages/landing", import.meta.url),
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN PROVISIONAL.*DATA_BENCH/);
  assert.match(result.stderr, /WARN PROVISIONAL.*CODE_BENCH/);
  assert.match(result.stdout, /checked with 2 warnings/);
  assert.doesNotMatch(result.stdout, /certified provenance/);
});

// A candidate copy that drops the flag is the case the fail-closed arm exists for: the gate
// must refuse to certify it, and the override is what makes that exercisable end to end.
test("CLI fails closed on a candidate copy that is not flagged provisional", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  // A Windows bare path is not an importable specifier — the generated module needs a file URL
  // for its own dependency, which is the same conversion the gate's override performs.
  const source = pathToFileURL(
    fileURLToPath(new URL("../packages/landing/src/lib/benchmark-data.ts", import.meta.url)),
  ).href;
  writeFileSync(
    join(dir, "benchmark-data.ts"),
    `import { DATA_BENCH as D, CODE_BENCH as C } from ${JSON.stringify(source)};\n` +
      "const DATA_BENCH = structuredClone(D);\n" +
      "const CODE_BENCH = structuredClone(C);\n" +
      "delete DATA_BENCH[0].provisional;\n" +
      "export { DATA_BENCH, CODE_BENCH };\n",
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./verify-benchmark-data.mjs", import.meta.url))],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PENGUIN_BENCH_DATA: join(dir, "benchmark-data.ts") },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /FAIL MISSING_PROVENANCE.*DATA_BENCH/);
  assert.match(result.stderr, /Benchmark integrity BLOCKED/);
});
