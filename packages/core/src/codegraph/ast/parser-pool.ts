/**
 * Grammar-backed parser pool — the AST substrate for the code graph (cluster-D report §7).
 *
 * Design sources, deliberately modernized rather than copied:
 * - vscode-tree-sitter: the incremental reparse loop (`tree.edit(delta)` → `parse(text, oldTree)`)
 *   with edits applied in order and synchronously per batch (async processing causes edit
 *   anomalies), a per-URI tree cache, and one module-scope `Parser.init()` promise (re-init
 *   crashes). Its two traps are fixed here: grammar paths are resolved absolutely (never
 *   cwd-relative), and the tree cache is LRU-bounded (an editor is bounded by open tabs; a
 *   long-lived server is not).
 * - calldiff: grammar pinning discipline — but prebuilt wasm only. This pool NEVER installs
 *   packages at runtime.
 *
 * `web-tree-sitter` is an optional dependency: when it (or a grammar) is missing, the pool
 * reports engine tier `fallback` and the existing regex extraction remains authoritative. A
 * missing grammar degrades one language, never the process.
 */

/** The six-field edit delta tree-sitter consumes (vscode-tree-sitter's shape, verbatim fields). */
export interface EditDelta {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: Point;
  oldEndPosition: Point;
  newEndPosition: Point;
}

export interface Point {
  row: number;
  column: number;
}

/** Engine tier actually in force for a language. */
export type EngineTier = "ast" | "fallback";

export interface ParserPoolOptions {
  /** Directory holding `tree-sitter.wasm` and per-language `<lang>.wasm` grammars. */
  grammarDir?: string;
  /** Maximum cached trees per pool (LRU eviction). */
  maxCachedTrees?: number;
  /** Approximate byte budget for cached source text (entries over the budget are evicted first). */
  maxCachedBytes?: number;
}

export interface ParsedTreeHandle {
  language: string;
  /** Opaque tree object (web-tree-sitter `Tree`); typed loosely to keep the dependency optional. */
  tree: unknown;
  sourceLength: number;
}

/** Offset → Point over the text that the offset indexes into. */
export function pointAt(text: string, offset: number): Point {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let row = 0;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      row++;
      lastNewline = i;
    }
  }
  return { row, column: clamped - lastNewline - 1 };
}

/**
 * Build the edit delta for one content change. `changeStart`/`oldEnd` are offsets into the OLD
 * text; `newText` is the replacement. Callers with several changes must build and apply deltas
 * one at a time, each against the text state that its offsets describe — the reference applies
 * `old.edit(delta)` in order on the same old tree for exactly this reason.
 */
export function editDelta(
  oldText: string,
  changeStart: number,
  oldEnd: number,
  newText: string,
): EditDelta {
  const newEnd = changeStart + newText.length;
  // start/oldEnd positions live in the OLD text; newEnd lives in the NEW text. Everything
  // before the change is shared by both, so the new end point is measured over the composed
  // prefix `old[0..start) + newText`.
  const newPrefix = oldText.slice(0, changeStart) + newText;
  return {
    startIndex: changeStart,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: pointAt(oldText, changeStart),
    oldEndPosition: pointAt(oldText, oldEnd),
    newEndPosition: pointAt(newPrefix, newPrefix.length),
  };
}

interface CacheEntry {
  handle: ParsedTreeHandle;
  bytes: number;
  lastUsed: number;
}

type WebTreeSitterModule = {
  Parser: {
    init(): Promise<void>;
    new (): {
      setLanguage(language: unknown): void;
      parse(text: string, oldTree?: unknown): unknown;
    };
  };
  Language: { load(path: string): Promise<unknown> };
};

/**
 * The pool. One per process is enough (grammar bytes are shared); construct directly in tests.
 */
export class ParserPool {
  private readonly grammarDir: string | undefined;
  private readonly maxCachedTrees: number;
  private readonly maxCachedBytes: number;
  private readonly trees = new Map<string, CacheEntry>();
  private readonly languages = new Map<string, unknown>();
  private module: WebTreeSitterModule | null = null;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;
  private clock = 0;

  constructor(options: ParserPoolOptions = {}) {
    this.grammarDir = options.grammarDir;
    this.maxCachedTrees = options.maxCachedTrees ?? 64;
    this.maxCachedBytes = options.maxCachedBytes ?? 8 * 1024 * 1024;
  }

  /** Which tier this pool can serve for a language right now. */
  async engineFor(language: string): Promise<EngineTier> {
    if (this.initFailed) return "fallback";
    try {
      await this.ensureInit();
      await this.loadLanguage(language);
      return "ast";
    } catch {
      return "fallback";
    }
  }

  /**
   * Parse `text` for `uri`, reusing the previous tree for incremental reparse when one is
   * cached. `edits` describe the change from the cached source; when omitted the parse is
   * from scratch. Returns null when no grammar is available (caller falls back).
   */
  async parse(
    uri: string,
    language: string,
    text: string,
    edits?: readonly EditDelta[],
    oldTree?: unknown,
  ): Promise<ParsedTreeHandle | null> {
    try {
      await this.ensureInit();
      const lang = await this.loadLanguage(language);
      const parser = new this.module!.Parser();
      parser.setLanguage(lang);
      const previous = oldTree ?? this.trees.get(uri)?.handle.tree;
      if (previous !== undefined && edits !== undefined) {
        const tree = previous as { edit(delta: EditDelta): void };
        for (const delta of edits) tree.edit(delta);
      }
      const tree = edits === undefined ? parser.parse(text) : parser.parse(text, previous);
      const handle: ParsedTreeHandle = { language, tree, sourceLength: text.length };
      this.storeTree(uri, handle, text.length);
      return handle;
    } catch {
      return null;
    }
  }

  /**
   * Insert a tree into the cache under the LRU + byte budget. This is the cache seam: `parse`
   * uses it, and tests drive it directly so eviction behavior is provable without a grammar.
   */
  storeTree(uri: string, handle: ParsedTreeHandle, bytes: number): void {
    this.trees.delete(uri);
    this.trees.set(uri, { handle, bytes, lastUsed: ++this.clock });
    // LRU + byte budget: evict coldest first until both bounds hold.
    while (this.trees.size > this.maxCachedTrees || this.totalBytes() > this.maxCachedBytes) {
      let coldestKey: string | null = null;
      let coldestUse = Infinity;
      for (const [key, entry] of this.trees) {
        if (entry.lastUsed < coldestUse) {
          coldestUse = entry.lastUsed;
          coldestKey = key;
        }
      }
      if (coldestKey === null) break;
      this.trees.delete(coldestKey);
    }
  }

  /** Cached tree for a URI, or null. */
  cached(uri: string): ParsedTreeHandle | null {
    const entry = this.trees.get(uri);
    if (!entry) return null;
    entry.lastUsed = ++this.clock;
    return entry.handle;
  }

  /** Drop a URI's tree (file closed / deleted). */
  evict(uri: string): void {
    this.trees.delete(uri);
  }

  /** Introspection for the `code_graph` status surface. */
  stats(): { cachedTrees: number; cachedBytes: number; languages: string[]; tier: EngineTier } {
    let bytes = 0;
    for (const entry of this.trees.values()) bytes += entry.bytes;
    return {
      cachedTrees: this.trees.size,
      cachedBytes: bytes,
      languages: [...this.languages.keys()],
      tier: this.module !== null && !this.initFailed ? "ast" : "fallback",
    };
  }

  private async ensureInit(): Promise<void> {
    if (this.initFailed) throw new Error("parser pool initialization failed");
    if (this.initPromise === null) {
      // One init per process — the reference documents a hard crash on re-init.
      this.initPromise = (async () => {
        // Non-literal specifier on purpose: web-tree-sitter is an OPTIONAL dependency, so this
        // must stay a runtime resolution that fails soft rather than a build-time requirement.
        const specifier = "web-tree-sitter";
        const imported = (await import(
          /* webpackIgnore: true */ specifier
        )) as unknown as WebTreeSitterModule;
        await imported.Parser.init();
        this.module = imported;
      })().catch((err: unknown) => {
        this.initFailed = true;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async loadLanguage(language: string): Promise<unknown> {
    const cached = this.languages.get(language);
    if (cached !== undefined) return cached;
    if (this.grammarDir === undefined) throw new Error("no grammar directory configured");
    // Absolute resolution: the reference's cwd-relative loading silently failed outside the
    // editor's own directory.
    const path = await import("node:path");
    const grammarPath = path.resolve(this.grammarDir, `${language}.wasm`);
    const lang = await this.module!.Language.load(grammarPath);
    this.languages.set(language, lang);
    return lang;
  }

  private totalBytes(): number {
    let bytes = 0;
    for (const entry of this.trees.values()) bytes += entry.bytes;
    return bytes;
  }
}
