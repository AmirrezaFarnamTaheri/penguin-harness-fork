/**
 * Prompt archaeology toolkit — extraction and normalisation for captured system prompts.
 *
 * Everything an operator needs to turn a minified shipping binary or a vendor markdown
 * dump into a clean, cataloguable prompt: template-literal extraction with code/noise
 * filtering, JS source-escape decoding, YAML-ish frontmatter render and parse, canonical
 * filename slugging, injection-marker stripping, markdown normalisation, tool-call format
 * detection, placeholder interpolation and a token estimate.
 *
 * Ports and supersedes three donor utilities, merged into one dependency-free surface:
 *  - the canonical filename + frontmatter + escape-decode helpers of a Claude-Code prompt
 *    archive's markdown utilities (nameToFilename / yamlString / parseYamlString /
 *    decodeSourceEscapes / renderPromptFrontmatter / assertUniquePromptFilenames),
 *  - the prompt-template extractor of a vendor-bundle extraction pipeline, whose v4
 *    heuristic separated real system prompts from 2,916 template literals of minified
 *    application code in one shipping extension bundle,
 *  - the prompt categoriser of that same archive's README generator.
 *
 * No upstream archive, repository or donor name appears in any identifier here.
 */

import { estimateTokens } from "./prompt-fingerprint.js";

/* -------------------------------------------------------------------------- */
/* Kinds and categories                                                       */
/* -------------------------------------------------------------------------- */

/** Coarse kind of a captured prompt, derived from its canonical name prefix. */
export type PromptCategory =
  | "agent"
  | "system"
  | "reminder"
  | "tool-description"
  | "tool-parameter"
  | "data"
  | "skill"
  | "output-style"
  | "command"
  | "other";

/** A categorised prompt, as produced by {@link categorizePromptName}. */
export interface CategorizedPrompt {
  readonly category: PromptCategory;
  readonly subcategory: string | null;
}

const PROMPT_NAME_PREFIXES: ReadonlyArray<readonly [string, string, PromptCategory]> = [
  ["Agent Prompt: ", "agent-prompt-", "agent"],
  ["System Prompt: ", "system-prompt-", "system"],
  ["System Reminder: ", "system-reminder-", "reminder"],
  ["Tool Description: ", "tool-description-", "tool-description"],
  ["Tool Parameter: ", "tool-parameter-", "tool-parameter"],
  ["Data: ", "data-", "data"],
  ["Skill: ", "skill-", "skill"],
];

const AGENT_SUBAGENT_PREFIXES = ["Explore", "Plan mode (enhanced)", "Task tool"];
const AGENT_CREATION_PREFIXES = [
  "Agent creation architect",
  "CLAUDE.md creation",
  "Status line setup",
];

/**
 * Map a captured prompt's canonical name to its category, mirroring the donor archive's
 * README taxonomy. Agent prompts split into sub-agents / creation assistants / slash
 * commands / utilities; everything else lands in a single bucket.
 */
export function categorizePromptName(name: string): CategorizedPrompt {
  const stringName = String(name);

  for (const [prefix, , category] of PROMPT_NAME_PREFIXES) {
    if (!stringName.startsWith(prefix)) continue;

    if (category !== "agent") {
      return { category, subcategory: null };
    }
    const namePart = stringName.slice(prefix.length);
    if (AGENT_SUBAGENT_PREFIXES.some((sub) => namePart.startsWith(sub))) {
      return { category, subcategory: "Sub-agents" };
    }
    if (AGENT_CREATION_PREFIXES.some((sub) => namePart.includes(sub))) {
      return { category, subcategory: "Creation Assistants" };
    }
    if (namePart.includes("slash command") || namePart.startsWith("/")) {
      return { category, subcategory: "Slash commands" };
    }
    return { category, subcategory: "Utilities" };
  }

  return { category: "other", subcategory: null };
}

/* -------------------------------------------------------------------------- */
/* Canonical filenames                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Convert a captured prompt name to its canonical generated Markdown filename:
 * lower-case, non-alphanumerics collapsed to hyphens, category prefix prepended.
 *
 * Collisions are meaningful — two prompt names that slug to the same file are two names
 * for one prompt — so {@link assertUniquePromptFilenames} rejects them rather than
 * letting a later entry silently overwrite an earlier one.
 */
export function nameToFilename(name: string): string {
  const stringName = String(name);
  const entry = PROMPT_NAME_PREFIXES.find(([prefix]) => stringName.startsWith(prefix));
  const [namePrefix, filenamePrefix] = entry ?? ["", ""];
  const slug = stringName
    .slice(namePrefix.length)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${filenamePrefix}${slug}.md`;
}

/** Prompts whose canonical names slug to one filename, keyed by that filename. */
export type PromptFilenamesByName = ReadonlyMap<string, string>;

/**
 * Reject canonical filename collisions before generation can overwrite one prompt with
 * another. Throws with both colliding names so the operator can disambiguate by hand.
 */
export function assertUniquePromptFilenames(
  prompts: ReadonlyArray<{ name: string }>,
): PromptFilenamesByName {
  const namesByFilename = new Map<string, string>();

  for (const prompt of prompts) {
    const filename = nameToFilename(prompt.name);
    const existing = namesByFilename.get(filename);
    if (existing !== undefined) {
      throw new Error(
        `Canonical filename collision for ${filename}: ${existing} and ${prompt.name}`,
      );
    }
    namesByFilename.set(filename, prompt.name);
  }

  return namesByFilename;
}

/* -------------------------------------------------------------------------- */
/* YAML-ish scalars                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Serialize a string as a deterministic, YAML-safe double-quoted scalar. JSON.stringify
 * is a valid YAML double-quoted scalar, which keeps the emitter one call and the parser
 * one `JSON.parse`.
 *
 * `-->` is rejected because frontmatter lives inside an HTML comment: a value that closed
 * the comment would escape the metadata block and inject into the prompt body.
 */
export function yamlString(value: unknown): string {
  const stringValue = String(value ?? "");
  if (stringValue.includes("-->")) {
    throw new Error("Frontmatter strings cannot contain the HTML comment terminator '-->'");
  }
  return JSON.stringify(stringValue);
}

/**
 * Parse a scalar emitted by {@link yamlString}, plus the legacy single-quoted form used
 * by earlier generated files (where `''` was an escaped apostrophe).
 */
export function parseYamlString(value: string): string {
  const scalar = String(value).trim();
  if (scalar.startsWith('"')) {
    return JSON.parse(scalar) as string;
  }
  if (scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replace(/''/g, "'");
  }
  return scalar;
}

/* -------------------------------------------------------------------------- */
/* Source escape decoding                                                     */
/* -------------------------------------------------------------------------- */

const DECODABLE_ESCAPES = new Set(["`", '"', "'", "$", "\\"]);

/**
 * Restore the characters a prompt extractor had to escape to lift the text out of a
 * JavaScript template literal: \` \' \" \$ and \\ are unescaped, and every other escape
 * (including `\n` and `\t`) is left intact as literal text.
 *
 * The asymmetry is deliberate. Real prompts contain literal `\n` sequences in prose
 * ("reply with \n separated lines"); decoding those would silently corrupt them.
 */
export function decodeSourceEscapes(value: unknown): string {
  const text = String(value ?? "");
  let result = "";
  let i = 0;

  while (i < text.length) {
    const char = text.charAt(i);
    if (char === "\\" && i + 1 < text.length) {
      const next = text.charAt(i + 1);
      if (DECODABLE_ESCAPES.has(next)) {
        result += next;
        i += 2;
      } else {
        result += char;
        i += 1;
      }
    } else {
      result += char;
      i += 1;
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Frontmatter                                                                */
/* -------------------------------------------------------------------------- */

/** Agent metadata captured alongside a generated agent prompt. */
export interface PromptAgentMetadata {
  readonly agentType?: string;
  readonly model?: string;
  readonly color?: string;
  readonly permissionMode?: string;
  readonly maxTurns?: number;
  readonly whenToUseDynamic?: boolean;
  readonly tools?: string | readonly string[];
  readonly toolsNote?: string;
  readonly disallowedTools?: string | readonly string[];
  readonly whenToUse?: string;
  readonly criticalSystemReminder?: string;
}

/** Shape of a prompt record as it arrives from an extractor. */
export interface PromptRecord {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Identifier id -> variable name, for prompts reconstructed from split literals. */
  readonly identifierMap?: Readonly<Record<string, string>>;
  readonly agentMetadata?: PromptAgentMetadata;
}

/** Parsed frontmatter plus the prompt body that followed it. */
export interface ParsedPromptFrontmatter {
  readonly name: string | null;
  readonly description: string | null;
  readonly ccVersion: string | null;
  readonly variables: string[];
  readonly body: string;
}

const FRONTMATTER_KEYS = ["name", "description", "ccVersion", "variables"] as const;

/**
 * Render the HTML-comment frontmatter used by generated prompt Markdown files. Every
 * string field and list item is quoted, so a description containing `#`, `true`, `null`
 * or a newline round-trips through {@link parsePromptFrontmatter} without being
 * re-interpreted as YAML syntax.
 */
export function renderPromptFrontmatter(prompt: PromptRecord): string {
  const lines = [
    "<!--",
    `name: ${yamlString(prompt.name)}`,
    `description: ${yamlString(prompt.description)}`,
    `ccVersion: ${yamlString(prompt.version)}`,
  ];
  const variables = prompt.identifierMap ? Object.values(prompt.identifierMap) : [];

  if (variables.length > 0) {
    lines.push("variables:");
    for (const variable of variables) {
      lines.push(`  - ${yamlString(variable)}`);
    }
  }

  const metadata = prompt.agentMetadata;
  if (metadata) {
    lines.push("agentMetadata:");

    for (const key of ["agentType", "model", "color", "permissionMode"] as const) {
      const value = metadata[key];
      if (value != null) {
        lines.push(`  ${key}: ${yamlString(value)}`);
      }
    }
    if (metadata.maxTurns != null) {
      lines.push(`  maxTurns: ${metadata.maxTurns}`);
    }
    if (metadata.whenToUseDynamic) {
      lines.push("  whenToUseDynamic: true");
    }
    if (Array.isArray(metadata.tools)) {
      lines.push("  tools:");
      for (const tool of metadata.tools) {
        lines.push(`    - ${yamlString(tool)}`);
      }
    } else if (metadata.tools != null) {
      lines.push(`  tools: ${yamlString(metadata.tools)}`);
    }
    if (metadata.toolsNote != null) {
      lines.push(`  toolsNote: ${yamlString(metadata.toolsNote)}`);
    }
    if (Array.isArray(metadata.disallowedTools)) {
      lines.push("  disallowedTools:");
      for (const tool of metadata.disallowedTools) {
        lines.push(`    - ${yamlString(tool)}`);
      }
    } else if (metadata.disallowedTools != null) {
      lines.push(`  disallowedTools: ${yamlString(metadata.disallowedTools)}`);
    }
    if (metadata.whenToUse != null) {
      lines.push(`  whenToUse: ${yamlString(metadata.whenToUse)}`);
    }
    if (metadata.criticalSystemReminder != null) {
      lines.push(`  criticalSystemReminder: ${yamlString(metadata.criticalSystemReminder)}`);
    }
  }

  lines.push("-->");
  return `${lines.join("\n")}\n`;
}

/**
 * Parse generated prompt Markdown back into metadata plus body. Returns `null` when the
 * file carries no HTML-comment frontmatter, so a plain prompt file degrades to body-only
 * instead of throwing.
 */
export function parsePromptFrontmatter(content: string): ParsedPromptFrontmatter | null {
  const commentMatch = /^[\t ]*<!--([\s\S]*?)-->/u.exec(content);
  if (!commentMatch || commentMatch[1] === undefined || commentMatch.index === undefined) {
    return null;
  }

  const metadataSection = commentMatch[1];
  const body = content.slice(commentMatch.index + commentMatch[0].length);

  const lines = metadataSection.split("\n");
  const values = new Map<string, string>();
  const variables: string[] = [];

  let inVariables = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (!inVariables && /^variables:\s*$/u.test(trimmed)) {
      inVariables = true;
      continue;
    }
    if (inVariables) {
      const item = /^-\s*(.*)$/u.exec(trimmed);
      if (item === null || item[1] === undefined) {
        inVariables = false;
      } else {
        variables.push(parseYamlString(item[1]));
        continue;
      }
    }

    const entry = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/su.exec(trimmed);
    if (entry === null || entry[1] === undefined || entry[2] === undefined) continue;
    if (FRONTMATTER_KEYS.includes(entry[1] as (typeof FRONTMATTER_KEYS)[number])) {
      values.set(entry[1], entry[2]);
    }
  }

  const name = values.get("name");
  const description = values.get("description");
  const ccVersion = values.get("ccVersion");

  return {
    name: name === undefined ? null : parseYamlString(name),
    description: description === undefined ? null : parseYamlString(description),
    ccVersion: ccVersion === undefined ? null : parseYamlString(ccVersion),
    variables,
    body,
  };
}

/* -------------------------------------------------------------------------- */
/* Template-literal extraction                                                */
/* -------------------------------------------------------------------------- */

/** A template literal lifted from JavaScript source, with its interpolation sites. */
export interface ExtractedTemplate {
  /** Raw literal text, escapes still encoded. */
  readonly text: string;
  /** Decoded literal text ({@link decodeSourceEscapes} applied). */
  readonly decoded: string;
  /** Names of the `${...}` interpolations found inside the literal. */
  readonly interpolated: string[];
  /** Zero-based offset of the opening backtick in the source. */
  readonly start: number;
  /** Zero-based offset just past the closing backtick in the source. */
  readonly end: number;
}

/** Why an extracted literal was kept or dropped by the filter. */
export type ExtractionVerdict =
  | "kept-strong-prefix"
  | "kept-structure-marker"
  | "kept-tool-tags"
  | "kept-weak-signals"
  | "dropped-too-short"
  | "dropped-code-or-markup";

/** An extraction filter decision, kept so a run can be audited. */
export interface ExtractionDecision {
  readonly template: ExtractedTemplate;
  readonly verdict: ExtractionVerdict;
}

/** Knobs for {@link extractTemplateLiterals}. */
export interface ExtractTemplateLiteralsOptions {
  /** Minimum decoded length for a literal to be considered a prompt. Defaults to 150. */
  readonly minLength?: number;
  /** Include per-literal keep/drop decisions in the result. Defaults to `false`. */
  readonly explain?: boolean;
}

/**
 * Scan JavaScript source for backtick template literals, returning the ones that look like
 * system prompts.
 *
 * The scanner is hand-written rather than regex-based so it can track `${...}`
 * interpolations as it goes — a regex that stops at the first backtick mangles any prompt
 * that interpolates a shell path or a working directory, which most of them do.
 */
export function scanTemplateLiterals(source: string): ExtractedTemplate[] {
  const templates: ExtractedTemplate[] = [];
  let i = 0;

  while (i < source.length) {
    if (source.charCodeAt(i) !== 0x60 /* ` */) {
      i += 1;
      continue;
    }

    const start = i;
    i += 1;
    let text = "";
    const interpolated: string[] = [];
    let terminated = false;

    while (i < source.length) {
      const char = source.charAt(i);
      if (char === "\\") {
        // Keep the escape pair verbatim; decodeSourceEscapes un-escapes it later.
        text += char + (source.charAt(i + 1) ?? "");
        i += 2;
        continue;
      }
      if (char === "`") {
        terminated = true;
        i += 1;
        break;
      }
      if (char === "$" && source.charAt(i + 1) === "{") {
        const close = findInterpolationClose(source, i + 2);
        if (close === -1) {
          text += char;
          i += 1;
          continue;
        }
        interpolated.push(source.slice(i + 2, close).trim());
        text += source.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      text += char;
      i += 1;
    }

    if (terminated) {
      templates.push({ text, decoded: decodeSourceEscapes(text), interpolated, start, end: i });
    } else {
      // Unterminated: the scanner ran off the end of the source. Skip the backtick.
      i = start + 1;
    }
  }

  return templates;
}

/** Find the index of the `}` that closes a `${` opened at `openIndex`, ignoring nesting. */
function findInterpolationClose(source: string, openIndex: number): number {
  let depth = 1;
  let i = openIndex;
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Result of a template-literal extraction run. */
export interface TemplateExtractionResult {
  readonly templates: readonly ExtractedTemplate[];
  readonly decisions: readonly ExtractionDecision[];
  /** Total backtick literals the scanner found, before filtering. */
  readonly totalFound: number;
  /** Literals kept by the filter. */
  readonly kept: number;
}

/**
 * Extract likely system prompts from minified or bundled JavaScript source.
 *
 * A shipping vendor extension can carry thousands of template literals — application
 * strings, CSS, HTML templates, JSON — alongside a handful of real prompts. The filter
 * keeps a literal when it opens with a strong identity line ("you are ..."), when it
 * carries a vendor's section structure, when it documents tool tags, or when it
 * accumulates enough weaker prompt vocabulary. Everything that reads like code or markup
 * is dropped first, so a literal that merely *mentions* a function is not mistaken for one
 * that *is* one.
 */
export function extractTemplateLiterals(
  source: string,
  options: ExtractTemplateLiteralsOptions = {},
): TemplateExtractionResult {
  const minLength = options.minLength ?? 150;
  const explain = options.explain ?? false;

  const decisions: ExtractionDecision[] = [];
  const kept: ExtractedTemplate[] = [];
  const all = scanTemplateLiterals(source);

  for (const template of all) {
    const verdict = classifyTemplate(template, minLength);
    if (verdict.startsWith("kept")) kept.push(template);
    if (explain) decisions.push({ template, verdict });
  }

  return { templates: kept, decisions, totalFound: all.length, kept: kept.length };
}

const VERY_STRONG_PROMPT_PREFIXES = [
  "you are blackboxai",
  "you are a helpful assistant",
  "you are ",
];

const STRUCTURE_MARKERS = [
  "====\ntool use\n====",
  "====\nrules\n====",
  "====\nsystem information\n====",
  "====\nobjective\n====",
  "====\ncapabilities\n====",
  "====\nmcp servers\n====",
  "--- start of example ---",
  "--- end of example ---",
];

const TOOL_TAGS = [
  "<execute_command>",
  "<read_file>",
  "<create_file>",
  "<write_to_file>",
  "<edit_file>",
  "<replace_in_file>",
  "<ask_followup_question>",
  "<attempt_completion>",
  "<brainstorm_plan>",
  "<search_code>",
  "<search_files>",
  "<list_files>",
  "<browser_action>",
  "<use_mcp_tool>",
  "<access_mcp_resource>",
  "<tool_name>",
];

const OTHER_PROMPT_KEYWORDS = [
  "parameters:",
  "usage:",
  "description:",
  "current working directory",
  "tool use formatting",
  "tool use guidelines",
  "# tools",
  "mcp servers are not always necessary",
];

function classifyTemplate(template: ExtractedTemplate, minLength: number): ExtractionVerdict {
  const decoded = template.decoded;
  if (decoded.length < minLength) {
    return "dropped-too-short";
  }

  const lower = decoded.toLowerCase();
  const prefix = lower.slice(0, 100);
  const startsStrong = VERY_STRONG_PROMPT_PREFIXES.some((keyword) => prefix.startsWith(keyword));

  if (!startsStrong && isLikelyCodeOrMarkup(decoded, lower)) {
    return "dropped-code-or-markup";
  }

  const toolTagCount = TOOL_TAGS.reduce((count, tag) => count + (lower.includes(tag) ? 1 : 0), 0);
  const hasStructure = STRUCTURE_MARKERS.some((marker) => lower.includes(marker));
  const weakCount = OTHER_PROMPT_KEYWORDS.reduce(
    (count, keyword) => count + (lower.includes(keyword) ? 1 : 0),
    0,
  );

  if (startsStrong) return "kept-strong-prefix";
  if (hasStructure || toolTagCount >= 2) return "kept-structure-marker";
  if (toolTagCount >= 1 && weakCount >= 2) return "kept-tool-tags";
  if (weakCount >= 4) return "kept-weak-signals";
  return "dropped-code-or-markup";
}

const CODE_KEYWORDS = [
  "function(",
  " class ",
  " constructor(",
  " Symbol(",
  ".prototype",
  "addEventListener",
  "querySelector",
  "getElementById",
  "createElement",
  "Object.assign",
  "Object.defineProperty",
  "Promise.resolve",
  "Promise.reject",
  "module.exports",
  "export default",
  "import {",
  "console.log",
  "console.error",
  " try {",
  "} catch (",
  " for (",
  " while (",
  ".map(",
  ".filter(",
  ".reduce(",
  ".forEach(",
  "JSON.stringify",
  "JSON.parse",
  "new Error(",
  "throw new ",
  "# sourceMappingURL=",
];

const AMBIGUOUS_CODE_KEYWORDS = ["async (", "await ", "this.", "=> {"];

const HTML_CSS_KEYWORDS = [
  "<!DOCTYPE html>",
  "<html",
  "<head>",
  "<body",
  "</script>",
  "</style>",
  "padding:",
  "margin:",
  "color:",
  "background-color:",
  "font-size:",
  "display: flex",
  "position: absolute",
  "z-index:",
  "border-radius:",
  ".CodeMirror",
  "w-button",
  "w-form",
  "::placeholder",
  ":-ms-input-placeholder",
];

/**
 * Heuristic: does this string look more like code, HTML or CSS than a natural-language
 * prompt? Symbol ratios and DOM-vocabulary counts decide; strings that merely mention
 * syntax in prose survive because a strong identity line was already seen.
 */
export function isLikelyCodeOrMarkup(text: string, textLower?: string): boolean {
  const lower = textLower ?? text.toLowerCase();

  const codeCount = CODE_KEYWORDS.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
  const ambiguousCount = AMBIGUOUS_CODE_KEYWORDS.reduce(
    (n, kw) => n + (lower.includes(kw) ? 1 : 0),
    0,
  );
  const htmlCssCount = HTML_CSS_KEYWORDS.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);

  const codeSymbols = (text.match(/[{}()[\];=.,+\-*/&|!<>?:%]/gu) ?? []).length;
  const wordCount = Math.max((text.match(/\b\w+\b/gu) ?? []).length, 1);
  const symbolRatio = codeSymbols / (codeSymbols + wordCount);

  const htmlTags = (text.match(/<[/!]?\s*\w+/u) ?? []).length;
  const htmlTagRatio = htmlTags / wordCount;
  const cssCharRatio = (text.match(/[{};:]/gu) ?? []).length / Math.max(text.length, 1);
  const htmlEntities = (text.match(/&[#a-zA-Z0-9]+;/gu) ?? []).length;
  const entityRatio = htmlEntities / Math.max(text.length, 1);

  if (symbolRatio > 0.45 && codeCount < 1 && ambiguousCount < 1) return true;
  if (codeCount >= 2 && symbolRatio > 0.25) return true;
  if (ambiguousCount >= 2 && symbolRatio > 0.3) return true;
  if (htmlCssCount >= 2 || htmlTagRatio > 0.1) return true;
  if (cssCharRatio > 0.07) return true;
  if (entityRatio > 0.05 && htmlEntities > 15) return true;

  return false;
}

/* -------------------------------------------------------------------------- */
/* Reconstruction                                                             */
/* -------------------------------------------------------------------------- */

/** A prompt split across a source literal and its interpolation identifiers. */
export interface SplitPromptRecord {
  /** Ordered literal pieces; `${...}` sites sit between them. */
  readonly pieces: readonly string[];
  /** Identifier ids in the source, in order. */
  readonly identifiers: readonly (string | number)[];
  /** Identifier id -> variable name. */
  readonly identifierMap: Readonly<Record<string, string>>;
}

/**
 * Reassemble a prompt that an extractor split into literal pieces and interpolation
 * identifiers. Adjacent pieces are joined with the variable name the identifier maps to,
 * then the whole is escape-decoded once at the end.
 */
export function reconstructPrompt(prompt: SplitPromptRecord): string {
  if (prompt.pieces.length === 0) return "";
  if (prompt.pieces.length === 1) {
    return decodeSourceEscapes(prompt.pieces[0] as string);
  }

  let result = "";
  let identifierIndex = 0;

  for (let i = 0; i < prompt.pieces.length; i += 1) {
    result += prompt.pieces[i];
    if (i < prompt.pieces.length - 1 && identifierIndex < prompt.identifiers.length) {
      const identifierId = String(prompt.identifiers[identifierIndex]);
      const variableName = prompt.identifierMap[identifierId];
      if (variableName !== undefined) {
        result += variableName;
      }
      identifierIndex += 1;
    }
  }

  return decodeSourceEscapes(result);
}

/* -------------------------------------------------------------------------- */
/* Normalisation and provenance cleaning                                      */
/* -------------------------------------------------------------------------- */

/**
 * Marker kinds that a captured prompt may carry and that shipping code must
 * strip, because each one reproduces *another* harness's runtime control flow
 * rather than the vendor's own instructions.
 */
export type InjectionMarkerKind =
  | "frontmatter"
  | "system-reminder"
  | "user-prompt-submit-hook"
  | "anthropic-reminders"
  | "system-reminder-tag"
  | "user-prompt-tag"
  | "session-tag"
  | "user-query-tag";

/** A marker occurrence found in a prompt text. */
export interface InjectionMarker {
  readonly kind: InjectionMarkerKind;
  /** Opening delimiter, or the whole marker for single-token forms. */
  readonly opener: string;
  /** Closing delimiter, or `null` for single-token markers. */
  readonly closer: string | null;
  /** How many characters the marker occupies in the original text. */
  readonly length: number;
}

/**
 * Tag pairs treated as harness-injected control markers, not prompt prose.
 *
 * `<example>` is deliberately absent: vendors author `<example>` few-shot blocks into their
 * own prompts (the Windsurf entry's tool-call demonstrations, for instance), and stripping
 * those would delete the most instructive passage of the text. A marker is only a marker
 * when it reproduces *another* harness's runtime control flow; a vendor's own teaching
 * examples are the prompt.
 */
const INJECTION_TAG_PAIRS: ReadonlyArray<readonly [InjectionMarkerKind, string, string]> = [
  ["system-reminder", "<system-reminder>", "</system-reminder>"],
  ["user-prompt-submit-hook", "<user-prompt-submit-hook>", "</user-prompt-submit-hook>"],
  ["anthropic-reminders", "<anthropic_reminders>", "</anthropic_reminders>"],
  ["system-reminder-tag", "[SYSTEM_PROMPT]", "[/SYSTEM_PROMPT]"],
  ["user-prompt-tag", "[USER_PROMPT]", "[/USER_PROMPT]"],
  ["session-tag", "<session>", "</session>"],
  ["user-query-tag", "<user_query>", "</user_query>"],
];

/**
 * List every harness-injected marker in a captured prompt. A vendor prompt that still
 * carries `<system-reminder>` or a `[USER_PROMPT]` wrapper will reproduce the *source*
 * harness's control flow when re-used, which is exactly what a catalogued prompt must not
 * do — markers are reported so the entry can be cleaned before it ships.
 */
export function findInjectionMarkers(text: string): InjectionMarker[] {
  const markers: InjectionMarker[] = [];

  if (/^[\t ]*<!--[\s\S]*?-->\s*/u.test(text)) {
    const match = /^[\t ]*<!--([\s\S]*?)-->\s*/u.exec(text);
    if (match?.[0]) {
      markers.push({ kind: "frontmatter", opener: "<!--", closer: "-->", length: match[0].length });
    }
  }

  for (const [kind, opener, closer] of INJECTION_TAG_PAIRS) {
    const pattern = new RegExp(escapeRegExp(opener) + "([\\s\\S]*?)" + escapeRegExp(closer), "gu");
    for (const match of text.matchAll(pattern)) {
      if (match[0]) {
        markers.push({ kind, opener, closer, length: match[0].length });
      }
    }
  }

  return markers;
}

/** Options for {@link stripInjectionMarkers}. */
export interface StripInjectionMarkersOptions {
  /** Keep HTML-comment frontmatter (it is provenance, not injection). Defaults to `false`. */
  readonly keepFrontmatter?: boolean;
  /** Kinds to leave in place even though they would otherwise be stripped. */
  readonly allow?: readonly InjectionMarkerKind[];
}

/**
 * Remove harness-injected control markers from a captured prompt so the text carries only
 * its own instructions. Tag pairs are removed with their contents when a closing tag is
 * present; a lone opening tag with no closer is dropped on its own. Frontmatter is
 * stripped by default and can be preserved for provenance.
 */
export function stripInjectionMarkers(
  text: string,
  options: StripInjectionMarkersOptions = {},
): string {
  const allow = new Set(options.allow ?? []);
  let out = text;

  if (!options.keepFrontmatter && !allow.has("frontmatter")) {
    out = out.replace(/^[\t ]*<!--[\s\S]*?-->\s*/u, "");
  }

  for (const [kind, opener, closer] of INJECTION_TAG_PAIRS) {
    if (allow.has(kind)) continue;
    const pair = new RegExp(escapeRegExp(opener) + "[\\s\\S]*?" + escapeRegExp(closer), "gu");
    out = out.replace(pair, "");
    out = out.replace(new RegExp(escapeRegExp(opener), "gu"), "");
    out = out.replace(new RegExp(escapeRegExp(closer), "gu"), "");
  }

  return out;
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Options for {@link normalizeMarkdown}. */
export interface NormalizeMarkdownOptions {
  /** Remove harness-injected markers (see {@link stripInjectionMarkers}). Defaults to `true`. */
  readonly stripMarkers?: boolean;
  /** Remove leading indentation common to every non-blank line. Defaults to `true`. */
  readonly dedent?: boolean;
  /** Collapse 3+ consecutive blank lines into one. Defaults to `true`. */
  readonly collapseBlanks?: boolean;
}

/**
 * Normalise a captured prompt to a canonical form for storage: line endings unified,
 * trailing whitespace stripped, common indentation removed, blank runs collapsed, markers
 * stripped. The prompt's wording is never changed.
 */
export function normalizeMarkdown(text: string, options: NormalizeMarkdownOptions = {}): string {
  const stripMarkers = options.stripMarkers ?? true;
  const dedent = options.dedent ?? true;
  const collapseBlanks = options.collapseBlanks ?? true;

  let out = stripMarkers ? stripInjectionMarkers(text) : text;
  out = out.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");

  if (dedent) out = dedentLines(out);
  out = out.replace(/[\t ]+$/gmu, "");
  if (collapseBlanks) out = out.replace(/\n{3,}/gu, "\n\n");

  return out.trim();
}

/** Remove the longest indentation shared by every non-blank line. */
function dedentLines(text: string): string {
  const lines = text.split("\n");
  let common: number | null = null;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    common = common === null ? indent : Math.min(common, indent);
    if (common === 0) break;
  }

  if (!common || common <= 0) return text;
  return lines.map((line) => (line.length >= common ? line.slice(common) : line)).join("\n");
}

/* -------------------------------------------------------------------------- */
/* Tool-call format detection                                                 */
/* -------------------------------------------------------------------------- */

/** Tool-invocation convention a prompt instructs the model to use. */
export type ToolCallFormat =
  "xml-tags" | "json-schema" | "python-dsl" | "search-replace" | "artifact-tags" | "none";

export interface DetectedToolCallFormat {
  readonly format: ToolCallFormat;
  /** Evidence strings that fired, strongest first. */
  readonly evidence: string[];
}

const TOOL_TAG_NAMES = [
  "execute_command",
  "read_file",
  "write_to_file",
  "create_file",
  "replace_in_file",
  "edit_file",
  "search_files",
  "list_files",
  "ask_followup_question",
  "attempt_completion",
  "use_mcp_tool",
  "access_mcp_resource",
  "browser_action",
  "tool_name",
];

const ARTIFACT_TAG_NAMES = ["boltArtifact", "boltAction", "CodeProject", "QuickEdit", "artifact"];

/**
 * Detect which tool-call convention a captured prompt teaches. Vendors are fiercely
 * partisan about this — XML-style tags, JSON Schema blocks, a Python-flavoured DSL, or
 * SEARCH/REPLACE diff blocks — and the value drives how a ported prompt has to be paired
 * with a tool layer, so a wrong guess shows up as a prompt that can never emit a valid call.
 */
export function detectToolCallFormat(text: string): DetectedToolCallFormat {
  const evidence: string[] = [];

  for (const tag of TOOL_TAG_NAMES) {
    if (text.includes(`<${tag}>`)) {
      evidence.push(`<${tag}>`);
    }
  }
  if (evidence.length > 0) {
    return { format: "xml-tags", evidence };
  }

  for (const tag of ARTIFACT_TAG_NAMES) {
    if (text.includes(`<${tag}`)) {
      evidence.push(`<${tag}`);
    }
  }
  if (evidence.length > 0) {
    return { format: "artifact-tags", evidence };
  }

  if (/^<{7}\s*SEARCH/mu.test(text) || /&lt;{7}\s*SEARCH/u.test(text)) {
    evidence.push("<<<<<<< SEARCH");
    return { format: "search-replace", evidence };
  }

  const jsonSchemaHits: string[] = [];
  if (/"type":\s*"function"/u.test(text)) jsonSchemaHits.push(`"type": "function"`);
  if (/"additionalProperties":\s*false/u.test(text))
    jsonSchemaHits.push(`"additionalProperties": false`);
  if (/```json/u.test(text) && /"properties"/u.test(text))
    jsonSchemaHits.push("```json + properties");
  if (jsonSchemaHits.length >= 2) {
    return { format: "json-schema", evidence: jsonSchemaHits };
  }

  const pythonHits: string[] = [];
  if (/\bdef\s+\w+\s*\([^)]*\)\s*->\s*\w+/u.test(text)) pythonHits.push("def f(...) -> T");
  if (/\)\s*->\s*(?:list|str|None|bool|int|dict)/u.test(text)) pythonHits.push(") -> type");
  if (/standard python calling syntax|custom DSL syntax/u.test(text)) pythonHits.push("DSL prose");
  if (pythonHits.length >= 2) {
    return { format: "python-dsl", evidence: pythonHits };
  }

  return { format: "none", evidence: [] };
}

/* -------------------------------------------------------------------------- */
/* Placeholders and interpolation                                             */
/* -------------------------------------------------------------------------- */

/** Placeholder syntax a prompt uses for runtime values. */
export type InterpolationStyle = "dollar-brace" | "double-brace" | "single-brace" | "none";

/**
 * Detect a prompt's placeholder syntax. Vendors split three ways: shell-style `${cwd}`,
 * template-style `{{name}}`, and brace-style `{name}` used by plan and prompt DSLs.
 */
export function detectInterpolationStyle(text: string): InterpolationStyle {
  if (/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/u.test(text)) return "dollar-brace";
  if (/\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}/u.test(text)) return "double-brace";
  if (/(?<!\{)\{(?![\{])\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}(?!\})/u.test(text)) return "single-brace";
  return "none";
}

/** Collect every placeholder name in a prompt, in first-seen order, de-duplicated. */
export function extractVariables(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const patterns = [
    /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/gu,
    /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/gu,
    /(?<!\{)\{(?![\{])\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}(?!\})/gu,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }

  return names;
}

/** Options for {@link interpolatePrompt}. */
export interface InterpolatePromptOptions {
  /** Behaviour for a placeholder with no supplied value. Defaults to `keep`. */
  readonly missing?: "keep" | "blank" | "throw";
  /** Placeholder syntax to substitute. Defaults to auto-detection. */
  readonly style?: InterpolationStyle;
}

/**
 * Substitute a prompt's placeholders from a plain value map. No `eval`, no `new Function`,
 * no expression evaluation — a placeholder is replaced by the literal string of its value,
 * so a user-supplied value can never become executable template syntax.
 */
export function interpolatePrompt(
  text: string,
  variables: Readonly<Record<string, string>>,
  options: InterpolatePromptOptions = {},
): string {
  const missing = options.missing ?? "keep";
  const style = options.style ?? detectInterpolationStyle(text);
  if (style === "none") return text;

  const pattern =
    style === "dollar-brace"
      ? /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/gu
      : style === "double-brace"
        ? /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/gu
        : /(?<!\{)\{(?![\{])\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}(?!\})/gu;

  return text.replace(pattern, (full, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      if (missing === "throw") {
        throw new Error(`Prompt placeholder "${name}" has no supplied value`);
      }
      return missing === "blank" ? "" : full;
    }
    return value;
  });
}

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Upper bound on a system prompt's share of the model context window. A prompt that eats
 * more than this leaves no room for the task it is supposed to steer.
 */
export const PROMPT_TOKEN_BUDGET_RATIO = 0.15;

/**
 * Estimate a prompt's token cost and its share of a context window. The estimate is the
 * cheap 4-chars-per-token heuristic from the fingerprint module — deliberately
 * pessimistic, so a budget verdict errs on the side of refusing an oversized prompt.
 */
export function promptTokenBudget(
  text: string,
  contextWindow: number,
  ratio: number = PROMPT_TOKEN_BUDGET_RATIO,
): { tokens: number; budget: number; withinBudget: boolean; ratio: number } {
  const tokens = estimateTokens(text);
  const budget = Math.floor(contextWindow * ratio);
  return { tokens, budget, withinBudget: tokens <= budget, ratio };
}
