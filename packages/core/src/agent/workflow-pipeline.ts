/**
 * Autonomous Workflow Pipeline & Organization DAG Engine.
 *
 * Implements workflow directed acyclic graph (DAG) pipelines for multi-agent organizations,
 * conditional branch gates, role assignments, and artifact passing between pipeline stages.
 */

export type WorkflowNodeKind = "trigger" | "agent" | "condition" | "gate" | "output";

export type WorkflowExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting_gate";

export interface WorkflowNode {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  summary?: string;
  agentRole?: string;
  conditionField?: string;
  conditionExpected?: string | boolean | number;
  config?: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  conditionValue?: string | boolean | number;
}

export interface WorkflowNodeState {
  nodeId: string;
  status: WorkflowExecutionStatus;
  startedAt?: number;
  completedAt?: number;
  output?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowRunState {
  runId: string;
  pipelineId: string;
  status: "idle" | "running" | "completed" | "failed";
  currentNodeIds: string[];
  nodeStates: Record<string, WorkflowNodeState>;
  context: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
}

type EdgeSettlement = "active" | "inactive" | "unresolved";

export class WorkflowPipeline {
  public readonly id: string;
  public readonly name: string;
  public readonly description?: string;
  private nodes = new Map<string, WorkflowNode>();
  private edges: WorkflowEdge[] = [];

  constructor(definition: {
    id: string;
    name: string;
    description?: string;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
  }) {
    this.id = definition.id;
    this.name = definition.name;
    this.description = definition.description;

    if (definition.nodes) {
      const seen = new Set<string>();
      for (const node of definition.nodes) {
        if (seen.has(node.id)) {
          throw new Error(`Duplicate node ID '${node.id}' in pipeline '${definition.id}'`);
        }
        seen.add(node.id);
        this.addNode(node);
      }
    }
    if (definition.edges) {
      for (const edge of definition.edges) {
        this.addEdge(edge.from, edge.to, edge.conditionValue);
      }
    }
  }

  public addNode(node: WorkflowNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Duplicate node ID '${node.id}' in pipeline '${this.id}'`);
    }
    this.nodes.set(node.id, { ...node, config: node.config ? { ...node.config } : undefined });
  }

  public getNode(nodeId: string): WorkflowNode | undefined {
    const node = this.nodes.get(nodeId);
    return node ? { ...node, config: node.config ? { ...node.config } : undefined } : undefined;
  }

  public listNodes(): WorkflowNode[] {
    return Array.from(this.nodes.values()).map((node) => ({
      ...node,
      config: node.config ? { ...node.config } : undefined,
    }));
  }

  public addEdge(from: string, to: string, conditionValue?: string | boolean | number): void {
    if (!this.nodes.has(from)) {
      throw new Error(`Source node '${from}' does not exist in pipeline '${this.id}'`);
    }
    if (!this.nodes.has(to)) {
      throw new Error(`Target node '${to}' does not exist in pipeline '${this.id}'`);
    }
    this.edges.push({ from, to, conditionValue });
  }

  public listEdges(): WorkflowEdge[] {
    return this.edges.map((edge) => ({ ...edge }));
  }

  public validateDAG(): { isValid: boolean; cycle?: string[]; errors: string[] } {
    const errors: string[] = [];

    if (this.nodes.size === 0) {
      errors.push("Pipeline must contain at least one node");
    }

    const triggers = Array.from(this.nodes.values()).filter((node) => node.kind === "trigger");
    if (this.nodes.size > 0 && triggers.length === 0) {
      errors.push("Pipeline must contain at least one trigger node as an entry point");
    }

    for (const edge of this.edges) {
      if (!this.nodes.has(edge.from)) errors.push(`Source node '${edge.from}' does not exist`);
      if (!this.nodes.has(edge.to)) errors.push(`Target node '${edge.to}' does not exist`);
    }

    const adjacency = new Map<string, string[]>();
    for (const id of this.nodes.keys()) adjacency.set(id, []);
    for (const edge of this.edges) adjacency.get(edge.from)?.push(edge.to);

    const visited = new Map<string, number>();
    const path: string[] = [];
    let detectedCycle: string[] | undefined;

    const dfs = (node: string): boolean => {
      visited.set(node, 1);
      path.push(node);
      for (const next of adjacency.get(node) ?? []) {
        const state = visited.get(next) ?? 0;
        if (state === 1) {
          const cycleStart = path.indexOf(next);
          detectedCycle = path.slice(cycleStart).concat(next);
          return true;
        }
        if (state === 0 && dfs(next)) return true;
      }
      path.pop();
      visited.set(node, 2);
      return false;
    };

    for (const id of this.nodes.keys()) {
      if ((visited.get(id) ?? 0) === 0 && dfs(id)) {
        errors.push(`Cycle detected in workflow pipeline: ${detectedCycle?.join(" -> ")}`);
        break;
      }
    }

    return { isValid: errors.length === 0, cycle: detectedCycle, errors };
  }

  private conditionalEdgeSettlement(
    run: WorkflowRunState,
    source: WorkflowNode,
    edge: WorkflowEdge,
  ): EdgeSettlement {
    const sourceState = run.nodeStates[source.id];
    if (!sourceState) return "inactive";
    if (sourceState.status === "pending" || sourceState.status === "running" || sourceState.status === "waiting_gate") {
      return "unresolved";
    }
    if (sourceState.status !== "succeeded") return "inactive";

    const outgoing = this.edges.filter((candidate) => candidate.from === source.id);
    const resolvedValue = source.conditionField ? run.context[source.conditionField] : undefined;
    const matching = outgoing.filter(
      (candidate) =>
        candidate.conditionValue !== undefined &&
        (candidate.conditionValue === resolvedValue || String(candidate.conditionValue) === String(resolvedValue)),
    );

    if (matching.length > 0) {
      return matching.includes(edge) ? "active" : "inactive";
    }
    return edge.conditionValue === undefined ? "active" : "inactive";
  }

  private edgeSettlement(run: WorkflowRunState, edge: WorkflowEdge): EdgeSettlement {
    const source = this.nodes.get(edge.from);
    const sourceState = run.nodeStates[edge.from];
    if (!source || !sourceState) return "inactive";

    if (source.kind === "condition" || source.kind === "gate") {
      return this.conditionalEdgeSettlement(run, source, edge);
    }

    if (sourceState.status === "pending" || sourceState.status === "running" || sourceState.status === "waiting_gate") {
      return "unresolved";
    }
    return sourceState.status === "succeeded" ? "active" : "inactive";
  }

  /**
   * Settle unreachable nodes and start every node whose selected predecessors have completed.
   * Decisions are computed from one snapshot per iteration, then applied together. This makes
   * readiness independent of edge ordering and revisits joins after conditional branches settle.
   */
  private settleReadiness(run: WorkflowRunState, now: number): void {
    let changed = true;
    while (changed) {
      changed = false;
      const toSkip: string[] = [];
      const toStart: string[] = [];

      for (const node of this.nodes.values()) {
        const state = run.nodeStates[node.id];
        if (!state || state.status !== "pending" || node.kind === "trigger") continue;

        const incoming = this.edges.filter((edge) => edge.to === node.id);
        if (incoming.length === 0) {
          toSkip.push(node.id);
          continue;
        }

        const settlements = incoming.map((edge) => this.edgeSettlement(run, edge));
        if (settlements.includes("unresolved")) continue;

        const activeEdges = incoming.filter((_, index) => settlements[index] === "active");
        if (activeEdges.length === 0) {
          toSkip.push(node.id);
          continue;
        }

        const allSelectedSucceeded = activeEdges.every(
          (edge) => run.nodeStates[edge.from]?.status === "succeeded",
        );
        if (allSelectedSucceeded) toStart.push(node.id);
      }

      if (toSkip.length > 0 || toStart.length > 0) changed = true;
      for (const id of toSkip) {
        const state = run.nodeStates[id];
        if (state?.status === "pending") {
          state.status = "skipped";
          state.completedAt = now;
        }
      }
      for (const id of toStart) {
        const state = run.nodeStates[id];
        if (state?.status === "pending") {
          state.status = "running";
          state.startedAt = now;
        }
      }
    }

    run.currentNodeIds = Object.values(run.nodeStates)
      .filter((state) => state.status === "running" || state.status === "waiting_gate")
      .map((state) => state.nodeId);

    const unsettled = Object.values(run.nodeStates).some(
      (state) => state.status === "pending" || state.status === "running" || state.status === "waiting_gate",
    );
    if (!unsettled && run.status !== "failed") {
      run.status = "completed";
      run.completedAt = now;
    }
  }

  public getNextNodes(currentNodeId: string, context: Record<string, unknown>): WorkflowNode[] {
    const currentNode = this.nodes.get(currentNodeId);
    if (!currentNode) return [];
    const outgoing = this.edges.filter((edge) => edge.from === currentNodeId);

    if (currentNode.kind === "condition" || currentNode.kind === "gate") {
      const resolvedValue = currentNode.conditionField ? context[currentNode.conditionField] : undefined;
      const matching = outgoing.filter(
        (edge) =>
          edge.conditionValue !== undefined &&
          (edge.conditionValue === resolvedValue || String(edge.conditionValue) === String(resolvedValue)),
      );
      const selected = matching.length > 0 ? matching : outgoing.filter((edge) => edge.conditionValue === undefined);
      return selected
        .map((edge) => this.nodes.get(edge.to))
        .filter((node): node is WorkflowNode => node !== undefined)
        .map((node) => ({ ...node, config: node.config ? { ...node.config } : undefined }));
    }

    return outgoing
      .map((edge) => this.nodes.get(edge.to))
      .filter((node): node is WorkflowNode => node !== undefined)
      .map((node) => ({ ...node, config: node.config ? { ...node.config } : undefined }));
  }

  public createRun(initialContext: Record<string, unknown> = {}): WorkflowRunState {
    const validation = this.validateDAG();
    if (!validation.isValid) {
      throw new Error(`Cannot create run for invalid pipeline '${this.id}': ${validation.errors.join("; ")}`);
    }

    const now = Date.now();
    const runId = `run_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const initialNodes = Array.from(this.nodes.values()).filter((node) => node.kind === "trigger");
    const nodeStates: Record<string, WorkflowNodeState> = {};

    for (const node of this.nodes.values()) {
      nodeStates[node.id] = { nodeId: node.id, status: "pending" };
    }
    for (const trigger of initialNodes) {
      const state = nodeStates[trigger.id]!;
      state.status = "running";
      state.startedAt = now;
    }

    return {
      runId,
      pipelineId: this.id,
      status: "running",
      currentNodeIds: initialNodes.map((node) => node.id),
      nodeStates,
      context: { ...initialContext },
      startedAt: now,
    };
  }

  public completeNode(
    run: WorkflowRunState,
    nodeId: string,
    result: { output?: Record<string, unknown>; error?: string },
  ): WorkflowRunState {
    if (run.pipelineId !== this.id) {
      throw new Error(
        `Cannot evaluate run '${run.runId}' for pipeline '${run.pipelineId}' with definition '${this.id}'.`,
      );
    }
    if (run.status === "completed" || run.status === "failed") {
      throw new Error(
        `Cannot complete node '${nodeId}': run '${run.runId}' is already in terminal state '${run.status}'`,
      );
    }

    const nodeState = run.nodeStates[nodeId];
    if (!nodeState || !this.nodes.has(nodeId)) {
      throw new Error(`Node '${nodeId}' not found in run '${run.runId}' and its bound pipeline definition`);
    }
    if (nodeState.status !== "running" && nodeState.status !== "waiting_gate") {
      throw new Error(
        `Cannot complete node '${nodeId}': node is not running (current status: '${nodeState.status}')`,
      );
    }

    const now = Date.now();
    nodeState.completedAt = now;
    if (result.error) {
      nodeState.status = "failed";
      nodeState.error = result.error;
      run.status = "failed";
      run.completedAt = now;
      run.currentNodeIds = run.currentNodeIds.filter((id) => id !== nodeId);
      return { ...run };
    }

    nodeState.status = "succeeded";
    nodeState.output = result.output;
    if (result.output) Object.assign(run.context, result.output);

    this.settleReadiness(run, now);
    return { ...run };
  }
}
