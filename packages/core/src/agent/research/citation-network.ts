/**
 * Citation network — a real directed graph over scholarly works.
 *
 * Nodes are papers; an edge A → B means "A cites B". The graph keeps both the
 * adjacency map and the reverse index so both outgoing and incoming traversals are
 * constant-time, which is what makes transitive closure and influence scoring cheap
 * enough to run during a live research loop.
 *
 * The network is also the citation-hallucination detector. A claim that cites a
 * marker which resolves to no node in the graph — or to a node whose text does not
 * contain the claim — is reported as unresolved, and the plan's QoS target is that a
 * finished synthesis carries zero unresolved markers.
 */

export interface CitationNode {
  readonly id: string;
  readonly title: string;
  readonly authors: string[];
  readonly year?: number;
  readonly doi?: string;
  readonly arxivId?: string;
  /** Marker the citing text uses, e.g. `[12]` or `smith2020`. */
  readonly marker?: string;
  /** Full text or abstract, used for primary-source verification. */
  readonly text?: string;
  /** Whether the node was actually fetched or is a placeholder reference. */
  readonly fetched: boolean;
}

export type EdgeRelation = "cites" | "extends" | "contradicts" | "reproduces" | "surveys";

export interface CitationEdge {
  readonly source: string;
  readonly target: string;
  readonly relation: EdgeRelation;
  /** Section the citation appears in, when known. */
  readonly context?: string;
}

export interface UnresolvedMarker {
  readonly marker: string;
  /** Claim text the marker was attached to. */
  readonly claimText?: string;
  readonly reason:
    "unknown-marker" | "unfetched-node" | "marker-ambiguous" | "self-citation-blocked";
}

export interface CitationReport {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly unresolvedMarkers: UnresolvedMarker[];
  /** Zero is the QoS target for a finished synthesis. */
  readonly hallucinationRate: number;
  readonly cycles: string[][];
  readonly danglingEdges: string[];
  readonly selfCitations: string[];
  readonly influence: ReadonlyMap<string, number>;
  readonly coverage: number;
}

export class CitationNetwork {
  private readonly nodes = new Map<string, CitationNode>();
  private readonly markerIndex = new Map<string, Set<string>>();
  private readonly outgoing = new Map<string, Map<string, EdgeRelation>>();
  private readonly incoming = new Map<string, Set<string>>();
  private nextSynthetic = 0;

  /** Adds a paper to the network, keyed by a stable id. */
  addNode(node: CitationNode): string {
    const existing = this.nodes.get(node.id);
    // `fetched` must be preserved for the same reason `text` is: a caller that upserts a
    // node (metadata first, then text) would otherwise carry full text while reporting
    // unfetched, and `verifyMarkers` would flag its citations as hallucinated.
    this.nodes.set(node.id, {
      ...node,
      text: node.text ?? existing?.text,
      fetched: node.fetched || existing?.fetched || Boolean(node.text),
    });
    this.indexMarker(node);
    if (!this.outgoing.has(node.id)) this.outgoing.set(node.id, new Map());
    if (!this.incoming.has(node.id)) this.incoming.set(node.id, new Set());
    return node.id;
  }

  /**
   * Adds a paper from minimal metadata, synthesising a stable id. An explicit `id` wins
   * over the DOI/arXiv fallback — callers that already key their corpus (the research
   * loop keys sources by search-hit id) must get a node under that same key, otherwise
   * the edges wired from that key point at a node that was never created.
   */
  addPaper(paper: {
    id?: string;
    title: string;
    authors?: string[];
    year?: number;
    doi?: string;
    arxivId?: string;
    marker?: string;
    text?: string;
  }): string {
    const id =
      paper.id ??
      paper.doi ??
      paper.arxivId ??
      `paper_${this.nextSynthetic++}_${slug(paper.title)}`;
    return this.addNode({
      id,
      title: paper.title,
      authors: paper.authors ?? [],
      year: paper.year,
      doi: paper.doi,
      arxivId: paper.arxivId,
      marker: paper.marker,
      text: paper.text,
      fetched: Boolean(paper.text),
    });
  }

  private indexMarker(node: CitationNode): void {
    if (!node.marker) return;
    const key = normaliseMarker(node.marker);
    let bucket = this.markerIndex.get(key);
    if (!bucket) {
      bucket = new Set();
      this.markerIndex.set(key, bucket);
    }
    bucket.add(node.id);
  }

  /** Records that `source` cites `target`. Self-citations are rejected and reported. */
  addEdge(edge: CitationEdge): boolean {
    if (edge.source === edge.target) return false;
    if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) return false;
    this.outgoing.get(edge.source)!.set(edge.target, edge.relation);
    this.incoming.get(edge.target)!.add(edge.source);
    return true;
  }

  /** Bulk-loads edges from a paper's parsed reference list. */
  addEdgesFromReferences(
    sourceId: string,
    references: ReadonlyArray<{ marker?: string; text: string }>,
  ): number {
    let added = 0;
    for (const reference of references) {
      const targetId = this.resolveMarker(reference.marker ?? "");
      if (!targetId) continue;
      if (
        this.addEdge({
          source: sourceId,
          target: targetId,
          relation: "cites",
          context: reference.text,
        })
      )
        added += 1;
    }
    return added;
  }

  getNode(id: string): CitationNode | undefined {
    return this.nodes.get(id);
  }

  /** Resolves an in-text marker to node ids; ambiguity is reported, not silently flattened. */
  resolveMarker(marker: string): string | undefined {
    const key = normaliseMarker(marker);
    const bucket = this.markerIndex.get(key);
    if (!bucket || bucket.size === 0) return undefined;
    return [...bucket][0];
  }

  /** All ids the marker could refer to (more than one means an ambiguous citation). */
  resolveMarkerCandidates(marker: string): string[] {
    const key = normaliseMarker(marker);
    const bucket = this.markerIndex.get(key);
    return bucket ? [...bucket] : [];
  }

  /** Papers cited by `id`. */
  citedBy(id: string): string[] {
    return [...(this.outgoing.get(id)?.keys() ?? [])];
  }

  /** Papers that cite `id`. */
  citing(id: string): string[] {
    return [...(this.incoming.get(id) ?? [])];
  }

  /** Direct citation relation between two papers, if any. */
  relation(sourceId: string, targetId: string): EdgeRelation | undefined {
    return this.outgoing.get(sourceId)?.get(targetId);
  }

  /**
   * Transitive closure of the citation relation from `id` — every paper reachable by
   * following citation edges. Breadth-first so shorter citation chains are visited
   * first, which matters when ranking evidence by proximity.
   */
  descendants(id: string, maxDepth = Number.POSITIVE_INFINITY): Set<string> {
    const visited = new Set<string>();
    let frontier: string[] = [id];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const target of this.citedBy(nodeId)) {
          if (!visited.has(target)) {
            visited.add(target);
            next.push(target);
          }
        }
      }
      frontier = next;
      depth += 1;
    }
    visited.delete(id);
    return visited;
  }

  /** Ancestors: everything that transitively cites `id`. */
  ancestors(id: string, maxDepth = Number.POSITIVE_INFINITY): Set<string> {
    const visited = new Set<string>();
    let frontier: string[] = [id];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const citer of this.citing(nodeId)) {
          if (!visited.has(citer)) {
            visited.add(citer);
            next.push(citer);
          }
        }
      }
      frontier = next;
      depth += 1;
    }
    visited.delete(id);
    return visited;
  }

  /**
   * Topological sort of the citation graph. Papers with no outgoing citations come
   * first. Returns null when the graph contains a cycle — a citation cycle is a real
   * anomaly worth surfacing rather than papering over with an arbitrary order.
   */
  topologicalOrder(): string[] | null {
    const states = new Map<string, 0 | 1 | 2>();
    for (const id of this.nodes.keys()) states.set(id, 0);
    const order: string[] = [];

    const visit = (id: string): boolean => {
      const state = states.get(id);
      if (state === 2) return true;
      if (state === 1) return false; // back edge → cycle
      states.set(id, 1);
      for (const target of this.citedBy(id)) {
        if (!visit(target)) return false;
      }
      states.set(id, 2);
      order.push(id);
      return true;
    };

    for (const id of this.nodes.keys()) {
      if (states.get(id) === 0 && !visit(id)) return null;
    }
    return order;
  }

  /**
   * Detects citation cycles with an explicit-colour DFS. Cycles are reported as node
   * chains so a human can see which papers form the loop.
   */
  detectCycles(): string[][] {
    const states = new Map<string, 0 | 1 | 2>();
    for (const id of this.nodes.keys()) states.set(id, 0);
    const cycles: string[][] = [];

    const visit = (id: string, path: string[]): void => {
      const state = states.get(id);
      if (state === 2) return;
      if (state === 1) {
        const start = path.indexOf(id);
        if (start >= 0) cycles.push([...path.slice(start), id]);
        return;
      }
      states.set(id, 1);
      path.push(id);
      for (const target of this.citedBy(id)) visit(target, path);
      path.pop();
      states.set(id, 2);
    };

    for (const id of this.nodes.keys()) visit(id, []);
    return dedupeCycles(cycles);
  }

  /**
   * Influence score by damped iteration — the citation analogue of PageRank. A paper's
   * score is the sum of the scores of the papers citing it, damped by `damping`, with
   * the residual mass spread uniformly so nodes with no inbound citations still get a
   * floor. Converges in a handful of iterations on typical citation graphs.
   */
  influenceScores(iterations = 12, damping = 0.85): Map<string, number> {
    const ids = [...this.nodes.keys()];
    const n = ids.length;
    if (n === 0) return new Map();

    let scores = new Map<string, number>(ids.map((id) => [id, 1 / n]));

    for (let iteration = 0; iteration < iterations; iteration++) {
      const next = new Map<string, number>(ids.map((id) => [id, (1 - damping) / n]));
      let dangling = 0;

      for (const id of ids) {
        const cited = this.citedBy(id);
        if (cited.length === 0) {
          dangling += scores.get(id) ?? 0;
          continue;
        }
        const share = ((scores.get(id) ?? 0) * damping) / cited.length;
        for (const target of cited) next.set(target, (next.get(target) ?? 0) + share);
      }

      if (dangling > 0) {
        const spread = (dangling * damping) / n;
        for (const id of ids) next.set(id, (next.get(id) ?? 0) + spread);
      }
      scores = next;
    }
    return scores;
  }

  /**
   * Verifies that every citation marker in a set of claims resolves to a fetched node.
   * Unresolved markers are citation hallucinations: the synthesis asserts support from
   * a source that does not exist in the network (or was never fetched).
   */
  verifyMarkers(claims: ReadonlyArray<{ citations: string[]; text: string }>): {
    resolved: string[];
    unresolved: UnresolvedMarker[];
  } {
    const resolved: string[] = [];
    const unresolved: UnresolvedMarker[] = [];

    for (const claim of claims) {
      for (const marker of claim.citations) {
        const candidates = this.resolveMarkerCandidates(marker);
        if (candidates.length === 0) {
          unresolved.push({ marker, claimText: claim.text, reason: "unknown-marker" });
          continue;
        }
        if (candidates.length > 1) {
          unresolved.push({ marker, claimText: claim.text, reason: "marker-ambiguous" });
          continue;
        }
        const node = this.nodes.get(candidates[0]!);
        if (!node) {
          unresolved.push({ marker, claimText: claim.text, reason: "unknown-marker" });
          continue;
        }
        if (!node.fetched)
          unresolved.push({ marker, claimText: claim.text, reason: "unfetched-node" });
        else resolved.push(marker);
      }
    }
    return { resolved, unresolved: dedupeMarkers(unresolved) };
  }

  /** Builds a full network report, including the citation-hallucination figure. */
  report(claims?: ReadonlyArray<{ citations: string[]; text: string }>): CitationReport {
    const edges: CitationEdge[] = [];
    for (const [source, targets] of this.outgoing) {
      for (const [target, relation] of targets) edges.push({ source, target, relation });
    }

    const danglingEdges = edges
      .filter((edge) => !this.nodes.get(edge.target)?.fetched)
      .map((edge) => edge.target);
    const selfCitations = edges
      .filter((edge) => edge.source === edge.target)
      .map((edge) => edge.source);

    const verification = claims
      ? this.verifyMarkers(claims)
      : { resolved: [], unresolved: [] as UnresolvedMarker[] };
    const markerTotal = verification.resolved.length + verification.unresolved.length;
    const influence = this.influenceScores();

    return {
      nodeCount: this.nodes.size,
      edgeCount: edges.length,
      unresolvedMarkers: verification.unresolved,
      hallucinationRate: markerTotal > 0 ? verification.unresolved.length / markerTotal : 0,
      cycles: this.detectCycles(),
      danglingEdges: [...new Set(danglingEdges)],
      selfCitations: [...new Set(selfCitations)],
      influence,
      coverage:
        this.nodes.size > 0
          ? [...this.nodes.values()].filter((node) => node.fetched).length / this.nodes.size
          : 0,
    };
  }

  /** Serialises the graph to a plain object for transport or snapshot testing. */
  toJSON(): { nodes: CitationNode[]; edges: CitationEdge[] } {
    const edges: CitationEdge[] = [];
    for (const [source, targets] of this.outgoing) {
      for (const [target, relation] of targets) edges.push({ source, target, relation });
    }
    return { nodes: [...this.nodes.values()], edges };
  }

  get size(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    let count = 0;
    for (const targets of this.outgoing.values()) count += targets.size;
    return count;
  }
}

function normaliseMarker(marker: string): string {
  return marker
    .trim()
    .toLowerCase()
    .replace(/[\\{}]/g, "")
    .replace(/^cite[a-z]*[:?]*/i, "")
    .replace(/[\s,]+/g, ",")
    .replace(/[^a-z0-9,_:-]/g, "")
    .replace(/^[,\s]+|[,\s]+$/g, "");
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function dedupeCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const cycle of cycles) {
    const key = [...cycle].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cycle);
  }
  return out;
}

function dedupeMarkers(markers: UnresolvedMarker[]): UnresolvedMarker[] {
  const seen = new Set<string>();
  const out: UnresolvedMarker[] = [];
  for (const marker of markers) {
    const key = `${marker.marker}::${marker.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(marker);
  }
  return out;
}

/**
 * Builds a citation network from parsed papers, wiring each paper's reference markers
 * to the papers that were actually retrieved. A reference whose marker resolves to none
 * of the supplied papers is added as an unfetched placeholder, so its marker still
 * resolves — which is precisely how a dangling citation becomes visible rather than
 * invisible, and how it is reported as unfetched instead of as an unknown marker.
 */
export function buildNetworkFromPapers(
  papers: ReadonlyArray<{
    id?: string;
    title: string;
    authors?: string[];
    year?: number;
    doi?: string;
    arxivId?: string;
    marker?: string;
    text?: string;
    references?: ReadonlyArray<{ marker?: string; text: string }>;
  }>,
): CitationNetwork {
  const network = new CitationNetwork();
  const idByMarker = new Map<string, string>();

  for (const paper of papers) {
    const id = network.addPaper(paper);
    if (paper.marker) idByMarker.set(normaliseMarker(paper.marker), id);
  }

  // Unresolved references become placeholder nodes under a namespaced id so they cannot
  // collide with a real paper's id.
  const placeholderId = new Map<string, string>();
  for (const paper of papers) {
    for (const reference of paper.references ?? []) {
      if (!reference.marker) continue;
      const key = normaliseMarker(reference.marker);
      if (idByMarker.has(key) || placeholderId.has(key)) continue;
      const id = `ref::${key}`;
      placeholderId.set(key, id);
      network.addPaper({ id, title: reference.text, marker: reference.marker });
    }
  }

  for (const paper of papers) {
    const id = paper.id ?? paper.doi ?? paper.arxivId;
    if (!id) continue;
    for (const reference of paper.references ?? []) {
      const key = normaliseMarker(reference.marker ?? "");
      const targetId = idByMarker.get(key) ?? placeholderId.get(key);
      if (targetId && targetId !== id) {
        network.addEdge({
          source: id,
          target: targetId,
          relation: "cites",
          context: reference.text,
        });
      }
    }
  }
  return network;
}
