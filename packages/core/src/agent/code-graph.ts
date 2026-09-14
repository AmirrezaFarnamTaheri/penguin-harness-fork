/**
 * CodeGraph Knowledge Graph and Traversal Engine.
 * Synthesized and ported from CodeGraph and Graphify.
 */

import type { FileSummary } from "./symbol-indexer.js";

export type CodeNodeKind =
  | "file"
  | "module"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "function"
  | "type"
  | "component";

export type CodeEdgeKind =
  "contains" | "calls" | "imports" | "exports" | "extends" | "implements" | "references";

export interface CodeGraphNode {
  id: string;
  name: string;
  filePath: string;
  kind: CodeNodeKind;
  loc?: number;
  exports?: string[];
  imports?: string[];
}

export interface CodeGraphEdge {
  source: string;
  target: string;
  kind: CodeEdgeKind;
  line?: number;
}

export interface CodeGraphSubgraph {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  roots: string[];
}

export interface ConceptExplanation {
  focal: CodeGraphNode | null;
  callers: CodeGraphNode[];
  callees: CodeGraphNode[];
  impactRadius: CodeGraphNode[];
  connectedFiles: string[];
}

function cloneNode(node: CodeGraphNode): CodeGraphNode {
  return {
    ...node,
    exports: node.exports ? [...node.exports] : undefined,
    imports: node.imports ? [...node.imports] : undefined,
  };
}

function cloneEdge(edge: CodeGraphEdge): CodeGraphEdge {
  return { ...edge };
}

export class CodeGraph {
  private readonly nodes = new Map<string, CodeGraphNode>();
  private readonly outgoing = new Map<string, CodeGraphEdge[]>();
  private readonly incoming = new Map<string, CodeGraphEdge[]>();

  public addNode(node: CodeGraphNode): void {
    this.nodes.set(node.id, cloneNode(node));
  }

  public getNode(id: string): CodeGraphNode | undefined {
    const node = this.nodes.get(id);
    return node ? cloneNode(node) : undefined;
  }

  public getAllNodes(): CodeGraphNode[] {
    return Array.from(this.nodes.values(), cloneNode);
  }

  public removeNode(id: string): void {
    if (!this.nodes.has(id)) return;
    this.nodes.delete(id);

    const outEdges = this.outgoing.get(id) ?? [];
    for (const edge of outEdges) {
      const inList = this.incoming.get(edge.target);
      if (inList) {
        this.incoming.set(
          edge.target,
          inList.filter((e) => !(e.source === id && e.target === edge.target && e.kind === edge.kind)),
        );
      }
    }
    this.outgoing.delete(id);

    const inEdges = this.incoming.get(id) ?? [];
    for (const edge of inEdges) {
      const outList = this.outgoing.get(edge.source);
      if (outList) {
        this.outgoing.set(
          edge.source,
          outList.filter((e) => !(e.source === edge.source && e.target === id && e.kind === edge.kind)),
        );
      }
    }
    this.incoming.delete(id);
  }

  public removeFile(filePath: string): void {
    const toRemove: string[] = [];
    for (const [id, node] of this.nodes) {
      if (node.filePath === filePath || id.startsWith(filePath + "#")) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.removeNode(id);
    }
  }

  public updateFile(summary: FileSummary): void {
    this.removeFile(summary.filePath);

    this.addNode({
      id: summary.filePath,
      name: summary.filePath.split("/").pop() || summary.filePath,
      filePath: summary.filePath,
      kind: "file",
      loc: summary.linesOfCode,
      exports: summary.exports,
      imports: summary.imports,
    });

    for (const cls of summary.classes) {
      const id = `${summary.filePath}#${cls}`;
      this.addNode({
        id,
        name: cls,
        filePath: summary.filePath,
        kind: "class",
      });
      this.addEdge({
        source: summary.filePath,
        target: id,
        kind: "contains",
      });
    }

    for (const iface of summary.interfaces) {
      const id = `${summary.filePath}#${iface}`;
      this.addNode({
        id,
        name: iface,
        filePath: summary.filePath,
        kind: "interface",
      });
      this.addEdge({
        source: summary.filePath,
        target: id,
        kind: "contains",
      });
    }

    for (const fn of summary.functions) {
      const id = `${summary.filePath}#${fn}`;
      this.addNode({
        id,
        name: fn,
        filePath: summary.filePath,
        kind: "function",
      });
      this.addEdge({
        source: summary.filePath,
        target: id,
        kind: "contains",
      });
    }

    const allFiles = Array.from(this.nodes.values()).filter(
      (n) => n.kind === "file" && n.filePath !== summary.filePath,
    );

    const matchPath = (imp: string, path: string) => {
      const base = path.replace(/\.[^/.]+$/, "");
      return imp.endsWith(base) || base.endsWith(imp) || imp.includes(base);
    };

    for (const imp of summary.imports) {
      const target = allFiles.find((other) => matchPath(imp, other.filePath));
      if (target) {
        this.addEdge({
          source: summary.filePath,
          target: target.filePath,
          kind: "imports",
        });
      }
    }

    for (const other of allFiles) {
      if (other.imports) {
        for (const imp of other.imports) {
          if (matchPath(imp, summary.filePath)) {
            this.addEdge({
              source: other.filePath,
              target: summary.filePath,
              kind: "imports",
            });
          }
        }
      }
    }
  }

  public getAllEdges(): CodeGraphEdge[] {
    const edges: CodeGraphEdge[] = [];
    for (const list of this.outgoing.values()) {
      for (const edge of list) {
        edges.push(cloneEdge(edge));
      }
    }
    return edges;
  }

  public toJSON(): { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] } {
    return {
      nodes: this.getAllNodes(),
      edges: this.getAllEdges(),
    };
  }

  public static fromJSON(data: { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] }): CodeGraph {
    const graph = new CodeGraph();
    for (const node of data.nodes) {
      graph.addNode(node);
    }
    for (const edge of data.edges) {
      graph.addEdge(edge);
    }
    return graph;
  }

  public addEdge(edge: CodeGraphEdge): void {
    const stored = cloneEdge(edge);
    let outList = this.outgoing.get(stored.source);
    if (!outList) {
      outList = [];
      this.outgoing.set(stored.source, outList);
    }
    outList.push(stored);

    let inList = this.incoming.get(stored.target);
    if (!inList) {
      inList = [];
      this.incoming.set(stored.target, inList);
    }
    inList.push(stored);
  }

  public getOutgoingEdges(nodeId: string, kinds?: CodeEdgeKind[]): CodeGraphEdge[] {
    const list = this.outgoing.get(nodeId) ?? [];
    const selected =
      !kinds || kinds.length === 0 ? list : list.filter((edge) => new Set(kinds).has(edge.kind));
    return selected.map(cloneEdge);
  }

  public getIncomingEdges(nodeId: string, kinds?: CodeEdgeKind[]): CodeGraphEdge[] {
    const list = this.incoming.get(nodeId) ?? [];
    const selected =
      !kinds || kinds.length === 0 ? list : list.filter((edge) => new Set(kinds).has(edge.kind));
    return selected.map(cloneEdge);
  }

  /**
   * Breadth-first search for shortest path between two nodes.
   */
  public findShortestPath(
    fromId: string,
    toId: string,
    edgeKinds?: CodeEdgeKind[],
  ): Array<{ node: CodeGraphNode; edge: CodeGraphEdge | null }> | null {
    const fromNode = this.getNode(fromId);
    const toNode = this.getNode(toId);
    if (!fromNode || !toNode) return null;

    if (fromId === toId) {
      return [{ node: fromNode, edge: null }];
    }

    const visited = new Set<string>([fromId]);
    const queue: Array<{
      nodeId: string;
      path: Array<{ node: CodeGraphNode; edge: CodeGraphEdge | null }>;
    }> = [{ nodeId: fromId, path: [{ node: fromNode, edge: null }] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const edges = this.getOutgoingEdges(current.nodeId, edgeKinds);

      for (const edge of edges) {
        const nextId = edge.target;
        if (nextId === toId) {
          const nextNode = this.getNode(nextId);
          if (nextNode) {
            return [...current.path, { node: nextNode, edge }];
          }
        }

        if (!visited.has(nextId)) {
          visited.add(nextId);
          const nextNode = this.getNode(nextId);
          if (nextNode) {
            queue.push({
              nodeId: nextId,
              path: [...current.path, { node: nextNode, edge }],
            });
          }
        }
      }
    }

    return null;
  }

  /**
   * Calculates the blast/impact radius of altering a node up to maxDepth.
   * Uses shortest incoming distance rather than first DFS visitation, so a shared
   * dependent reached through a long path can still be re-expanded through a shorter one.
   */
  public getImpactRadius(
    nodeId: string,
    maxDepth: number = 3,
  ): { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] } {
    const focalNode = this.getNode(nodeId);
    if (!focalNode) return { nodes: [], edges: [] };

    const impactedNodes = new Map<string, CodeGraphNode>([[nodeId, focalNode]]);
    const impactedEdges = new Map<string, CodeGraphEdge>();
    const bestDepth = new Map<string, number>([[nodeId, 0]]);
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      for (const edge of this.getIncomingEdges(id)) {
        const edgeKey = `${edge.source}->${edge.target}:${edge.kind}:${edge.line ?? ""}`;
        impactedEdges.set(edgeKey, edge);

        const sourceNode = this.getNode(edge.source);
        if (!sourceNode) continue;
        impactedNodes.set(sourceNode.id, sourceNode);

        const nextDepth = depth + 1;
        const previousDepth = bestDepth.get(sourceNode.id);
        if (previousDepth === undefined || nextDepth < previousDepth) {
          bestDepth.set(sourceNode.id, nextDepth);
          queue.push({ id: sourceNode.id, depth: nextDepth });
        }
      }
    }

    const orderedNodes = [...impactedNodes.values()].sort((a, b) => {
      const depthA = bestDepth.get(a.id) ?? Number.POSITIVE_INFINITY;
      const depthB = bestDepth.get(b.id) ?? Number.POSITIVE_INFINITY;
      return depthA - depthB || a.id.localeCompare(b.id);
    });
    const orderedEdges = [...impactedEdges.values()].sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.kind.localeCompare(b.kind) ||
        (a.line ?? 0) - (b.line ?? 0),
    );

    return { nodes: orderedNodes, edges: orderedEdges };
  }

  /**
   * Discovers callers of a function or class.
   */
  public getCallers(nodeId: string, maxDepth: number = 1): CodeGraphNode[] {
    const callers = new Map<string, CodeGraphNode>();
    const visited = new Set<string>([nodeId]);

    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const incoming = this.getIncomingEdges(id, ["calls", "references", "imports"]);
      for (const edge of incoming) {
        const caller = this.getNode(edge.source);
        if (caller && !visited.has(caller.id)) {
          visited.add(caller.id);
          callers.set(caller.id, caller);
          queue.push({ id: caller.id, depth: depth + 1 });
        }
      }
    }

    return Array.from(callers.values());
  }

  /**
   * Discovers callees (outgoing calls/imports) from a node.
   */
  public getCallees(nodeId: string, maxDepth: number = 1): CodeGraphNode[] {
    const callees = new Map<string, CodeGraphNode>();
    const visited = new Set<string>([nodeId]);

    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const outgoing = this.getOutgoingEdges(id, ["calls", "references", "imports"]);
      for (const edge of outgoing) {
        const callee = this.getNode(edge.target);
        if (callee && !visited.has(callee.id)) {
          visited.add(callee.id);
          callees.set(callee.id, callee);
          queue.push({ id: callee.id, depth: depth + 1 });
        }
      }
    }

    return Array.from(callees.values());
  }

  /**
   * Queries nodes by name, symbol, or filepath match.
   */
  public queryNodes(term: string): CodeGraphNode[] {
    const q = term.toLowerCase().trim();
    if (!q) return [];

    return Array.from(this.nodes.values())
      .filter((node) => {
        return (
          node.name.toLowerCase().includes(q) ||
          node.filePath.toLowerCase().includes(q) ||
          (node.exports && node.exports.some((entry) => entry.toLowerCase().includes(q)))
        );
      })
      .map(cloneNode);
  }

  /**
   * Explains a concept or symbol with its full relational context.
   */
  public explainConcept(concept: string): ConceptExplanation {
    const matches = this.queryNodes(concept);
    const focal = matches[0] ?? null;
    if (!focal) {
      return { focal: null, callers: [], callees: [], impactRadius: [], connectedFiles: [] };
    }

    const callers = this.getCallers(focal.id, 2);
    const callees = this.getCallees(focal.id, 2);
    const impact = this.getImpactRadius(focal.id, 2);

    const fileSet = new Set<string>([focal.filePath]);
    for (const c of callers) fileSet.add(c.filePath);
    for (const c of callees) fileSet.add(c.filePath);
    for (const c of impact.nodes) fileSet.add(c.filePath);

    return {
      focal,
      callers,
      callees,
      impactRadius: impact.nodes,
      connectedFiles: Array.from(fileSet),
    };
  }

  /**
   * Returns hub nodes whose total degree (incoming + outgoing edges) >= minDegree,
   * sorted by degree descending.
   */
  public getHubNodes(minDegree = 4): Array<{ node: CodeGraphNode; degree: number }> {
    const results: Array<{ node: CodeGraphNode; degree: number }> = [];
    for (const node of this.nodes.values()) {
      const inDegree = this.incoming.get(node.id)?.length ?? 0;
      const outDegree = this.outgoing.get(node.id)?.length ?? 0;
      const totalDegree = inDegree + outDegree;
      if (totalDegree >= minDegree) {
        results.push({ node: cloneNode(node), degree: totalDegree });
      }
    }
    return results.sort((a, b) => b.degree - a.degree);
  }

  /**
   * Returns bridge nodes (articulation points) whose removal disconnects graph components.
   * Uses Tarjan's DFS articulation point algorithm on the underlying undirected graph.
   */
  public getBridgeNodes(): CodeGraphNode[] {
    const adj = new Map<string, Set<string>>();
    for (const node of this.nodes.values()) {
      adj.set(node.id, new Set());
    }
    for (const edgeList of this.outgoing.values()) {
      for (const edge of edgeList) {
        if (adj.has(edge.source) && adj.has(edge.target)) {
          adj.get(edge.source)!.add(edge.target);
          adj.get(edge.target)!.add(edge.source);
        }
      }
    }

    const visited = new Set<string>();
    const discoveryTime = new Map<string, number>();
    const low = new Map<string, number>();
    const parent = new Map<string, string | null>();
    const articulationPoints = new Set<string>();
    let time = 0;

    const dfs = (u: string) => {
      visited.add(u);
      time++;
      discoveryTime.set(u, time);
      low.set(u, time);
      let children = 0;

      const neighbors = adj.get(u) ?? new Set();
      for (const v of neighbors) {
        if (!visited.has(v)) {
          children++;
          parent.set(v, u);
          dfs(v);

          low.set(u, Math.min(low.get(u)!, low.get(v)!));

          if (parent.get(u) === null && children > 1) {
            articulationPoints.add(u);
          }
          if (parent.get(u) !== null && low.get(v)! >= discoveryTime.get(u)!) {
            articulationPoints.add(u);
          }
        } else if (v !== parent.get(u)) {
          low.set(u, Math.min(low.get(u)!, discoveryTime.get(v)!));
        }
      }
    };

    for (const node of this.nodes.values()) {
      if (!visited.has(node.id)) {
        parent.set(node.id, null);
        dfs(node.id);
      }
    }

    const result: CodeGraphNode[] = [];
    for (const id of articulationPoints) {
      const node = this.getNode(id);
      if (node) result.push(node);
    }
    return result;
  }

  /**
   * Explores the neighborhood of matching nodes up to radius, returning a bounded subgraph.
   */
  public explore(query: string, radius = 1): CodeGraphSubgraph {
    const matching = this.queryNodes(query);
    if (matching.length === 0) {
      return { nodes: [], edges: [], roots: [] };
    }

    const subNodes = new Map<string, CodeGraphNode>();
    const subEdges = new Map<string, CodeGraphEdge>();
    const roots: string[] = [];

    for (const root of matching.slice(0, 5)) {
      roots.push(root.id);
      subNodes.set(root.id, root);

      const queue: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];
      const visited = new Set<string>([root.id]);

      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (depth >= radius) continue;

        for (const edge of this.getOutgoingEdges(id)) {
          const edgeKey = `${edge.source}->${edge.target}:${edge.kind}`;
          subEdges.set(edgeKey, edge);
          const targetNode = this.getNode(edge.target);
          if (targetNode) {
            subNodes.set(targetNode.id, targetNode);
            if (!visited.has(targetNode.id)) {
              visited.add(targetNode.id);
              queue.push({ id: targetNode.id, depth: depth + 1 });
            }
          }
        }

        for (const edge of this.getIncomingEdges(id)) {
          const edgeKey = `${edge.source}->${edge.target}:${edge.kind}`;
          subEdges.set(edgeKey, edge);
          const sourceNode = this.getNode(edge.source);
          if (sourceNode) {
            subNodes.set(sourceNode.id, sourceNode);
            if (!visited.has(sourceNode.id)) {
              visited.add(sourceNode.id);
              queue.push({ id: sourceNode.id, depth: depth + 1 });
            }
          }
        }
      }
    }

    return {
      nodes: Array.from(subNodes.values(), cloneNode),
      edges: Array.from(subEdges.values(), cloneEdge),
      roots: [...roots],
    };
  }

  /**
   * Factory constructing a CodeGraph from parsed FileSummary records.
   */
  public static fromFileSummaries(summaries: FileSummary[]): CodeGraph {
    const graph = new CodeGraph();

    for (const fs of summaries) {
      graph.addNode({
        id: fs.filePath,
        name: fs.filePath.split("/").pop() || fs.filePath,
        filePath: fs.filePath,
        kind: "file",
        loc: fs.linesOfCode,
        exports: fs.exports,
        imports: fs.imports,
      });

      for (const cls of fs.classes) {
        const id = `${fs.filePath}#${cls}`;
        graph.addNode({
          id,
          name: cls,
          filePath: fs.filePath,
          kind: "class",
        });
        graph.addEdge({
          source: fs.filePath,
          target: id,
          kind: "contains",
        });
      }

      for (const iface of fs.interfaces) {
        const id = `${fs.filePath}#${iface}`;
        graph.addNode({
          id,
          name: iface,
          filePath: fs.filePath,
          kind: "interface",
        });
        graph.addEdge({
          source: fs.filePath,
          target: id,
          kind: "contains",
        });
      }

      for (const fn of fs.functions) {
        const id = `${fs.filePath}#${fn}`;
        graph.addNode({
          id,
          name: fn,
          filePath: fs.filePath,
          kind: "function",
        });
        graph.addEdge({
          source: fs.filePath,
          target: id,
          kind: "contains",
        });
      }
    }

    for (const fs of summaries) {
      for (const imp of fs.imports) {
        const target = summaries.find((other) => {
          if (other.filePath === fs.filePath) return false;
          const otherBase = other.filePath.replace(/\.[^/.]+$/, "");
          return imp.endsWith(otherBase) || otherBase.endsWith(imp) || imp.includes(otherBase);
        });

        if (target) {
          graph.addEdge({
            source: fs.filePath,
            target: target.filePath,
            kind: "imports",
          });
        }
      }
    }

    return graph;
  }
}
