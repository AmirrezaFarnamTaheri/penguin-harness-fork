/**
 * Dependency-aware task fan-out and barrier-join for the mesh.
 *
 * What this is for: `agent/workflow-pipeline.ts` already settles a *static*
 * node/edge DAG that a host authors. This is the dynamic counterpart — given
 * one objective, it decides *how the work splits into parallel waves right
 * now*, who may start simultaneously, and what to cancel when a dependency
 * fails. It owns no execution: it produces a schedule the caller dispatches.
 *
 * Algorithms, all real:
 *  - cycle detection over the subtask dependency graph (a dependency cycle
 *    makes a plan unrunnable and is reported rather than silently hung);
 *  - topological levelling via Kahn's algorithm over in-degrees, producing
 *    the parallel waves — two subtasks share a wave iff neither depends on
 *    the other, so a wave is genuinely concurrent;
 *  - worker-budget chunking inside a wave, so a 9-item wave on a 4-worker
 *    budget becomes chunks of 4/4/1, never 9 simultaneous dispatches;
 *  - barrier recomputation as subtasks complete, advancing the ready set
 *    without re-running the whole levelling pass;
 *  - cascade cancellation: a failed subtask poisons its transitive
 *    dependents, and the failure frontier is computed by BFS over dependents.
 */

export type SubtaskStatus = "pending" | "ready" | "running" | "succeeded" | "failed" | "cancelled";

export interface Subtask {
  id: string;
  goal: string;
  /** Ids of subtasks that must succeed before this one may start. */
  dependencies: string[];
  /** Role the allocator should staff this with, if any. */
  roleId?: string;
  estimatedCost: number;
  status: SubtaskStatus;
}

export interface ParallelWave {
  index: number;
  subtaskIds: string[];
  /** Budget-respecting chunks within the wave; dispatch one chunk at a time. */
  chunks: string[][];
}

export interface FanOutPlan {
  waves: ParallelWave[];
  cycle: string[] | null;
  readyNow: string[];
  /** Subtasks that can never become ready because a dependency failed. */
  poisoned: string[];
  totalCost: number;
  criticalPathLength: number;
}

export interface TaskParallelizerOptions {
  /** Max subtasks running at once; the worker budget the plan respects. */
  workerBudget?: number;
  /** Max subtasks in one graph before fan-out is refused. */
  maxSubtasks?: number;
  /** Max dependency edges, a guard against pathological plans. */
  maxEdges?: number;
}

export class TaskParallelizer {
  private readonly subtasks = new Map<string, Subtask>();
  private readonly options: Required<TaskParallelizerOptions>;

  constructor(options: TaskParallelizerOptions = {}) {
    this.options = {
      workerBudget: Math.max(1, options.workerBudget ?? 4),
      maxSubtasks: Math.max(1, options.maxSubtasks ?? 512),
      maxEdges: Math.max(1, options.maxEdges ?? 4_096),
    };
  }

  public addSubtask(subtask: Subtask): Subtask {
    const id = subtask.id.trim();
    if (!id) throw new Error("Subtask id cannot be empty");
    if (this.subtasks.has(id)) {
      throw new Error(`Duplicate subtask id '${id}' in task parallelizer`);
    }
    if (this.subtasks.size >= this.options.maxSubtasks) {
      throw new Error(`Task parallelizer subtask limit reached (${this.options.maxSubtasks})`);
    }
    const stored: Subtask = {
      ...subtask,
      id,
      dependencies: Array.from(
        new Set(subtask.dependencies.map((dependency) => dependency.trim())),
      ),
      estimatedCost: Math.max(0, subtask.estimatedCost),
      status: subtask.status,
    };
    this.subtasks.set(id, stored);
    return { ...stored, dependencies: [...stored.dependencies] };
  }

  public getSubtask(id: string): Subtask | undefined {
    const subtask = this.subtasks.get(id.trim());
    return subtask ? { ...subtask, dependencies: [...subtask.dependencies] } : undefined;
  }

  public listSubtasks(filter?: { status?: SubtaskStatus }): Subtask[] {
    return Array.from(this.subtasks.values())
      .filter((subtask) => !filter?.status || subtask.status === filter.status)
      .map((subtask) => ({ ...subtask, dependencies: [...subtask.dependencies] }));
  }

  public size(): number {
    return this.subtasks.size;
  }

  /** Validates that every dependency edge points at a real subtask. */
  public validateDependencies(): { valid: boolean; dangling: string[]; selfEdges: string[] } {
    const dangling = new Set<string>();
    const selfEdges = new Set<string>();
    for (const subtask of this.subtasks.values()) {
      for (const dependency of subtask.dependencies) {
        if (dependency === subtask.id) selfEdges.add(subtask.id);
        if (!this.subtasks.has(dependency)) dangling.add(dependency);
      }
    }
    return {
      valid: dangling.size === 0 && selfEdges.size === 0,
      dangling: Array.from(dangling),
      selfEdges: Array.from(selfEdges),
    };
  }

  /**
   * Cycle detection by DFS over the dependency graph. A dependency cycle is
   * fatal to the plan — nothing on it can ever become ready — so it is
   * reported as a path rather than tolerated.
   */
  public detectCycle(): string[] | null {
    const colour = new Map<string, number>();
    const stack: string[] = [];

    const visit = (id: string): string[] | null => {
      colour.set(id, 1);
      stack.push(id);
      const subtask = this.subtasks.get(id);
      for (const dependency of subtask?.dependencies ?? []) {
        const state = colour.get(dependency) ?? 0;
        if (state === 1) {
          const from = stack.indexOf(dependency);
          return from >= 0 ? stack.slice(from).concat(dependency) : null;
        }
        if (state === 0) {
          const found = visit(dependency);
          if (found) return found;
        }
      }
      stack.pop();
      colour.set(id, 2);
      return null;
    };

    for (const id of this.subtasks.keys()) {
      if ((colour.get(id) ?? 0) === 0) {
        const found = visit(id);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Kahn's algorithm: repeatedly peel off every subtask whose dependencies are
   * all already placed, and each peel is one parallel wave. O(V + E).
   */
  public computeWaves(): ParallelWave[] {
    const remaining = new Map<string, Set<string>>();
    for (const subtask of this.subtasks.values()) {
      const unmet = new Set<string>();
      for (const dependency of subtask.dependencies) {
        if (this.subtasks.has(dependency)) unmet.add(dependency);
      }
      remaining.set(subtask.id, unmet);
    }

    const waves: ParallelWave[] = [];
    const placed = new Set<string>();
    let waveIndex = 0;

    while (placed.size < this.subtasks.size) {
      const level: string[] = [];
      for (const [id, unmet] of remaining) {
        if (placed.has(id)) continue;
        let satisfied = true;
        for (const dependency of unmet) {
          if (!placed.has(dependency)) {
            satisfied = false;
            break;
          }
        }
        if (satisfied) level.push(id);
      }
      if (level.length === 0) break; // cycle or stuck; caller sees detectCycle()

      for (const id of level) placed.add(id);
      waves.push({
        index: waveIndex++,
        subtaskIds: level,
        chunks: this.chunk(level),
      });
    }
    return waves;
  }

  /**
   * The full plan: waves, immediate readiness, the poison frontier, and the
   * critical path length (the longest dependency chain, which bounds the
   * minimum wall-clock time no matter how many workers you throw at it).
   */
  public fanOut(): FanOutPlan {
    const cycle = this.detectCycle();
    const waves = cycle ? [] : this.computeWaves();
    const readyNow = this.readySet();
    const poisoned = cycle ? [] : this.computePoisoned();
    const totalCost = Array.from(this.subtasks.values()).reduce(
      (sum, subtask) => sum + subtask.estimatedCost,
      0,
    );

    return {
      waves,
      cycle,
      readyNow,
      poisoned,
      totalCost,
      criticalPathLength: this.criticalPathLength(),
    };
  }

  /** Marks `id` complete and recomputes what just became runnable. */
  public complete(id: string, succeeded: boolean): { advanced: string[]; poisoned: string[] } {
    const subtask = this.subtasks.get(id.trim());
    if (!subtask) throw new Error(`Cannot complete unknown subtask '${id}'`);
    const TERMINAL: SubtaskStatus[] = ["succeeded", "failed", "cancelled"];
    if (TERMINAL.includes(subtask.status)) {
      throw new Error(
        `Cannot complete subtask '${subtask.id}': it already reached the terminal status '${subtask.status}'; only non-terminal subtasks may be completed`,
      );
    }
    subtask.status = succeeded ? "succeeded" : "failed";

    if (!succeeded) {
      const poisoned = this.computePoisoned();
      for (const poisonedId of poisoned) {
        const poisonedTask = this.subtasks.get(poisonedId);
        if (poisonedTask && poisonedTask.status === "pending") poisonedTask.status = "cancelled";
      }
      return { advanced: [], poisoned };
    }

    return { advanced: this.readySet(), poisoned: [] };
  }

  /**
   * The subtasks runnable right now: dependencies all succeeded, status
   * pending. Computed by a single scan, not a re-levelling.
   */
  public readySet(): string[] {
    const statusOf = (id: string): SubtaskStatus | undefined => this.subtasks.get(id)?.status;
    return Array.from(this.subtasks.values())
      .filter((subtask) => {
        if (subtask.status !== "pending") return false;
        return subtask.dependencies.every((dependency) => statusOf(dependency) === "succeeded");
      })
      .map((subtask) => subtask.id);
  }

  // ---------------------------------------------------------------- internals

  /**
   * Splits a wave into chunks no bigger than the worker budget. Chunking
   * inside a wave keeps the dispatch count honest with the available workers.
   */
  private chunk(ids: string[]): string[][] {
    const budget = this.options.workerBudget;
    if (ids.length <= budget) return ids.length === 0 ? [] : [ids];
    const chunks: string[][] = [];
    for (let start = 0; start < ids.length; start += budget) {
      chunks.push(ids.slice(start, start + budget));
    }
    return chunks;
  }

  /**
   * BFS over the *dependents* graph from every already-failed subtask. A
   * subtask whose dependency failed can never run, so it is poisoned — and
   * poison is transitive.
   */
  private computePoisoned(): string[] {
    const dependents = new Map<string, string[]>();
    for (const subtask of this.subtasks.values()) {
      for (const dependency of subtask.dependencies) {
        const list = dependents.get(dependency) ?? [];
        list.push(subtask.id);
        dependents.set(dependency, list);
      }
    }

    const poisoned = new Set<string>();
    const queue: string[] = [];
    for (const subtask of this.subtasks.values()) {
      if (subtask.status === "failed" || subtask.status === "cancelled") {
        if (!poisoned.has(subtask.id)) {
          poisoned.add(subtask.id);
          queue.push(subtask.id);
        }
      }
    }

    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const dependent of dependents.get(current) ?? []) {
        if (!poisoned.has(dependent)) {
          poisoned.add(dependent);
          queue.push(dependent);
        }
      }
    }
    return Array.from(poisoned);
  }

  /**
   * Longest dependency chain, by memoised depth. This is the lower bound on
   * wall-clock time: extra workers cannot shorten it, only widen the waves.
   */
  private criticalPathLength(): number {
    const memo = new Map<string, number>();
    const depthOf = (id: string, ancestors: Set<string>): number => {
      if (memo.has(id)) return memo.get(id) as number;
      if (ancestors.has(id)) return 0; // defensive: cycle contributes nothing
      const subtask = this.subtasks.get(id);
      if (!subtask) return 0;
      const next = new Set(ancestors).add(id);
      let deepest = 0;
      for (const dependency of subtask.dependencies) {
        deepest = Math.max(deepest, depthOf(dependency, next));
      }
      const depth = deepest + 1;
      memo.set(id, depth);
      return depth;
    };

    let longest = 0;
    for (const id of this.subtasks.keys()) {
      longest = Math.max(longest, depthOf(id, new Set()));
    }
    return longest;
  }
}
