/**
 * Semantic code topology engine — the Tier-1 facade of the subsystem.
 *
 * Synthesis target of plan §6: an incremental AST-style parser building live directed graphs of
 * symbols, call hierarchies and variable lifecycles across TypeScript, Python, Rust and Go; on a
 * bug or build failure it computes the impact radius, identifies the offending symbol, and guides
 * a targeted auto-fix patch.
 *
 * Composition:
 *  - `IncrementalGraphCache` — content-hash fingerprinting and dependent invalidation.
 *  - per-language `symbol-extractors` — definition/import extraction (the tree-sitter seam is
 *    replaced by a dependency-free line-oriented scanner).
 *  - `SymbolIndex` — module/export maps and local→imported symbol resolution.
 *  - `call-hierarchy` + `variable-lifecycle` — call-edge construction and def-use chains.
 *  - `ImpactRadiusEngine` — weighted propagation, PageRank centrality, blame ranking.
 *  - `ReviewEngine` — deterministic review over unified diffs, anchored to real hunk lines.
 */

import type {
  GraphSymbol,
  ImpactReport,
  SymbolScope,
  TopologyEdge,
  TopologyNode,
  ReviewIssue,
} from "./types.js";
import { GRAPH_BUDGETS } from "./types.js";
import {
  IncrementalGraphCache,
  type CachedFileEntry,
  type UpdateResult,
} from "./incremental-graph-cache.js";
import { normalizePath, SymbolIndex } from "./symbol-index.js";
import { buildScopes } from "./scope-tracker.js";
import { buildCallEdges, extractCallSites } from "./call-hierarchy.js";
import {
  computeAllLifecycles,
  extractInstanceTypes,
  extractVariableBindings,
  type VariableLifecycle,
} from "./variable-lifecycle.js";
import { ImpactRadiusEngine } from "./impact-radius.js";
import { ALL_REVIEW_RULES } from "./review-presets.js";
import { ReviewEngine, type SymbolReviewStats } from "./review-engine.js";
import { parseDiffText } from "./diff-graph.js";

export interface BuildStats {
  files: number;
  symbols: number;
  edges: number;
  callEdges: number;
  importEdges: number;
  parseMs: number;
}

export interface TopologyQueryOptions {
  maxDepth?: number;
  edgeKinds?: string[];
}

/** A snapshot of the graph, for serialization and inspection. */
export interface TopologySnapshot {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  stats: BuildStats;
}

export class TopologyEngine {
  private readonly cache: IncrementalGraphCache;
  private readonly index: SymbolIndex;
  private readonly repoRoot: string;
  private nodes = new Map<string, TopologyNode>();
  private edges: TopologyEdge[] = [];
  private impact: ImpactRadiusEngine;
  private lifecycles = new Map<string, VariableLifecycle[]>();

  constructor(repoRoot: string = "") {
    this.repoRoot = repoRoot;
    this.cache = new IncrementalGraphCache(repoRoot);
    this.index = new SymbolIndex();
    this.impact = new ImpactRadiusEngine(this.nodes, this.edges);
  }

  /** Cold-start build over many files. */
  build(files: Array<{ path: string; content: string }>): BuildStats {
    const startedAt = performance.now();
    for (const file of files) this.updateFile(file.path, file.content);
    return {
      ...this.cache.stats(),
      callEdges: this.edges.filter((edge) => edge.kind === "calls").length,
      importEdges: this.edges.filter((edge) => edge.kind === "imports").length,
      parseMs: Math.round(performance.now() - startedAt),
    };
  }

  /** Incremental update on a single-file edit. */
  updateFile(filePath: string, content: string): UpdateResult {
    const result = this.cache.update(filePath, content);
    if (!result.changed) return result;
    const work = new Set<string>([normalizePath(filePath), ...result.stale]);

    // Re-register symbols in the index for every stale file.
    for (const stale of work) {
      this.index.unregisterFile(stale, this.repoRoot);
      const entry = this.cache.get(stale);
      if (entry) this.index.registerFile(stale, entry.symbols, this.repoRoot);
    }

    // Rebuild edges for every stale file (order independent now that the index is current).
    for (const stale of work) {
      const entry = this.cache.get(stale);
      if (!entry) continue;
      this.cache.setEdges(stale, this.buildEdgesForFile(entry));
      this.lifecycles.set(stale, computeAllLifecycles(entry.variableBindings));
    }

    this.rebuild();
    return result;
  }

  /** Rebuild edges for one file without touching the aggregate views (used by removeFile). */
  private rebuildFileEdges(filePath: string): void {
    const entry = this.cache.get(filePath);
    if (!entry) return;
    this.cache.setEdges(filePath, this.buildEdgesForFile(entry));
    this.lifecycles.set(filePath, computeAllLifecycles(entry.variableBindings));
  }

  /** Remove a file; returns the files left stale. */
  removeFile(filePath: string): string[] {
    const stale = this.cache.delete(filePath);
    for (const affected of [normalizePath(filePath), ...stale]) {
      this.index.unregisterFile(affected, this.repoRoot);
      const entry = this.cache.get(affected);
      if (entry) {
        this.index.registerFile(affected, entry.symbols, this.repoRoot);
        this.rebuildFileEdges(affected);
      }
    }
    this.rebuild();
    return stale;
  }

  /** Derive every edge kind contributed by one file. */
  private buildEdgesForFile(entry: CachedFileEntry): TopologyEdge[] {
    const edges: TopologyEdge[] = [];
    const fileNode = entry.filePath;

    // Containment: file -> symbol.
    for (const symbol of entry.symbols) {
      edges.push({ source: fileNode, target: symbol.id, kind: "contains", line: symbol.startLine });
      if (symbol.isExported) {
        edges.push({
          source: symbol.id,
          target: fileNode,
          kind: "exports",
          line: symbol.startLine,
        });
      }
    }

    // Inheritance: class bases resolved through the symbol index.
    for (const symbol of entry.symbols) {
      for (const base of symbol.bases ?? []) {
        const baseId = this.index.resolveSymbol(base, entry.filePath, entry.imports);
        if (baseId && baseId !== symbol.id) {
          edges.push({
            source: symbol.id,
            target: baseId,
            kind: baseImplements(base) ? "implements" : "extends",
            line: symbol.startLine,
          });
        }
      }
    }

    // File-level dependency edges from resolved imports.
    for (const target of this.cache.getImportTargets(entry.filePath)) {
      if (target === entry.filePath) continue;
      edges.push({ source: entry.filePath, target, kind: "imports" });
    }

    // Call edges, routed through the scoped type table.
    const scopeSymbolMap = this.buildScopeSymbolMap(entry);
    edges.push(
      ...buildCallEdges(
        entry.callSites,
        this.index,
        entry.imports,
        entry.instanceTypes,
        scopeSymbolMap,
        entry.filePath,
      ),
    );
    return edges;
  }

  /** Map scope ids to symbol ids for one file (the donor's O(1) scope lookup). */
  private buildScopeSymbolMap(entry: CachedFileEntry): Map<string, string> {
    const map = new Map<string, string>();
    const byScopeKey = new Map<string, string>();
    for (const symbol of entry.symbols) {
      const scopeKey = symbol.className
        ? `${entry.filePath}::method::${symbol.className}.${symbol.name}`
        : `${entry.filePath}::function::${symbol.name}`;
      byScopeKey.set(scopeKey, symbol.id);
      if (symbol.kind === "class" || symbol.kind === "struct" || symbol.kind === "trait") {
        byScopeKey.set(`${entry.filePath}::class::${symbol.name}`, symbol.id);
      }
    }
    for (const scope of entry.scopes) {
      const target = byScopeKey.get(`${entry.filePath}::${scope.id}`);
      if (target) map.set(scope.id, target);
    }
    return map;
  }

  /** Rebuild the aggregate node/edge views and the impact engine. */
  private rebuild(): void {
    const nodes = new Map<string, TopologyNode>();
    const edges: TopologyEdge[] = [];
    for (const entry of this.cache.getAll()) {
      nodes.set(entry.filePath, {
        id: entry.filePath,
        name: entry.filePath.split("/").pop() ?? entry.filePath,
        filePath: entry.filePath,
        kind: "file",
      });
      for (const symbol of entry.symbols) {
        nodes.set(symbol.id, toTopologyNode(symbol));
      }
      edges.push(...entry.edges);
    }
    this.nodes = nodes;
    this.edges = edges;
    this.impact = new ImpactRadiusEngine(this.nodes, this.edges);
  }

  /** Look up a symbol id by name or qualified name. */
  resolveSymbol(name: string, filePath?: string): string | undefined {
    if (filePath)
      return this.index.resolveSymbol(name, filePath, this.cache.get(filePath)?.imports ?? []);
    const bucket = this.index.byName.get(name);
    return bucket?.[0];
  }

  /** Callers of a symbol, nearest first. */
  getCallers(symbolId: string, maxDepth = 2): TopologyNode[] {
    return this.walk(symbolId, "incoming", ["calls", "references", "imports"], maxDepth);
  }

  /** Callees of a symbol, nearest first. */
  getCallees(symbolId: string, maxDepth = 2): TopologyNode[] {
    return this.walk(symbolId, "outgoing", ["calls", "references", "imports"], maxDepth);
  }

  private walk(
    symbolId: string,
    direction: "incoming" | "outgoing",
    kinds: string[],
    maxDepth: number,
  ): TopologyNode[] {
    const found = new Map<string, TopologyNode>();
    const visited = new Set<string>([symbolId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: symbolId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const edge of this.edges) {
        if (!kinds.includes(edge.kind)) continue;
        const next =
          direction === "incoming"
            ? edge.target === id
              ? edge.source
              : undefined
            : edge.source === id
              ? edge.target
              : undefined;
        if (!next || visited.has(next)) continue;
        visited.add(next);
        const node = this.nodes.get(next);
        if (!node) continue;
        found.set(next, node);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
    return [...found.values()];
  }

  /** Shortest path between two symbols over the selected edge kinds. */
  findPath(fromId: string, toId: string, edgeKinds?: string[]): TopologyNode[] | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    if (fromId === toId) return [this.nodes.get(fromId)!];
    const visited = new Set<string>([fromId]);
    const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      for (const edge of this.edges) {
        if (edgeKinds && !edgeKinds.includes(edge.kind)) continue;
        if (edge.source !== id) continue;
        if (visited.has(edge.target)) continue;
        const nextPath = [...path, edge.target];
        if (edge.target === toId)
          return nextPath.map((nodeId) => this.nodes.get(nodeId)!).filter(Boolean);
        visited.add(edge.target);
        queue.push({ id: edge.target, path: nextPath });
      }
    }
    return null;
  }

  /** Weighted impact radius of a symbol. */
  getImpactRadius(symbolId: string, options?: TopologyQueryOptions): ImpactReport | null {
    return this.impact.analyze(symbolId, options);
  }

  /** PageRank centrality of a symbol. */
  getCentrality(symbolId: string): number {
    return this.impact.getCentrality(symbolId);
  }

  /**
   * Diagnose a bug or build failure at a symbol: compute the impact radius, rank the suspects,
   * and emit targeted auto-fix guidance. This is the plan §6 exit-criteria capability.
   */
  diagnose(failingSymbolId: string, options?: TopologyQueryOptions): ImpactReport | null {
    return this.impact.analyze(failingSymbolId, {
      maxDepth: options?.maxDepth ?? GRAPH_BUDGETS.maxImpactDepth,
      edgeKinds: options?.edgeKinds,
    });
  }

  /** Variable lifecycles for a file (def-use chains). */
  getLifecycles(filePath: string): VariableLifecycle[] {
    return this.lifecycles.get(normalizePath(filePath)) ?? [];
  }

  /** Search nodes by symbol name, qualified name, or path. */
  querySymbols(term: string): TopologyNode[] {
    const q = term.toLowerCase().trim();
    if (!q) return [];
    return [...this.nodes.values()].filter(
      (node) =>
        node.name.toLowerCase().includes(q) ||
        (node.qualifiedName?.toLowerCase().includes(q) ?? false) ||
        node.filePath.toLowerCase().includes(q),
    );
  }

  /** Hub nodes by total degree. */
  getHubNodes(minDegree = 4): Array<{ node: TopologyNode; degree: number }> {
    const degree = new Map<string, number>();
    for (const edge of this.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    return [...degree.entries()]
      .filter(([, deg]) => deg >= minDegree)
      .map(([id, deg]) => ({ node: this.nodes.get(id)!, degree: deg }))
      .filter((entry) => entry.node !== undefined)
      .sort((a, b) => b.degree - a.degree);
  }

  /** Symbol review statistics consumed by graph-integrated review rules. */
  buildSymbolReviewStats(): Map<string, SymbolReviewStats> {
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const edge of this.edges) {
      outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
    const stats = new Map<string, SymbolReviewStats>();
    for (const [id, node] of this.nodes) {
      if (node.kind === "file") continue;
      stats.set(id, {
        kind: node.kind,
        qualifiedName: node.qualifiedName ?? node.name,
        complexity: node.complexity ?? 1,
        startLine: node.startLine ?? 0,
        endLine: node.endLine ?? 0,
        inDegree: inDegree.get(id) ?? 0,
        outDegree: outDegree.get(id) ?? 0,
        centrality: this.getCentrality(id),
        isExported: this.isExported(id),
      });
    }
    return stats;
  }

  private isExported(symbolId: string): boolean {
    return this.edges.some((edge) => edge.source === symbolId && edge.kind === "exports");
  }

  /**
   * Review a unified diff against the current graph. Findings are anchored to real hunk lines;
   * graph-integrated rules consult live symbol statistics.
   */
  reviewDiff(diffText: string, fileContents?: Map<string, string>): ReviewIssue[] {
    const diffs = parseDiffText(diffText);
    const contents = fileContents ?? new Map<string, string>();
    const engine = new ReviewEngine(ALL_REVIEW_RULES);
    return engine.run({
      diffs,
      fileContents: contents,
      symbolStats: this.buildSymbolReviewStats(),
    });
  }

  /** Serialize the graph. */
  snapshot(): TopologySnapshot {
    return {
      nodes: [...this.nodes.values()],
      edges: this.edges,
      stats: {
        ...this.cache.stats(),
        callEdges: this.edges.filter((edge) => edge.kind === "calls").length,
        importEdges: this.edges.filter((edge) => edge.kind === "imports").length,
        parseMs: 0,
      },
    };
  }
}

function toTopologyNode(symbol: GraphSymbol): TopologyNode {
  return {
    id: symbol.id,
    name: symbol.name,
    filePath: symbol.filePath,
    kind: symbol.kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    qualifiedName: symbol.qualifiedName,
    complexity: symbol.complexity,
  };
}

/** Heuristic: a base name expressing an interface/protocol relationship. */
function baseImplements(base: string): boolean {
  return /^(?:I[A-Z]|.*(?:Interface|Protocol|Trait|Contract))$/.test(base);
}
