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
  | "contains"
  | "calls"
  | "imports"
  | "exports"
  | "extends"
  | "implements"
  | "references";

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

export class CodeGraph {
  private readonly nodes = new Map<string, CodeGraphNode>();
  private readonly outgoing = new Map<string, CodeGraphEdge[]>();
  private readonly incoming = new Map<string, CodeGraphEdge[]>();

  public addNode(node: CodeGraphNode): void {
    this.nodes.set(node.id, node);
  }

  public getNode(id: string): CodeGraphNode | undefined {
    return this.nodes.get(id);
  }

  public getAllNodes(): CodeGraphNode[] {
    return Array.from(this.nodes.values());
  }

  public addEdge(edge: CodeGraphEdge): void {
    let outList = this.outgoing.get(edge.source);
    if (!outList) {
      outList = [];
      this.outgoing.set(edge.source, outList);
    }
    outList.push(edge);

    let inList = this.incoming.get(edge.target);
    if (!inList) {
      inList = [];
      this.incoming.set(edge.target, inList);
    }
    inList.push(edge);
  }

  public getOutgoingEdges(nodeId: string, kinds?: CodeEdgeKind[]): CodeGraphEdge[] {
    const list = this.outgoing.get(nodeId) ?? [];
    if (!kinds || kinds.length === 0) return list;
    const filterSet = new Set(kinds);
    return list.filter((e) => filterSet.has(e.kind));
  }

  public getIncomingEdges(nodeId: string, kinds?: CodeEdgeKind[]): CodeGraphEdge[] {
    const list = this.incoming.get(nodeId) ?? [];
    if (!kinds || kinds.length === 0) return list;
    const filterSet = new Set(kinds);
    return list.filter((e) => filterSet.has(e.kind));
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
   */
  public getImpactRadius(
    nodeId: string,
    maxDepth: number = 3,
  ): { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] } {
    const focalNode = this.getNode(nodeId);
    if (!focalNode) return { nodes: [], edges: [] };

    const impactedNodes = new Map<string, CodeGraphNode>([[nodeId, focalNode]]);
    const impactedEdges: CodeGraphEdge[] = [];
    const visited = new Set<string>();

    const traverseImpact = (id: string, depth: number) => {
      if (visited.has(id) || depth >= maxDepth) return;
      visited.add(id);

      // Incoming dependencies (callers, importers, references)
      const incoming = this.getIncomingEdges(id);
      for (const edge of incoming) {
        impactedEdges.push(edge);
        const sourceNode = this.getNode(edge.source);
        if (sourceNode) {
          impactedNodes.set(sourceNode.id, sourceNode);
          traverseImpact(sourceNode.id, depth + 1);
        }
      }
    };

    traverseImpact(nodeId, 0);

    return {
      nodes: Array.from(impactedNodes.values()),
      edges: impactedEdges,
    };
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

    return Array.from(this.nodes.values()).filter((n) => {
      return (
        n.name.toLowerCase().includes(q) ||
        n.filePath.toLowerCase().includes(q) ||
        (n.exports && n.exports.some((e) => e.toLowerCase().includes(q)))
      );
    });
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
        results.push({ node, degree: totalDegree });
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

          // Root of DFS tree is an articulation point if it has 2 or more children
          if (parent.get(u) === null && children > 1) {
            articulationPoints.add(u);
          }
          // Non-root node u is an articulation point if low[v] >= discoveryTime[u]
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
      const n = this.getNode(id);
      if (n) result.push(n);
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

        // Outgoing
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

        // Incoming
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
      nodes: Array.from(subNodes.values()),
      edges: Array.from(subEdges.values()),
      roots,
    };
  }

  /**
   * Factory constructing a CodeGraph from parsed FileSummary records.
   */
  public static fromFileSummaries(summaries: FileSummary[]): CodeGraph {
    const graph = new CodeGraph();

    // 1. Register file nodes
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

      // Register symbol nodes
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

    // 2. Resolve import edges
    for (const fs of summaries) {
      for (const imp of fs.imports) {
        // Match import to candidate files
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
