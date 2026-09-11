/**
 * Spend Flow Sankey / Cost-Attribution Matrix.
 * Ported and unified from codeburn and Hermes session ledger.
 */

export interface SpendFlowNode {
  id: string;
  label: string;
  cost: number;
}

export interface SpendFlowLink {
  model: string;
  project: string;
  cost: number;
}

export interface SpendFlowReport {
  period: {
    label: string;
    start: string;
    end: string;
  };
  models: SpendFlowNode[];
  projects: SpendFlowNode[];
  links: SpendFlowLink[];
  totalCostUsd: number;
}

export interface SessionCostRecord {
  sessionId: string;
  projectId: string;
  projectPath?: string;
  timestamp?: number | string;
  modelBreakdown: Record<string, { costUSD: number; tokens?: number }>;
}

const TOP_NODE_LIMIT = 8;
export const OTHER_NODE_ID = "__other__";

export function normalizePathSeparators(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

export function foldWindowsPath(path: string): string {
  const norm = normalizePathSeparators(path);
  if (/^[a-zA-Z]:\//.test(norm)) {
    return norm[0]!.toLowerCase() + norm.slice(1);
  }
  return norm;
}

export function spendProjectIdentity(project: { projectId: string; projectPath?: string }): {
  id: string;
  label: string;
} {
  const raw = (project.projectPath ?? "").trim().replace(/\\/g, "/");
  const looksAbs = raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || (raw.includes("/") && !raw.startsWith("-"));
  if (looksAbs && raw) {
    const trimmed = raw.replace(/\/+$/, "");
    const parts = trimmed.split("/").filter(Boolean);
    const base = parts.pop() || project.projectId;
    return { id: foldWindowsPath(trimmed), label: base };
  }
  return { id: project.projectId, label: project.projectId };
}

function sortedEntries(totals: Map<string, number>): Array<[string, number]> {
  return [...totals.entries()].sort(([aName, aCost], [bName, bCost]) => {
    const byCost = bCost - aCost;
    return byCost !== 0 ? byCost : aName.localeCompare(bName);
  });
}

function buildNodes(
  totals: Map<string, number>,
  limit: number = TOP_NODE_LIMIT,
): { nodes: SpendFlowNode[]; keep: Set<string> } {
  const sorted = sortedEntries(totals);
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const keep = new Set(top.map(([id]) => id));
  const nodes: SpendFlowNode[] = top.map(([id, cost]) => ({ id, label: id, cost }));
  const otherCost = rest.reduce((sum, [, cost]) => sum + cost, 0);
  if (otherCost > 0) {
    nodes.push({ id: OTHER_NODE_ID, label: "Other", cost: Number(otherCost.toFixed(6)) });
  }
  return { nodes, keep };
}

function looksAbsId(id: string): boolean {
  return id.startsWith("/") || /^[a-zA-Z]:\//.test(id);
}

function pathParts(id: string): string[] {
  return id.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
}

export function assignDistinguishingProjectLabels(
  nodes: SpendFlowNode[],
  labels: Map<string, string>,
): void {
  const visible = nodes.filter((node) => node.id !== OTHER_NODE_ID);
  for (const node of visible) {
    if (!looksAbsId(node.id)) {
      node.label = labels.get(node.id) ?? node.id;
      continue;
    }
    const parts = pathParts(node.id);
    const base = parts[parts.length - 1] || labels.get(node.id) || node.id;
    const collisions = visible.filter(
      (other) =>
        other.id !== node.id &&
        looksAbsId(other.id) &&
        pathParts(other.id)[pathParts(other.id).length - 1] === base,
    );
    if (collisions.length === 0) {
      node.label = base;
      continue;
    }
    let label = base;
    for (let n = 2; n <= parts.length; n++) {
      label = parts.slice(-n).join("/");
      const clash = collisions.some(
        (other) => pathParts(other.id).slice(-n).join("/") === label,
      );
      if (!clash) break;
    }
    node.label = label;
  }
}

/**
 * Computes model-to-project spend flows and aggregation links.
 */
export function computeSpendFlow(
  sessions: SessionCostRecord[],
  options?: {
    startDate?: Date;
    endDate?: Date;
    topNodeLimit?: number;
  },
): SpendFlowReport {
  const limit = options?.topNodeLimit ?? TOP_NODE_LIMIT;
  const matrix = new Map<string, Map<string, number>>();
  const projectTotals = new Map<string, number>();
  const modelTotals = new Map<string, number>();
  const projectLabels = new Map<string, string>();

  let totalCost = 0;

  for (const session of sessions) {
    const { id: projectId, label: projectLabel } = spendProjectIdentity({
      projectId: session.projectId,
      projectPath: session.projectPath,
    });
    if (!projectLabels.has(projectId)) {
      projectLabels.set(projectId, projectLabel);
    }

    for (const [model, breakdown] of Object.entries(session.modelBreakdown)) {
      const cost = breakdown.costUSD;
      if (cost <= 0) continue;

      totalCost += cost;

      let modelCosts = matrix.get(projectId);
      if (!modelCosts) {
        modelCosts = new Map<string, number>();
        matrix.set(projectId, modelCosts);
      }
      modelCosts.set(model, (modelCosts.get(model) ?? 0) + cost);
      projectTotals.set(projectId, (projectTotals.get(projectId) ?? 0) + cost);
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + cost);
    }
  }

  const { nodes: models, keep: keptModels } = buildNodes(modelTotals, limit);
  const { nodes: projectsNodes, keep: keptProjects } = buildNodes(projectTotals, limit);
  assignDistinguishingProjectLabels(projectsNodes, projectLabels);

  const rolledLinks = new Map<string, SpendFlowLink>();

  for (const [project, modelCosts] of matrix.entries()) {
    const rolledProject = keptProjects.has(project) ? project : OTHER_NODE_ID;
    for (const [model, cost] of modelCosts.entries()) {
      const rolledModel = keptModels.has(model) ? model : OTHER_NODE_ID;
      const key = `${rolledModel}\u0000${rolledProject}`;
      const existing = rolledLinks.get(key);
      if (existing) {
        existing.cost = Number((existing.cost + cost).toFixed(6));
      } else {
        rolledLinks.set(key, {
          model: rolledModel,
          project: rolledProject,
          cost: Number(cost.toFixed(6)),
        });
      }
    }
  }

  const modelOrder = new Map(models.map((node, index) => [node.id, index]));
  const projectOrder = new Map(projectsNodes.map((node, index) => [node.id, index]));

  const links = [...rolledLinks.values()].sort((a, b) => {
    const byModel =
      (modelOrder.get(a.model) ?? Number.MAX_SAFE_INTEGER) -
      (modelOrder.get(b.model) ?? Number.MAX_SAFE_INTEGER);
    if (byModel !== 0) return byModel;
    return (
      (projectOrder.get(a.project) ?? Number.MAX_SAFE_INTEGER) -
      (projectOrder.get(b.project) ?? Number.MAX_SAFE_INTEGER)
    );
  });

  const start = options?.startDate ?? new Date(0);
  const end = options?.endDate ?? new Date();

  return {
    period: {
      label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
      start: start.toISOString(),
      end: end.toISOString(),
    },
    models: models.map((m) => ({ ...m, cost: Number(m.cost.toFixed(6)) })),
    projects: projectsNodes.map((p) => ({ ...p, cost: Number(p.cost.toFixed(6)) })),
    links,
    totalCostUsd: Number(totalCost.toFixed(6)),
  };
}
