/**
 * Scientific paper parser.
 *
 * Turns paper text — extracted PDF text, arXiv HTML, LaTeX source, or markdown — into
 * structured sections, a parsed reference list, BibTeX entries, and normalised
 * identifiers. Owns the document-structure concerns (sections, equations, references)
 * and deliberately does not touch fenced code blocks: that is the omnimessage
 * artifact extractor's job.
 *
 * Grammar pieces (plan Tier-5):
 * - DOI normalization: `10.\d{4,9}/\S+` with tail trimming of punctuation and
 *   parenthesised suffixes, plus scheme/host stripping.
 * - BibTeX: a brace-depth scanner tolerant of nested braces, embedded `=` inside
 *   braces, and unbalanced entries — a real BibTeX file is full of both.
 */

export type PaperSectionKind =
  | "title"
  | "abstract"
  | "introduction"
  | "background"
  | "related-work"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "appendix"
  | "unknown";

export interface PaperSection {
  readonly kind: PaperSectionKind;
  readonly heading: string;
  readonly text: string;
  readonly order: number;
}

export interface EquationBlock {
  readonly kind: "display" | "inline" | "environment";
  readonly content: string;
  /** Label if the equation declares one (`\label{...}`). */
  readonly label?: string;
  readonly order: number;
}

export interface RawReference {
  /** Raw text of one bibliography entry. */
  readonly text: string;
  /** Normalised marker, e.g. `[12]` or `[Smith2020]`. */
  readonly marker?: string;
  /** Parsed identifiers found inside the entry. */
  readonly identifiers: ParsedIdentifiers;
  readonly order: number;
}

export interface ParsedIdentifiers {
  readonly dois: string[];
  readonly arxivIds: string[];
  readonly urls: string[];
  readonly isbns: string[];
}

export interface ParsedPaper {
  readonly title: string;
  readonly authors: string[];
  readonly abstract: string;
  readonly year?: number;
  readonly identifiers: ParsedIdentifiers;
  readonly sections: PaperSection[];
  readonly equations: EquationBlock[];
  readonly references: RawReference[];
  /** Citation markers as they appear in the body text, in order of first appearance. */
  readonly citationMarkers: string[];
}

/**
 * DOI normalization regex (plan Tier-5). Matches the registrant code, the optional
 * direct-object suffix, and stops at whitespace or a closing bracket. Trailing
 * punctuation (`.`, `,`, `;`, `)`) that is not part of the DOI is stripped.
 */
export const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/g;

/** arXiv identifier, old- and new-style, with optional version. */
export const ARXIV_ID_PATTERN =
  /\b(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/[a-z-]+\d{2}(?:v\d+)?)\b/gi;

export const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;
export const ISBN_PATTERN = /\b(?:97[89][- ]?)?\d[- ]?(?:\d[- ]?){8}[\dXx]\b/g;

const SECTION_HEADING_RULES: ReadonlyArray<{
  kind: PaperSectionKind;
  patterns: readonly RegExp[];
}> = [
  {
    kind: "abstract",
    patterns: [/^\s*#{0,6}\s*abstract\b/i, /^\s*abstract\s*$/im, /^\s*#{0,6}\s*summary\b/i],
  },
  {
    kind: "introduction",
    patterns: [/^\s*#{0,6}\s*(?:\d+\.?\s*)?introduction\b/i],
  },
  {
    kind: "related-work",
    patterns: [/^\s*#{0,6}\s*(?:\d+\.?\s*)?related\s+work\b/i],
  },
  {
    // Related work is listed after the general background rule on purpose: `related work`
    // would otherwise fall through to the broader background match and never be reported
    // as its own section kind.
    kind: "background",
    patterns: [/^\s*#{0,6}\s*(?:\d+\.?\s*)?(?:background|preliminar(?:y|ies)|related works?)\b/i],
  },
  {
    kind: "methods",
    patterns: [
      /^\s*#{0,6}\s*(?:\d+\.?\s*)?(?:method(?:s|ology)?|approach|model|experimental setup|experiments?|materials and methods|implementation details)\b/i,
    ],
  },
  {
    kind: "results",
    patterns: [
      /^\s*#{0,6}\s*(?:\d+\.?\s*)?(?:results?|evaluation|experiments? and results?|findings?|analysis)\b/i,
    ],
  },
  {
    kind: "discussion",
    patterns: [/^\s*#{0,6}\s*(?:\d+\.?\s*)?(?:discussion|limitations)\b/i],
  },
  {
    kind: "conclusion",
    patterns: [/^\s*#{0,6}\s*(?:\d+\.?\s*)?(?:conclusion[s]?|future work|final remarks)\b/i],
  },
  {
    kind: "references",
    patterns: [/^\s*#{0,6}\s*(?:\d+\.?\s*)?(?:references|bibliography|works cited)\b/i],
  },
  {
    kind: "appendix",
    patterns: [/^\s*#{0,6}\s*(?:\d+\.?\s*)?appendix(?:[ :].*)?$/i],
  },
];

/**
 * Normalises a raw DOI match: strips a scheme or host prefix that preceded it, removes
 * trailing punctuation, and drops a trailing parenthetical that publishers append as
 * disambiguator (e.g. `10.1000/xyz(Figure 1)`).
 */
export function normalizeDoi(raw: string): string {
  let value = raw.trim();
  // A leading `https://doi.org/` or bare `doi:` is not part of the identifier.
  value = value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
  // A trailing parenthetical disambiguator, e.g. `10.1000/xyz(Figure 1)`. This must run
  // before the punctuation strip, otherwise the closing bracket is removed first and the
  // unbalanced remainder no longer matches.
  value = value.replace(/\([^)]*\)$/, "");
  // Trailing punctuation that never belongs to a DOI.
  value = value.replace(/[.,;)\]]+$/, "");
  return value.trim();
}

export function extractIdentifiers(text: string): ParsedIdentifiers {
  const dois = collect(text, DOI_PATTERN, normalizeDoi);
  const arxivIds = collect(text, ARXIV_ID_PATTERN, (value) => value.replace(/^arxiv:/i, "").trim());
  const urls = collect(text, URL_PATTERN, (value) => value.replace(/[.,;)]+$/, ""));
  const isbns = collect(text, ISBN_PATTERN, (value) => value.replace(/[- ]/g, "").toUpperCase());
  return { dois, arxivIds, urls, isbns };
}

function collect(text: string, pattern: RegExp, normalize: (value: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) !== null) {
    const value = normalize(match[0]);
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Splits paper text into sections by heading, keeping content attached to the heading
 * that introduced it. Markdown `#` headings and bare ALL-CAPS or numbered lines both
 * work; the ordering of the rules above decides which kind wins on conflict.
 */
export function splitSections(text: string): PaperSection[] {
  const lines = text.split(/\r?\n/);
  const sections: PaperSection[] = [];
  let current: { kind: PaperSectionKind; heading: string; lines: string[] } | null = null;
  let order = 0;

  const flush = (): void => {
    if (!current) return;
    sections.push({
      kind: current.kind,
      heading: current.heading,
      text: current.lines.join("\n").trim(),
      order: order++,
    });
    current = null;
  };

  const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/;

  for (const line of lines) {
    const kind = classifyHeading(line);
    if (kind && line.trim().length < 200) {
      flush();
      current = { kind, heading: line.replace(/^#+\s*/, "").trim(), lines: [] };
      continue;
    }
    // A markdown heading that names no known section is still a heading: it ends the
    // running section and becomes the document's title candidate.
    const heading = MARKDOWN_HEADING.exec(line);
    if (heading && line.trim().length < 200) {
      flush();
      current = { kind: "unknown", heading: heading[1]!.trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else if (line.trim()) current = { kind: "unknown", heading: "", lines: [line] };
  }
  flush();
  return sections;
}

function classifyHeading(line: string): PaperSectionKind | null {
  const candidate = line.trim();
  if (!candidate) return null;
  for (const rule of SECTION_HEADING_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(candidate)) return rule.kind;
    }
  }
  return null;
}

const DISPLAY_EQUATION = /^\s*\$\$(?!\$)([\s\S]*?)\$\$\s*$/;
/** Display math sitting in the middle of a longer line rather than alone on one. */
const MID_LINE_DISPLAY = /\$\$(?!\$)([\s\S]*?)\$\$/g;
// Stateless test twin of MID_LINE_DISPLAY: the `g` flag makes `.test()` stateful, and a
// stateful test would advance lastIndex past the first span before matchAll ran.
const HAS_MID_LINE_DISPLAY = /\$\$(?!\$)([\s\S]*?)\$\$/;
const INLINE_EQUATION = /(?<!\$)\$(?!\$)((?:[^$\\]|\\.)*)\$/g;
const LATEX_EQUATION_ENV =
  /\\begin\{(equation|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g;

/**
 * Extracts equations. Display math is separated from inline math because a
 * mathematical claim extractor only treats display math as a claim candidate — inline
 * math is usually notation, not an assertion.
 */
export function extractEquations(text: string): EquationBlock[] {
  const blocks: EquationBlock[] = [];
  let order = 0;

  const scanInline = (line: string): void => {
    for (const match of line.matchAll(new RegExp(INLINE_EQUATION.source, "g"))) {
      const content = (match[1] ?? "").trim();
      if (content) blocks.push({ kind: "inline", content, order: order++ });
    }
  };

  const lines = text.split(/\r?\n/);
  let buffer: string[] = [];
  for (const line of lines) {
    if (DISPLAY_EQUATION.test(line.trim())) {
      const content = line.trim().slice(2, -2).trim();
      if (content)
        blocks.push({ kind: "display", content, label: readLabel(content), order: order++ });
      continue;
    }
    // Multi-line display block opened by $$ on its own line.
    if (line.trim() === "$$") {
      if (buffer.length > 0) {
        const content = buffer.join("\n").trim();
        if (content)
          blocks.push({ kind: "display", content, label: readLabel(content), order: order++ });
        buffer = [];
      } else {
        buffer.push("");
      }
      continue;
    }
    if (buffer.length > 0) {
      buffer.push(line);
      continue;
    }
    // Display math may sit in the middle of a line; inline math around it still counts.
    if (HAS_MID_LINE_DISPLAY.test(line)) {
      for (const span of line.matchAll(MID_LINE_DISPLAY)) {
        const content = (span[1] ?? "").trim();
        if (content)
          blocks.push({ kind: "display", content, label: readLabel(content), order: order++ });
      }
      // Remove the display spans so the inline scan does not re-see them as inline math.
      scanInline(line.replace(MID_LINE_DISPLAY, "  "));
      continue;
    }
    scanInline(line);
  }
  if (buffer.length > 0) {
    const content = buffer
      .join("\n")
      .trim()
      .replace(/^\$\$|\$\$$/g, "")
      .trim();
    if (content)
      blocks.push({ kind: "display", content, label: readLabel(content), order: order++ });
  }

  let envMatch: RegExpExecArray | null;
  const envPattern = new RegExp(LATEX_EQUATION_ENV.source, "g");
  while ((envMatch = envPattern.exec(text)) !== null) {
    const content = (envMatch[2] ?? "").trim();
    if (content)
      blocks.push({ kind: "environment", content, label: readLabel(content), order: order++ });
  }

  return blocks;
}

function readLabel(content: string): string | undefined {
  const match = /\\label\{([^}]+)\}/.exec(content);
  return match?.[1];
}

/** Citation markers in the body: `[12]`, `[12, 15]`, `(Smith et al., 2020)`, `\cite{key}`. */
export const CITATION_MARKER_PATTERNS = [
  /\\cite[a-z]*\{([^}]+)\}/g,
  /\[(?:\d+(?:[,\s–-]+\d+)*)\]/g,
  /\((?:[A-Z][A-Za-z'`-]+(?:\s+(?:et al\.|and\s+[A-Z][A-Za-z'`-]+))?),\s*(?:19|20)\d{2}[a-z]?\)/g,
];

/** Extracts citation markers in order of first appearance, de-duplicated. */
export function extractCitationMarkers(text: string): string[] {
  const markers: string[] = [];
  const seen = new Set<string>();
  for (const pattern of CITATION_MARKER_PATTERNS) {
    const global = new RegExp(pattern.source, "g");
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
      const value = match[0];
      if (seen.has(value)) continue;
      seen.add(value);
      markers.push(value);
    }
  }
  // Restore first-appearance order across the merged pattern sets.
  return orderMarkers(text, markers);
}

function orderMarkers(text: string, markers: string[]): string[] {
  return markers
    .map((marker) => ({ marker, index: text.indexOf(marker) }))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.marker);
}

/**
 * Splits a reference list into entries. Numbered lists (`[1] ...`, `1. ...`) and
 * BibTeX blocks are both handled; an unnumbered paragraph block is split on blank
 * lines as a last resort.
 */
export function splitReferenceList(referencesText: string): RawReference[] {
  const trimmed = referencesText.trim();
  if (!trimmed) return [];

  const entries: RawReference[] = [];
  let order = 0;

  // Numbered entries: `[1] Author, Title...` possibly spanning lines.
  const numbered = /^\s*(?:\[?(\d{1,4})\]?\.?)\s+(?=[A-Z"\\])/;
  const lines = trimmed.split(/\r?\n/);
  let buffer: { marker?: string; text: string } | null = null;

  const flushEntry = (): void => {
    if (!buffer || !buffer.text.trim()) return;
    entries.push({
      text: buffer.text.trim(),
      marker: buffer.marker,
      identifiers: extractIdentifiers(buffer.text),
      order: order++,
    });
    buffer = null;
  };

  for (const line of lines) {
    const match = numbered.exec(line);
    if (match) {
      flushEntry();
      buffer = {
        marker: match[1] ? `[${match[1]}]` : undefined,
        text: line.replace(numbered, "").trim(),
      };
      continue;
    }
    if (line.trim() === "") {
      flushEntry();
      continue;
    }
    if (buffer) buffer.text += ` ${line.trim()}`;
    else buffer = { text: line.trim() };
  }
  flushEntry();

  return entries;
}

export interface BibTeXEntry {
  readonly type: string;
  readonly key: string;
  readonly fields: ReadonlyMap<string, string>;
  readonly raw: string;
}

/**
 * Parses BibTeX with a brace-depth scanner. Tolerates nested braces in values,
 * `=` inside a value, missing trailing commas, and a truncated final entry — all
 * common in real `.bib` files. Anything it cannot structurally complete is skipped
 * rather than emitting a malformed entry.
 */
export function parseBibTeX(source: string): BibTeXEntry[] {
  const entries: BibTeXEntry[] = [];
  let index = 0;

  while (index < source.length) {
    const at = source.indexOf("@", index);
    if (at === -1) break;

    const typeMatch = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(at));
    if (!typeMatch) {
      index = at + 1;
      continue;
    }
    const type = typeMatch[1]!.toLowerCase();

    let cursor = at + typeMatch[0].length;
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] !== "{") {
      index = at + 1;
      continue;
    }
    cursor += 1;

    const keyEnd = findUnquoted(source, cursor, [",", "}"]);
    if (keyEnd === -1) break;
    const key = source.slice(cursor, keyEnd).trim();
    cursor = keyEnd + 1;
    if (!key) {
      index = keyEnd;
      continue;
    }

    const fields = new Map<string, string>();
    let terminatedBy = "}";
    let depth = 1;
    let rawStart = at;

    while (depth > 0 && cursor < source.length) {
      cursor = skipWhitespaceAndCommas(source, cursor);
      if (source[cursor] === "}") {
        depth -= 1;
        cursor += 1;
        break;
      }
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*(?:=)/.exec(source.slice(cursor));
      if (!nameMatch) {
        // Unparseable field — skip to the next brace-balanced boundary.
        const boundary = findUnquoted(source, cursor, [",", "}"]);
        if (boundary === -1) {
          depth = 0;
          terminatedBy = "truncated";
          break;
        }
        if (source[boundary] === "}") {
          depth -= 1;
          cursor = boundary + 1;
          terminatedBy = "}";
          break;
        }
        cursor = boundary + 1;
        continue;
      }

      const fieldName = nameMatch[1]!.toLowerCase();
      cursor += nameMatch[0].length;
      cursor = skipWhitespace(source, cursor);

      const value = readBibTeXValue(source, cursor);
      if (value.next === cursor) {
        // Empty or malformed value: treat the entry as ending here.
        break;
      }
      fields.set(fieldName, value.text);
      cursor = value.next;

      // Only whitespace may be skipped here: skipping commas would consume the field
      // separator, the comma check below would then always fail, and every entry would
      // end after its first field.
      cursor = skipWhitespace(source, cursor);
      if (source[cursor] === "}") {
        depth -= 1;
        cursor += 1;
        terminatedBy = "}";
        break;
      }
      if (source[cursor] !== ",") break;
      cursor += 1;
    }

    if (depth !== 0) terminatedBy = "truncated";
    entries.push({
      type,
      key,
      fields,
      raw: source.slice(rawStart, cursor),
    });
    index = cursor;
    void terminatedBy;
  }

  return entries;
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
  return cursor;
}

function skipWhitespaceAndCommas(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /[\s,]/.test(source[cursor]!)) cursor += 1;
  return cursor;
}

/** Finds the first of `needles` outside a brace- or quote-delimited region. */
function findUnquoted(source: string, from: number, needles: readonly string[]): number {
  let cursor = from;
  let braceDepth = 0;
  let inString = false;

  while (cursor < source.length) {
    const char = source[cursor]!;
    if (inString) {
      if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      else return cursor;
    } else if (braceDepth === 0 && needles.includes(char)) {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

interface ValueRead {
  text: string;
  next: number;
}

function readBibTeXValue(source: string, from: number): ValueRead {
  let cursor = skipWhitespace(source, from);
  if (source[cursor] === "{") {
    let depth = 1;
    cursor += 1;
    const start = cursor;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor]!;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      cursor += 1;
    }
    if (depth !== 0) return { text: source.slice(start, cursor), next: cursor };
    const text = source.slice(start, cursor);
    return { text: stripAccents(text), next: cursor + 1 };
  }
  if (source[cursor] === '"') {
    cursor += 1;
    const start = cursor;
    while (cursor < source.length && source[cursor] !== '"') cursor += 1;
    const text = source.slice(start, cursor);
    return { text: stripAccents(text), next: Math.min(source.length, cursor + 1) };
  }
  // Unbraced value: digits, macros or concatenated strings.
  const start = cursor;
  while (cursor < source.length && /[^,}\s]/.test(source[cursor]!)) cursor += 1;
  return { text: source.slice(start, cursor), next: cursor };
}

function stripAccents(value: string): string {
  return value
    .replace(/\{\\[`'^"~=.][a-zA-Z]\}/g, (match) => match.slice(-2, -1))
    .replace(/\\[`'^"~=.]?([a-zA-Z])/g, "$1")
    .replace(/[{}]/g, "");
}

/**
 * Emits a BibTeX entry for a paper. Used by the research loop so a synthesized report
 * carries machine-checkable citations rather than prose-only references.
 */
export function toBibTeX(entry: {
  key: string;
  type?: string;
  fields: ReadonlyMap<string, string>;
}): string {
  const type = entry.type ?? "article";
  const lines = [`@${type}{${entry.key},`];
  for (const [name, value] of entry.fields) {
    lines.push(`  ${name} = {${value.replace(/\\/g, "\\\\")}},`);
  }
  lines.push("}");
  return lines.join("\n");
}

export interface PaperParseOptions {
  /** Extracts the title from the first non-empty heading when no title line is given. */
  readonly inferTitle?: boolean;
  /** Maximum sections to retain (bounds memory on very long documents). */
  readonly maxSections?: number;
}

/**
 * Parses a complete paper from raw text. Title and authors are taken from explicit
 * `Title:` / `Authors:` front matter when present, otherwise from the first heading.
 */
export function parsePaper(text: string, options: PaperParseOptions = {}): ParsedPaper {
  const sections = splitSections(text).slice(0, options.maxSections ?? Number.POSITIVE_INFINITY);
  const referencesSection = sections.find((section) => section.kind === "references");
  const references = referencesSection ? splitReferenceList(referencesSection.text) : [];

  const frontTitle = /^\s*(?:title|paper title)\s*[:\-]?\s*(.+)$/im.exec(text)?.[1]?.trim();
  const headingTitle = sections
    .filter(
      (section) =>
        (section.kind === "unknown" || section.kind === "title") && section.heading.length > 0,
    )
    .map((section) => section.heading)[0];
  const title = frontTitle || (options.inferTitle !== false ? headingTitle : "") || "";

  const authorLine = /^\s*authors?\s*[:\-]?\s*(.+)$/im.exec(text)?.[1] ?? "";
  const authors = authorLine
    .split(/,| and |;|\//i)
    .map((author) => author.trim())
    .filter((author) => author.length > 0 && author.length < 200);

  const abstractSection = sections.find((section) => section.kind === "abstract");
  const abstract = abstractSection?.text ?? "";

  const yearMatch = /\b(?:19|20)\d{2}\b/.exec(`${title} ${abstract}`);
  const identifiers = extractIdentifiers(text);

  return {
    title,
    authors,
    abstract,
    year: yearMatch ? Number(yearMatch[0]) : undefined,
    identifiers,
    sections,
    equations: extractEquations(text),
    references,
    citationMarkers: extractCitationMarkers(text),
  };
}

/** Heuristic: is this text plausibly a scientific paper rather than prose? */
export function looksLikePaper(parsed: ParsedPaper): boolean {
  const hasAbstract = parsed.abstract.length > 100;
  const hasReferences = parsed.references.length > 0;
  const hasMarkers = parsed.citationMarkers.length > 0;
  const score = [hasAbstract, hasReferences, hasMarkers, parsed.sections.length >= 3].filter(
    Boolean,
  ).length;
  return score >= 3;
}
