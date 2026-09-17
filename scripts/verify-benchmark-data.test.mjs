import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
const consistencyErrors = (errors) => errors.filter((error) => error.code !== "MISSING_PROVENANCE");

// These are copies/mutations of the real schema, not synthetic benchmark outcomes.
test("current tables are consistent, but neither suite has verifiable provenance", () => {
  const errors = check();
  assert.deepEqual(consistencyErrors(errors), []);
  assert.deepEqual(
    errors.map((error) => error.code),
    ["MISSING_PROVENANCE", "MISSING_PROVENANCE"],
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

test("rejects stale model attribution even when metrics have not changed", () => {
  const data = fresh();
  // The initial repository revision paired Claude Code with DeepSeek; the publication no longer does.
  data.DATA_BENCH[1].model = data.DATA_BENCH[0].model;
  assert.ok(
    check(data).some(
      (error) => error.code === "PUBLICATION_MISMATCH" && error.location.endsWith(".model"),
    ),
  );
});

test("checks all published numeric columns, at the publication's precision", () => {
  for (const field of ["accuracyPct", "tokensM", "costUsd"]) {
    const data = fresh();
    data.CODE_BENCH[0][field] += 1;
    assert.ok(
      check(data).some(
        (error) => error.code === "PUBLICATION_MISMATCH" && error.location.endsWith(`.${field}`),
      ),
    );
  }
});

test("checks both locales and refuses missing, malformed or truncated publications", () => {
  for (const sources of [[], [{ path: "missing", text: "" }], publications.slice(0, 1)]) {
    assert.ok(check(fresh(), sources).some((error) => error.code === "INVALID_PUBLICATION"));
  }
  for (let index = 0; index < publications.length; index++) {
    const sources = structuredClone(publications);
    sources[index].text = sources[index].text.replace("66.67", "66.68");
    assert.ok(check(fresh(), sources).some((error) => error.code === "PUBLICATION_MISMATCH"));
    sources[index].text = sources[index].text.replace(/^\| Claude Code.*$/m, "");
    assert.ok(check(fresh(), sources).some((error) => error.code === "INVALID_PUBLICATION"));
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

test("rejects duplicate sources, broken separators and nonnumeric published cells", () => {
  const duplicate = [...publications, publications[0]];
  assert.ok(check(fresh(), duplicate).some((error) => error.code === "INVALID_PUBLICATION"));
  for (const [before, after] of [
    ["-----------:", "broken"],
    ["66.67", "NaN"],
  ]) {
    const sources = structuredClone(publications);
    assert.ok(sources[0].text.includes(before));
    sources[0].text = sources[0].text.replace(before, after);
    assert.ok(check(fresh(), sources).some((error) => error.code === "INVALID_PUBLICATION"));
  }
});

test("does not bless arbitrary citations or extra provenance fields absent from the actual schema", () => {
  const data = fresh();
  data.DATA_BENCH[0].source = "https://example.invalid/unverified";
  data.DATA_BENCH[0].provenance = { verified: true };
  assert.equal(check(data).filter((error) => error.code === "MISSING_PROVENANCE").length, 2);
});

test("CLI fails closed on the real landing data, also outside the repository cwd", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./verify-benchmark-data.mjs", import.meta.url))],
    {
      cwd: new URL("../packages/landing", import.meta.url),
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /MISSING_PROVENANCE.*DATA_BENCH/);
  assert.match(result.stderr, /MISSING_PROVENANCE.*CODE_BENCH/);
  assert.doesNotMatch(result.stdout, /Benchmark data verified/);
});
