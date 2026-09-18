import { describe, it, expect } from "vitest";
import {
  parsePaper,
  splitSections,
  extractIdentifiers,
  extractEquations,
  extractCitationMarkers,
  splitReferenceList,
  parseBibTeX,
  toBibTeX,
  normalizeDoi,
  looksLikePaper,
  type BibTeXEntry,
} from "../../../src/agent/research/paper-parser.js";

describe("normalizeDoi", () => {
  it("strips a scheme, host and doi: prefix", () => {
    expect(normalizeDoi("https://doi.org/10.1000/xyz")).toBe("10.1000/xyz");
    expect(normalizeDoi("https://dx.doi.org/10.1000/xyz")).toBe("10.1000/xyz");
    expect(normalizeDoi("doi: 10.1000/xyz")).toBe("10.1000/xyz");
    expect(normalizeDoi("10.1000/xyz")).toBe("10.1000/xyz");
  });

  it("trims trailing punctuation and a trailing parenthetical disambiguator", () => {
    expect(normalizeDoi("10.1000/xyz.")).toBe("10.1000/xyz");
    expect(normalizeDoi("10.1000/xyz,")).toBe("10.1000/xyz");
    expect(normalizeDoi("10.1000/xyz)")).toBe("10.1000/xyz");
    expect(normalizeDoi("10.1000/xyz(fig1)")).toBe("10.1000/xyz");
  });
});

describe("extractIdentifiers", () => {
  it("collects and normalises doi, arXiv, url and isbn identifiers", () => {
    const ids = extractIdentifiers(
      "See https://doi.org/10.48550/arXiv.2305.09781 and arXiv:2305.09781v2 at " +
        "https://example.org/paper (isbn 978-0-306-40615-7).",
    );
    expect(ids.dois).toContain("10.48550/arXiv.2305.09781");
    expect(ids.arxivIds).toContain("2305.09781v2");
    expect(ids.urls).toContain("https://example.org/paper");
    expect(ids.isbns).toContain("9780306406157");
  });

  it("de-duplicates repeated identifiers", () => {
    const ids = extractIdentifiers("10.1000/xyz and 10.1000/xyz and 10.1000/xyz");
    expect(ids.dois).toEqual(["10.1000/xyz"]);
  });

  it("leaves the lists empty for text without identifiers", () => {
    const ids = extractIdentifiers("No identifiers anywhere in this sentence.");
    expect(ids.dois).toHaveLength(0);
    expect(ids.arxivIds).toHaveLength(0);
    expect(ids.urls).toHaveLength(0);
    expect(ids.isbns).toHaveLength(0);
  });
});

describe("splitSections", () => {
  it("splits markdown headings and keeps content with its heading", () => {
    const sections = splitSections("# Abstract\nbody one\n\n## Methods\nbody two");
    expect(sections.map((section) => section.kind)).toEqual(["abstract", "methods"]);
    expect(sections[0]!.text).toBe("body one");
    expect(sections[1]!.text).toBe("body two");
    expect(sections[0]!.order).toBe(0);
  });

  it("classifies numbered and bare heading lines", () => {
    const sections = splitSections("2. Related Work\nprose\n3 Results\nmore prose");
    expect(sections.map((section) => section.kind)).toEqual(["related-work", "results"]);
  });

  it("collects leading untitled prose into an unknown section", () => {
    const sections = splitSections("preamble line\n# Introduction\nbody");
    expect(sections[0]!.kind).toBe("unknown");
    expect(sections[0]!.text).toBe("preamble line");
    expect(sections[1]!.kind).toBe("introduction");
  });

  it("returns an empty array for blank input", () => {
    expect(splitSections("   ")).toHaveLength(0);
  });
});

describe("extractEquations", () => {
  it("separates single-line display math from inline math", () => {
    const blocks = extractEquations("The identity $$E = mc^2$$ holds, as does $a = b$ inline.");
    const display = blocks.filter((block) => block.kind === "display");
    const inline = blocks.filter((block) => block.kind === "inline");
    expect(display).toHaveLength(1);
    expect(display[0]!.content).toBe("E = mc^2");
    expect(inline).toHaveLength(1);
    expect(inline[0]!.content).toBe("a = b");
  });

  it("reads the label of a labelled display equation", () => {
    const blocks = extractEquations("$$y = x^2 \\label{eq:quad}$$");
    expect(blocks[0]!.label).toBe("eq:quad");
  });

  it("joins a multi-line display block", () => {
    const blocks = extractEquations("intro text\n$$\na + b = c\n$$\nafter text");
    const display = blocks.find((block) => block.kind === "display");
    expect(display?.content).toBe("a + b = c");
  });

  it("extracts LaTeX equation environments", () => {
    const blocks = extractEquations("\\begin{equation}\n  z = y + 1\n\\end{equation}");
    const env = blocks.find((block) => block.kind === "environment");
    expect(env?.content).toBe("z = y + 1");
  });
});

describe("extractCitationMarkers", () => {
  it("returns markers in first-appearance order, de-duplicated", () => {
    const markers = extractCitationMarkers(
      "First \\cite{smith2020}, then [12], then [12, 15], then [12] again and (Jones et al., 2021).",
    );
    expect(markers).toEqual(["\\cite{smith2020}", "[12]", "[12, 15]", "(Jones et al., 2021)"]);
  });

  it("returns nothing for prose without citations", () => {
    expect(extractCitationMarkers("A claim with no citation at all.")).toHaveLength(0);
  });
});

describe("splitReferenceList", () => {
  it("splits numbered entries that span lines", () => {
    const refs = splitReferenceList(
      "[1] Smith, John. A Study of Things.\nJournal of Things, 2020.\n\n[2] Doe, Jane. Another Study.",
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]!.marker).toBe("[1]");
    expect(refs[0]!.text).toContain("Journal of Things, 2020.");
    expect(refs[1]!.marker).toBe("[2]");
  });

  it("splits an unnumbered block on blank lines", () => {
    const refs = splitReferenceList("Doe, Jane. One Study.\n\nRoe, Rowan. Two Study.");
    expect(refs).toHaveLength(2);
    expect(refs[0]!.marker).toBeUndefined();
  });

  it("returns an empty array for empty input", () => {
    expect(splitReferenceList("")).toHaveLength(0);
  });
});

describe("parseBibTeX", () => {
  const SIMPLE = [
    "@article{smith2020,",
    "  title = {The {Great} Title},",
    "  year = {2020},",
    "  author = {Smith, John}",
    "}",
  ].join("\n");

  it("parses type, key and fields", () => {
    const entries = parseBibTeX(SIMPLE);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("article");
    expect(entries[0]!.key).toBe("smith2020");
    expect(entries[0]!.fields.get("title")).toBe("The Great Title");
    expect(entries[0]!.fields.get("year")).toBe("2020");
    expect(entries[0]!.fields.get("author")).toBe("Smith, John");
  });

  it("tolerates nested braces and an equals sign inside a value", () => {
    const entries = parseBibTeX("@misc{k, note = {a = {b} and c}}");
    expect(entries[0]!.fields.get("note")).toBe("a = b and c");
  });

  it("keeps a truncated final entry rather than dropping it", () => {
    const entries = parseBibTeX("@article{bad,\n  title = {unclosed");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("bad");
    expect(entries[0]!.fields.get("title")).toBe("unclosed");
  });

  it("skips malformed entries that cannot structurally complete", () => {
    const entries = parseBibTeX("@not-an-entry @article{good, title = {ok}}");
    expect(entries.some((entry) => entry.key === "good")).toBe(true);
  });
});

describe("toBibTeX", () => {
  it("emits a parseable entry from a key and fields", () => {
    const entry: BibTeXEntry = {
      type: "misc",
      key: "k1",
      fields: new Map([
        ["title", "A Title"],
        ["year", "2021"],
      ]),
      raw: "",
    };
    const source = toBibTeX(entry);
    expect(source).toContain("@misc{k1,");
    expect(source).toContain("title = {A Title},");
    const reparsed = parseBibTeX(source);
    expect(reparsed[0]!.fields.get("title")).toBe("A Title");
    expect(reparsed[0]!.fields.get("year")).toBe("2021");
  });
});

describe("parsePaper", () => {
  const PAPER = [
    "Title: Speculative Decoding for Large Language Models",
    "Authors: Alice Smith, Bob Jones",
    "",
    "Abstract",
    "We propose a speculative decoding method that improves throughput by 31.4%.",
    "",
    "# Introduction",
    "Autoregressive generation is memory bandwidth bound. Prior work established that " +
      "acceptance above 80% is achievable [12].",
    "",
    "# References",
    "",
    "leviathan2023: Leviathan et al., Fast inference via speculative decoding, 2023.",
    "",
    "chen2023: Chen et al., Accelerating decoding with speculative sampling, 2023.",
  ].join("\n");

  it("reads front matter, sections, references and markers", () => {
    const parsed = parsePaper(PAPER);
    expect(parsed.title).toBe("Speculative Decoding for Large Language Models");
    expect(parsed.authors).toEqual(["Alice Smith", "Bob Jones"]);
    expect(parsed.abstract).toContain("improves throughput by 31.4%");
    expect(parsed.sections.some((section) => section.kind === "introduction")).toBe(true);
    expect(parsed.references).toHaveLength(2);
    expect(parsed.citationMarkers).toContain("[12]");
    expect(parsed.identifiers).toBeDefined();
  });

  it("infers the title from the first heading when no front matter is present", () => {
    const parsed = parsePaper("# On the Effects of Speculation\n\nbody text");
    expect(parsed.title).toBe("On the Effects of Speculation");
  });

  it("caps the number of sections when maxSections is set", () => {
    const parsed = parsePaper(PAPER, { maxSections: 2 });
    expect(parsed.sections).toHaveLength(2);
  });

  it("detects a paper-like document", () => {
    expect(looksLikePaper(parsePaper(PAPER))).toBe(true);
    expect(looksLikePaper(parsePaper("Just a sentence of prose with no structure at all."))).toBe(
      false,
    );
  });
});
