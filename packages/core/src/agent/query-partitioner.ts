/**
 * Query Partitioner & Multi-Agent Auto-Router.
 *
 * Decomposes complex user queries into sub-queries while preserving shared constraints,
 * short requested tasks, continuations, and original ordering.
 */

export interface SubQuery {
  id: string;
  query: string;
  targetRole: string;
  priority: number;
}

export interface PartitionResult {
  originalQuery: string;
  subQueries: SubQuery[];
}

export interface SpecialistCapability {
  role: string;
  keywords: string[];
  description: string;
}

export const DEFAULT_SPECIALISTS: SpecialistCapability[] = [
  {
    role: "software_architect",
    keywords: ["architecture", "design", "structure", "system", "c4", "boundary", "scale", "modular"],
    description: "System architecture and component boundaries",
  },
  {
    role: "security_auditor",
    keywords: ["security", "auth", "oauth", "token", "cve", "vulnerability", "injection", "sanitize", "leak"],
    description: "Security review, vulnerability analysis, and hardening",
  },
  {
    role: "qa_test_engineer",
    keywords: ["test", "vitest", "unit", "e2e", "coverage", "mock", "assert", "regression", "qa"],
    description: "Automated test development and verification",
  },
  {
    role: "fullstack_engineer",
    keywords: ["implement", "code", "feature", "build", "api", "route", "component", "fix", "refactor"],
    description: "Feature development and code modifications",
  },
  {
    role: "technical_writer",
    keywords: ["docs", "document", "readme", "guide", "tutorial", "explain", "markdown", "changelog"],
    description: "Documentation and technical content authoring",
  },
];

export class QueryPartitioner {
  private specialists: SpecialistCapability[];

  constructor(specialists: SpecialistCapability[] = DEFAULT_SPECIALISTS) {
    this.specialists = [...specialists];
  }

  public classifyIntent(text: string): string {
    const lower = text.toLowerCase();
    let bestRole = "fullstack_engineer";
    let bestScore = 0;

    for (const spec of this.specialists) {
      let score = 0;
      for (const kw of spec.keywords) {
        if (lower.includes(kw)) score += kw.length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestRole = spec.role;
      }
    }

    return bestRole;
  }

  private partitionBullets(trimmed: string): string[] | null {
    const lines = trimmed.split("\n");
    const bulletPattern = /^\s*([*-]|\d+[.)])\s+(.*)$/;
    const bulletCount = lines.filter((line) => bulletPattern.test(line)).length;
    if (bulletCount < 2) return null;

    const shared: string[] = [];
    const items: string[][] = [];
    let current: string[] | null = null;

    for (const line of lines) {
      const match = bulletPattern.exec(line);
      if (match) {
        current = [match[2]!.trim()];
        items.push(current);
        continue;
      }
      const cleaned = line.trim();
      if (!cleaned) continue;
      if (current) current.push(cleaned);
      else shared.push(cleaned);
    }

    const sharedPrefix = shared.join("\n").trim();
    return items
      .map((parts) => parts.join("\n").trim())
      .filter(Boolean)
      .map((item) => (sharedPrefix ? `${sharedPrefix}\n\n${item}` : item));
  }

  public partitionQuery(query: string): PartitionResult {
    const trimmed = query.trim();
    if (!trimmed) return { originalQuery: query, subQueries: [] };

    let segments = this.partitionBullets(trimmed) ?? [];

    if (segments.length === 0) {
      // Keep every non-empty clause, including short actions such as "Test" or "Ship".
      segments = trimmed
        .split(/;|\b(?:and also|as well as|then|next)\b/i)
        .map((clause) => clause.trim())
        .filter(Boolean);
    }

    if (segments.length === 0) segments = [trimmed];

    const subQueries: SubQuery[] = segments.map((segment, index) => ({
      id: `sq_${index + 1}`,
      query: segment,
      targetRole: this.classifyIntent(segment),
      // Preserve source order; callers may parallelize equal-priority work explicitly later.
      priority: index + 1,
    }));

    return { originalQuery: query, subQueries };
  }

  public aggregateResponses(
    originalQuery: string,
    results: Array<{ subQueryId: string; role: string; response: string }>,
  ): string {
    const sections = results.map((result, index) => `### Part ${index + 1}: ${result.role}\n${result.response}`);
    return `# Synthesis: ${originalQuery}\n\n${sections.join("\n\n")}`;
  }
}
