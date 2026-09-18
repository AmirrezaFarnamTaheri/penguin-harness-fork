/**
 * Incremental graph cache.
 *
 * Donor lineage (algorithms only): FastCode's `cache.py` and `CodeGraphBuilder.save/load/merge`,
 * including the critical data-loss fix — entries are keyed and restored by *unique id* rather than
 * by symbol name, because duplicate function names across files silently overwrote each other in
 * the by-name map. This cache adds true incremental update on edit, which the donor lacked: it
 * fingerprints file contents, re-extracts only changed files, and invalidates the *dependents* of
 * a changed file (its reverse-import closure) so that stale import and call edges are rebuilt
 * without re-parsing the rest of the repository.
 */

import type {
  GraphSymbol,
  ImportRecord,
  SymbolScope,
  TopologyEdge,
  VariableBinding,
  CallSite,
} from "./types.js";
import { extractFile } from "./symbol-extractors/index.js";
import { buildScopes } from "./scope-tracker.js";
import { extractCallSites } from "./call-hierarchy.js";
import { extractInstanceTypes, extractVariableBindings } from "./variable-lifecycle.js";
import { normalizePath, stripCodeExtension } from "./symbol-index.js";

/** A per-file cache entry holding everything derived from its source. */
export interface CachedFileEntry {
  filePath: string;
  contentHash: string;
  language: string;
  content: string;
  contentLines: string[];
  symbols: GraphSymbol[];
  scopes: SymbolScope[];
  imports: ImportRecord[];
  callSites: CallSite[];
  variableBindings: VariableBinding[];
  instanceTypes: Record<string, Record<string, string[]>>;
  exports: string[];
  linesOfCode: number;
  /** Edges whose source lives in this file; removed and rebuilt on every update of the file. */
  edges: TopologyEdge[];
}

/** Result of an incremental update. */
export interface UpdateResult {
  /** True when content actually changed (hash mismatch). */
  changed: boolean;
  /** Files whose derived edges must be rebuilt: the file itself plus its dependents. */
  stale: string[];
}

/** cyrb53: small, fast, dependency-free string hash (used as a content fingerprint). */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export class IncrementalGraphCache {
  private readonly entries = new Map<string, CachedFileEntry>();
  /**
   * importer file -> imported files.
   *
   * Both maps use ONE canonical key form: the *full normalized* path (extension kept), because
   * that is what `knownFiles`/`resolveImportTargets` hands out. Earlier versions mixed full paths
   * with `stripCodeExtension` lookups, which made every reverse lookup miss and silently left
   * dependents stale.
   */
  private readonly importTargets = new Map<string, string[]>();
  /** imported file -> importers (reverse closure for invalidation). */
  private readonly reverseImports = new Map<string, Set<string>>();
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  /** Number of cached files. */
  get size(): number {
    return this.entries.size;
  }

  /** Read a cached entry, or undefined when the file has never been indexed. */
  get(filePath: string): CachedFileEntry | undefined {
    return this.entries.get(normalizePath(filePath));
  }

  /** All cached entries. */
  getAll(): CachedFileEntry[] {
    return [...this.entries.values()];
  }

  /** Known file paths (normalized). */
  knownFiles(): Set<string> {
    return new Set(this.entries.keys());
  }

  /**
   * Insert or update one file. When the content fingerprint is unchanged this is a no-op that
   * reports `changed: false`. On change the file is re-extracted and its dependents are returned
   * as stale so their import/call edges can be rebuilt.
   *
   * Edge construction is deliberately left to the caller (via `setEdges`): edges must be built
   * *after* the symbol index has registered the changed symbols, otherwise local resolution would
   * miss the file's own definitions.
   */
  update(filePath: string, content: string): UpdateResult {
    const normalized = normalizePath(filePath);
    const hash = cyrb53(content);
    const existing = this.entries.get(normalized);
    if (existing && existing.contentHash === hash) {
      return { changed: false, stale: [] };
    }

    const extraction = extractFile(filePath, content);
    const scopes = buildScopes(normalized, extraction.definitions);
    const symbols: GraphSymbol[] = extraction.definitions.map((def) => ({
      id: `${normalized}::${def.className ? `${def.className}.` : ""}${def.name}`,
      name: def.name,
      kind: def.kind,
      filePath: normalized,
      startLine: def.startLine,
      endLine: def.endLine ?? def.startLine,
      startColumn: def.startColumn,
      className: def.className,
      qualifiedName: def.className ? `${def.className}.${def.name}` : def.name,
      parameters: def.parameters,
      returnType: def.returnType,
      bases: def.bases,
      decorators: def.decorators,
      isAsync: def.isAsync,
      isExported: def.isExported,
      complexity: def.complexity,
    }));

    // Lazy import of the two analysis passes keeps the module graph acyclic at import time.
    const entry: CachedFileEntry = {
      filePath: normalized,
      contentHash: hash,
      language: extraction.language,
      content,
      contentLines: content.split("\n"),
      symbols,
      scopes,
      imports: extraction.imports,
      callSites: extractCallSites(content, scopes, normalized),
      variableBindings: [],
      instanceTypes: {},
      exports: extraction.exports,
      linesOfCode: extraction.linesOfCode,
      edges: [],
    };
    entry.instanceTypes = extractInstanceTypes(content, scopes, normalized);
    entry.variableBindings = extractVariableBindings(content, scopes, normalized);

    // Remove the previous reverse-import edges contributed by this file before re-deriving them.
    this.detachImportLinks(normalized);
    this.entries.set(normalized, entry);

    // Derive import links against the (now updated) known-file set.
    this.linkImporters(normalized, entry.imports);

    entry.edges = [];
    return { changed: true, stale: [normalized, ...this.dependentsOf(normalized)] };
  }

  /** Importer -> targets and reverse-index population for one file. */
  private linkImporters(normalized: string, imports: ImportRecord[]): void {
    const targets = this.resolveImportTargets(normalized, imports);
    this.importTargets.set(normalized, targets);
    for (const target of targets) {
      let importers = this.reverseImports.get(target);
      if (!importers) {
        importers = new Set();
        this.reverseImports.set(target, importers);
      }
      importers.add(normalized);
    }
  }

  /**
   * Re-derive every file's import links against the complete known-file set.
   *
   * A cold build registers files one at a time, so links derived during registration only ever saw
   * the files added *earlier*; an import of a not-yet-registered file stayed unresolved. Calling
   * this after every file is registered repairs those links before edges are built.
   */
  relinkAll(): void {
    this.importTargets.clear();
    this.reverseImports.clear();
    for (const entry of this.entries.values()) {
      this.linkImporters(entry.filePath, entry.imports);
    }
  }

  /** Assign the derived edges for a file (called by the topology engine after symbol registration). */
  setEdges(filePath: string, edges: TopologyEdge[]): void {
    const entry = this.entries.get(normalizePath(filePath));
    if (entry) entry.edges = edges;
  }

  /** The concrete files a file's imports resolve to (for file-level dependency edges). */
  getImportTargets(filePath: string): string[] {
    return this.importTargets.get(normalizePath(filePath)) ?? [];
  }

  /** Remove a file and detach its import links. */
  delete(filePath: string): string[] {
    const normalized = normalizePath(filePath);
    const dependents = this.dependentsOf(normalized);
    this.detachImportLinks(normalized);
    this.importTargets.delete(normalized);
    this.entries.delete(normalized);
    return dependents;
  }

  /** Files that (transitively) import the given file and must be re-linked when it changes. */
  dependentsOf(filePath: string): string[] {
    const normalized = normalizePath(filePath);
    const seen = new Set<string>();
    const queue = [normalized];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const importers = this.reverseImports.get(current);
      if (!importers) continue;
      for (const importer of importers) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        queue.push(importer);
      }
    }
    return [...seen];
  }

  /** Resolve a file's imports to concrete cached file paths (extension-stripped keys). */
  private resolveImportTargets(filePath: string, imports: ImportRecord[]): string[] {
    const known = this.knownFiles();
    const stripped = new Map<string, string>();
    for (const knownPath of known) stripped.set(stripCodeExtension(knownPath), knownPath);
    const resolved: string[] = [];
    for (const imp of imports) {
      const spec = normalizePath(imp.module);
      if (!spec || spec.startsWith("@") || (!spec.startsWith(".") && !spec.startsWith("/"))) {
        // Absolute/bare specifier: match against the tail of known paths.
        for (const [key, full] of stripped) {
          if (key === spec || key.endsWith(`/${spec}`)) resolved.push(full);
        }
        continue;
      }
      const base = spec.startsWith("/") ? spec : resolvePathSibling(filePath, spec);
      for (const candidate of [base, `${base}/index`]) {
        const full = stripped.get(stripCodeExtension(candidate));
        if (full) resolved.push(full);
      }
    }
    return [...new Set(resolved)];
  }

  /** Remove this file's contribution to the reverse-import index. */
  private detachImportLinks(filePath: string): void {
    const normalized = normalizePath(filePath);
    for (const importers of this.reverseImports.values()) {
      importers.delete(normalized);
    }
    this.reverseImports.delete(normalized);
  }

  /** Cache statistics. */
  stats(): { files: number; symbols: number; edges: number; importLinks: number } {
    let symbols = 0;
    let edges = 0;
    for (const entry of this.entries.values()) {
      symbols += entry.symbols.length;
      edges += entry.edges.length;
    }
    return { files: this.entries.size, symbols, edges, importLinks: this.importTargets.size };
  }
}

/** Resolve a `./`- or `../`-style spec against the directory containing `filePath`. */
function resolvePathSibling(filePath: string, spec: string): string {
  const parts = normalizePath(filePath).split("/");
  parts.pop();
  for (const seg of normalizePath(spec).split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
