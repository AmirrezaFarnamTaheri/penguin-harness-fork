/**
 * Persistent Knowledge Wiki & Markdown Memory Graph Engine.
 *
 * Provides bidirectional wikilink extraction, frontmatter indexing, CJK/multilingual
 * sliding window search, neighbor graph expansion, path finding, and dead-link linting.
 *
 * Synthesized from llm-wiki-agent and graphify architectures.
 */

export type WikiNodeType = "source" | "entity" | "concept" | "synthesis" | "unknown";
export type WikiEdgeType = "extracted" | "inferred" | "ambiguous";

export interface WikiNode {
  id: string;
  title: string;
  type: WikiNodeType;
  tags: string[];
  aliases: string[];
  rawContent: string;
  filePath?: string;
  metadata: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

export interface WikiEdge {
  id: string;
  from: string;
  to: string;
  type: WikiEdgeType;
  confidence: number;
  label?: string;
}

export interface WikiGraph {
  nodes: WikiNode[];
  edges: WikiEdge[];
  updatedAt: number;
}

export interface WikiLintIssue {
  type: "broken_link" | "orphan_node" | "missing_type";
  nodeId: string;
  target?: string;
  description: string;
}

export interface WikiLintReport {
  brokenLinks: Array<{ fromNodeId: string; target: string; snippet?: string }>;
  orphanedNodes: string[];
  missingTypes: string[];
  issues: WikiLintIssue[];
}

export interface WikiSearchMatch {
  node: WikiNode;
  score: number;
  matchedField: "title" | "alias" | "tag" | "content";
  snippet?: string;
}

export class WikiEngine {
  private nodes = new Map<string, WikiNode>();
  private edges = new Map<string, WikiEdge>();

  public normalizeId(input: string): string {
    return input
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.md$/i, "")
      .toLowerCase();
  }

  public parseFrontmatter(content: string): {
    metadata: Record<string, unknown>;
    body: string;
  } {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("---")) {
      return { metadata: {}, body: content };
    }

    const endIdx = trimmed.indexOf("\n---", 3);
    if (endIdx === -1) {
      return { metadata: {}, body: content };
    }

    const header = trimmed.slice(3, endIdx).trim();
    const body = trimmed.slice(endIdx + 4).trimStart();
    const metadata: Record<string, unknown> = {};

    for (const line of header.split("\n")) {
      const colIdx = line.indexOf(":");
      if (colIdx === -1) continue;
      const key = line.slice(0, colIdx).trim();
      let val = line.slice(colIdx + 1).trim();

      if (val.startsWith("[") && val.endsWith("]")) {
        const inner = val.slice(1, -1);
        metadata[key] = inner
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      } else {
        val = val.replace(/^['"]|['"]$/g, "");
        if (val === "true") metadata[key] = true;
        else if (val === "false") metadata[key] = false;
        else if (!isNaN(Number(val)) && val !== "") metadata[key] = Number(val);
        else metadata[key] = val;
      }
    }

    return { metadata, body };
  }

  public extractWikilinks(content: string): Array<{ target: string; alias?: string }> {
    const links: Array<{ target: string; alias?: string }> = [];
    // Matches [[Target]] or [[Target|Alias]]
    const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const rawTarget = match[1]?.trim();
      if (!rawTarget) continue;
      const rawAlias = match[2]?.trim();
      links.push({
        target: rawTarget,
        alias: rawAlias || undefined,
      });
    }

    return links;
  }

  public addPage(id: string, content: string, filePath?: string): WikiNode {
    const normalizedId = this.normalizeId(id);
    const { metadata, body } = this.parseFrontmatter(content);

    const typeStr = String(metadata.type ?? "unknown").toLowerCase();
    const type: WikiNodeType =
      typeStr === "source" || typeStr === "entity" || typeStr === "concept" || typeStr === "synthesis"
        ? typeStr
        : "unknown";

    const title =
      typeof metadata.title === "string" && metadata.title.trim()
        ? metadata.title.trim()
        : normalizedId.split("/").pop() ?? normalizedId;

    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.map(String)
      : typeof metadata.tags === "string"
        ? [metadata.tags]
        : [];

    const aliases = Array.isArray(metadata.aliases)
      ? metadata.aliases.map(String)
      : typeof metadata.aliases === "string"
        ? [metadata.aliases]
        : [];

    const now = Date.now();
    const existing = this.nodes.get(normalizedId);

    const node: WikiNode = {
      id: normalizedId,
      title,
      type,
      tags,
      aliases,
      rawContent: content,
      filePath,
      metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.nodes.set(normalizedId, node);
    this.rebuildExtractedEdgesForNode(normalizedId, body);

    return { ...node };
  }

  private rebuildExtractedEdgesForNode(fromId: string, bodyContent: string): void {
    // Remove existing extracted edges originating from fromId
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.from === fromId && edge.type === "extracted") {
        this.edges.delete(edgeId);
      }
    }

    const links = this.extractWikilinks(bodyContent);
    for (const link of links) {
      const toId = this.normalizeId(link.target);
      const edgeId = `${fromId}->${toId}:extracted`;
      this.edges.set(edgeId, {
        id: edgeId,
        from: fromId,
        to: toId,
        type: "extracted",
        confidence: 1.0,
        label: link.alias,
      });
    }
  }

  public removePage(id: string): boolean {
    const normalizedId = this.normalizeId(id);
    const deleted = this.nodes.delete(normalizedId);
    if (!deleted) return false;

    // Remove connected edges
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.from === normalizedId || edge.to === normalizedId) {
        this.edges.delete(edgeId);
      }
    }

    return true;
  }

  public getPage(id: string): WikiNode | undefined {
    const node = this.nodes.get(this.normalizeId(id));
    return node ? { ...node } : undefined;
  }

  public listPages(): WikiNode[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n }));
  }

  public addInferredEdge(fromId: string, toId: string, confidence = 0.8, label?: string): WikiEdge {
    const from = this.normalizeId(fromId);
    const to = this.normalizeId(toId);
    const edgeId = `${from}->${to}:inferred`;
    const edge: WikiEdge = {
      id: edgeId,
      from,
      to,
      type: confidence >= 0.7 ? "inferred" : "ambiguous",
      confidence,
      label,
    };
    this.edges.set(edgeId, edge);
    return { ...edge };
  }

  public buildGraph(): WikiGraph {
    return {
      nodes: Array.from(this.nodes.values()).map((n) => ({ ...n })),
      edges: Array.from(this.edges.values()).map((e) => ({ ...e })),
      updatedAt: Date.now(),
    };
  }

  public search(query: string, options?: { maxResults?: number; minScore?: number }): WikiSearchMatch[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const maxResults = options?.maxResults ?? 10;
    const minScore = options?.minScore ?? 10;
    const results: WikiSearchMatch[] = [];

    // CJK Bigram detection
    const hasCjk = /[\u4e00-\u9fff]/.test(q);
    const cjkBigrams: string[] = [];
    if (hasCjk) {
      for (let i = 0; i < q.length - 1; i++) {
        const sub = q.slice(i, i + 2);
        if (/[\u4e00-\u9fff]/.test(sub)) {
          cjkBigrams.push(sub);
        }
      }
    }

    for (const node of this.nodes.values()) {
      let score = 0;
      let matchedField: "title" | "alias" | "tag" | "content" = "content";
      let snippet: string | undefined;

      const titleLower = node.title.toLowerCase();
      const idLower = node.id.toLowerCase();

      // 1. Exact or prefix match on title or ID
      if (titleLower === q || idLower === q) {
        score = 100;
        matchedField = "title";
      } else if (titleLower.includes(q) || idLower.includes(q)) {
        score = 75;
        matchedField = "title";
      }

      // 2. Alias match
      if (score < 80) {
        for (const alias of node.aliases) {
          const aLower = alias.toLowerCase();
          if (aLower === q) {
            score = 80;
            matchedField = "alias";
            break;
          } else if (aLower.includes(q)) {
            score = Math.max(score, 65);
            matchedField = "alias";
          }
        }
      }

      // 3. Tag match
      if (score < 70) {
        for (const tag of node.tags) {
          const tLower = tag.toLowerCase();
          if (tLower === q || tLower.includes(q)) {
            score = Math.max(score, 60);
            matchedField = "tag";
            break;
          }
        }
      }

      // 4. CJK bigram match
      if (hasCjk && cjkBigrams.length > 0 && score < 50) {
        let bigramMatches = 0;
        for (const bg of cjkBigrams) {
          if (titleLower.includes(bg) || node.rawContent.toLowerCase().includes(bg)) {
            bigramMatches++;
          }
        }
        if (bigramMatches > 0) {
          const bigramRatio = bigramMatches / cjkBigrams.length;
          score = Math.max(score, Math.round(bigramRatio * 50));
        }
      }

      // 5. Content match
      if (score < 40) {
        const contentLower = node.rawContent.toLowerCase();
        const foundIdx = contentLower.indexOf(q);
        if (foundIdx !== -1) {
          score = Math.max(score, 30);
          matchedField = "content";
          const start = Math.max(0, foundIdx - 40);
          const end = Math.min(node.rawContent.length, foundIdx + q.length + 40);
          snippet = "..." + node.rawContent.slice(start, end).replace(/\n/g, " ") + "...";
        }
      }

      if (score >= minScore) {
        results.push({
          node: { ...node },
          score,
          matchedField,
          snippet,
        });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  public getNeighbors(
    nodeId: string,
    options?: { maxHops?: number; minConfidence?: number; bidirectional?: boolean }
  ): WikiNode[] {
    const rootId = this.normalizeId(nodeId);
    if (!this.nodes.has(rootId)) return [];

    const maxHops = options?.maxHops ?? 1;
    const minConfidence = options?.minConfidence ?? 0.0;
    const bidirectional = options?.bidirectional ?? true;

    const visited = new Set<string>([rootId]);
    let currentLevel = new Set<string>([rootId]);

    for (let hop = 0; hop < maxHops; hop++) {
      const nextLevel = new Set<string>();

      for (const curr of currentLevel) {
        for (const edge of this.edges.values()) {
          if (edge.confidence < minConfidence) continue;

          if (edge.from === curr && !visited.has(edge.to)) {
            visited.add(edge.to);
            nextLevel.add(edge.to);
          } else if (bidirectional && edge.to === curr && !visited.has(edge.from)) {
            visited.add(edge.from);
            nextLevel.add(edge.from);
          }
        }
      }

      currentLevel = nextLevel;
      if (currentLevel.size === 0) break;
    }

    visited.delete(rootId);
    const neighbors: WikiNode[] = [];
    for (const id of visited) {
      const n = this.nodes.get(id);
      if (n) neighbors.push({ ...n });
    }

    return neighbors;
  }

  public findPath(startNodeId: string, endNodeId: string): string[] | null {
    const start = this.normalizeId(startNodeId);
    const end = this.normalizeId(endNodeId);

    if (!this.nodes.has(start) || !this.nodes.has(end)) return null;
    if (start === end) return [start];

    const queue: Array<{ id: string; path: string[] }> = [{ id: start, path: [start] }];
    const visited = new Set<string>([start]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;

      for (const edge of this.edges.values()) {
        if (edge.from === current.id && !visited.has(edge.to)) {
          if (edge.to === end) {
            return [...current.path, end];
          }
          visited.add(edge.to);
          queue.push({ id: edge.to, path: [...current.path, edge.to] });
        }
      }
    }

    return null;
  }

  public lint(): WikiLintReport {
    const brokenLinks: Array<{ fromNodeId: string; target: string; snippet?: string }> = [];
    const missingTypes: string[] = [];
    const nodeDegree = new Map<string, number>();
    const issues: WikiLintIssue[] = [];

    for (const id of this.nodes.keys()) {
      nodeDegree.set(id, 0);
    }

    // Check broken links from edges
    for (const edge of this.edges.values()) {
      if (edge.type === "extracted") {
        const toExists = this.nodes.has(edge.to);
        if (!toExists) {
          brokenLinks.push({ fromNodeId: edge.from, target: edge.to });
          issues.push({
            type: "broken_link",
            nodeId: edge.from,
            target: edge.to,
            description: `Link [[${edge.to}]] points to non-existent document`,
          });
        } else {
          nodeDegree.set(edge.from, (nodeDegree.get(edge.from) ?? 0) + 1);
          nodeDegree.set(edge.to, (nodeDegree.get(edge.to) ?? 0) + 1);
        }
      }
    }

    // Check missing types
    for (const [id, node] of this.nodes.entries()) {
      if (node.type === "unknown") {
        missingTypes.push(id);
        issues.push({
          type: "missing_type",
          nodeId: id,
          description: `Node frontmatter missing recognized type ('source' | 'entity' | 'concept' | 'synthesis')`,
        });
      }
    }

    // Check orphans
    const orphanedNodes: string[] = [];
    for (const [id, degree] of nodeDegree.entries()) {
      if (degree === 0) {
        orphanedNodes.push(id);
        issues.push({
          type: "orphan_node",
          nodeId: id,
          description: `Node has 0 incoming or outgoing wikilinks`,
        });
      }
    }

    return { brokenLinks, orphanedNodes, missingTypes, issues };
  }

  public exportGraphJson(): string {
    return JSON.stringify(this.buildGraph(), null, 2);
  }

  public importGraphJson(jsonStr: string): void {
    const parsed = JSON.parse(jsonStr) as WikiGraph;
    if (Array.isArray(parsed.nodes)) {
      for (const n of parsed.nodes) {
        this.nodes.set(n.id, { ...n });
      }
    }
    if (Array.isArray(parsed.edges)) {
      for (const e of parsed.edges) {
        this.edges.set(e.id, { ...e });
      }
    }
  }
}
