/**
 * Autonomous Workflow Pipeline & Organization DAG Engine.
 *
 * Implements workflow directed acyclic graph (DAG) pipelines for multi-agent organizations,
 * conditional branch gates, role assignments, and artifact passing between pipeline stages.
 *
 * Synthesized from opencompany, openfang, and tinyflows architectures.
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
    this.nodes.set(node.id, { ...node });
  }

  public getNode(nodeId: string): WorkflowNode | undefined {
    const n = this.nodes.get(nodeId);
    return n ? { ...n } : undefined;
  }

  public listNodes(): WorkflowNode[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n }));
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
    return this.edges.map((e) => ({ ...e }));
  }

  public validateDAG(): { isValid: boolean; cycle?: string[]; errors: string[] } {
    const errors: string[] = [];

    if (this.nodes.size === 0) {
      errors.push("Pipeline must contain at least one node");
    }

    const triggers = Array.from(this.nodes.values()).filter((n) => n.kind === "trigger");
    if (this.nodes.size > 0 && triggers.length === 0) {
      errors.push("Pipeline must contain at least one trigger node as an entry point");
    }

    for (const edge of this.edges) {
      if (!this.nodes.has(edge.from)) {
        errors.push(`Source node '${edge.from}' does not exist`);
      }
      if (!this.nodes.has(edge.to)) {
        errors.push(`Target node '${edge.to}' does not exist`);
      }
    }

    const adj = new Map<string, string[]>();

    for (const id of this.nodes.keys()) {
      adj.set(id, []);
    }
    for (const edge of this.edges) {
      const list = adj.get(edge.from);
      if (list) list.push(edge.to);
    }

    // Cycle detection via DFS (0 = unvisited, 1 = visiting, 2 = visited)
    const visited = new Map<string, number>();
    const path: string[] = [];
    let detectedCycle: string[] | undefined;

    const dfs = (node: string): boolean => {
      visited.set(node, 1);
      path.push(node);

      const neighbors = adj.get(node) ?? [];
      for (const next of neighbors) {
        const state = visited.get(next) ?? 0;
        if (state === 1) {
          const cycleStart = path.indexOf(next);
          detectedCycle = path.slice(cycleStart).concat(next);
          return true;
        }
        if (state === 0 && dfs(next)) {
          return true;
        }
      }

      path.pop();
      visited.set(node, 2);
      return false;
    };

    for (const id of this.nodes.keys()) {
      if ((visited.get(id) ?? 0) === 0) {
        if (dfs(id)) {
          errors.push(`Cycle detected in workflow pipeline: ${detectedCycle?.join(" -> ")}`);
          break;
        }
      }
    }

    return {
      isValid: errors.length === 0,
      cycle: detectedCycle,
      errors,
    };
  }

  public getNextNodes(currentNodeId: string, context: Record<string, unknown>): WorkflowNode[] {
    const currentNode = this.nodes.get(currentNodeId);
    if (!currentNode) return [];

    const outgoing = this.edges.filter((e) => e.from === currentNodeId);
    const nextNodes: WorkflowNode[] = [];

    // If currentNode is a condition or gate
    if (currentNode.kind === "condition" || currentNode.kind === "gate") {
      let resolvedValue: unknown = undefined;
      if (currentNode.conditionField) {
        resolvedValue = context[currentNode.conditionField];
      }

      for (const edge of outgoing) {
        if (edge.conditionValue !== undefined) {
          if (edge.conditionValue === resolvedValue || String(edge.conditionValue) === String(resolvedValue)) {
            const target = this.nodes.get(edge.to);
            if (target) nextNodes.push({ ...target });
          }
        } else {
          // Default branch when condition matches
          const target = this.nodes.get(edge.to);
          if (target) nextNodes.push({ ...target });
        }
      }
    } else {
      // Normal node: transitions to all downstream targets
      for (const edge of outgoing) {
        const target = this.nodes.get(edge.to);
        if (target) nextNodes.push({ ...target });
      }
    }

    return nextNodes;
  }

  public createRun(initialContext: Record<string, unknown> = {}): WorkflowRunState {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const initialNodes = Array.from(this.nodes.values()).filter((n) => n.kind === "trigger");

    const nodeStates: Record<string, WorkflowNodeState> = {};
    for (const node of this.nodes.values()) {
      nodeStates[node.id] = {
        nodeId: node.id,
        status: "pending",
      };
    }

    for (const trig of initialNodes) {
      const state = nodeStates[trig.id];
      if (state) {
        state.status = "running";
        state.startedAt = Date.now();
      }
    }

    return {
      runId,
      pipelineId: this.id,
      status: "running",
      currentNodeIds: initialNodes.map((n) => n.id),
      nodeStates,
      context: { ...initialContext },
      startedAt: Date.now(),
    };
  }

  private isReachableFrom(sourceIds: string[], targetId: string): boolean {
    if (sourceIds.length === 0) return false;
    const visited = new Set<string>();
    const queue = [...sourceIds];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr === targetId) return true;
      if (visited.has(curr)) continue;
      visited.add(curr);
      for (const edge of this.edges) {
        if (edge.from === curr && !visited.has(edge.to)) {
          queue.push(edge.to);
        }
      }
    }
    return false;
  }

  public completeNode(
    run: WorkflowRunState,
    nodeId: string,
    result: { output?: Record<string, unknown>; error?: string }
  ): WorkflowRunState {
    if (run.status === "completed" || run.status === "failed") {
      throw new Error(`Cannot complete node '${nodeId}': run '${run.runId}' is already in terminal state '${run.status}'`);
    }

    const nodeState = run.nodeStates[nodeId];
    if (!nodeState) {
      throw new Error(`Node '${nodeId}' not found in run '${run.runId}'`);
    }

    if (nodeState.status !== "running") {
      throw new Error(`Cannot complete node '${nodeId}': node is not running (current status: '${nodeState.status}')`);
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
    if (result.output) {
      Object.assign(run.context, result.output);
    }

    // Other nodes currently running (excluding the node that just completed)
    const otherRunning = run.currentNodeIds.filter((id) => id !== nodeId);

    // Determine candidate next nodes
    const nextNodes = this.getNextNodes(nodeId, run.context);
    const nextIds: string[] = [];

    for (const next of nextNodes) {
      const nextState = run.nodeStates[next.id];
      if (!nextState || nextState.status !== "pending") {
        continue;
      }

      // Check all incoming edges to next.id
      const incomingEdges = this.edges.filter((e) => e.to === next.id);
      let allPrerequisitesSatisfied = true;

      for (const edge of incomingEdges) {
        const fromNode = this.nodes.get(edge.from);
        const fromState = run.nodeStates[edge.from];

        // If source node was a condition/gate, check if this branch was selected
        if (fromNode && (fromNode.kind === "condition" || fromNode.kind === "gate") && edge.conditionValue !== undefined) {
          const resolvedVal = fromNode.conditionField ? run.context[fromNode.conditionField] : undefined;
          const matched = edge.conditionValue === resolvedVal || String(edge.conditionValue) === String(resolvedVal);
          if (fromState?.status === "succeeded" && !matched) {
            // This conditional branch was evaluated and not taken; not a required dependency
            continue;
          }
        }

        if (fromState?.status === "succeeded") {
          continue;
        }

        // If fromState is running, or if it is pending and reachable from other running nodes, candidate must wait
        if (fromState?.status === "running" || (fromState?.status === "pending" && this.isReachableFrom(otherRunning, edge.from))) {
          allPrerequisitesSatisfied = false;
          break;
        }
      }

      if (allPrerequisitesSatisfied) {
        nextState.status = "running";
        nextState.startedAt = now;
        nextIds.push(next.id);
      }
    }

    run.currentNodeIds = otherRunning.concat(nextIds);

    if (run.currentNodeIds.length === 0) {
      run.status = "completed";
      run.completedAt = now;
    }

    return { ...run };
  }
}
