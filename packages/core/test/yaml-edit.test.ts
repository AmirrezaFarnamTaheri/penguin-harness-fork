/**
 * H2 — YAML edit round trip: style goldens and non-mutating refusals.
 *
 * Every fixture under `fixtures/yaml-edit/` is frozen bytes. The supported ones have an
 * `.expected.yaml` golden that the edited document must equal **byte for byte** — that is the whole
 * point of H2: not "the values are right" but "the file the user wrote is still their file".
 * The refusal fixtures have no golden: what is asserted is that the returned text IS the original
 * bytes, i.e. the adapter refused before changing anything.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyYamlEdits,
  detectYamlIndent,
  detectYamlSequenceStyle,
  parseYamlForEdit,
  type YamlEdit,
} from "../src/state/yaml-edit.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/yaml-edit/${name}`, import.meta.url)), "utf8");

interface SupportedCase {
  name: string;
  edits: YamlEdit[];
  /** Substrings a reader can check at a glance; the byte golden is the real assertion. */
  keeps: string[];
  /** Expected notes, if any (repairs and style normalizations the caller may surface). */
  notes?: string[];
}

const SUPPORTED: SupportedCase[] = [
  {
    name: "styled",
    edits: [
      { path: ["max_turns"], value: 12 },
      { path: ["model", "max_tokens"], value: 8192 },
    ],
    keeps: [
      "# Agent system config — hand-tuned, comments matter.",
      "# the model block: nested map with a quoted scalar and a number",
      "# tools section, indentless sequence follows",
      '"My Agent"',
      "'single-quoted description'",
      '"medium"',
      "# the two the user actually wants",
      "You are a careful agent.",
      "compaction: { max_context_length: 0 }",
    ],
  },
  {
    name: "four-space",
    edits: [{ path: ["model", "max_tokens"], value: 8192 }],
    keeps: ["# four-space document", "      depth: 2", "  - read_file"],
  },
  { name: "empty", edits: [{ path: ["name"], value: "hello" }], keeps: ["name: hello"] },
  {
    name: "comments-only",
    edits: [{ path: ["name"], value: "hello" }],
    keeps: ["# nothing but comments so far", "# the user started the file and stopped"],
  },
  {
    name: "null-section",
    edits: [{ path: ["tools", "read_file"], value: true }],
    keeps: ["name: x", "max_turns: 3"],
    notes: ['replaced non-mapping section "tools"'],
  },
  {
    name: "mixed-seq-styles",
    edits: [{ path: ["name"], value: "mixed" }],
    // The indentless style is kept; the indented sequence is rewritten flush to match it.
    keeps: ["first:\n- indentless", "second:\n- indented"],
    notes: [
      "mixed sequence styles: the document uses both indentless and indented sequences; " +
        "the indentless style is kept and the indented ones are rewritten flush",
    ],
  },
];

interface RefusalCase {
  name: string;
  code: string;
  /** A phrase the message must carry, so the refusal is actionable rather than "invalid YAML". */
  says: string;
}

const REFUSALS: RefusalCase[] = [
  { name: "duplicate-keys", code: "duplicate-key", says: "Map keys must be unique" },
  { name: "malformed", code: "malformed", says: "malformed" },
  { name: "tab-indent", code: "unsupported-syntax", says: "unsupported-syntax" },
  { name: "root-sequence", code: "root-type", says: "expected a mapping" },
  { name: "root-scalar", code: "root-type", says: "expected a mapping" },
  { name: "alias-copy", code: "unwritable-path", says: "alias" },
];

const REFUSAL_EDIT: YamlEdit = { path: ["copy", "max_tokens"], value: 8192 };

describe("H2.1 — frozen style fixtures", () => {
  it("detects indentation width from the source", () => {
    expect(detectYamlIndent(fixture("styled.yaml"))).toBe(2);
    expect(detectYamlIndent(fixture("four-space.yaml"))).toBe(4);
    expect(detectYamlIndent("")).toBe(2); // nothing to detect: the library default
  });

  it("classifies indentless, indented and mixed sequence styles", () => {
    expect(detectYamlSequenceStyle(fixture("styled.yaml"))).toMatchObject({
      indentless: true,
      indented: false,
      mixed: false,
    });
    expect(detectYamlSequenceStyle(fixture("four-space.yaml"))).toMatchObject({
      indentless: false,
      indented: true,
      mixed: false,
    });
    expect(detectYamlSequenceStyle(fixture("mixed-seq-styles.yaml"))).toMatchObject({
      mixed: true,
    });
  });

  it("parses a comment block scalar and flow collection without notes or refusal", () => {
    const parsed = parseYamlForEdit(fixture("styled.yaml"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.notes).toEqual([]);
  });
});

describe("H2.2/H2.4 — supported edits preserve the document's own style (byte goldens)", () => {
  for (const testCase of SUPPORTED) {
    it(`${testCase.name}: edited bytes equal the golden`, () => {
      const raw = fixture(`${testCase.name}.yaml`);
      const expected = fixture(`${testCase.name}.expected.yaml`);
      const outcome = applyYamlEdits(raw, testCase.edits);
      if (!outcome.ok) throw new Error(`refused unexpectedly: ${outcome.refusal.message}`);
      expect(outcome.text).toBe(expected);
      expect(outcome.text).not.toBe(raw);
      for (const kept of testCase.keeps) expect(outcome.text).toContain(kept);
      expect(outcome.notes).toEqual(testCase.notes ?? []);
    });

    it(`${testCase.name}: re-applying the same edits is byte-stable`, () => {
      const raw = fixture(`${testCase.name}.yaml`);
      const once = applyYamlEdits(raw, testCase.edits);
      if (!once.ok) throw new Error("refused unexpectedly");
      const twice = applyYamlEdits(once.text, testCase.edits);
      if (!twice.ok) throw new Error("refused on the second pass");
      expect(twice.text).toBe(once.text);
    });
  }

  it("leaves unrelated comments alone when only one value changes", () => {
    const raw = fixture("four-space.yaml");
    const outcome = applyYamlEdits(raw, [{ path: ["model", "max_tokens"], value: 8192 }]);
    if (!outcome.ok) throw new Error("refused unexpectedly");
    // Everything except the one edited line is identical.
    const before = raw.split("\n");
    const after = outcome.text.split("\n");
    const changed = before.filter((line, i) => line !== after[i]);
    expect(changed).toEqual(["    max_tokens: 4096"]);
  });

  it("writes a new sequence in the document's own sequence style", () => {
    // A fresh node has no style of its own, so the document's style has to be applied to it —
    // otherwise adding a list to an indentless config silently reformats it to the library default.
    const indentless = applyYamlEdits(fixture("styled.yaml"), [
      { path: ["extra"], value: ["x", "y"] },
    ]);
    if (!indentless.ok) throw new Error("refused unexpectedly");
    expect(indentless.text).toContain("extra:\n- x\n- y");

    const indented = applyYamlEdits(fixture("four-space.yaml"), [
      { path: ["extra"], value: ["x", "y"] },
    ]);
    if (!indented.ok) throw new Error("refused unexpectedly");
    // Four-space document: the new sequence is indented four spaces, not the library's two.
    expect(indented.text).toContain("extra:\n    - x\n    - y");
  });

  it("touches no other key's value", () => {
    const raw = fixture("styled.yaml");
    const outcome = applyYamlEdits(raw, [
      { path: ["max_turns"], value: 12 },
      { path: ["model", "max_tokens"], value: 8192 },
    ]);
    if (!outcome.ok) throw new Error("refused unexpectedly");
    expect(outcome.text).toContain('name: "My Agent"');
    expect(outcome.text).toContain("description: 'single-quoted description'");
    expect(outcome.text).toContain('thinking_level: "medium"');
    expect(outcome.text).toContain("- write_file");
  });
});

describe("H2 — known style limitations, pinned", () => {
  it("moves an inline comment on a sequence-valued key to the line above the sequence", () => {
    // The library attaches that comment to the sequence, not the key, and stringify re-emits it
    // before the items. The text survives; the inline position does not. Pinned here so the
    // limitation is visible rather than discovered later as a "comment was lost" report.
    const raw = fixture("styled.yaml");
    const outcome = applyYamlEdits(raw, [{ path: ["max_turns"], value: 12 }]);
    if (!outcome.ok) throw new Error("refused unexpectedly");
    expect(outcome.text).toContain(
      "tools:\n# tools section, indentless sequence follows\n- read_file",
    );
  });
});

describe("H2.3 — refusals are non-mutating and coded", () => {
  for (const testCase of REFUSALS) {
    it(`${testCase.name}: refused as ${testCase.code}, original bytes returned`, () => {
      const raw = fixture(`${testCase.name}.yaml`);
      const edit =
        testCase.name === "alias-copy" ? REFUSAL_EDIT : { path: ["max_turns"], value: 4 };
      const outcome = applyYamlEdits(raw, [edit]);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal.code).toBe(testCase.code);
      expect(outcome.refusal.message).toContain(testCase.says);
      // The non-mutating contract: the caller gets back exactly what it passed in.
      expect(outcome.text).toBe(raw);
    });
  }

  it("refuses a write through an alias even when the path exists via the anchor", () => {
    const raw = fixture("alias-copy.yaml");
    const outcome = applyYamlEdits(raw, [{ path: ["copy", "max_tokens"], value: 8192 }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe("unwritable-path");
      expect(outcome.text).toBe(raw);
      // Refusing, not partial-writing: the anchor's own value is untouched too.
      expect(outcome.text).toContain("max_tokens: 4096");
    }
  });

  it("refuses when a path would replace a collection of the wrong kind", () => {
    const raw = "tools:\n  - read_file\n";
    const outcome = applyYamlEdits(raw, [{ path: ["tools", "read_file"], value: true }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe("unwritable-path");
      expect(outcome.text).toBe(raw);
    }
  });

  it("refuses a duplicate-key document instead of guessing which value wins", () => {
    const raw = fixture("duplicate-keys.yaml");
    const parsed = parseYamlForEdit(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.line).toBe(2);
  });

  it("does not touch the filesystem (the contract is a pure string in, string out)", () => {
    // Pin: importing node:fs here would let a future edit write during a "preview".
    const source = readFileSync(
      fileURLToPath(new URL("../src/state/yaml-edit.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from "node:fs/);
    expect(source).not.toMatch(/atomicWriteFile/);
  });
});
