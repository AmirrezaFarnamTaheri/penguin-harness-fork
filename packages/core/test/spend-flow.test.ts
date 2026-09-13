import { describe, it, expect } from "vitest";
import {
  computeSpendFlow,
  spendProjectIdentity,
  assignDistinguishingProjectLabels,
  OTHER_NODE_ID,
  type SessionCostRecord,
} from "../src/hud/spend-flow.js";

describe("spend-flow", () => {
  it("derives spendProjectIdentity correctly for relative and absolute paths", () => {
    const rel = spendProjectIdentity({ projectId: "frontend", projectPath: "frontend" });
    expect(rel.id).toBe("frontend");
    expect(rel.label).toBe("frontend");

    const absWin = spendProjectIdentity({
      projectId: "proj-1",
      projectPath: "C:\\Users\\dev\\workspace\\my-app",
    });
    expect(absWin.id).toBe("c:/Users/dev/workspace/my-app");
    expect(absWin.label).toBe("my-app");
  });

  it("assigns distinguishing labels when project basenames collide", () => {
    const nodes = [
      { id: "c:/repo-a/packages/web", label: "web", cost: 10 },
      { id: "c:/repo-b/packages/web", label: "web", cost: 20 },
      { id: "backend", label: "backend", cost: 5 },
    ];
    const labels = new Map([
      ["c:/repo-a/packages/web", "web"],
      ["c:/repo-b/packages/web", "web"],
      ["backend", "backend"],
    ]);

    assignDistinguishingProjectLabels(nodes, labels);

    expect(nodes[0]!.label).toBe("repo-a/packages/web");
    expect(nodes[1]!.label).toBe("repo-b/packages/web");
    expect(nodes[2]!.label).toBe("backend");
  });

  it("computes spend flow with model and project node aggregations and other rollup", () => {
    const sessions: SessionCostRecord[] = [
      {
        sessionId: "s1",
        projectId: "p1",
        projectPath: "/apps/frontend",
        modelBreakdown: {
          "claude-3-7-sonnet": { costUSD: 1.5 },
          "gpt-4o": { costUSD: 0.5 },
        },
      },
      {
        sessionId: "s2",
        projectId: "p2",
        projectPath: "/apps/backend",
        modelBreakdown: {
          "claude-3-7-sonnet": { costUSD: 2.0 },
          "deepseek-reasoner": { costUSD: 0.3 },
        },
      },
    ];

    const report = computeSpendFlow(sessions);

    expect(report.totalCostUsd).toBe(4.3);
    expect(report.models.length).toBe(3);
    expect(report.models[0]!.id).toBe("claude-3-7-sonnet");
    expect(report.models[0]!.cost).toBe(3.5);

    expect(report.projects.length).toBe(2);
    expect(report.links.length).toBe(4);
  });
});
