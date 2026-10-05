/**
 * Safe YAML edits (H2) — one adapter for every programmatic write to a `system_config.yaml`.
 *
 * The rule this module enforces: **a config file the user hand-edited stays their file.** An edit
 * must change the requested paths and nothing else — comments, indentation width, indentless
 * sequence style, quoted scalars, block scalars and flow collections all survive. Where that cannot
 * be guaranteed, the adapter refuses **before touching anything** and hands back the original bytes
 * so the caller can show a preview instead of writing.
 *
 * The edit strategy is deliberately *not* parse-into-an-object then stringify: that is exactly how
 * comments disappear. It reuses yaml's CST-backed `parseDocument` and mutates targeted nodes
 * (`doc.setIn`), which is what the kernel update and the config PUT already did — this module makes
 * that path explicit, style-aware and refusable.
 *
 * Refusals (all non-mutating, `text` is the untouched input):
 *
 * | code | meaning |
 * | ---- | ------- |
 * | `malformed` | the parser reported syntax errors |
 * | `duplicate-key` | a key is defined twice — which value wins is not something to guess |
 * | `unsupported-syntax` | parses, but not in a form these edits can preserve (e.g. tab-as-indent) |
 * | `root-type` | the document's root is a sequence or scalar, not a map |
 * | `unwritable-path` | a write would have to travel through an alias or replace a collection |
 *
 * The measured style behaviours this relies on (yaml 2.x, pinned by the byte goldens in
 * `test/yaml-edit.test.ts`):
 *   - comments survive targeted edits, including inline comments on an edited key;
 *   - **indentation width is not preserved by the library** — `toString()` re-indents to 2 spaces,
 *     so the width is detected from the source and passed back in;
 *   - **indentless sequences are not preserved by the library** — `toString()` indents them, so
 *     `indentSeq: false` is passed when the source uses that style;
 *   - a fresh sequence added to an indentless document is written indentless for the same reason.
 *
 * Known limitation, pinned by its own test rather than hidden: an **inline comment on a key whose
 * value is a block sequence** (`tools:  # note`) is re-emitted on the line above the sequence. The
 * comment text survives; its inline position does not. The library attaches that comment to the
 * sequence node, and moving it back would mean rewriting comment placement by hand — more risk than
 * the position is worth. Mixed sequence styles in one document are the other normalization: the
 * indentless style is kept and the indented ones are rewritten flush (reported in `notes`).
 */
import { parseDocument, isMap, isAlias, isCollection, type Document } from "yaml";

export type YamlEditRefusalCode =
  "malformed" | "duplicate-key" | "unsupported-syntax" | "root-type" | "unwritable-path";

export interface YamlEditRefusal {
  code: YamlEditRefusalCode;
  /** Human-readable, safe to surface in an API error or a log line. */
  message: string;
  /** 1-based source line when the parser supplied one. */
  line?: number;
}

/** A targeted node change: `path` is the key path from the document root. */
export interface YamlEdit {
  path: string[];
  value: unknown;
}

export interface YamlEditParseSuccess {
  ok: true;
  /** The document to mutate. Mutating it mutates the returned `text` of a later stringify. */
  document: Document.Parsed;
  /** Style/repair notes gathered while loading; empty for a plain well-formed document. */
  notes: string[];
}

export interface YamlEditParseFailure {
  ok: false;
  refusal: YamlEditRefusal;
}

export type YamlEditParseResult = YamlEditParseSuccess | YamlEditParseFailure;

export type YamlEditOutcome =
  | { ok: true; text: string; notes: string[] }
  | { ok: false; refusal: YamlEditRefusal; text: string };

/** The default block indent yaml uses when the source width cannot be determined. */
export const DEFAULT_YAML_INDENT = 2;

/**
 * The block indent width of a source document: the smallest positive leading-space run among
 * content lines. Comments are ignored (they are often aligned by hand and would skew the minimum);
 * block-scalar bodies are indented deeper than the map, so they never lower the minimum.
 */
export function detectYamlIndent(raw: string): number {
  let indent = Number.POSITIVE_INFINITY;
  for (const line of raw.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const width = /^ +/.exec(line)?.[0].length ?? 0;
    if (width > 0) indent = Math.min(indent, width);
  }
  if (!Number.isFinite(indent) || indent < 1 || indent > 8) return DEFAULT_YAML_INDENT;
  return indent;
}

export interface YamlSequenceStyle {
  /** True when at least one block sequence sits flush with its key (`key:` then `- item`). */
  indentless: boolean;
  /** True when at least one block sequence is indented under its key (`key:` then `  - item`). */
  indented: boolean;
  /** Both styles in one document: no single stringify option can reproduce it byte-exactly. */
  mixed: boolean;
}

/** Classifies the document's block sequences that are values of a mapping key. */
export function detectYamlSequenceStyle(raw: string): YamlSequenceStyle {
  const lines = raw.split("\n");
  let indentless = false;
  let indented = false;
  for (let i = 0; i < lines.length; i++) {
    const item = /^( *)(-)( +|$)/.exec(lines[i]!);
    if (!item) continue;
    const width = item[1]!.length;
    // Find the nearest preceding content line that is not itself a sequence item.
    let keyLine: string | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = lines[j]!;
      if (candidate.trim() === "" || candidate.trimStart().startsWith("#")) continue;
      if (/^( *)(-)( +|$)/.test(candidate)) continue;
      keyLine = candidate;
      break;
    }
    if (keyLine === undefined) continue;
    if (!/:\s*(#.*)?$/.test(keyLine.trimEnd())) continue; // not a sequence under a bare key
    if (width === 0) indentless = true;
    else indented = true;
  }
  return { indentless, indented, mixed: indentless && indented };
}

/** Refusal classifier for parser errors — duplicate keys are called out rather than lumped in. */
function refusalFromErrors(document: Document.Parsed): YamlEditRefusal | null {
  const first = document.errors[0];
  if (first === undefined) return null;
  const line = first.linePos?.[0]?.line;
  const head = first.message.split("\n")[0] ?? "YAML syntax error";
  const code: YamlEditRefusalCode =
    first.code === "DUPLICATE_KEY"
      ? "duplicate-key"
      : first.code === "TAB_AS_INDENT"
        ? "unsupported-syntax"
        : "malformed";
  return { code, message: `${code}: ${head}`, ...(line !== undefined ? { line } : {}) };
}

/**
 * Loads a document for editing, or explains why it will not be edited. Never mutates the input and
 * never touches the filesystem.
 */
export function parseYamlForEdit(raw: string): YamlEditParseResult {
  const document = parseDocument(raw);
  const refusal = refusalFromErrors(document);
  if (refusal !== null) return { ok: false, refusal };
  // `contents === null` (an empty or comments-only file) is supported: `setIn` materializes a map
  // root, so such a file can be initialized without losing the comments it does have.
  if (document.contents !== null && !isMap(document.contents)) {
    return {
      ok: false,
      refusal: {
        code: "root-type",
        message: `root-type: expected a mapping at the document root, found ${document.contents.constructor.name}`,
      },
    };
  }
  const notes: string[] = [];
  const style = detectYamlSequenceStyle(raw);
  if (style.mixed) {
    notes.push(
      "mixed sequence styles: the document uses both indentless and indented sequences; " +
        "the indentless style is kept and the indented ones are rewritten flush",
    );
  }
  return { ok: true, document, notes };
}

/** Stringifies with the source document's own indentation width and sequence style. */
export function stringifyYamlDocument(document: Document.Parsed, raw: string): string {
  const style = detectYamlSequenceStyle(raw);
  return document.toString({
    indent: detectYamlIndent(raw),
    // Only switch off sequence indentation when the source actually uses that style; otherwise a
    // plain indented document would be rewritten flush for no reason.
    indentSeq: style.indentless ? false : true,
  });
}

/**
 * Makes every intermediate node of `path` writable, recording what had to be repaired.
 *
 * A missing section is materialized. A section holding a *scalar* is replaced (it reads as absent
 * on the config side — `tools:` with no value parses to null — so the tab is materialized anyway).
 * A section holding a **collection of the wrong kind**, or an alias, is not replaced: reusing that
 * node would either destroy the user's value or write through a shared anchor, so the edit is
 * refused.
 */
function preparePath(
  document: Document.Parsed,
  path: string[],
  notes: string[],
): YamlEditRefusal | null {
  for (let depth = 1; depth < path.length; depth++) {
    const prefix = path.slice(0, depth);
    const node = document.getIn(prefix, true) as unknown;
    const label = prefix.join(".");
    if (node === undefined || node === null) {
      document.setIn(prefix, document.createNode({}));
      notes.push(`materialized missing section "${label}"`);
      continue;
    }
    if (isAlias(node)) {
      return {
        code: "unwritable-path",
        message: `unwritable-path: "${label}" is an alias (*…) and cannot be edited in place`,
      };
    }
    if (isMap(node)) continue;
    if (isCollection(node)) {
      return {
        code: "unwritable-path",
        message: `unwritable-path: "${label}" is a ${node.constructor.name.toLowerCase()}, not a mapping; refusing to replace it`,
      };
    }
    // A scalar (including an explicit null) reads as an absent section: replace it with a map.
    document.setIn(prefix, document.createNode({}));
    notes.push(`replaced non-mapping section "${label}"`);
  }
  return null;
}

/**
 * Applies targeted edits to a YAML document.
 *
 * On success `text` is the edited document. On any refusal `text` is the **original input
 * byte-for-byte** and nothing has been mutated, so the caller can render a preview and stop.
 */
export function applyYamlEdits(raw: string, edits: readonly YamlEdit[]): YamlEditOutcome {
  const parsed = parseYamlForEdit(raw);
  if (!parsed.ok) return { ok: false, refusal: parsed.refusal, text: raw };
  const { document } = parsed;
  const notes = [...parsed.notes];
  for (const edit of edits) {
    const refusal = preparePath(document, edit.path, notes);
    if (refusal !== null) return { ok: false, refusal, text: raw };
    try {
      document.setIn(edit.path, edit.value);
    } catch (error) {
      // A path that cannot be traversed (an alias deeper than the checked levels, a node type the
      // walker above could not anticipate) is a refusal, not a crash midway through an edit list.
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      return {
        ok: false,
        refusal: {
          code: "unwritable-path",
          message: `unwritable-path: cannot write ${edit.path.join(".")} (${reason ?? "unknown reason"})`,
        },
        text: raw,
      };
    }
  }
  let text: string;
  try {
    text = stringifyYamlDocument(document, raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ok: false,
      refusal: {
        code: "unsupported-syntax",
        message: `unsupported-syntax: ${reason ?? "stringify refused"}`,
      },
      text: raw,
    };
  }
  return { ok: true, text, notes };
}

/** One-line rendering of a refusal for an API error or a log line. */
export function yamlEditRefusalMessage(refusal: YamlEditRefusal): string {
  const where = refusal.line !== undefined ? ` (line ${refusal.line})` : "";
  return `${refusal.message}${where} — the file was left unchanged.`;
}
