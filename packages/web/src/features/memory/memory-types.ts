export type MemoryScope = "user" | "workspace" | "all";

export interface MemoryTopicNode {
  id: string;
  name: string;
  title: string;
  scope: "user" | "workspace";
  bytes: number;
  tokens: number;
  tags: string[];
  updatedAt: string;
  content: string;
}

export interface MemoryRecallResult {
  topic: MemoryTopicNode;
  relevance: number;
  tokenCount: number;
  snippet: string;
}

export interface MemoryScopeStats {
  userTopicsCount: number;
  workspaceTopicsCount: number;
  totalBytes: number;
  totalTokens: number;
}

const LINK_PATTERN = /\]\(\s*<?(?:\.\/)?([^>)]+)>?\s*(?:"[^"]*"|'[^']*')?\s*\)/g;

/**
 * Extracts relative markdown link filenames from topic content to form graph edges.
 */
export function parseMemoryLinks(content: string): string[] {
  const links: string[] = [];
  const matches = content.matchAll(LINK_PATTERN);
  for (const match of matches) {
    if (match[1]) {
      const target = match[1].trim();
      if (!target.startsWith("http://") && !target.startsWith("https://")) {
        links.push(target);
      }
    }
  }
  return links;
}

/**
 * Filters topic nodes based on search keyword and scope category.
 */
export function filterMemoryTopics(
  topics: MemoryTopicNode[],
  query: string,
  scope: MemoryScope,
): MemoryTopicNode[] {
  const normalizedQuery = query.trim().toLowerCase();

  return topics.filter((topic) => {
    if (scope !== "all" && topic.scope !== scope) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const matchesName = topic.name.toLowerCase().includes(normalizedQuery);
    const matchesTitle = topic.title.toLowerCase().includes(normalizedQuery);
    const matchesTags = topic.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));

    return matchesName || matchesTitle || matchesTags;
  });
}

/**
 * Simulates semantic recall scoring against memory topics based on keyword overlap and semantic tokens.
 */
export function simulateSemanticRecall(
  query: string,
  topics: MemoryTopicNode[],
  threshold = 0.2,
): MemoryRecallResult[] {
  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);

  if (terms.length === 0) {
    return [];
  }

  const results: MemoryRecallResult[] = [];

  for (const topic of topics) {
    const textCorpus =
      `${topic.title} ${topic.name} ${topic.tags.join(" ")} ${topic.content}`.toLowerCase();
    let hits = 0;

    for (const term of terms) {
      if (textCorpus.includes(term)) {
        hits++;
      }
    }

    const relevance = Math.min(1, Number((hits / terms.length).toFixed(2)));

    if (relevance >= threshold) {
      const firstLine =
        topic.content.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("---")) ??
        topic.title;

      results.push({
        topic,
        relevance,
        tokenCount: topic.tokens,
        snippet: firstLine.slice(0, 120),
      });
    }
  }

  return results.sort((a, b) => b.relevance - a.relevance);
}

/**
 * Validates and extracts YAML frontmatter from topic markdown files.
 */
export function validateMemoryFrontmatter(content: string): {
  valid: boolean;
  metadata?: { title?: string; tags?: string[] };
} {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return { valid: true };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { valid: false };
  }

  const frontmatterBody = trimmed.slice(3, endIndex).trim();
  const titleMatch = frontmatterBody.match(/title:\s*(.+)/);
  const tagsMatch = frontmatterBody.match(/tags:\s*\[(.*)\]/);

  const title =
    titleMatch && titleMatch[1] ? titleMatch[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
  const tags =
    tagsMatch && tagsMatch[1]
      ? tagsMatch[1]
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
      : undefined;

  return {
    valid: true,
    metadata: {
      title,
      tags,
    },
  };
}

/**
 * Formats bytes into clean human-readable units.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
