/**
 * Query Partitioner & Multi-Agent Auto-Router.
 *
 * Decomposes complex user queries into independent sub-queries, routes them
 * to the most appropriate specialist persona, and aggregates parallel subagent findings.
 *
 * Synthesized from Qwen-Agent group_chat_auto_router and parallel_doc_qa architectures.
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
        if (lower.includes(kw)) {
          score += kw.length;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestRole = spec.role;
      }
    }

    return bestRole;
  }

  public partitionQuery(query: string): PartitionResult {
    const trimmed = query.trim();
    if (!trimmed) {
      return { originalQuery: query, subQueries: [] };
    }

    // Split on conjuncts or numbered/bulleted items
    const segments: string[] = [];
    const bulletLines = trimmed.split("\n").filter((l) => /^\s*([*-]|\d+[.)])\s+/.test(l));

    if (bulletLines.length >= 2) {
      for (const line of bulletLines) {
        const clean = line.replace(/^\s*([*-]|\d+[.)])\s+/, "").trim();
        if (clean.length > 5) {
          segments.push(clean);
        }
      }
    } else {
      // Split on clauses like "and also", "as well as", "then", or semicolons
      const clauses = trimmed.split(/;|\b(?:and also|as well as|then|next)\b/i);
      for (const c of clauses) {
        const clean = c.trim();
        if (clean.length > 8) {
          segments.push(clean);
        }
      }
    }

    // If no distinct segments found, treat as single query
    if (segments.length === 0) {
      segments.push(trimmed);
    }

    const subQueries: SubQuery[] = segments.map((seg, idx) => ({
      id: `sq_${idx + 1}`,
      query: seg,
      targetRole: this.classifyIntent(seg),
      priority: idx === 0 ? 1 : 2,
    }));

    return {
      originalQuery: query,
      subQueries,
    };
  }

  public aggregateResponses(
    originalQuery: string,
    results: Array<{ subQueryId: string; role: string; response: string }>
  ): string {
    const sections = results.map((r, idx) => {
      return `### Part ${idx + 1}: ${r.role}\n${r.response}`;
    });

    return `# Synthesis: ${originalQuery}\n\n${sections.join("\n\n")}`;
  }
}
