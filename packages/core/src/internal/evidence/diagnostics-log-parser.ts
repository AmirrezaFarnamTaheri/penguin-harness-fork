/**
 * Parse the diagnostics log: the indented key/value document that describes the machine a CI run used.
 *
 * Provenance: the bundle's `diagnostics.log` is a hand-rolled YAML lookalike rather than YAML — it is written by
 * formatting key/value pairs directly, so it carries three shapes a YAML parser would reject and that this
 * parser therefore handles explicitly. Scalar lines carry values containing colons (an ISO instant with an
 * offset, a Windows path) and backslashes, so a line is split at the first colon that is followed by a space or
 * by the end of the line, never at a colon inside a value. Section headers are keys with no value at all, and
 * the sections hold either further key/value lines or free-form indented text — the `git_state` section's
 * `status:` key is followed by the literal `## HEAD (no branch)`, which is a value and not a section. Finally
 * some sections repeat their keys on purpose: `repository_inventory` says `dir:` once per directory and `file:`
 * once per file, so the entries are kept as an ordered list and a map would have thrown most of them away.
 */

/** A line that has a key and a value, with the indentation it was written at. */
export interface DiagnosticsEntry {
  key: string;
  value: string;
  indent: number;
}

/** A section: a key whose children were themselves key/value lines. */
export interface DiagnosticsSection {
  name: string;
  indent: number;
  entries: DiagnosticsEntry[];
  sections: DiagnosticsSection[];
}

/** Parsed diagnostics document: top-level scalars on the left, sections on the right. */
export interface DiagnosticsLog {
  entries: DiagnosticsEntry[];
  sections: DiagnosticsSection[];
  /** Lines that belonged to no key at all, in the order they were written. */
  stray: string[];
}

/** A line the parser has classified: either a `key: value` line or continuation text with no key. */
interface RawLine {
  indent: number;
  /** `undefined` when the line has no key and is continuation text of the key before it. */
  key: string | undefined;
  value: string;
  /** The line trimmed, for continuation blocks that join several of them. */
  text: string;
}

const SECTION_DELIMITER = /^-{3,}$/;

/**
 * Matches `key: value` and `key:`. The separator is a colon followed by a space or by the end of the line,
 * which is what keeps `C: used_gib=117.95 root=C:\` and `commit: <sha> 2026-09-11T16:51:08+03:30 ...` splitting
 * where a reader would expect. A line with no colon at all — the `## HEAD (no branch)` that follows `status:` —
 * does not match, which is what makes it continuation text instead of a key.
 */
const KEY_VALUE = /^(\s*)([^\s:][^:]*?):(?:[ \t]+(.*))?$/;

function classify(line: string): RawLine | undefined {
  const match = KEY_VALUE.exec(line);
  const trimmed = line.trim();
  if (match) {
    return {
      indent: (match[1] ?? "").length,
      key: match[2] ?? "",
      value: match[3] ?? "",
      text: trimmed,
    };
  }
  if (trimmed.length === 0) return undefined;
  return {
    indent: line.length - line.trimStart().length,
    key: undefined,
    value: trimmed,
    text: trimmed,
  };
}

/** Split the document into classified lines, dropping blanks and stopping at a `---` terminator. */
function prepareLines(text: string): RawLine[] {
  const prepared: RawLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (SECTION_DELIMITER.test(line.trim())) break;
    const classified = classify(line);
    if (classified === undefined) continue;
    prepared.push(classified);
  }
  return prepared;
}

/** Parsed `lockfile_fingerprints` entry: `Cargo.lock: bytes=245807 sha256=<hex>`. */
export interface LockfileFingerprint {
  path: string;
  bytes: number | null;
  sha256: string | null;
}

/** Parsed `repository_inventory` entry: `dir: .github bytes=-` or `file: README.md bytes=1818`. */
export interface InventoryEntry {
  kind: "dir" | "file";
  path: string;
  /** Size in bytes; `null` when the log writes the `-` sentinel directories carry. */
  bytes: number | null;
}

/** Parsed `filesystem_capacity` entry: `C: used_gib=117.95 free_gib=31.5 root=C:\`. */
export interface CapacityEntry {
  /** Drive letter or volume name as written. */
  drive: string;
  usedGib: number | null;
  freeGib: number | null;
  root: string;
}

/**
 * Parse a diagnostics log. Indentation decides the structure: a line's children are the following lines that
 * are indented deeper, and a key with children is a section when any of those children is itself a key/value
 * line — otherwise the children are the continuation of that key's value, which is how `status:` keeps its
 * `## HEAD (no branch)` block. A line of three or more dashes ends the document.
 */
export function parseDiagnosticsLog(text: string): DiagnosticsLog {
  const classified = prepareLines(text);
  const stray: string[] = [];

  const build = (
    start: number,
    indent: number,
  ): { consumed: number; entries: DiagnosticsEntry[]; sections: DiagnosticsSection[] } => {
    const entries: DiagnosticsEntry[] = [];
    const sections: DiagnosticsSection[] = [];
    let index = start;
    while (index < classified.length) {
      const current = classified[index];
      if (current === undefined || current.indent < indent) break;

      if (current.key === undefined) {
        // Continuation text of the key before it; at this level it is stray when there was no key.
        const target = entries[entries.length - 1];
        if (target !== undefined)
          target.value =
            target.value.length > 0 ? `${target.value}\n${current.text}` : current.text;
        else stray.push(current.text);
        index += 1;
        continue;
      }

      const children: RawLine[] = [];
      let scan = index + 1;
      while (scan < classified.length) {
        const candidate = classified[scan];
        if (candidate === undefined || candidate.indent <= current.indent) break;
        children.push(candidate);
        scan += 1;
      }

      const hasKeyValueChild = children.some(
        (child) => child.key !== undefined && child.value.length > 0,
      );
      if (children.length > 0 && hasKeyValueChild) {
        // A key whose children are key/value lines is a section header.
        const subtree = build(index + 1, current.indent + 1);
        sections.push({
          name: current.key,
          indent: current.indent,
          entries: subtree.entries,
          sections: subtree.sections,
        });
        index = subtree.consumed;
      } else {
        // A key whose children are not key/value lines owns them as a multi-line value.
        const continuation = children
          .filter((child) => child.key === undefined)
          .map((child) => child.text)
          .join("\n");
        const value =
          continuation.length === 0 ? current.value : `${current.value}\n${continuation}`.trim();
        entries.push({ key: current.key, value, indent: current.indent });
        index = scan;
      }
    }
    return { consumed: index, entries, sections };
  };

  const built = build(0, 0);
  return { entries: built.entries, sections: built.sections, stray };
}

/** Lines that belonged to no key at all, in the order they were written. */
export function diagnosticsStrayLines(log: DiagnosticsLog): string[] {
  return log.stray;
}

/** The first top-level scalar with this key, or `undefined` when the log does not state it. */
export function diagnosticsValue(log: DiagnosticsLog, key: string): string | undefined {
  for (const entry of log.entries) if (entry.key === key) return entry.value;
  return undefined;
}

/** Every entry with this key, anywhere in the document, in the order they were written. */
export function diagnosticsValues(log: DiagnosticsLog, key: string): string[] {
  const values: string[] = [];
  const visit = (entries: DiagnosticsEntry[], sections: DiagnosticsSection[]) => {
    for (const entry of entries) if (entry.key === key) values.push(entry.value);
    for (const section of sections) visit(section.entries, section.sections);
  };
  visit(log.entries, log.sections);
  return values;
}

/** The named section, or `undefined` when the log does not have one. */
export function diagnosticsSection(
  log: DiagnosticsLog,
  name: string,
): DiagnosticsSection | undefined {
  const visit = (sections: DiagnosticsSection[]): DiagnosticsSection | undefined => {
    for (const section of sections) {
      if (section.name === name) return section;
      const nested = visit(section.sections);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return visit(log.sections);
}

/** Value of one key inside one section, or `undefined` when either is absent. */
export function diagnosticsSectionValue(
  log: DiagnosticsLog,
  section: string,
  key: string,
): string | undefined {
  const found = diagnosticsSection(log, section);
  if (found === undefined) return undefined;
  for (const entry of found.entries) if (entry.key === key) return entry.value;
  return undefined;
}

/** Match `key=value` attributes inside a section entry's value, e.g. `bytes=245807 sha256=<hex>`. */
function attributes(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of value.split(/\s+/)) {
    const equals = token.indexOf("=");
    if (equals > 0) map.set(token.slice(0, equals), token.slice(equals + 1));
  }
  return map;
}

/** Parse a `lockfile_fingerprints` section into one entry per lockfile. */
export function parseLockfileFingerprints(
  section: DiagnosticsSection | undefined,
): LockfileFingerprint[] {
  if (section === undefined) return [];
  return section.entries.map((entry) => {
    const attrs = attributes(entry.value);
    const bytes = attrs.get("bytes");
    const sha256 = attrs.get("sha256");
    return {
      path: entry.key,
      bytes: bytes === undefined || bytes === "-" ? null : Number(bytes),
      sha256: sha256 ?? null,
    };
  });
}

/** Parse a `repository_inventory` section into one entry per directory or file. */
export function parseRepositoryInventory(
  section: DiagnosticsSection | undefined,
): InventoryEntry[] {
  if (section === undefined) return [];
  return section.entries.map((entry) => {
    const attrs = attributes(entry.value);
    const bytes = attrs.get("bytes");
    return {
      kind: entry.key === "dir" ? "dir" : "file",
      path: entry.value.split(/\s+/)[0] ?? "",
      bytes: bytes === undefined || bytes === "-" ? null : Number(bytes),
    };
  });
}

/** Parse a `filesystem_capacity` section into one entry per volume. */
export function parseFilesystemCapacity(section: DiagnosticsSection | undefined): CapacityEntry[] {
  if (section === undefined) return [];
  return section.entries.map((entry) => {
    const attrs = attributes(entry.value);
    const used = attrs.get("used_gib");
    const free = attrs.get("free_gib");
    const root = attrs.get("root");
    return {
      drive: entry.key,
      usedGib: used === undefined ? null : Number(used),
      freeGib: free === undefined ? null : Number(free),
      root: root ?? "",
    };
  });
}
