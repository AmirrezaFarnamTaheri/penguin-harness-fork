/**
 * Agent Kanban & Task Orchestration Engine.
 */

export type KanbanTaskState =
  | "backlog"
  | "triage"
  | "in_progress"
  | "review"
  | "done"
  | "archived"
  | "failed";

export type KanbanTaskPriority = "low" | "normal" | "high" | "urgent";

export interface KanbanTask {
  id: string;
  boardId: string;
  title: string;
  description?: string;
  state: KanbanTaskState;
  priority: KanbanTaskPriority;
  assignee?: string | null;
  workerPid?: number | null;
  parentTaskId?: string | null;
  dependencies: string[];
  childTaskIds: string[];
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  claimExpires?: number | null;
  lastHeartbeatAt?: number | null;
  leaseGeneration?: number;
  metadata?: Record<string, unknown>;
}

export interface TriageDraft {
  id: string;
  title: string;
  body: string;
  suggestedTasks: Array<{
    title: string;
    description?: string;
    priority?: KanbanTaskPriority;
    dependencies?: string[];
  }>;
  createdAt: number;
  messageId?: string | number | null;
}

export type KanbanEventType =
  | "task.created"
  | "task.updated"
  | "task.state_changed"
  | "task.assigned"
  | "task.unassigned"
  | "task.heartbeat"
  | "task.lease_expired"
  | "task.deleted"
  | "triage.draft_created"
  | "triage.launched";

export interface KanbanEvent {
  type: KanbanEventType;
  taskId?: string;
  boardId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type KanbanEventListener = (event: KanbanEvent) => void;

export interface KanbanBoardOptions {
  boardId?: string;
  defaultLeaseDurationMs?: number;
}

export interface LeaseIdentity {
  workerId: string;
  generation: number;
}

function stateRequiresCompletedDependencies(state: KanbanTaskState): boolean {
  return state === "in_progress" || state === "review" || state === "done";
}

export class KanbanBoard {
  public readonly boardId: string;
  private readonly defaultLeaseDurationMs: number;
  private tasks = new Map<string, KanbanTask>();
  private drafts = new Map<string, TriageDraft>();
  private listeners: KanbanEventListener[] = [];

  constructor(options: KanbanBoardOptions = {}) {
    this.boardId = options.boardId ?? "default-board";
    this.defaultLeaseDurationMs = options.defaultLeaseDurationMs ?? 60_000;
  }

  public subscribe(listener: KanbanEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  private emit(event: KanbanEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscriber faults must not corrupt board state.
      }
    }
  }

  private assertDependenciesExist(dependencies: string[]): void {
    for (const depId of dependencies) {
      if (!this.tasks.has(depId)) throw new Error(`Dependency ${depId} does not exist`);
    }
  }

  private assertDependenciesComplete(dependencies: string[]): void {
    for (const depId of dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep) throw new Error(`Dependency ${depId} does not exist`);
      if (dep.state !== "done") {
        throw new Error(`Dependency ${depId} (${dep.title}) is ${dep.state}, not done`);
      }
    }
  }

  private assertActiveLease(task: KanbanTask, identity: LeaseIdentity, operation: string): void {
    const now = Date.now();
    if (!task.assignee || task.claimExpires === null || task.claimExpires === undefined) {
      throw new Error(`Cannot ${operation} task '${task.id}': task has no active lease`);
    }
    if (task.claimExpires <= now) {
      throw new Error(`Cannot ${operation} task '${task.id}': lease has expired`);
    }
    if (task.assignee !== identity.workerId) {
      throw new Error(
        `Cannot ${operation} task '${task.id}': worker mismatch (claimed by '${task.assignee}', got '${identity.workerId}')`,
      );
    }
    if (task.leaseGeneration !== identity.generation) {
      throw new Error(
        `Cannot ${operation} task '${task.id}': lease generation mismatch (expected ${task.leaseGeneration ?? 0}, got ${identity.generation})`,
      );
    }
  }

  public createTask(input: {
    id?: string;
    title: string;
    description?: string;
    state?: KanbanTaskState;
    priority?: KanbanTaskPriority;
    assignee?: string | null;
    parentTaskId?: string | null;
    dependencies?: string[];
    metadata?: Record<string, unknown>;
  }): KanbanTask {
    const id = input.id ?? `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (this.tasks.has(id)) throw new Error(`Task with id '${id}' already exists`);

    const dependencies = Array.from(new Set(input.dependencies ?? []));
    this.assertDependenciesExist(dependencies);
    const initialState = input.state ?? "backlog";
    if (stateRequiresCompletedDependencies(initialState)) {
      this.assertDependenciesComplete(dependencies);
    }

    let parent: KanbanTask | undefined;
    if (input.parentTaskId) {
      if (input.parentTaskId === id) throw new Error(`Task '${id}' cannot be its own parent`);
      parent = this.tasks.get(input.parentTaskId);
      if (!parent) throw new Error(`Parent task ${input.parentTaskId} does not exist`);
    }

    const now = Date.now();
    const task: KanbanTask = {
      id,
      boardId: this.boardId,
      title: input.title,
      description: input.description,
      state: initialState,
      priority: input.priority ?? "normal",
      assignee: input.assignee ?? null,
      workerPid: null,
      parentTaskId: input.parentTaskId ?? null,
      dependencies,
      childTaskIds: [],
      createdAt: now,
      startedAt: initialState === "in_progress" ? now : null,
      completedAt: initialState === "done" ? now : null,
      claimExpires: null,
      lastHeartbeatAt: null,
      leaseGeneration: 0,
      metadata: input.metadata ? { ...input.metadata } : {},
    };

    if (parent && !parent.childTaskIds.includes(id)) parent.childTaskIds.push(id);

    this.tasks.set(id, task);
    this.emit({
      type: "task.created",
      taskId: id,
      boardId: this.boardId,
      timestamp: now,
      payload: { task: { ...task } },
    });
    return { ...task, dependencies: [...task.dependencies], childTaskIds: [...task.childTaskIds] };
  }

  public getTask(id: string): KanbanTask | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task, dependencies: [...task.dependencies], childTaskIds: [...task.childTaskIds] } : undefined;
  }

  public listTasks(filter?: {
    state?: KanbanTaskState;
    assignee?: string | null;
    priority?: KanbanTaskPriority;
    parentTaskId?: string | null;
  }): KanbanTask[] {
    const list: KanbanTask[] = [];
    for (const task of this.tasks.values()) {
      if (filter?.state && task.state !== filter.state) continue;
      if (filter?.assignee !== undefined && task.assignee !== filter.assignee) continue;
      if (filter?.priority && task.priority !== filter.priority) continue;
      if (filter?.parentTaskId !== undefined && task.parentTaskId !== filter.parentTaskId) continue;
      list.push({ ...task, dependencies: [...task.dependencies], childTaskIds: [...task.childTaskIds] });
    }
    return list;
  }

  public canTransitionToInProgress(taskId: string): { allowed: boolean; reason?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { allowed: false, reason: "Task not found" };
    try {
      this.assertDependenciesComplete(task.dependencies);
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: (error as Error).message };
    }
  }

  public updateTaskState(
    taskId: string,
    nextState: KanbanTaskState,
    options?: { force?: boolean; workerId?: string; generation?: number },
  ): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task with id '${taskId}' not found`);

    if (!options?.force) {
      const hasWorkerId = options?.workerId !== undefined;
      const hasGeneration = options?.generation !== undefined;
      if (hasWorkerId !== hasGeneration) {
        throw new Error(`Cannot update task '${taskId}': workerId and generation must be supplied together`);
      }
      const requiresLeaseIdentity = Boolean(task.assignee) || (task.leaseGeneration ?? 0) > 0 || hasWorkerId;
      if (requiresLeaseIdentity) {
        if (!options?.workerId || options.generation === undefined) {
          throw new Error(`Cannot update task '${taskId}': an active lease identity is required`);
        }
        this.assertActiveLease(task, { workerId: options.workerId, generation: options.generation }, "update");
      }

      if (stateRequiresCompletedDependencies(nextState)) {
        this.assertDependenciesComplete(task.dependencies);
      }
    }

    const previousState = task.state;
    task.state = nextState;
    const now = Date.now();
    if (nextState === "in_progress" && !task.startedAt) task.startedAt = now;
    if (nextState === "done" || nextState === "archived" || nextState === "failed") {
      task.completedAt = now;
      if (task.assignee) task.leaseGeneration = (task.leaseGeneration ?? 0) + 1;
      task.assignee = null;
      task.workerPid = null;
      task.claimExpires = null;
    }

    this.emit({
      type: "task.state_changed",
      taskId,
      boardId: this.boardId,
      timestamp: now,
      payload: { previousState, nextState, task: { ...task } },
    });
    return { ...task, dependencies: [...task.dependencies], childTaskIds: [...task.childTaskIds] };
  }

  public claimTask(
    taskId: string,
    assignee: string,
    options?: { leaseDurationMs?: number; workerPid?: number },
  ): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task with id '${taskId}' not found`);
    if (task.state === "backlog" || task.state === "triage") this.assertDependenciesComplete(task.dependencies);

    const now = Date.now();
    const isExpired = task.claimExpires !== null && task.claimExpires !== undefined && task.claimExpires <= now;
    if (task.assignee && task.assignee !== assignee && !isExpired && task.state === "in_progress") {
      throw new Error(`Task is already claimed by ${task.assignee} until ${new Date(task.claimExpires ?? 0).toISOString()}`);
    }

    const leaseDuration = options?.leaseDurationMs ?? this.defaultLeaseDurationMs;
    if (!Number.isFinite(leaseDuration) || leaseDuration <= 0) {
      throw new Error("leaseDurationMs must be a positive finite number");
    }
    task.assignee = assignee;
    task.workerPid = options?.workerPid ?? null;
    task.lastHeartbeatAt = now;
    task.claimExpires = now + leaseDuration;
    task.leaseGeneration = (task.leaseGeneration ?? 0) + 1;

    if (task.state === "backlog" || task.state === "triage") {
      task.state = "in_progress";
      task.startedAt = now;
    }

    this.emit({
      type: "task.assigned",
      taskId,
      boardId: this.boardId,
      timestamp: now,
      payload: {
        assignee,
        claimExpires: task.claimExpires,
        workerPid: task.workerPid,
        leaseGeneration: task.leaseGeneration,
      },
    });
    return { ...task, dependencies: [...task.dependencies], childTaskIds: [...task.childTaskIds] };
  }

  public heartbeat(
    taskId: string,
    identity: LeaseIdentity & { leaseDurationMs?: number },
  ): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task with id '${taskId}' not found`);
    this.assertActiveLease(task, identity, "heartbeat");

    const duration = identity.leaseDurationMs ?? this.defaultLeaseDurationMs;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("leaseDurationMs must be a positive finite number");
    }
    const now = Date.now();
    task.lastHeartbeatAt = now;
    task.claimExpires = now + duration;
    this.emit({
      type: "task.heartbeat",
      taskId,
      boardId: this.boardId,
      timestamp: now,
      payload: {
        lastHeartbeatAt: now,
        claimExpires: task.claimExpires,
        leaseGeneration: task.leaseGeneration,
      },
    });
    return { ...task, dependencies: [...task.dependencies], childTaskIds: [...task.childTaskIds] };
  }

  public setTaskClaimExpiry(taskId: string, expiresAt: number | null): void {
    const task = this.tasks.get(taskId);
    if (task) task.claimExpires = expiresAt;
  }

  public releaseTask(taskId: string, identity: LeaseIdentity): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task with id '${taskId}' not found`);
    this.assertActiveLease(task, identity, "release");

    const previousAssignee = task.assignee;
    task.assignee = null;
    task.workerPid = null;
    task.claimExpires = null;
    task.leaseGeneration = (task.leaseGeneration ?? 0) + 1;
    if (task.state === "in_progress") task.state = "triage";

    this.emit({
      type: "task.unassigned",
      taskId,
      boardId: this.boardId,
      timestamp: Date.now(),
      payload: { previousAssignee, leaseGeneration: task.leaseGeneration },
    });
    return { ...task, dependencies: [...task.dependencies], childTaskIds: [...task.childTaskIds] };
  }

  public reclaimExpiredLeases(): string[] {
    const now = Date.now();
    const reclaimed: string[] = [];
    for (const [id, task] of this.tasks.entries()) {
      if (
        task.state === "in_progress" &&
        task.claimExpires !== null &&
        task.claimExpires !== undefined &&
        task.claimExpires <= now
      ) {
        const expiredAssignee = task.assignee;
        task.assignee = null;
        task.workerPid = null;
        task.claimExpires = null;
        task.leaseGeneration = (task.leaseGeneration ?? 0) + 1;
        task.state = "triage";
        reclaimed.push(id);
        this.emit({
          type: "task.lease_expired",
          taskId: id,
          boardId: this.boardId,
          timestamp: now,
          payload: { expiredAssignee, leaseGeneration: task.leaseGeneration },
        });
      }
    }
    return reclaimed;
  }

  public createTriageDraft(input: {
    id?: string;
    title: string;
    body: string;
    suggestedTasks?: Array<{
      title: string;
      description?: string;
      priority?: KanbanTaskPriority;
      dependencies?: string[];
    }>;
    messageId?: string | number | null;
  }): TriageDraft {
    const id = input.id ?? `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const draft: TriageDraft = {
      id,
      title: input.title,
      body: input.body,
      suggestedTasks: input.suggestedTasks ? [...input.suggestedTasks] : [],
      createdAt: Date.now(),
      messageId: input.messageId ?? null,
    };
    this.drafts.set(id, draft);
    this.emit({
      type: "triage.draft_created",
      boardId: this.boardId,
      timestamp: Date.now(),
      payload: { draft: { ...draft } },
    });
    return { ...draft };
  }

  public launchTriage(draftId: string): { parentTask: KanbanTask; childTasks: KanbanTask[] } {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error(`Triage draft with id '${draftId}' not found`);

    const parentTask = this.createTask({
      title: draft.title,
      description: draft.body,
      state: "in_progress",
      priority: "high",
    });
    const childTasks: KanbanTask[] = [];
    const indexToCreatedId = new Map<number, string>();

    draft.suggestedTasks.forEach((suggestion, index) => {
      const child = this.createTask({
        title: suggestion.title,
        description: suggestion.description,
        state: "backlog",
        priority: suggestion.priority ?? "normal",
        parentTaskId: parentTask.id,
      });
      indexToCreatedId.set(index, child.id);
      childTasks.push(child);
    });

    draft.suggestedTasks.forEach((suggestion, index) => {
      const currentId = indexToCreatedId.get(index);
      if (!currentId || !suggestion.dependencies?.length) return;
      const currentTask = this.tasks.get(currentId);
      if (!currentTask) return;

      for (const dependency of suggestion.dependencies) {
        const dependencyIndex = Number.parseInt(dependency, 10);
        if (!Number.isNaN(dependencyIndex) && indexToCreatedId.has(dependencyIndex)) {
          const resolvedId = indexToCreatedId.get(dependencyIndex);
          if (resolvedId && !currentTask.dependencies.includes(resolvedId)) currentTask.dependencies.push(resolvedId);
        } else {
          const found = childTasks.find(
            (candidate) => candidate.title.toLowerCase() === dependency.toLowerCase(),
          );
          if (found && !currentTask.dependencies.includes(found.id)) currentTask.dependencies.push(found.id);
        }
      }
    });

    this.drafts.delete(draftId);
    this.emit({
      type: "triage.launched",
      taskId: parentTask.id,
      boardId: this.boardId,
      timestamp: Date.now(),
      payload: {
        draftId,
        parentTaskId: parentTask.id,
        childTaskIds: childTasks.map((task) => task.id),
      },
    });
    return {
      parentTask: { ...parentTask },
      childTasks: childTasks.map((task) => this.getTask(task.id) ?? task),
    };
  }

  public exportState(): { tasks: KanbanTask[]; drafts: TriageDraft[] } {
    return {
      tasks: Array.from(this.tasks.values()).map((task) => ({
        ...task,
        dependencies: [...task.dependencies],
        childTaskIds: [...task.childTaskIds],
      })),
      drafts: Array.from(this.drafts.values()).map((draft) => ({ ...draft })),
    };
  }

  public importState(data: { tasks?: KanbanTask[]; drafts?: TriageDraft[] }): void {
    this.tasks.clear();
    this.drafts.clear();
    for (const task of data.tasks ?? []) {
      this.tasks.set(task.id, {
        ...task,
        dependencies: [...(task.dependencies ?? [])],
        childTaskIds: [...(task.childTaskIds ?? [])],
        leaseGeneration: task.leaseGeneration ?? 0,
      });
    }
    for (const draft of data.drafts ?? []) this.drafts.set(draft.id, { ...draft });
  }
}
