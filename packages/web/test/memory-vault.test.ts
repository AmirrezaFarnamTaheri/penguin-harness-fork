import { describe, expect, it } from "vitest";
import {
  parseMemoryLinks,
  memoryLinkEdges,
  filterMemoryTopics,
  simulateSemanticRecall,
  validateMemoryFrontmatter,
  formatBytes,
  type MemoryTopicNode,
  type MemoryScope,
} from "../src/features/memory/memory-types";

describe("memory-types and utility functions", () => {
  const sampleTopics: MemoryTopicNode[] = [
    {
      id: "coding-style",
      name: "coding-style.md",
      title: "TypeScript & React Standards",
      scope: "workspace",
      bytes: 2048,
      tokens: 512,
      tags: ["typescript", "react", "frontend"],
      updatedAt: "2026-09-14T10:00:00Z",
      content: `---
title: TypeScript & React Standards
tags: [typescript, react, frontend]
---
# Coding Standards
Follow strict component props and check [state-management](./state-management.md) for hooks.
Also see [api-contract](<api-contract.md>).`,
    },
    {
      id: "state-management",
      name: "state-management.md",
      title: "State Management Architecture",
      scope: "workspace",
      bytes: 1536,
      tokens: 384,
      tags: ["state", "react", "zustand"],
      updatedAt: "2026-09-13T12:00:00Z",
      content: `---
title: State Management Architecture
tags: [state, react, zustand]
---
# State
Use atomic stores. Connects with [api-contract](./api-contract.md).`,
    },
    {
      id: "api-contract",
      name: "api-contract.md",
      title: "Backend API Contracts",
      scope: "workspace",
      bytes: 4096,
      tokens: 1024,
      tags: ["api", "rest", "backend"],
      updatedAt: "2026-09-12T09:00:00Z",
      content: `# API Contracts
REST conventions for server services.`,
    },
    {
      id: "user-profile",
      name: "user-profile.md",
      title: "User Profile & Preferences",
      scope: "user",
      bytes: 1024,
      tokens: 256,
      tags: ["preference", "identity"],
      updatedAt: "2026-09-11T08:00:00Z",
      content: `# User Profile
Persistent developer preferences.`,
    },
  ];

  describe("parseMemoryLinks", () => {
    it("extracts cross-topic link edges from markdown content", () => {
      const links1 = parseMemoryLinks(sampleTopics[0]!.content);
      expect(links1).toEqual(["state-management.md", "api-contract.md"]);

      const links2 = parseMemoryLinks(sampleTopics[1]!.content);
      expect(links2).toEqual(["api-contract.md"]);

      const linksEmpty = parseMemoryLinks("Just text with no markdown links.");
      expect(linksEmpty).toEqual([]);
    });
  });

  describe("memoryLinkEdges", () => {
    it("resolves wiki links without connecting duplicate filenames across scopes", () => {
      const source = {
        ...sampleTopics[0]!,
        id: "a/source",
        scopeKey: "workspace-a",
        content: "[[notes]] [same](./notes.md#section)",
      };
      const target = {
        ...sampleTopics[1]!,
        id: "a/notes",
        scopeKey: "workspace-a",
        name: "notes.md",
        content: "",
      };
      const other = { ...target, id: "b/notes", scopeKey: "workspace-b" };
      expect(
        memoryLinkEdges([source, target, other]).every((edge) => edge.target === "a/notes"),
      ).toBe(true);
      expect(memoryLinkEdges([source, other])).toEqual([]);
      expect(parseMemoryLinks("[[notes]] [[notes|label]]")).toEqual(["notes.md"]);
    });
  });

  describe("filterMemoryTopics", () => {
    it("filters topics by scope", () => {
      const workspaceTopics = filterMemoryTopics(sampleTopics, "", "workspace");
      expect(workspaceTopics).toHaveLength(3);
      expect(workspaceTopics.every((t) => t.scope === "workspace")).toBe(true);

      const userTopics = filterMemoryTopics(sampleTopics, "", "user");
      expect(userTopics).toHaveLength(1);
      expect(userTopics[0]!.id).toBe("user-profile");
    });

    it("filters topics by search query against title, name, and tags", () => {
      const matchTag = filterMemoryTopics(sampleTopics, "typescript", "all");
      expect(matchTag).toHaveLength(1);
      expect(matchTag[0]!.id).toBe("coding-style");

      const matchTitle = filterMemoryTopics(sampleTopics, "Architecture", "all");
      expect(matchTitle).toHaveLength(1);
      expect(matchTitle[0]!.id).toBe("state-management");

      const matchNone = filterMemoryTopics(sampleTopics, "nonexistent-query", "all");
      expect(matchNone).toHaveLength(0);
    });
  });

  describe("simulateSemanticRecall", () => {
    it("ranks and returns topics matching query keywords with relevance score", () => {
      const results = simulateSemanticRecall(
        "Zustand state management store architecture",
        sampleTopics,
        0.2,
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.topic.id).toBe("state-management");
      expect(results[0]!.relevance).toBeGreaterThan(0.2);
      expect(results[0]!.tokenCount).toBe(384);
    });

    it("respects threshold and filters low relevance matches", () => {
      const results = simulateSemanticRecall("completely unrelated query", sampleTopics, 0.8);
      expect(results).toHaveLength(0);
    });
  });

  describe("validateMemoryFrontmatter", () => {
    it("parses YAML frontmatter blocks accurately", () => {
      const parsed = validateMemoryFrontmatter(sampleTopics[0]!.content);
      expect(parsed.valid).toBe(true);
      expect(parsed.metadata?.title).toBe("TypeScript & React Standards");
      expect(parsed.metadata?.tags).toEqual(["typescript", "react", "frontend"]);
    });

    it("handles markdown without frontmatter gracefully", () => {
      const parsed = validateMemoryFrontmatter("# Pure Markdown\nNo frontmatter here.");
      expect(parsed.valid).toBe(true);
      expect(parsed.metadata).toBeUndefined();
    });
  });

  describe("formatBytes", () => {
    it("formats raw byte counts into human-readable strings", () => {
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(2048)).toBe("2.0 KB");
      expect(formatBytes(1048576)).toBe("1.0 MB");
    });
  });
});
