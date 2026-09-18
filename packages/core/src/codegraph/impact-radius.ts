/**
 * Impact-radius analysis.
 *
 * Supersedes the existing file-level `CodeGraph.getImpactRadius` (plain BFS over incoming edges)
 * with symbol-level analysis: BFS depth via reverse edges, impact *weights* from normalized
 * multi-hop propagation, PageRank centrality, a ranked suspect list for blame attribution, and
 * targeted auto-fix guidance that names the offending symbol and the files a patch must touch.
 *
 * Weighting rationale: a symbol reached through many distinct paths accumulates more propagated
 * signal, so it is likelier to break when the focal symbol changes. High complexity and high
 * degree raise the risk further; depth discounts it.
 */

import { GRAPH_BUDGETS, type ImpactReport, type TopologyEdge, type TopologyNode } from "./types.js";
import {
  buildWeightedAdjacency,
  levenshteinSimilarity,
  pageRank,
  propagateImpact,
  symmetricNormalize,
} from "./graph-algorithms.js";

export interface ImpactOptions {
  maxDepth?: number;
  edgeKinds?: string[];
}

export class ImpactRadiusEngine {
  private readonly nodes: Map<string, TopologyNode>;
  private readonly edges: TopologyEdge[];
  private readonly centrality: Map<string, number>;

  constructor(nodes: Map<string, TopologyNode>, edges: TopologyEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
    this.centrality = pageRank(edges.map((edge) => ({ source: edge.source, target: edge.target })));
  }

  /** PageRank centrality of a node, in [0, 1]. */
  getCentrality(nodeId: string): number {
    return this.centrality.get(nodeId) ?? 0;
  }

  /** All nodes that transitively depend on `focalId`, nearest first, with depth and weight. */
  analyze(focalId: string, options?: ImpactOptions): ImpactReport | null {
    const focal = this.nodes.get(focalId);
    if (!focal) return null;
    const maxDepth = options?.maxDepth ?? GRAPH_BUDGETS.maxImpactDepth;
    const kinds = options?.edgeKinds;

    const selected = kinds ? this.edges.filter((edge) => kinds.includes(edge.kind)) : this.edges;

    // Reverse BFS: walk incoming edges to find dependents, tracking the shortest depth.
    const depthById = new Map<string, number>([[focalId, 0]]);
    const touchedEdges = new Map<string, TopologyEdge>();
    const queue: Array<{ id: string; depth: number }> = [{ id: focalId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const edge of selected) {
        if (edge.target !== id) continue;
        const key = `${edge.source}->${edge.target}:${edge.kind}:${edge.line ?? 0}`;
        touchedEdges.set(key, edge);
        const nextDepth = depth + 1;
        const previous = depthById.get(edge.source);
        if (previous === undefined || nextDepth < previous) {
          depthById.set(edge.source, nextDepth);
          queue.push({ id: edge.source, depth: nextDepth });
        }
      }
    }

    // Weighted impact via normalized propagation over the selected subgraph.
    const weighted = buildWeightedAdjacency(selected);
    const undirected: WeightedPairs = new Map();
    for (const [source, targets] of weighted) {
      for (const [target, weight] of targets) {
        addPair(undirected, source, target, weight);
        addPair(undirected, target, source, weight);
      }
    }
    const seeds = new Map<string, number>([[focalId, 1]]);
    const propagated = propagateImpact(symmetricNormalize(undirected), seeds, maxDepth);

    const impacted: ImpactReport["impacted"] = [];
    for (const [id, depth] of depthById) {
      if (id === focalId) continue;
      const node = this.nodes.get(id);
      if (!node) continue;
      impacted.push({ node, depth, weight: propagated.get(id) ?? 0 });
    }
    impacted.sort(
      (a, b) => a.depth - b.depth || b.weight - a.weight || a.node.id.localeCompare(b.node.id),
    );

    const suspects = this.rankSuspects(focal, impacted);
    const topSuspect = suspects[0];
    const fixGuidance: ImpactReport["fixGuidance"] = topSuspect
      ? {
          symbol: topSuspect.node,
          strategy: this.fixStrategyFor(focal, topSuspect.node, topSuspect.reason),
          relatedFiles: [
            ...new Set(
              impacted
                .map((entry) => entry.node.filePath)
                .filter((path) => path !== focal.filePath),
            ),
          ].slice(0, 10),
        }
      : {
          symbol: focal,
          strategy: "No dependents; contain the change to the focal symbol.",
          relatedFiles: [],
        };

    return {
      focal,
      impacted,
      edges: [...touchedEdges.values()],
      centrality: this.getCentrality(focalId),
      suspects,
      fixGuidance,
    };
  }

  /** Rank impacted symbols by how likely they are the offending cause of a failure. */
  private rankSuspects(
    focal: TopologyNode,
    impacted: ImpactReport["impacted"],
  ): ImpactReport["suspects"] {
    return impacted
      .map((entry) => {
        const node = entry.node;
        const complexity = node.complexity ?? 1;
        const degree = this.degree(node.id);
        const score =
          (entry.weight * (1 + complexity / 10) * (1 + degree / 20)) / (1 + entry.depth);
        const reason = this.suspectReason(node, entry, focal);
        return { node, score, reason };
      })
      .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
      .slice(0, 10);
  }

  private degree(nodeId: string): number {
    let count = 0;
    for (const edge of this.edges) {
      if (edge.source === nodeId || edge.target === nodeId) count++;
    }
    return count;
  }

  private suspectReason(
    node: TopologyNode,
    entry: { depth: number; weight: number },
    focal: TopologyNode,
  ): string {
    const parts: string[] = [];
    parts.push(
      `${node.kind} "${node.qualifiedName ?? node.name}" is ${entry.depth} hop(s) from "${focal.qualifiedName ?? focal.name}"`,
    );
    if ((node.complexity ?? 1) >= 8) parts.push(`high cyclomatic complexity (${node.complexity})`);
    if (entry.weight > 1) parts.push(`reached through ${Math.round(entry.weight)} weighted paths`);
    return parts.join("; ");
  }

  private fixStrategyFor(focal: TopologyNode, suspect: TopologyNode, reason: string): string {
    if (suspect.kind === "method" || suspect.kind === "function") {
      return `Patch ${suspect.filePath}:${suspect.startLine}-${suspect.endLine} (${suspect.qualifiedName ?? suspect.name}); verify its contract against ${focal.qualifiedName ?? focal.name} and add a regression test. Rationale: ${reason}.`;
    }
    if (suspect.kind === "class" || suspect.kind === "struct" || suspect.kind === "trait") {
      return `Audit ${suspect.qualifiedName ?? suspect.name} in ${suspect.filePath}; its members consume the changed symbol, so re-check invariants and downstream callers before regenerating the patch.`;
    }
    return `Review ${suspect.filePath} around line ${suspect.startLine}; the change to ${focal.qualifiedName ?? focal.name} propagates here. Rationale: ${reason}.`;
  }
}

type WeightedPairs = Map<string, Map<string, number>>;

function addPair(map: WeightedPairs, a: string, b: string, weight: number): void {
  let inner = map.get(a);
  if (!inner) {
    inner = new Map();
    map.set(a, inner);
  }
  inner.set(b, (inner.get(b) ?? 0) + weight);
}

/** Fuzzy-match a code excerpt against candidate lines, for blame confirmation. */
export function bestEffortMatch(
  excerpt: string,
  candidates: string[],
): { index: number; similarity: number } {
  let best = { index: -1, similarity: 0 };
  candidates.forEach((candidate, index) => {
    const similarity = levenshteinSimilarity(excerpt.trim(), candidate.trim());
    if (similarity > best.similarity) best = { index, similarity };
  });
  return best;
}
