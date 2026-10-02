import { useId, useState } from "react";
import type { SpendFlowNode, SpendFlowReport } from "@prismshadow/penguin-core/browser";

const WIDTH = 720;
const LEFT = 190;
const RIGHT = 530;
const BAR = 8;

/** Geometry is based on links, not independently rounded marginal totals. */
export function layoutSpendFlow(report: SpendFlowReport) {
  const modelIds = new Set(report.models.map((node) => node.id));
  const projectIds = new Set(report.projects.map((node) => node.id));
  const valid = report.links.filter(
    (link) =>
      Number.isFinite(link.cost) &&
      link.cost > 0 &&
      modelIds.has(link.model) &&
      projectIds.has(link.project),
  );
  // Normalize first so even large finite costs cannot overflow the layout sum.
  const maxCost = valid.reduce((max, link) => Math.max(max, link.cost), 0);
  const weight = valid.reduce((sum, link) => sum + link.cost / maxCost, 0);
  const widthFor = (cost: number) => (weight > 0 ? (cost / maxCost / weight) * 220 : 0);
  const column = (nodes: SpendFlowNode[], side: "model" | "project") => {
    let y = 38;
    return nodes.flatMap((node) => {
      const height = valid.reduce(
        (sum, link) => (link[side] === node.id ? sum + widthFor(link.cost) : sum),
        0,
      );
      if (height <= 0) return [];
      const placed = { ...node, y, height };
      // Reserve label space without inflating the value-encoded bar itself.
      y += Math.max(32, height) + 14;
      return [placed];
    });
  };
  const models = column(report.models, "model");
  const projects = column(report.projects, "project");
  const modelPositions = new Map(models.map((node) => [node.id, node.y]));
  const projectPositions = new Map(projects.map((node) => [node.id, node.y]));
  const links = valid.map((link) => {
    const width = widthFor(link.cost);
    const source = modelPositions.get(link.model)!;
    const target = projectPositions.get(link.project)!;
    modelPositions.set(link.model, source + width);
    projectPositions.set(link.project, target + width);
    const sourceY = source + width / 2;
    const targetY = target + width / 2;
    return {
      ...link,
      width,
      sourceY,
      targetY,
      path: `M ${LEFT + BAR} ${sourceY} C 340 ${sourceY}, 380 ${targetY}, ${RIGHT} ${targetY}`,
    };
  });
  const height = Math.max(
    140,
    ...[...models, ...projects].map((node) => node.y + Math.max(32, node.height) + 20),
  );
  const omitted = report.links.some(
    (link) =>
      !Number.isFinite(link.cost) ||
      link.cost < 0 ||
      !modelIds.has(link.model) ||
      !projectIds.has(link.project),
  );
  return { models, projects, links, height, omitted };
}

function money(cost: number) {
  return `$${cost.toFixed(cost > 0 && cost < 0.0001 ? 6 : 4)} USD`;
}

/** Reuses the usage charts' dependency-free SVG approach; axes/ChartFrame are time-series-only. */
export function SankeySpendChart({ report }: { report: SpendFlowReport }) {
  const titleId = useId();
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const graph = layoutSpendFlow(report);
  const modelLabels = new Map(report.models.map((node) => [node.id, node.label]));
  const projectLabels = new Map(report.projects.map((node) => [node.id, node.label]));
  const label = (link: (typeof graph.links)[number]) => {
    const share =
      Number.isFinite(report.totalCostUsd) && report.totalCostUsd > 0
        ? ` (${Math.round((link.cost / report.totalCostUsd) * 100)}%)`
        : "";
    return `${modelLabels.get(link.model)} → ${projectLabels.get(link.project)}: ${money(link.cost)}${share}`;
  };
  const largest = graph.links.reduce<(typeof graph.links)[number] | undefined>(
    (best, link) => (!best || link.cost > best.cost ? link : best),
    undefined,
  );
  const active = hovered ?? focused;
  const selected = active === null ? undefined : graph.links[active];
  return (
    <section aria-label="Spend flow attribution" className="min-w-0 space-y-2">
      <h4 id={titleId} className="font-semibold text-gray-900 dark:text-gray-100">
        Spend flow attribution
      </h4>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Band width represents recorded USD cost. Focus or hover a flow for its value.
      </p>
      {graph.omitted && <p role="note">Some attribution records could not be plotted.</p>}
      {graph.links.length === 0 ? (
        <p>No positive recorded cost to plot.</p>
      ) : (
        <>
          <div className="max-w-full overflow-x-auto">
            <svg
              role="group"
              aria-labelledby={titleId}
              viewBox={`0 0 ${WIDTH} ${graph.height}`}
              style={{ width: "100%", minWidth: WIDTH, height: "auto", display: "block" }}
            >
              <text x="12" y="18" fill="currentColor" fontSize="12">
                Models
              </text>
              <text x={RIGHT + BAR + 12} y="18" fill="currentColor" fontSize="12">
                Projects
              </text>
              {graph.links.map((link, index) => (
                <g key={index}>
                  <path
                    d={link.path}
                    stroke="currentColor"
                    strokeWidth={link.width}
                    fill="none"
                    className="text-blue-600 dark:text-blue-400"
                    opacity={active === null || active === index ? 0.65 : 0.18}
                    aria-hidden="true"
                  />
                  <path
                    data-spend-link={index}
                    d={link.path}
                    stroke="transparent"
                    strokeWidth={Math.max(12, link.width)}
                    fill="none"
                    tabIndex={0}
                    role="img"
                    aria-label={label(link)}
                    className="focus:outline focus:outline-2 focus:outline-blue-500"
                    onMouseEnter={() => setHovered(index)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setFocused(index)}
                    onBlur={() => setFocused(null)}
                  >
                    <title>{label(link)}</title>
                  </path>
                </g>
              ))}
              {[
                { nodes: graph.models, x: LEFT, side: "model" },
                { nodes: graph.projects, x: RIGHT, side: "project" },
              ].map(({ nodes, x, side }) =>
                nodes.map((node) => (
                  <g key={`${side}:${node.id}`}>
                    <rect
                      x={x}
                      y={node.y}
                      width={BAR}
                      height={node.height}
                      fill="currentColor"
                      className="text-blue-600 dark:text-blue-400"
                    />
                    <text
                      x={side === "model" ? LEFT - 12 : RIGHT + BAR + 12}
                      y={node.y + Math.max(14, node.height / 2)}
                      textAnchor={side === "model" ? "end" : "start"}
                      fill="currentColor"
                      fontSize="12"
                    >
                      <title>{node.label}</title>
                      {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                    </text>
                  </g>
                )),
              )}
            </svg>
          </div>
          <p
            aria-live="polite"
            className="min-h-10 break-words text-xs text-gray-700 dark:text-gray-300"
          >
            {selected
              ? label(selected)
              : "Full values are available in Model-to-project detail below."}
          </p>
          {largest && (
            <p className="break-words text-xs text-gray-700 dark:text-gray-300">
              <strong>Largest flow:</strong> {label(largest)}
            </p>
          )}
        </>
      )}
    </section>
  );
}
