/**
 * Causal Signal & Action Execution Chain.
 *
 * Implements causal provenance and depth-controlled action tracking for autonomous agent decisions,
 * chaining Root Source -> Intermediate Signals -> Dispatched Actions -> Execution Attempts.
 *
 * Synthesized from lobehub agent-signal and hermes-agent event tracking architectures.
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
  attempts: ExecutionAttempt[];
  timestamp: number;
  completedAt?: number;
}

export interface SignalChainManagerOptions {
  maxDepth?: number;
  maxRetries?: number;
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

  public registerSource(input: {
    sourceId?: string;
    sourceType: string;
    payload?: Record<string, unknown>;
    scope?: SignalScope;
  }): SourceNode {
    const sourceId = input.sourceId ?? `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      if (parentAction) {
        parentDepth = parentAction.chain.depth;
        parentNodeId = parentAction.actionId;
      }
    }

    const nextDepth = parentDepth + 1;
    if (nextDepth > this.maxDepth) {
      throw new Error(`Exceeded maximum causal depth of ${this.maxDepth} (current: ${nextDepth})`);
    }

    const signalId = input.signalId ?? `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

    const actionId = input.actionId ?? `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      attempts: [],
      timestamp: Date.now(),
    };

    this.actions.set(actionId, node);
    return { ...node };
  }

  public startAttempt(actionId: string): ExecutionAttempt {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new Error(`Action with id '${actionId}' not found`);
    }

    const attemptNumber = action.attempts.length + 1;
    const attempt: ExecutionAttempt = {
      attemptNumber,
      maxAttempts: this.maxRetries,
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
      status: "succeeded" | "failed" | "cancelled" | "skipped";
      output?: Record<string, unknown>;
      error?: string;
    }
  ): ActionNode {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new Error(`Action with id '${actionId}' not found`);
    }

    const currentAttempt = action.attempts[action.attempts.length - 1];
    if (currentAttempt && currentAttempt.status === "running") {
      currentAttempt.completedAt = Date.now();
      currentAttempt.status = result.status;
      currentAttempt.output = result.output;
      currentAttempt.error = result.error;
    }

    if (result.status === "succeeded") {
      action.status = "succeeded";
      action.completedAt = Date.now();
    } else if (result.status === "failed") {
      if (action.attempts.length >= this.maxRetries) {
        action.status = "failed";
        action.completedAt = Date.now();
      } else {
        action.status = "pending"; // Ready for retry
      }
    } else {
      action.status = result.status;
      action.completedAt = Date.now();
    }

    return { ...action };
  }

  public getTrace(nodeId: string): Array<SourceNode | SignalNode | ActionNode> {
    const trace: Array<SourceNode | SignalNode | ActionNode> = [];
    let currentId: string | undefined = nodeId;

    while (currentId) {
      const action = this.actions.get(currentId);
      if (action) {
        trace.unshift({ ...action });
        currentId = action.chain.parentNodeId;
        continue;
      }

      const signal = this.signals.get(currentId);
      if (signal) {
        trace.unshift({ ...signal });
        currentId = signal.chain.parentNodeId;
        continue;
      }

      const source = this.sources.get(currentId);
      if (source) {
        trace.unshift({ ...source });
        break;
      }

      break;
    }

    return trace;
  }

  public getAction(actionId: string): ActionNode | undefined {
    const action = this.actions.get(actionId);
    return action ? { ...action } : undefined;
  }

  public listActions(filter?: { status?: ActionStatus; actionType?: string }): ActionNode[] {
    const list: ActionNode[] = [];
    for (const a of this.actions.values()) {
      if (filter?.status && a.status !== filter.status) continue;
      if (filter?.actionType && a.actionType !== filter.actionType) continue;
      list.push({ ...a });
    }
    return list;
  }
}
