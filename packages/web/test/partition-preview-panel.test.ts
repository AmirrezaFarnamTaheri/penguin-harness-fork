import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PartitionResult } from "@prismshadow/penguin-core";
import { QueryPartitioner } from "../../core/src/browser";
import { PartitionPreviewPanel } from "../src/features/agent/partition-preview-panel";

function render(result: PartitionResult) {
  return renderToStaticMarkup(createElement(PartitionPreviewPanel, { result }));
}

describe("PartitionPreviewPanel", () => {
  it("renders real partitioner output with original query, IDs, roles and priorities", () => {
    const result = new QueryPartitioner().partitionQuery("Implement login; Write unit tests");
    const html = render(result);
    expect(html).toContain("Decomposition preview");
    expect(html).toContain(result.originalQuery);
    expect(result.subQueries).toHaveLength(2);
    for (const part of result.subQueries) {
      expect(html).toContain(part.id);
      expect(html).toContain(part.query);
      expect(html).toContain(part.targetRole);
      expect(html).toContain(`Priority: ${part.priority}`);
    }
    expect(html.indexOf("sq_1")).toBeLessThan(html.indexOf("sq_2"));
    expect(html).not.toContain("<button");
  });

  it("shows an explicit empty state without a list", () => {
    const html = render(new QueryPartitioner().partitionQuery("   "));
    expect(html).toContain("No sub-queries to preview.");
    expect(html).not.toContain("<ol");
  });

  it("preserves supplied order and custom role strings without mutating input", () => {
    const result: PartitionResult = {
      originalQuery: "Review deployment",
      subQueries: [
        { id: "first", query: "Check rollout", targetRole: "release_engineer", priority: 9 },
        { id: "second", query: "Check rollback", targetRole: "ops_specialist", priority: 2 },
      ],
    };
    const before = JSON.stringify(result);
    const html = render(result);
    expect(html).toContain("release_engineer");
    expect(html).toContain("ops_specialist");
    expect(html).toContain("Priority: 9");
    expect(html.indexOf("Check rollout")).toBeLessThan(html.indexOf("Check rollback"));
    expect(JSON.stringify(result)).toBe(before);
  });

  it("renders query and role markup as text, not executable HTML", () => {
    const html = render({
      originalQuery: "<script>alert(1)</script>",
      subQueries: [{ id: "<id>", query: "<img src=x>", targetRole: "<custom>", priority: 1 }],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("&lt;custom&gt;");
    expect(html).toContain("&lt;id&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
});
