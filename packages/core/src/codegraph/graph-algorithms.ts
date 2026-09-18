/**
 * Graph algorithms for code topology.
 *
 * Donor lineage (algorithms only, ported to dependency-free TypeScript):
 *  - AnyGraph `data_handler.normalize_adj` — symmetric normalization `D^-1/2 A D^-1/2` and the
 *    column-normalized asymmetric variant (degree raised to -0.5, infinities zeroed).
 *  - AnyGraph `TopoEncoder.forward` — layer-wise propagation `E <- A_norm @ E`, summed across
 *    layers, which is the multi-hop neighbourhood aggregation used for weighted impact radius.
 *  - Plan Tier-5 requirement: PageRank centrality weighting.
 *  - Plan Tier-5 requirement: Levenshtein distance for diff hunk alignment.
 */

import { GRAPH_BUDGETS } from "./types.js";

export type WeightedAdjacency = Map<string, Map<string, number>>;

/** Build a directed adjacency map from an edge list, optionally filtered by edge kind. */
export function buildDirectedAdjacency(
  edges: Array<{ source: string; target: string; kind?: string }>,
  kind?: string,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (kind && edge.kind !== kind) continue;
    let targets = adj.get(edge.source);
    if (!targets) {
      targets = new Set();
      adj.set(edge.source, targets);
    }
    targets.add(edge.target);
  }
  return adj;
}

/** Build a weighted adjacency map where every edge has weight 1. */
export function buildWeightedAdjacency(
  edges: Array<{ source: string; target: string; kind?: string }>,
  kind?: string,
): WeightedAdjacency {
  const adj: WeightedAdjacency = new Map();
  for (const edge of edges) {
    if (kind && edge.kind !== kind) continue;
    let targets = adj.get(edge.source);
    if (!targets) {
      targets = new Map();
      adj.set(edge.source, targets);
    }
    targets.set(edge.target, (targets.get(edge.target) ?? 0) + 1);
  }
  return adj;
}

/**
 * Symmetric normalization `D^-1/2 (A + I) D^-1/2`, the graph-convolution propagation used for
 * weighted impact analysis. Self-loops are added so each node retains part of its own signal.
 * Isolated degrees (0, giving 1/0 = Infinity) are floored to 0 exactly as the donor does.
 */
export function symmetricNormalize(adj: WeightedAdjacency): WeightedAdjacency {
  const nodes = new Set<string>();
  for (const [source, targets] of adj) {
    nodes.add(source);
    for (const target of targets.keys()) nodes.add(target);
  }
  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node, 1); // self-loop
  for (const [source, targets] of adj) {
    for (const target of targets.keys()) {
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }
  const invSqrt = new Map<string, number>();
  for (const [node, deg] of degree) {
    invSqrt.set(node, deg > 0 ? 1 / Math.sqrt(deg) : 0);
  }
  const normalized: WeightedAdjacency = new Map();
  for (const source of nodes) {
    const row = new Map<string, number>();
    const selfWeight = (invSqrt.get(source) ?? 0) * (invSqrt.get(source) ?? 0);
    if (selfWeight > 0) row.set(source, selfWeight);
    for (const [target, weight] of adj.get(source) ?? new Map()) {
      const value = weight * (invSqrt.get(source) ?? 0) * (invSqrt.get(target) ?? 0);
      row.set(target, (row.get(target) ?? 0) + value);
    }
    normalized.set(source, row);
  }
  return normalized;
}

/**
 * Multi-hop signal propagation with per-layer summation (donor TopoEncoder loop).
 * `signal` holds per-node seed values; each iteration does `signal <- A_norm @ signal` and
 * accumulates, so nodes reachable through more paths accumulate more impact. Returns the
 * accumulated signal, which the impact-radius engine turns into weights.
 */
export function propagateImpact(
  normalized: WeightedAdjacency,
  seeds: Map<string, number>,
  iterations: number,
): Map<string, number> {
  let signal = new Map<string, number>(seeds);
  const accumulated = new Map<string, number>(seeds);
  for (let layer = 0; layer < Math.max(0, iterations); layer++) {
    const next = new Map<string, number>();
    for (const [source, row] of normalized) {
      const value = signal.get(source) ?? 0;
      if (value === 0) continue;
      for (const [target, weight] of row) {
        next.set(target, (next.get(target) ?? 0) + value * weight);
      }
    }
    signal = next;
    for (const [node, value] of next) {
      accumulated.set(node, (accumulated.get(node) ?? 0) + value);
    }
  }
  return accumulated;
}

/**
 * PageRank centrality over the directed graph, with dangling-node redistribution.
 * Iterates until the L1 delta falls below `epsilon` or the iteration budget is exhausted.
 */
export function pageRank(
  edges: Array<{ source: string; target: string }>,
  options?: { damping?: number; maxIterations?: number; epsilon?: number },
): Map<string, number> {
  const damping = options?.damping ?? GRAPH_BUDGETS.pageRankDamping;
  const maxIterations = options?.maxIterations ?? GRAPH_BUDGETS.maxPageRankIterations;
  const epsilon = options?.epsilon ?? GRAPH_BUDGETS.pageRankEpsilon;

  const out = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.source);
    nodes.add(edge.target);
    let targets = out.get(edge.source);
    if (!targets) {
      targets = new Set();
      out.set(edge.source, targets);
    }
    targets.add(edge.target);
  }
  const n = nodes.size;
  if (n === 0) return new Map();

  let scores = new Map<string, number>();
  for (const node of nodes) scores.set(node, 1 / n);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Dangling nodes (no out-edges) redistribute their mass uniformly.
    let danglingMass = 0;
    for (const node of nodes) {
      if ((out.get(node)?.size ?? 0) === 0) danglingMass += scores.get(node) ?? 0;
    }
    const next = new Map<string, number>();
    const teleport = (1 - damping) / n + (damping * danglingMass) / n;
    for (const node of nodes) {
      next.set(node, teleport);
    }
    for (const [source, targets] of out) {
      const share = (damping * (scores.get(source) ?? 0)) / targets.size;
      for (const target of targets) {
        next.set(target, (next.get(target) ?? 0) + share);
      }
    }
    let delta = 0;
    for (const node of nodes) {
      delta += Math.abs((next.get(node) ?? 0) - (scores.get(node) ?? 0));
    }
    scores = next;
    if (delta < epsilon) break;
  }
  return scores;
}

/**
 * Levenshtein edit distance between two strings (classic dynamic programming, O(len(a)*len(b))).
 * Used to fuzzy-align a review comment's code excerpt against diff hunk lines when an exact
 * consecutive match fails — the plan's Tier-5 hunk-alignment distance.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    const aChar = a[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = aChar === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1, // deletion
        current[j - 1]! + 1, // insertion
        previous[j - 1]! + cost, // substitution
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** Normalized similarity in [0, 1] derived from edit distance. */
export function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
