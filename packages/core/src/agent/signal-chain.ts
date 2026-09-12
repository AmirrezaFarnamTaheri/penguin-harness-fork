/**
 * Causal Signal & Action Execution Chain.
 *
 * Implements causal provenance and depth-controlled action tracking for autonomous agent decisions,
 * chaining Root Source -> Intermediate Signals -> Dispatched Actions -> Execution Attempts.
 */

export interface SignalScope {
  userId?: string;
  agentId?: string;
  taskId?: string;
  topicId?: string;
  workspaceId?: string;
}

export interface SignalChainRef {
  chainId: string;
  rootSourceId: string;
  parentNodeId?: string;
  parentSignalId?: string;
  parentActionId?: string;
  depth: number;
}

export interface SourceNode {
  sourceId: string;
  sourceType: string;
  chain: SignalChainRef;
  payload: Record<string, unknown>;
  scope?: SignalScope;
  timestamp: number;
}

export interface SignalNode {
  signalId: string;
  signalType: string;
  chain: SignalChainRef;
  sourceId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export type ActionStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface ExecutionAttempt {
  attemptNumber: number;
  maxAttempts: number;
  startedAt: number;
  completedAt?: number;
  status: ActionStatus;
  output?: Record<string, unknown>;
  error?: string;
}

export interface ActionNode {
  actionId: string;
  actionType: string;
  chain: SignalChainRef;
  signalId: string;
  sourceId: string;
  payload: Record<string, unknown>;
  status: ActionStatus;
  maxAttempts: number;
  attempts: ExecutionAttempt[];
  timestamp: number;
  completedAt?: number;
}

export interface SignalChainManagerOptions {
  maxDepth?: number;
  maxRetries?: number;
}

function isTerminalAction(status: ActionStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped";
}

export class SignalChainManager {
  private readonly maxDepth: number;
  private readonly maxRetries: number;

  private sources = new Map<string, SourceNode>();
  private signals = new Map<string, SignalNode>();
  private actions = new Map<string, ActionNode>();

  constructor(options: SignalChainManagerOptions = {}) {
    this.maxDepth = options.maxDepth ?? 32;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private hasNodeId(nodeId: string): boolean {
    return this.sources.has(nodeId) || this.signals.has(nodeId) || this.actions.has(nodeId);
  }

  private assertNodeIdAvailable(nodeId: string): void {
    if (this.hasNodeId(nodeId)) {
      throw new Error(`Causal node id '${nodeId}' is already registered`);
    }
  }

  public registerSource(input: {
    sourceId?: string;
    sourceType: string;
    payload?: Record<string, unknown>;
    scope?: SignalScope;
  }): SourceNode {
    const sourceId = input.sourceId ?? `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.assertNodeIdAvailable(sourceId);
    const chainId = `chain_${sourceId}`;

    const chain: SignalChainRef = {
      chainId,
      rootSourceId: sourceId,
      depth: 0,
    };

    const node: SourceNode = {
      sourceId,
      sourceType: input.sourceType,
      chain,
      payload: input.payload ?? {},
      scope: input.scope,
      timestamp: Date.now(),
    };

    this.sources.set(sourceId, node);
    return { ...node };
  }

  public emitSignal(input: {
    signalId?: string;
    signalType: string;
    sourceId: string;
    parentActionId?: string;
    payload?: Record<string, unknown>;
  }): SignalNode {
    const source = this.sources.get(input.sourceId);
    if (!source) {
      throw new Error(`Source with id '${input.sourceId}' not found`);
    }

    let parentDepth = source.chain.depth;
    let parentNodeId: string = source.sourceId;

    if (input.parentActionId) {
      const parentAction = this.actions.get(input.parentActionId);
      if (!parentAction) {
        throw new Error(`Parent action with id '${input.parentActionId}' not found`);
      }
      if (
        parentAction.chain.chainId !== source.chain.chainId ||
        parentAction.chain.rootSourceId !== source.sourceId
      ) {
        throw new Error(
          `Parent action '${input.parentActionId}' belongs to causal root '${parentAction.chain.rootSourceId}', not source '${source.sourceId}'`,
        );
      }
      parentDepth = parentAction.chain.depth;
      parentNodeId = parentAction.actionId;
    }

    const nextDepth = parentDepth + 1;
    if (nextDepth > this.maxDepth) {
      throw new Error(`Exceeded maximum causal depth of ${this.maxDepth} (current: ${nextDepth})`);
    }

    const signalId = input.signalId ?? `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.assertNodeIdAvailable(signalId);
    const chain: SignalChainRef = {
      chainId: source.chain.chainId,
      rootSourceId: source.sourceId,
      parentNodeId,
      parentActionId: input.parentActionId,
      depth: nextDepth,
    };

    const node: SignalNode = {
      signalId,
      signalType: input.signalType,
      chain,
      sourceId: input.sourceId,
      payload: input.payload ?? {},
      timestamp: Date.now(),
    };

    this.signals.set(signalId, node);
    return { ...node };
  }

  public dispatchAction(input: {
    actionId?: string;
    actionType: string;
    signalId: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
  }): ActionNode {
    const signal = this.signals.get(input.signalId);
    if (!signal) {
      throw new Error(`Signal with id '${input.signalId}' not found`);
    }

    const nextDepth = signal.chain.depth + 1;
    if (nextDepth > this.maxDepth) {
      throw new Error(`Exceeded maximum causal depth of ${this.maxDepth} (current: ${nextDepth})`);
    }

    const maxAttempts = input.maxAttempts ?? this.maxRetries;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }

    const actionId = input.actionId ?? `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.assertNodeIdAvailable(actionId);
    const chain: SignalChainRef = {
      chainId: signal.chain.chainId,
      rootSourceId: signal.chain.rootSourceId,
      parentNodeId: signal.signalId,
      parentSignalId: signal.signalId,
      parentActionId: signal.chain.parentActionId,
      depth: nextDepth,
    };

    const node: ActionNode = {
      actionId,
      actionType: input.actionType,
      chain,
      signalId: input.signalId,
      sourceId: signal.sourceId,
      payload: input.payload ?? {},
      status: "pending",
      maxAttempts,
      attempts: [],
      timestamp: Date.now(),
    };

    this.actions.set(actionId, node);
    return { ...node, attempts: [] };
  }

  public startAttempt(actionId: string): ExecutionAttempt {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new Error(`Action with id '${actionId}' not found`);
    }
    if (isTerminalAction(action.status)) {
      throw new Error(`Action '${actionId}' is terminal with status '${action.status}'`);
    }
    if (action.status === "running") {
      throw new Error(`Action '${actionId}' already has an active attempt`);
    }
    if (action.attempts.length >= action.maxAttempts) {
      action.status = "failed";
      action.completedAt ??= Date.now();
      throw new Error(`Action '${actionId}' exhausted its ${action.maxAttempts} attempt budget`);
    }

    const attemptNumber = action.attempts.length + 1;
    const attempt: ExecutionAttempt = {
      attemptNumber,
      maxAttempts: action.maxAttempts,
      startedAt: Date.now(),
      status: "running",
    };

    action.status = "running";
    action.attempts.push(attempt);
    return { ...attempt };
  }

  public completeAttempt(
    actionId: string,
    result: {
      /** Required after the first attempt so late retry callbacks cannot complete a newer attempt. */
      attemptNumber?: number;
      status: "succeeded" | "failed" | "cancelled" | "skipped";
      output?: Record<string, unknown>;
      error?: string;
    }
  ): ActionNode {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new Error(`Action with id '${actionId}' not found`);
    }
    if (isTerminalAction(action.status)) {
      throw new Error(`Action '${actionId}' is already terminal with status '${action.status}'`);
    }

    const currentAttempt = action.attempts[action.attempts.length - 1];
    if (!currentAttempt || currentAttempt.status !== "running" || action.status !== "running") {
      throw new Error(`Action '${actionId}' has no active attempt to complete`);
    }
    if (action.attempts.length > 1 && result.attemptNumber === undefined) {
      throw new Error(`attemptNumber is required when completing a retried action '${actionId}'`);
    }
    if (result.attemptNumber !== undefined && result.attemptNumber !== currentAttempt.attemptNumber) {
      throw new Error(
        `Attempt ${result.attemptNumber} is not active for action '${actionId}' (active: ${currentAttempt.attemptNumber})`,
      );
    }

    const completedAt = Date.now();
    currentAttempt.completedAt = completedAt;
    currentAttempt.status = result.status;
    currentAttempt.output = result.output;
    currentAttempt.error = result.error;

    if (result.status === "succeeded") {
      action.status = "succeeded";
      action.completedAt = completedAt;
    } else if (result.status === "failed") {
      if (action.attempts.length >= action.maxAttempts) {
        action.status = "failed";
        action.completedAt = completedAt;
      } else {
        action.status = "pending";
      }
    } else {
      action.status = result.status;
      action.completedAt = completedAt;
    }

    return { ...action, attempts: action.attempts.map((attempt) => ({ ...attempt })) };
  }

  public getTrace(nodeId: string): Array<SourceNode | SignalNode | ActionNode> {
    const trace: Array<SourceNode | SignalNode | ActionNode> = [];
    const visited = new Set<string>();
    let currentId: string | undefined = nodeId;
    let expectedRoot: string | undefined;
    let expectedChain: string | undefined;

    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error(`Causal trace for '${nodeId}' contains a cycle at '${currentId}'`);
      }
      visited.add(currentId);

      const node: SourceNode | SignalNode | ActionNode | undefined =
        this.actions.get(currentId) ?? this.signals.get(currentId) ?? this.sources.get(currentId);
      if (!node) {
        throw new Error(`Causal trace references missing node '${currentId}'`);
      }

      expectedRoot ??= node.chain.rootSourceId;
      expectedChain ??= node.chain.chainId;
      if (node.chain.rootSourceId !== expectedRoot || node.chain.chainId !== expectedChain) {
        throw new Error(`Causal trace for '${nodeId}' contains incompatible roots or chain ids`);
      }

      if ("actionId" in node) {
        trace.unshift({ ...node, attempts: node.attempts.map((attempt: ExecutionAttempt) => ({ ...attempt })) });
      } else {
        trace.unshift({ ...node });
      }

      if ("sourceType" in node) break;
      currentId = node.chain.parentNodeId;
    }

    return trace;
  }

  public getAction(actionId: string): ActionNode | undefined {
    const action = this.actions.get(actionId);
    return action ? { ...action, attempts: action.attempts.map((attempt) => ({ ...attempt })) } : undefined;
  }

  public listActions(filter?: { status?: ActionStatus; actionType?: string }): ActionNode[] {
    const list: ActionNode[] = [];
    for (const action of this.actions.values()) {
      if (filter?.status && action.status !== filter.status) continue;
      if (filter?.actionType && action.actionType !== filter.actionType) continue;
      list.push({ ...action, attempts: action.attempts.map((attempt) => ({ ...attempt })) });
    }
    return list;
  }
}
