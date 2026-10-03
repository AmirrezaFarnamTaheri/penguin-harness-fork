/**
 * G2 — frozen skill-routing probes.
 *
 * The routing corpus lives in `test/fixtures/skill-routing/`: synthetic skills as real
 * `SKILL.md` files (so they go through the same parser the product uses) plus a bounded set of
 * repository skills, each hashed. Every probe names the candidates it routes among, the expected
 * id sequence, and the leader's score as measured from the real resolver at freeze time.
 *
 * Nothing here re-implements scoring: `SkillRegistry.match` is the runtime resolver, and the
 * synthetic skills are parsed by `parseSkillMarkdown` from their bytes. What the suite adds is
 * the frozen expectation and a trace that says which prompt, which description and which score
 * moved — the part a CI failure needs to be actionable.
 *
 * Description-drift evidence: a candidate whose hash no longer matches fails the drift check, and
 * the mutation section then demonstrates, on purpose, that removing a prompt's vocabulary from a
 * description really does change routing (and that adding filler does not).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, SkillRegistry } from "../src/agent/skill-engine.js";
import type { SkillDefinition, SkillMatchResult } from "../src/agent/skill-engine.js";

interface Probe {
  id: string;
  branch: string;
  prompt: string;
  candidates: string[];
  expect: string[];
  leaderScore: number | null;
  note: string;
}

interface Mutation {
  id: string;
  probe: string;
  skill: string;
  patch: Partial<SkillDefinition>;
  expectRoutingChange: boolean;
  note: string;
}

interface Corpus {
  version: number;
  minScore: number;
  maxResults: number;
  rules: Record<string, string>;
  syntheticSkills: Array<{ file: string; sha256: string }>;
  invalidSkill: { file: string; sha256: string; reason: string };
  realSkills: Array<{ name: string; sha256: string }>;
  probes: Probe[];
  mutations: Mutation[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const FIXTURES = path.join(HERE, "fixtures/skill-routing");
const SYNTHETIC_DIR = path.join(FIXTURES, "skills");
const REAL_DIR = path.join(REPO, ".agents/skills");

const corpus = JSON.parse(await readFile(path.join(FIXTURES, "probes.json"), "utf8")) as Corpus;

/** Synthetic candidate name is its file stem, which is also the `name:` in its frontmatter. */
const syntheticName = (file: string): string => file.replace(/\.md$/, "");

const definitions = new Map<string, SkillDefinition>();
const bytes = new Map<string, Buffer>();

for (const entry of corpus.syntheticSkills) {
  const raw = await readFile(path.join(SYNTHETIC_DIR, entry.file));
  bytes.set(syntheticName(entry.file), raw);
  const parsed = parseSkillMarkdown(raw.toString("utf8"), entry.file);
  if (parsed !== null) definitions.set(parsed.name, parsed);
}
for (const entry of corpus.realSkills) {
  const raw = await readFile(path.join(REAL_DIR, entry.name, "SKILL.md"));
  bytes.set(entry.name, raw);
  const parsed = parseSkillMarkdown(raw.toString("utf8"), entry.name);
  if (parsed !== null) definitions.set(parsed.name, parsed);
}

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

function registryFor(
  candidates: string[],
  overrides: Record<string, Partial<SkillDefinition>> = {},
): SkillRegistry {
  const registry = new SkillRegistry({});
  for (const name of candidates) {
    const definition = definitions.get(name);
    expect(definition, `candidate ${name} is not in the frozen corpus`).toBeDefined();
    registry.register(overrides[name] ? { ...definition!, ...overrides[name] } : definition!);
  }
  return registry;
}

function route(
  probe: Probe,
  overrides: Record<string, Partial<SkillDefinition>> = {},
): SkillMatchResult[] {
  return registryFor(probe.candidates, overrides).match(probe.prompt, {
    maxResults: corpus.maxResults,
    minScore: corpus.minScore,
  });
}

const ids = (results: SkillMatchResult[]): string[] => results.map((result) => result.skill.name);

/** The trace a CI failure needs: prompt, expected, actual, scores, and the deciding keywords. */
function trace(probe: Probe, results: SkillMatchResult[]): string {
  const actual = ids(results);
  const scored = results.map(
    (result) => `${result.skill.name}=${result.score} [${result.matchedKeywords.join(", ")}]`,
  );
  return [
    `probe ${probe.id} (${probe.branch})`,
    `  prompt:    ${JSON.stringify(probe.prompt)}`,
    `  corpus:    ${probe.candidates.join(", ")}`,
    `  expected:  ${probe.expect.length === 0 ? "(no match)" : probe.expect.join(", ")}`,
    `  actual:    ${actual.length === 0 ? "(no match)" : actual.join(", ")}`,
    `  scored:    ${scored.length === 0 ? "(nothing cleared the floor)" : scored.join(" | ")}`,
    `  note:      ${probe.note}`,
  ].join("\n");
}

const probeById = new Map(corpus.probes.map((probe) => [probe.id, probe]));

describe("G2.1 — the corpus is frozen and drift is an explicit failure", () => {
  it("pins every corpus file by hash", () => {
    const missing: string[] = [];
    for (const [name, raw] of bytes) {
      const expected =
        corpus.syntheticSkills.find((entry) => syntheticName(entry.file) === name)?.sha256 ??
        corpus.realSkills.find((entry) => entry.name === name)?.sha256;
      if (sha256(raw) !== expected) missing.push(name);
    }
    expect(
      missing,
      `corpus drift: ${missing.join(", ")} — a description changed without updating the frozen ` +
        `expectations. Update the hash and the probes that depended on it in the same change.`,
    ).toEqual([]);
    expect(bytes.size).toBe(corpus.syntheticSkills.length + corpus.realSkills.length);
  });

  it("echoes the routing rules the probes rely on", () => {
    expect(Object.keys(corpus.rules).sort()).toEqual([
      "fanout",
      "floor",
      "invalid",
      "noMatch",
      "ordering",
      "tie",
    ]);
  });
});

describe("G2.2 — every probe runs through the runtime resolver", () => {
  for (const probe of corpus.probes) {
    it(`${probe.id} — ${probe.branch}`, () => {
      const results = route(probe);
      expect(ids(results), `\n${trace(probe, results)}`).toEqual(probe.expect);
      if (probe.leaderScore === null) {
        expect(results, `\n${trace(probe, results)}`).toEqual([]);
        return;
      }
      expect(results[0]!.score, `\n${trace(probe, results)}`).toBeCloseTo(probe.leaderScore, 5);
      // Every routed id carries a term match, so a failure names the vocabulary that decided it.
      for (const result of results) expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });
  }

  it("orders a score tie by name, not by candidate order", () => {
    const probe = probeById.get("syn/tie-deterministic")!;
    const forward = route(probe);
    const reversed: Probe = { ...probe, candidates: [...probe.candidates].reverse() };
    const backward = route(reversed);
    expect(ids(backward), `\n${trace(reversed, backward)}`).toEqual(ids(forward));
    expect(forward[0]!.score).toBe(forward[1]!.score);
    expect(ids(forward)).toEqual([...ids(forward)].sort());
  });
});

describe("G2.4 — description mutations and the named outcomes", () => {
  for (const mutation of corpus.mutations) {
    it(`${mutation.id} — ${mutation.expectRoutingChange ? "breaks" : "does not break"} routing`, () => {
      const probe = probeById.get(mutation.probe)!;
      const before = ids(route(probe));
      const after = ids(route(probe, { [mutation.skill]: mutation.patch }));
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      if (mutation.expectRoutingChange) {
        // This is the fixture that must fail: a real description break has to move the result.
        expect(
          changed,
          `\n${mutation.note}\n  mutation of ${mutation.skill} did not move ${probe.id}\n` +
            `  before: ${before.join(", ") || "(no match)"}\n  after:  ${after.join(", ") || "(no match)"}`,
        ).toBe(true);
      } else {
        expect(
          changed,
          `\n${mutation.note}\n  benign edit changed ${probe.id}: ${before.join(", ")} -> ${after.join(", ")}`,
        ).toBe(false);
      }
    });
  }

  it("refuses an invalid skill instead of registering an unnamed one", async () => {
    const raw = await readFile(path.join(SYNTHETIC_DIR, corpus.invalidSkill.file));
    expect(sha256(raw)).toBe(corpus.invalidSkill.sha256);
    expect(parseSkillMarkdown(raw.toString("utf8"), corpus.invalidSkill.file)).toBeNull();
    // A would-be candidate naming it cannot be routed, and the failure is the explicit
    // "not in the frozen corpus" assertion rather than a crash inside the registry.
    expect(() => registryFor(["broken"])).toThrow(/not in the frozen corpus/);
  });

  it("never routes an unmatched prompt to some default skill", () => {
    for (const probe of corpus.probes) {
      if (probe.expect.length > 0) continue;
      expect(ids(route(probe)), `probe ${probe.id}`).toEqual([]);
    }
  });
});
