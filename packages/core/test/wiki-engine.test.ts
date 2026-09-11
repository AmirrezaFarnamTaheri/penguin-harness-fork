import { describe, expect, it } from "vitest";
import { WikiEngine } from "../src/state/wiki-engine.js";

describe("WikiEngine", () => {
  it("parses frontmatter and extracts bidirectional wikilinks", () => {
    const wiki = new WikiEngine();
    const markdown = `---
type: concept
title: Memory Anchors
tags: [memory, persistence]
aliases: [Context Compaction, Memory Pruning]
---

# Memory Anchors

Memory anchors are created during compaction to retain essential facts.
Links to [[concepts/turn-ledger|Turn Ledger]] and [[concepts/mailbox]].
`;

    const node = wiki.addPage("concepts/memory-anchors.md", markdown);
    expect(node.id).toBe("concepts/memory-anchors");
    expect(node.type).toBe("concept");
    expect(node.title).toBe("Memory Anchors");
    expect(node.tags).toContain("memory");
    expect(node.aliases).toContain("Context Compaction");

    const links = wiki.extractWikilinks(markdown);
    expect(links.length).toBe(2);
    expect(links[0]?.target).toBe("concepts/turn-ledger");
    expect(links[0]?.alias).toBe("Turn Ledger");
    expect(links[1]?.target).toBe("concepts/mailbox");
  });

  it("performs search matching on titles, aliases, tags, content, and CJK bigrams", () => {
    const wiki = new WikiEngine();
    wiki.addPage(
      "agent/architecture.md",
      `---
type: synthesis
title: Agent System Architecture
tags: [core, orchestrator]
---
Detailed overview of system components.`
    );

    wiki.addPage(
      "cjk/memory.md",
      `---
type: concept
title: 记忆管理系统
tags: [memory]
---
智能体上下文记忆压缩与检索。`
    );

    // Title match
    const r1 = wiki.search("architecture");
    expect(r1.length).toBeGreaterThan(0);
    expect(r1[0]?.node.id).toBe("agent/architecture");
    expect(r1[0]?.matchedField).toBe("title");

    // Tag match
    const r2 = wiki.search("orchestrator");
    expect(r2.length).toBeGreaterThan(0);
    expect(r2[0]?.node.id).toBe("agent/architecture");

    // CJK bigram match
    const r3 = wiki.search("记忆");
    expect(r3.length).toBeGreaterThan(0);
    expect(r3[0]?.node.id).toBe("cjk/memory");
  });

  it("builds graph, explores neighbors, and finds paths", () => {
    const wiki = new WikiEngine();
    wiki.addPage("a.md", `---
type: source
title: Alpha
---
Links to [[b]].`);

    wiki.addPage("b.md", `---
type: concept
title: Beta
---
Links to [[c]].`);

    wiki.addPage("c.md", `---
type: synthesis
title: Gamma
---
Final node.`);

    const neighbors = wiki.getNeighbors("a", { maxHops: 2 });
    const neighborIds = neighbors.map((n) => n.id);
    expect(neighborIds).toContain("b");
    expect(neighborIds).toContain("c");

    const path = wiki.findPath("a", "c");
    expect(path).toEqual(["a", "b", "c"]);
  });

  it("detects broken links and orphaned nodes with linting", () => {
    const wiki = new WikiEngine();
    wiki.addPage("page1.md", `---
type: concept
title: Page One
---
Links to [[non-existent-page]].`);

    wiki.addPage("isolated.md", `---
type: entity
title: Isolated Island
---
No links in or out.`);

    const report = wiki.lint();
    expect(report.brokenLinks.length).toBe(1);
    expect(report.brokenLinks[0]?.fromNodeId).toBe("page1");
    expect(report.brokenLinks[0]?.target).toBe("non-existent-page");
    expect(report.orphanedNodes).toContain("isolated");
  });
});
