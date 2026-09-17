import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SpendFlowReport } from "@prismshadow/penguin-core/browser";
import { SankeySpendChart, layoutSpendFlow } from "../src/features/cockpit/sankey-spend-chart";
import { SpendFlowCard } from "../src/features/hud/spend-flow-card";

const report: SpendFlowReport = {
  period: { label: "Recent sessions", start: "2026-09-01", end: "2026-09-17" },
  models: [
    { id: "m1", label: "Model One", cost: 9 },
    { id: "m2", label: "Model Two", cost: 3 },
  ],
  projects: [
    { id: "p1", label: "Project One", cost: 6 },
    { id: "p2", label: "Project Two", cost: 6 },
  ],
  links: [
    { model: "m1", project: "p1", cost: 6 },
    { model: "m1", project: "p2", cost: 3 },
    { model: "m2", project: "p2", cost: 3 },
  ],
  totalCostUsd: 12,
};

function render(value = report) {
  return renderToStaticMarkup(createElement(SankeySpendChart, { report: value }));
}

describe("spend flow Sankey", () => {
  it("draws actual links with proportional widths and conserves cost on both sides", () => {
    const graph = layoutSpendFlow(report);
    expect(graph.links).toHaveLength(3);
    expect(graph.links[0]!.width).toBeCloseTo(graph.links[1]!.width * 2);
    for (const model of graph.models) {
      expect(
        graph.links
          .filter((link) => link.model === model.id)
          .reduce((sum, link) => sum + link.width, 0),
      ).toBeCloseTo(model.height);
    }
    for (const project of graph.projects) {
      expect(
        graph.links
          .filter((link) => link.project === project.id)
          .reduce((sum, link) => sum + link.width, 0),
      ).toBeCloseTo(project.height);
    }
    expect(graph.links[1]!.sourceY - graph.links[1]!.width / 2).toBeCloseTo(
      graph.links[0]!.sourceY + graph.links[0]!.width / 2,
    );
    expect(graph.links[2]!.targetY - graph.links[2]!.width / 2).toBeCloseTo(
      graph.links[1]!.targetY + graph.links[1]!.width / 2,
    );
  });

  it("renders labeled, keyboard-focusable flows and a largest-flow insight", () => {
    const html = render();
    expect(html).toContain('aria-label="Spend flow attribution"');
    expect(html.match(/data-spend-link=/g)).toHaveLength(3);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Model One → Project One: $6.0000 USD (50%)");
    expect(html).toContain("Largest flow");
    expect(html).toContain("Model Two");
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it("is mounted in the existing card without losing totals, period or attribution detail", () => {
    const html = renderToStaticMarkup(createElement(SpendFlowCard, { report }));
    expect(html).toContain('aria-label="Spend flow attribution"');
    expect(html).toContain("$12.0000");
    expect(html).toContain("Recent sessions");
    expect(html).toContain("Model-to-project detail (3)");
    expect(html).toContain("By model");
  });

  it("renders empty and zero-cost states without fake bands or percentages", () => {
    for (const value of [
      { ...report, models: [], projects: [], links: [], totalCostUsd: 0 },
      { ...report, links: report.links.map((link) => ({ ...link, cost: 0 })), totalCostUsd: 0 },
    ]) {
      const html = render(value);
      expect(html).toContain("No positive recorded cost to plot.");
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("Largest flow");
    }
  });

  it("excludes invalid and orphan links with an explicit note", () => {
    const value = {
      ...report,
      links: [
        ...report.links,
        { model: "absent", project: "p1", cost: 3 },
        { model: "m1", project: "p1", cost: -1 },
        { model: "m1", project: "p1", cost: NaN },
        { model: "m1", project: "p1", cost: Infinity },
      ],
    };
    expect(layoutSpendFlow(value).links).toHaveLength(3);
    expect(render(value)).toContain("Some attribution records could not be plotted.");
    expect(render(value)).not.toMatch(/NaN|Infinity/);
  });

  it("keeps Other nodes separate by column, preserves tiny values and does not mutate reports", () => {
    const value: SpendFlowReport = {
      ...report,
      models: [{ id: "__other__", label: "Other", cost: 0.000001 }],
      projects: [{ id: "__other__", label: "Other", cost: 0.000001 }],
      links: [{ model: "__other__", project: "__other__", cost: 0.000001 }],
      totalCostUsd: 0.000001,
    };
    const before = JSON.stringify(value);
    const graph = layoutSpendFlow(value);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0]!.width).toBeGreaterThan(0);
    expect(graph.models[0]!.height).toBe(graph.projects[0]!.height);
    expect(render(value)).toContain("$0.000001 USD");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("escapes long labels and preserves full text in accessible labels", () => {
    const label = '<script>alert("x")</script>' + " long name".repeat(12);
    const html = render({
      ...report,
      models: [{ ...report.models[0]!, label }, report.models[1]!],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain(" long name".repeat(12));
  });
});
