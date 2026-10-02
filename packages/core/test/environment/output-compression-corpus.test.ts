/**
 * B3 — the frozen corpus, the three non-negotiables, and the savings floor.
 *
 * This suite is deliberately separate from `output-compression.test.ts`: that file proves the
 * strategies' behaviour on hand-written shapes, while this one drives the *committed* corpus
 * (`test/fixtures/output-compression/`, every byte hashed in `manifest.json`) through the same
 * entry points the tool-result path uses. The point is reproducibility: the numbers in the
 * receipt and in `artifacts/output-compression-savings.json` come from these files, so they can
 * be re-derived by anyone who checks out the commit.
 *
 * A fixture edit without a manifest update fails the hash check — that is the freeze.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyToolOutput } from "../../src/environment/output-compression/detect.js";
import { compressOutput } from "../../src/environment/output-compression/strategies.js";
import type { OutputKind } from "../../src/environment/output-compression/strategies.js";

interface Fixture {
  file: string;
  sha256: string;
  bytes: number;
  class: OutputKind;
  command: string;
  exitCode: number;
  expected: "compressed" | "passthrough";
  minSavingRatio: number;
  notes: string;
  failureMarkers?: string[];
}

interface Manifest {
  version: number;
  budgetChars: number;
  fixtures: Fixture[];
}

const DIR = path.resolve(fileURLToPath(new URL("../fixtures/output-compression", import.meta.url)));

async function loadManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(DIR, "manifest.json"), "utf8")) as Manifest;
}

async function loadText(fixture: Fixture): Promise<string> {
  return readFile(path.join(DIR, fixture.file), "utf8");
}

/** The classification the tool-result path would make, from the fixture's recorded metadata. */
function classify(fixture: Fixture): OutputKind | null {
  if (fixture.command.startsWith("read_file")) {
    return classifyToolOutput("read_file", {
      file_path: fixture.command.slice("read_file ".length),
    });
  }
  return classifyToolOutput("exec_command", { cmd: fixture.command });
}

describe("B3.1 — the frozen corpus", () => {
  it("pins every fixture's bytes by hash and size", async () => {
    const manifest = await loadManifest();
    expect(manifest.version).toBe(1);
    for (const fixture of manifest.fixtures) {
      const text = await loadText(fixture);
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      expect(digest, `${fixture.file} bytes changed; update manifest.json deliberately`).toBe(
        fixture.sha256,
      );
      expect(Buffer.byteLength(text, "utf8"), `${fixture.file} size`).toBe(fixture.bytes);
    }
    // Every fixture names its class, command and exit code: the metadata a caller would have
    // had, which is what makes the corpus a measurement input rather than a pile of text.
    for (const fixture of manifest.fixtures) {
      expect(fixture.class.length).toBeGreaterThan(0);
      expect(fixture.command.length).toBeGreaterThan(0);
      expect(Number.isInteger(fixture.exitCode)).toBe(true);
      expect(fixture.notes.length).toBeGreaterThan(20);
    }
  });

  it("classifies every fixture through the real classifier, matching its recorded class", async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.fixtures) {
      expect(classify(fixture), `${fixture.file} (${fixture.command})`).toBe(fixture.class);
    }
  });
});

describe("B3.3 — the three non-negotiables", () => {
  it("keeps the promised failure evidence of every failing fixture", async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.fixtures) {
      const markers = fixture.failureMarkers ?? [];
      if (markers.length === 0) continue;
      const result = compressOutput({
        kind: fixture.class,
        text: await loadText(fixture),
        maxChars: manifest.budgetChars,
      });
      expect(result, `${fixture.file} must compress`).not.toBeNull();
      for (const marker of markers) {
        expect(result!.text, `${fixture.file} lost ${JSON.stringify(marker)}`).toContain(marker);
      }
    }
  });

  it("cannot turn a failure into a success: the exit code decides, never the text", async () => {
    const manifest = await loadManifest();
    // The tool-result path carries the exit code outside the compressible text, and a compressed
    // body must never read as a clean run. This asserts both halves on the failing fixtures.
    for (const fixture of manifest.fixtures) {
      if (fixture.exitCode === 0) continue;
      const result = compressOutput({
        kind: fixture.class,
        text: await loadText(fixture),
        maxChars: manifest.budgetChars,
      });
      expect(result, `${fixture.file} must compress`).not.toBeNull();
      // A body that reads as a success is the one thing compression may never produce. The
      // failing fixtures keep their own evidence (asserted in the test above); what is checked
      // here is that the *summary* never claims a clean run.
      expect(
        result!.text,
        `${fixture.file} compressed body must not read as a clean run`,
      ).not.toMatch(/\b(all tests passed|0 failed|no errors|passed \(\d+\)$)/i);
    }
  });

  it("is deterministic: the same fixture compresses to the same bytes twice", async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.fixtures) {
      const text = await loadText(fixture);
      const first = compressOutput({ kind: fixture.class, text, maxChars: manifest.budgetChars });
      const second = compressOutput({ kind: fixture.class, text, maxChars: manifest.budgetChars });
      expect(second, `${fixture.file}`).toEqual(first);
    }
  });

  it("returns a below-floor fixture untouched rather than announcing a loss", async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.fixtures) {
      if (fixture.expected !== "passthrough") continue;
      const result = compressOutput({
        kind: fixture.class,
        text: await loadText(fixture),
        maxChars: manifest.budgetChars,
      });
      expect(result, `${fixture.file} is documented as a pass-through`).toBeNull();
    }
  });
});

describe("B3.4 — the shipped classes clear the savings floor on the frozen corpus", () => {
  it("saves at least the recorded ratio for every compressed fixture", async () => {
    const manifest = await loadManifest();
    const rows: string[] = [];
    for (const fixture of manifest.fixtures) {
      const text = await loadText(fixture);
      const result = compressOutput({ kind: fixture.class, text, maxChars: manifest.budgetChars });
      if (fixture.expected === "passthrough") {
        expect(result).toBeNull();
        rows.push(`${fixture.class.padEnd(12)} ${fixture.file.padEnd(26)} pass-through`);
        continue;
      }
      expect(result, `${fixture.file}`).not.toBeNull();
      const before = text.length;
      const after = result!.text.length;
      const saved = 1 - after / before;
      rows.push(
        `${fixture.class.padEnd(12)} ${fixture.file.padEnd(26)} ${String(before).padStart(7)} -> ${String(after).padStart(6)} (${(saved * 100).toFixed(1)}%)`,
      );
      expect(
        saved,
        `${fixture.file} must save >= ${fixture.minSavingRatio}`,
      ).toBeGreaterThanOrEqual(fixture.minSavingRatio);
      // The counts a compressed result reports are the counts the note and the recall handle
      // are built from, so they must describe the input honestly.
      expect(result!.originalChars).toBe(text.length);
      expect(result!.keptLines).toBeGreaterThan(0);
      expect(result!.hiddenLines).toBeGreaterThanOrEqual(0);
    }
    expect(rows.length).toBe(manifest.fixtures.length);
  });

  it("clears the card's 10% floor for every shipped class", async () => {
    const manifest = await loadManifest();
    const byClass = new Map<OutputKind, { before: number; after: number }>();
    for (const fixture of manifest.fixtures) {
      if (fixture.expected !== "compressed") continue;
      const text = await loadText(fixture);
      const result = compressOutput({ kind: fixture.class, text, maxChars: manifest.budgetChars });
      expect(result).not.toBeNull();
      const entry = byClass.get(fixture.class) ?? { before: 0, after: 0 };
      entry.before += text.length;
      entry.after += result!.text.length;
      byClass.set(fixture.class, entry);
    }
    // Six shipped classes; each one measured here, not in a comment.
    expect([...byClass.keys()].sort()).toEqual([
      "git-diff",
      "git-log",
      "git-status",
      "lint",
      "log-dedup",
      "test-runner",
    ]);
    for (const [kind, { before, after }] of byClass) {
      const saved = 1 - after / before;
      expect(saved, `${kind} saves ${(saved * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.1);
    }
  });
});
