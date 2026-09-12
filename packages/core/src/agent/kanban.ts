/**
 * Agent Kanban & Task Orchestration Engine.
 *
 * Implements a full state machine for autonomous and human-guided task pipelines,
 * subagent leases with heartbeats, dependency-aware task transitions, and
 * conversational triage draft decomposition.
 *
 * Synthesized from kandev, hermes-war-room, and paperclip task architectures.
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
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: KanbanEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Silently isolate subscriber faults
      }
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
    const task: KanbanTask = {
      id,
      boardId: this.boardId,
      title: input.title,
      description: input.description,
      state: input.state ?? "backlog",
      priority: input.priority ?? "normal",
      assignee: input.assignee ?? null,
      workerPid: null,
      parentTaskId: input.parentTaskId ?? null,
      dependencies: [...(input.dependencies ?? [])],
      childTaskIds: [],
      createdAt: Date.now(),
      startedAt: input.state === "in_progress" ? Date.now() : null,
      completedAt: input.state === "done" ? Date.now() : null,
      claimExpires: null,
      lastHeartbeatAt: null,
      leaseGeneration: 0,
      metadata: input.metadata ? { ...input.metadata } : {},
    };

    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent && !parent.childTaskIds.includes(id)) {
        parent.childTaskIds.push(id);
      }
    }

    this.tasks.set(id, task);
    this.emit({
      type: "task.created",
      taskId: id,
      boardId: this.boardId,
      timestamp: Date.now(),
      payload: { task: { ...task } },
    });

    return { ...task };
  }

  public getTask(id: string): KanbanTask | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task } : undefined;
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
      list.push({ ...task });
    }
    return list;
  }

  public canTransitionToInProgress(taskId: string): { allowed: boolean; reason?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { allowed: false, reason: "Task not found" };

    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep) {
        return { allowed: false, reason: `Dependency ${depId} does not exist` };
      }
      if (dep.state !== "done") {
        return { allowed: false, reason: `Dependency ${depId} (${dep.title}) is ${dep.state}, not done` };
      }
    }

    return { allowed: true };
  }

  public updateTaskState(
    taskId: string,
    nextState: KanbanTaskState,
    options?: { force?: boolean; workerId?: string; generation?: number }
  ): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id '${taskId}' not found`);
    }

    if (options?.workerId !== undefined && task.assignee && task.assignee !== options.workerId) {
      throw new Error(`Cannot update task '${taskId}': worker mismatch (claimed by '${task.assignee}', got '${options.workerId}')`);
    }

    if (options?.generation !== undefined && task.leaseGeneration !== undefined && task.leaseGeneration !== options.generation) {
      throw new Error(`Cannot update task '${taskId}': lease generation mismatch (expected ${task.leaseGeneration}, got ${options.generation})`);
    }

    if (nextState === "in_progress" && !options?.force) {
      const check = this.canTransitionToInProgress(taskId);
      if (!check.allowed) {
        throw new Error(`Cannot move task to in_progress: ${check.reason}`);
      }
    }

    const previousState = task.state;
    task.state = nextState;

    if (nextState === "in_progress" && !task.startedAt) {
      task.startedAt = Date.now();
    }
    if (nextState === "done" || nextState === "archived") {
      task.completedAt = Date.now();
      task.claimExpires = null;
    }

    this.emit({
      type: "task.state_changed",
      taskId,
      boardId: this.boardId,
      timestamp: Date.now(),
      payload: { previousState, nextState, task: { ...task } },
    });

    return { ...task };
  }

  public claimTask(
    taskId: string,
    assignee: string,
    options?: { leaseDurationMs?: number; workerPid?: number }
  ): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id '${taskId}' not found`);
    }

    // Enforce dependency constraints before transitioning to in_progress
    if (task.state === "backlog" || task.state === "triage") {
      const check = this.canTransitionToInProgress(taskId);
      if (!check.allowed) {
        throw new Error(`Cannot claim task: ${check.reason}`);
      }
    }

    const now = Date.now();
    const isExpired = task.claimExpires !== null && task.claimExpires !== undefined && task.claimExpires < now;
    if (task.assignee && task.assignee !== assignee && !isExpired && task.state === "in_progress") {
      throw new Error(`Task is already claimed by ${task.assignee} until ${new Date(task.claimExpires ?? 0).toISOString()}`);
    }

    const leaseDuration = options?.leaseDurationMs ?? this.defaultLeaseDurationMs;
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
      payload: { assignee, claimExpires: task.claimExpires, workerPid: task.workerPid, leaseGeneration: task.leaseGeneration },
    });

    return { ...task };
  }

  public heartbeat(
    taskId: string,
    optionsOrDuration?: number | { leaseDurationMs?: number; workerId?: string; generation?: number }
  ): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id '${taskId}' not found`);
    }

    let duration = this.defaultLeaseDurationMs;
    if (typeof optionsOrDuration === "number") {
      duration = optionsOrDuration;
    } else if (typeof optionsOrDuration === "object" && optionsOrDuration !== null) {
      if (optionsOrDuration.leaseDurationMs !== undefined) {
        duration = optionsOrDuration.leaseDurationMs;
      }
      if (optionsOrDuration.workerId !== undefined && task.assignee !== optionsOrDuration.workerId) {
        throw new Error(`Cannot heartbeat task '${taskId}': worker mismatch (claimed by '${task.assignee}', got '${optionsOrDuration.workerId}')`);
      }
      if (optionsOrDuration.generation !== undefined && task.leaseGeneration !== optionsOrDuration.generation) {
        throw new Error(`Cannot heartbeat task '${taskId}': lease generation mismatch (expected ${task.leaseGeneration}, got ${optionsOrDuration.generation})`);
      }
    }

    const now = Date.now();
    task.lastHeartbeatAt = now;
    task.claimExpires = now + duration;

    this.emit({
      type: "task.heartbeat",
      taskId,
      boardId: this.boardId,
      timestamp: now,
      payload: { lastHeartbeatAt: now, claimExpires: task.claimExpires, leaseGeneration: task.leaseGeneration },
    });

    return { ...task };
  }

  public setTaskClaimExpiry(taskId: string, expiresAt: number | null): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.claimExpires = expiresAt;
    }
  }

  public releaseTask(
    taskId: string,
    options?: { workerId?: string; generation?: number }
  ): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with id '${taskId}' not found`);
    }

    if (options?.workerId !== undefined && task.assignee && task.assignee !== options.workerId) {
      throw new Error(`Cannot release task '${taskId}': worker mismatch (claimed by '${task.assignee}', got '${options.workerId}')`);
    }

    if (options?.generation !== undefined && task.leaseGeneration !== undefined && task.leaseGeneration !== options.generation) {
      throw new Error(`Cannot release task '${taskId}': lease generation mismatch (expected ${task.leaseGeneration}, got ${options.generation})`);
    }

    const previousAssignee = task.assignee;
    task.assignee = null;
    task.workerPid = null;
    task.claimExpires = null;

    if (task.state === "in_progress") {
      task.state = "triage";
    }

    this.emit({
      type: "task.unassigned",
      taskId,
      boardId: this.boardId,
      timestamp: Date.now(),
      payload: { previousAssignee, leaseGeneration: task.leaseGeneration },
    });

    return { ...task };
  }

  public reclaimExpiredLeases(): string[] {
    const now = Date.now();
    const reclaimed: string[] = [];

    for (const [id, task] of this.tasks.entries()) {
      if (
        task.state === "in_progress" &&
        task.claimExpires !== null &&
        task.claimExpires !== undefined &&
        task.claimExpires < now
      ) {
        const expiredAssignee = task.assignee;
        task.assignee = null;
        task.workerPid = null;
        task.claimExpires = null;
        task.state = "triage";
        reclaimed.push(id);

        this.emit({
          type: "task.lease_expired",
          taskId: id,
          boardId: this.boardId,
          timestamp: now,
          payload: { expiredAssignee },
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
    if (!draft) {
      throw new Error(`Triage draft with id '${draftId}' not found`);
    }

    // Create root triage task
    const parentTask = this.createTask({
      title: draft.title,
      description: draft.body,
      state: "in_progress",
      priority: "high",
    });

    const childTasks: KanbanTask[] = [];
    const indexToCreatedId = new Map<number, string>();

    // Pass 1: create all children
    draft.suggestedTasks.forEach((st, idx) => {
      const child = this.createTask({
        title: st.title,
        description: st.description,
        state: "backlog",
        priority: st.priority ?? "normal",
        parentTaskId: parentTask.id,
      });
      indexToCreatedId.set(idx, child.id);
      childTasks.push(child);
    });

    // Pass 2: link index-based or name-based dependencies
    draft.suggestedTasks.forEach((st, idx) => {
      const currentId = indexToCreatedId.get(idx);
      if (!currentId || !st.dependencies || st.dependencies.length === 0) return;

      const currentTask = this.tasks.get(currentId);
      if (!currentTask) return;

      for (const dep of st.dependencies) {
        // If dep is integer string index
        const depIdx = parseInt(dep, 10);
        if (!isNaN(depIdx) && indexToCreatedId.has(depIdx)) {
          const resolvedId = indexToCreatedId.get(depIdx);
          if (resolvedId && !currentTask.dependencies.includes(resolvedId)) {
            currentTask.dependencies.push(resolvedId);
          }
        } else {
          // If dep is title match
          const found = childTasks.find((c) => c.title.toLowerCase() === dep.toLowerCase());
          if (found && !currentTask.dependencies.includes(found.id)) {
            currentTask.dependencies.push(found.id);
          }
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
        childTaskIds: childTasks.map((c) => c.id),
      },
    });

    return {
      parentTask: { ...parentTask },
      childTasks: childTasks.map((c) => this.tasks.get(c.id) ?? c),
    };
  }

  public exportState(): { tasks: KanbanTask[]; drafts: TriageDraft[] } {
    return {
      tasks: Array.from(this.tasks.values()).map((t) => ({ ...t })),
      drafts: Array.from(this.drafts.values()).map((d) => ({ ...d })),
    };
  }

  public importState(data: { tasks?: KanbanTask[]; drafts?: TriageDraft[] }): void {
    if (data.tasks) {
      this.tasks.clear();
      for (const t of data.tasks) {
        this.tasks.set(t.id, { ...t });
      }
    }
    if (data.drafts) {
      this.drafts.clear();
      for (const d of data.drafts) {
        this.drafts.set(d.id, { ...d });
      }
    }
  }
}
