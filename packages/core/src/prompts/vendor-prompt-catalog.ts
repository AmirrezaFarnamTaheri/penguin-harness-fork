/**
 * Vendor prompt catalog — production system prompts as a typed, queryable catalog.
 *
 * The catalog holds the *texts*: identity lines, behavioural rules, tool-use conventions
 * and output-format contracts lifted from shipping AI products. Entries are keyed by
 * neutral vendor identifiers, never by a donor or archive name, so a re-shard of the
 * source corpora changes nothing downstream.
 *
 * Two contracts the catalog enforces at construction time:
 *  - ids are unique and slug-clean, so an entry can always be addressed by id;
 *  - no entry ships with a harness-injection marker still embedded
 *    ({@link ./prompt-archaeology.js} defines what counts).
 *
 * Entries with `truncated: true` carry the prompt's identity, rules and conventions
 * verbatim but not its tool-schema appendix; `sourceBytes` records the size of the full
 * captured text so the omission is visible rather than silent.
 */

import {
  type InjectionMarker,
  type ToolCallFormat,
  findInjectionMarkers,
  normalizeMarkdown,
} from "./prompt-archaeology.js";
import {
  type PromptFingerprint,
  fingerprintPrompt,
  normalizedDigest,
} from "./prompt-fingerprint.js";
import { ANTHROPIC_FAMILY_PROMPTS } from "./anthropic-family.js";
import { IDE_FAMILY_PROMPTS } from "./ide-family.js";
import { CHAT_FAMILY_PROMPTS } from "./chat-family.js";
import { PERSONA_FAMILY_PROMPTS } from "./persona-family.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Neutral vendor identifiers. One vendor may own several entries (a CLI, a design tool,
 * an output style set); the id, not the vendor, is the catalogue key.
 */
export type VendorId =
  | "anthropicClaude"
  | "anthropicClaudeCode"
  | "anthropicDesign"
  | "anthropicCowork"
  | "openaiChatgpt"
  | "openaiCodex"
  | "googleGemini"
  | "googleJules"
  | "xaiGrok"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "mistral"
  | "meta"
  | "perplexity"
  | "notion"
  | "cline"
  | "blackbox"
  | "augment"
  | "bolt"
  | "cursor"
  | "windsurf"
  | "v0"
  | "loveable"
  | "replit"
  | "sameDotNew"
  | "traeAgent"
  | "zed"
  | "opencode"
  | "microsoftCopilot"
  | "cluely"
  | "parahelp"
  | "clawdbot"
  | "manus"
  | "devin"
  | "zaiCode"
  | "piHarness";

/** Product class the prompt was written for. */
export type PromptFamily = "anthropic" | "ide" | "chat" | "persona";

/** How the captured text reached the catalog. */
export type ProvenanceKind =
  /** Published by the vendor themselves. */
  | "official"
  /** Recovered from a shipping binary, bundle or network capture. */
  | "captured"
  /** Lifted from an application source file a vendor ships to customers. */
  | "extracted"
  /** Distilled in this repo from a vendor's published behaviour. */
  | "distilled";

/** A catalogued production prompt. */
export interface VendorPromptEntry {
  /** Unique, slug-clean catalog id. */
  readonly id: string;
  readonly vendor: VendorId;
  readonly family: PromptFamily;
  /** Human-readable label, as the vendor would describe the prompt. */
  readonly name: string;
  /** What the prompt is for, in one line. */
  readonly description: string;
  /** The prompt text. */
  readonly text: string;
  /** Tool-invocation convention the prompt teaches, or `none`. */
  readonly toolCallFormat: ToolCallFormat;
  readonly provenance: ProvenanceKind;
  /** Vendor product version the text was captured from, when known. */
  readonly productVersion?: string;
  /** Capture date, ISO 8601, when known. */
  readonly capturedAt?: string;
  /** Byte size of the full captured source text. Present when {@link truncated}. */
  readonly sourceBytes?: number;
  /** The text omits a trailing tool-schema appendix from the full source. */
  readonly truncated?: boolean;
  /** Placeholder names the text expects to be interpolated. */
  readonly variables?: readonly string[];
  /** Model the vendor targets, when the prompt is model-specific. */
  readonly model?: string;
  /** Tools outside the prompt's scope, as captured in its agent metadata. */
  readonly disallowedTools?: readonly string[];
  readonly notes?: string;
}

/** Filter applied by {@link VendorPromptCatalog.list}. */
export interface VendorPromptFilter {
  readonly vendor?: VendorId;
  readonly family?: PromptFamily;
  readonly toolCallFormat?: ToolCallFormat;
  readonly provenance?: ProvenanceKind;
  /** Only entries whose name or description matches (case-insensitive). */
  readonly query?: string;
  /** Exclude entries whose text omits a tool-schema appendix. */
  readonly completeOnly?: boolean;
}

/** Aggregate catalog statistics. */
export interface VendorPromptStats {
  readonly entries: number;
  readonly vendors: number;
  readonly families: number;
  readonly toolCallFormats: number;
  readonly truncated: number;
  readonly chars: number;
  readonly estTokens: number;
  /** Digests shared by more than one entry (same normalised text). */
  readonly duplicateDigests: number;
  /** Entries that still carry a harness-injection marker. */
  readonly entriesWithMarkers: number;
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

/** All catalogued prompts, in catalog order. */
export const CATALOGED_VENDOR_PROMPTS: readonly VendorPromptEntry[] = [
  ...ANTHROPIC_FAMILY_PROMPTS,
  ...IDE_FAMILY_PROMPTS,
  ...CHAT_FAMILY_PROMPTS,
  ...PERSONA_FAMILY_PROMPTS,
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * Typed, indexed store of catalogued production prompts.
 *
 * Construction is validated once, so every later lookup is a plain map hit: the catalog
 * is built to answer `get`, `byVendor` and `stats` in microseconds, and to be safe to
 * build at module load.
 */
export class VendorPromptCatalog {
  private readonly entries = new Map<string, VendorPromptEntry>();
  private readonly byVendor = new Map<VendorId, VendorPromptEntry[]>();
  private readonly byFamily = new Map<PromptFamily, VendorPromptEntry[]>();
  private statsCache: VendorPromptStats | null = null;

  constructor(initial: readonly VendorPromptEntry[] = CATALOGED_VENDOR_PROMPTS) {
    for (const entry of initial) this.register(entry);
  }

  /**
   * Add a prompt. Throws on a duplicate or non-slug id — a catalog that silently
   * overwrote an entry would lose a prompt to an unrelated typo — and when the
   * text still carries a harness-injection marker, which is the other contract
   * the catalog exists to enforce.
   */
  register(entry: VendorPromptEntry): void {
    if (!ID_PATTERN.test(entry.id)) {
      throw new Error(`Vendor prompt id "${entry.id}" is not a lowercase slug`);
    }
    if (this.entries.has(entry.id)) {
      throw new Error(`Vendor prompt id "${entry.id}" is already registered`);
    }
    const markers = findInjectionMarkers(entry.text);
    if (markers.length > 0) {
      throw new Error(
        `Vendor prompt "${entry.id}" contains a harness-injection marker (${markers[0]!.opener}); ` +
          "strip it with stripInjectionMarkers before cataloguing",
      );
    }

    this.entries.set(entry.id, entry);
    this.addToIndex(this.byVendor, entry.vendor, entry);
    this.addToIndex(this.byFamily, entry.family, entry);
    this.statsCache = null;
  }

  /** Look up by id. Case-insensitive, matching the slug convention. */
  get(id: string): VendorPromptEntry | undefined {
    return this.entries.get(id.toLowerCase());
  }

  has(id: string): boolean {
    return this.entries.has(id.toLowerCase());
  }

  /** All entries, or those matching every supplied filter predicate. */
  list(filter?: VendorPromptFilter): VendorPromptEntry[] {
    if (!filter) return Array.from(this.entries.values());

    const query = filter.query?.toLowerCase().trim();
    const base = filter.vendor
      ? (this.byVendor.get(filter.vendor) ?? [])
      : Array.from(this.entries.values());

    return base.filter((entry) => {
      if (filter.family && entry.family !== filter.family) return false;
      if (filter.toolCallFormat && entry.toolCallFormat !== filter.toolCallFormat) return false;
      if (filter.provenance && entry.provenance !== filter.provenance) return false;
      if (filter.completeOnly && entry.truncated) return false;
      if (query) {
        const haystack = `${entry.name} ${entry.description} ${entry.vendor}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  /** Every entry from one vendor. */
  byVendorId(vendor: VendorId): VendorPromptEntry[] {
    return this.byVendor.get(vendor) ?? [];
  }

  /** Every entry in one product family. */
  byFamilyId(family: PromptFamily): VendorPromptEntry[] {
    return this.byFamily.get(family) ?? [];
  }

  /** Vendors with at least one catalogued prompt. */
  vendors(): VendorId[] {
    return Array.from(this.byVendor.keys()).sort();
  }

  /** Fingerprint one entry — digest, sizes, token estimate. */
  fingerprint(id: string): PromptFingerprint | undefined {
    const entry = this.get(id);
    return entry ? fingerprintPrompt(entry.text) : undefined;
  }

  /** Injection markers embedded in one entry's text, if any. */
  markers(id: string): InjectionMarker[] {
    const entry = this.get(id);
    return entry ? findInjectionMarkers(entry.text) : [];
  }

  /** Normalised text of one entry — markers stripped, whitespace canonical. */
  normalizedText(id: string): string | undefined {
    const entry = this.get(id);
    return entry ? normalizeMarkdown(entry.text) : undefined;
  }

  /** Aggregate statistics over the whole catalog. */
  stats(): VendorPromptStats {
    if (this.statsCache) return this.statsCache;

    const all = Array.from(this.entries.values());
    const digests = new Set<string>();
    let chars = 0;
    let truncated = 0;
    let withMarkers = 0;

    for (const entry of all) {
      chars += entry.text.length;
      if (entry.truncated) truncated += 1;
      digests.add(normalizedDigest(entry.text));
      if (findInjectionMarkers(entry.text).length > 0) withMarkers += 1;
    }

    const estTokens = all.reduce((sum, entry) => sum + Math.ceil(entry.text.length / 4), 0);

    this.statsCache = {
      entries: all.length,
      vendors: this.byVendor.size,
      families: this.byFamily.size,
      toolCallFormats: new Set(all.map((entry) => entry.toolCallFormat)).size,
      truncated,
      chars,
      estTokens,
      duplicateDigests: all.length - digests.size,
      entriesWithMarkers: withMarkers,
    };
    return this.statsCache;
  }

  /** Throw if any two entries share a normalised digest. */
  assertNoDuplicates(): void {
    const seen = new Map<string, string>();
    for (const [id, entry] of this.entries) {
      const digest = normalizedDigest(entry.text);
      const existing = seen.get(digest);
      if (existing !== undefined) {
        throw new Error(`Duplicate prompt text: "${id}" and "${existing}" share one digest`);
      }
      seen.set(digest, id);
    }
  }

  private addToIndex<K>(
    index: Map<K, VendorPromptEntry[]>,
    key: K,
    entry: VendorPromptEntry,
  ): void {
    const bucket = index.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      index.set(key, [entry]);
    }
  }
}
