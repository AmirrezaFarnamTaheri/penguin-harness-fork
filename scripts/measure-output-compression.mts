/**
 * B3.4 — measures the frozen corpus and writes the savings table.
 *
 * Reproducible by construction: the fixtures are byte-hashed in their manifest, the transforms are
 * deterministic, and this script only counts. Latency is reported (median of `RUNS` warm runs) but
 * never asserted anywhere — it is machine noise, not a property of the code.
 *
 * Exits non-zero if a *shipped* class lands under the card's 10% floor, so a regression here is a
 * failed build step rather than a quietly wrong table.
 *
 *   node --import tsx scripts/measure-output-compression.mts
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compressOutput } from "../packages/core/src/environment/output-compression/strategies.js";
import type { OutputKind } from "../packages/core/src/environment/output-compression/strategies.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "packages/core/test/fixtures/output-compression");
const OUT = path.join(ROOT, "artifacts/output-compression-savings.json");
const RUNS = 25;

interface Fixture {
  file: string;
  sha256: string;
  bytes: number;
  class: OutputKind;
  command: string;
  exitCode: number;
  expected: "compressed" | "passthrough";
  notes: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

const manifest = JSON.parse(await readFile(path.join(DIR, "manifest.json"), "utf8")) as {
  version: number;
  budgetChars: number;
  fixtures: Fixture[];
};

const rows: Array<Record<string, unknown>> = [];
const byClass = new Map<OutputKind, { beforeChars: number; afterChars: number }>();

for (const fixture of manifest.fixtures) {
  const text = await readFile(path.join(DIR, fixture.file), "utf8");
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (digest !== fixture.sha256) {
    console.error(`fixture ${fixture.file} does not match its manifest hash (${digest})`);
    process.exit(2);
  }
  const timings: number[] = [];
  let result = compressOutput({
    kind: fixture.class,
    text,
    maxChars: manifest.budgetChars,
  });
  for (let run = 0; run < RUNS; run += 1) {
    const started = process.hrtime.bigint();
    result = compressOutput({ kind: fixture.class, text, maxChars: manifest.budgetChars });
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const beforeChars = text.length;
  const afterChars = result === null ? beforeChars : result.text.length;
  const savedRatio = beforeChars === 0 ? 0 : 1 - afterChars / beforeChars;
  if (fixture.expected === "compressed" && result === null) {
    console.error(`${fixture.file} is recorded as compressed but the strategy declined`);
    process.exit(2);
  }
  if (result !== null) {
    const entry = byClass.get(fixture.class) ?? { beforeChars: 0, afterChars: 0 };
    entry.beforeChars += beforeChars;
    entry.afterChars += afterChars;
    byClass.set(fixture.class, entry);
  }
  rows.push({
    file: fixture.file,
    class: fixture.class,
    command: fixture.command,
    exitCode: fixture.exitCode,
    sha256: fixture.sha256,
    decision: result === null ? "passthrough" : "compressed",
    bytesIn: Buffer.byteLength(text, "utf8"),
    charsIn: beforeChars,
    charsOut: afterChars,
    savedRatio: Number(savedRatio.toFixed(4)),
    // The token estimate the recall handle also publishes, labelled as an estimate: this module
    // ships no tokenizer, so a "token count" here would be a fabricated precision.
    estimatedTokensIn: Math.ceil(Buffer.byteLength(text, "utf8") / 4),
    estimatedTokensOut:
      result === null ? Math.ceil(Buffer.byteLength(text, "utf8") / 4) : Math.ceil(afterChars / 4),
    medianMs: Number(median(timings).toFixed(4)),
    hiddenLines: result?.hiddenLines ?? 0,
  });
}

const classes = [...byClass.entries()]
  .map(([kind, { beforeChars, afterChars }]) => ({
    class: kind,
    charsIn: beforeChars,
    charsOut: afterChars,
    savedRatio: Number((1 - afterChars / beforeChars).toFixed(4)),
    shipped: 1 - afterChars / beforeChars >= 0.1,
  }))
  .sort((a, b) => b.savedRatio - a.savedRatio);

const artifact = {
  version: 1,
  generator: "scripts/measure-output-compression.mts",
  budgetChars: manifest.budgetChars,
  corpusManifest: "packages/core/test/fixtures/output-compression/manifest.json",
  runsPerFixture: RUNS,
  notes:
    "Character counts against the configured budget; latency is the median of warm runs and is machine-dependent. estimatedTokens is bytes/4 and is labelled an estimate because no tokenizer ships here. A class with shipped=false must not be enabled.",
  fixtures: rows,
  classes,
};
await writeFile(OUT, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

console.log(
  `${"class".padEnd(12)} ${"chars in".padStart(10)} ${"chars out".padStart(10)} ${"saved".padStart(8)}  shipped`,
);
for (const row of classes) {
  console.log(
    `${row.class.padEnd(12)} ${String(row.charsIn).padStart(10)} ${String(row.charsOut).padStart(10)} ` +
      `${(row.savedRatio * 100).toFixed(1).padStart(6)}%  ${row.shipped ? "yes" : "NO"}`,
  );
}
const dropped = classes.filter((row) => !row.shipped);
if (dropped.length > 0) {
  console.error(`classes below the 10% floor: ${dropped.map((row) => row.class).join(", ")}`);
  process.exit(1);
}
console.log(`wrote ${path.relative(ROOT, OUT)}`);
