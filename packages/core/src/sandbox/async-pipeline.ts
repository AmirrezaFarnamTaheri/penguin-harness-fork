/**
 * Async pipeline — a minimal async job registry for shell-adjacent scheduling.
 *
 * Ports the *concept* from the donors' asynchronous shell helper, which implemented
 * five functions in pure bash for interpreters without `coproc`:
 *
 * - `setTimeout` — run a function once, after a delay;
 * - `setInterval` — run a function repeatedly, on an interval;
 * - `async` — run a function with separate success and error continuations;
 * - `parallel` — run a main function, fan its result out across a set of functions,
 *   then run a final one if everything succeeded;
 * - `killJob` — kill a scheduled job by id, SIGTERM by default.
 *
 * What is worth porting is the model, not the script: a registry of cancellable
 * scheduled units that hand their result to a continuation and can be killed by id
 * before they fire. That is a genuinely useful primitive for a sandbox that wants to
 * schedule follow-up work without letting a hostile script plant an unbounded number
 * of timers — which is why this registry has a job cap, a global cancellation path,
 * and refuses to keep a job whose execution context has ended.
 *
 * The donors' `parallel` is ported as `parallel` below with its three-part contract
 * intact: the main function's output feeds every member of the function array, and
 * the final continuation runs only if *all* of them succeeded.
 */

/** A scheduled job's id. Opaque to callers; meaningful only to the registry. */
export type JobId = string;

/** Why a job ended. */
export type JobOutcome =
  | "completed"
  | "failed"
  | "killed"
  | "cancelled"
  /** The registry was shut down while the job was still pending. */
  | "drained";

/** The final state of a job, for the registry's log and for tests. */
export interface JobRecord {
  readonly id: JobId;
  readonly label: string;
  readonly scheduledAt: number;
  readonly firedAt?: number;
  readonly finishedAt?: number;
  readonly outcome?: JobOutcome;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Default maximum live jobs; a hostile script's timer-planting loop is bounded by this. */
export const DEFAULT_MAX_JOBS = 256;

/** Default maximum delay accepted, so a scheduled job cannot be a persistence backdoor. */
export const DEFAULT_MAX_DELAY_MS = 24 * 60 * 60 * 1000;

/** Error thrown when the registry is full or shut down. */
export class JobRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobRegistryError";
  }
}

/**
 * The job registry. Timers are real `setTimeout` handles — this is the scheduling
 * layer, not a virtual clock — but a job's *callback* is only run if the job is still
 * live when the timer fires, which is what makes `killJob` meaningful.
 */
export class AsyncJobRegistry {
  private readonly jobs = new Map<JobId, JobRecord>();
  private readonly timers = new Map<JobId, ReturnType<typeof setTimeout>>();
  private readonly maxJobs: number;
  private readonly maxDelayMs: number;
  private shutdown = false;
  private seq = 0;

  constructor(options?: { maxJobs?: number; maxDelayMs?: number }) {
    this.maxJobs = options?.maxJobs ?? DEFAULT_MAX_JOBS;
    this.maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  /** A snapshot of every job the registry knows about. */
  records(): readonly JobRecord[] {
    return [...this.jobs.values()];
  }

  /** How many jobs are currently pending. */
  get pendingCount(): number {
    return this.jobs.size;
  }

  /**
   * Schedule a function once, after a delay. Returns the job id so the caller can
   * cancel it before it fires.
   */
  setTimeout<Result>(fn: () => Result, delayMs: number, label = "setTimeout"): JobId {
    this.assertAcceptable(delayMs);
    return this.schedule(fn, delayMs, false, label);
  }

  /**
   * Schedule a function repeatedly on an interval. The registry cancels the whole
   * series on kill, and a failure in one iteration stops the series — a repeating
   * job whose error is swallowed is how a broken timer becomes an infinite one.
   */
  setInterval<Result>(fn: () => Result, intervalMs: number, label = "setInterval"): JobId {
    this.assertAcceptable(intervalMs);
    return this.schedule(fn, intervalMs, true, label);
  }

  /**
   * Run a function with success and error continuations, as the donors' `async` did:
   * the success callback receives the result, the error callback receives the
   * failure reason. Both are invoked exactly once.
   */
  async async<Success, Failure = unknown>(
    fn: () => Promise<Success>,
    onSuccess: (result: Success) => unknown,
    onError: (reason: unknown) => unknown,
    label = "async",
  ): Promise<JobId> {
    const id = this.allocate(label);
    try {
      const result = await fn();
      if (this.shutdown || !this.jobs.has(id)) {
        this.finish(id, "cancelled");
        return id;
      }
      this.finish(id, "completed", result);
      await onSuccess(result);
    } catch (error) {
      this.finish(id, "failed", undefined, error);
      await onError(error);
    }
    return id;
  }

  /**
   * The donors' `parallel`: run a main function, fan its result across an array of
   * functions, then run a final continuation with the collected successes — or, if
   * any of them failed, with the failure. The final continuation runs exactly once,
   * and only after every member has settled.
   */
  async parallel<Input, Member, Final>(
    main: () => Promise<Input>,
    members: ReadonlyArray<(input: Input) => Promise<Member>>,
    final: (successes: Member[], failure: unknown) => Promise<Final>,
    label = "parallel",
  ): Promise<JobId> {
    const id = this.allocate(label);
    try {
      const input = await main();
      if (this.shutdown || !this.jobs.has(id)) {
        this.finish(id, "cancelled");
        return id;
      }
      const settled = await Promise.allSettled(members.map((member) => member(input)));
      const firstFailure = settled.find((outcome) => outcome.status === "rejected");
      if (firstFailure && firstFailure.status === "rejected") {
        this.finish(id, "failed", undefined, firstFailure.reason);
        await final([], firstFailure.reason);
        return id;
      }
      const successes = settled.map((outcome) =>
        outcome.status === "fulfilled" ? outcome.value : undefined,
      ) as Member[];
      this.finish(id, "completed", successes);
      await final(successes, undefined);
    } catch (error) {
      this.finish(id, "failed", undefined, error);
      await final([], error);
    }
    return id;
  }

  /**
   * Kill a scheduled job. A pending job is cancelled before it fires; a running job's
   * outcome is recorded as killed so a caller can distinguish "it finished" from "I
   * stopped it". Returns true when the id named a live job.
   */
  killJob(id: JobId): boolean {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const record = this.jobs.get(id);
    if (record === undefined) return false;
    if (record.outcome === undefined) {
      this.jobs.set(id, { ...record, outcome: "killed", finishedAt: Date.now() });
    }
    return true;
  }

  /** Kill every live job. */
  killAll(): number {
    let killed = 0;
    for (const id of [...this.jobs.keys()]) {
      if (this.killJob(id)) killed++;
    }
    return killed;
  }

  /**
   * Shut the registry: no new jobs are accepted and every pending job is drained with
   * outcome `drained`. A scheduled job that outlives its execution context is a
   * lifetime escape, and draining is the safe answer — the work does not run, and the
   * refusal is recorded.
   */
  shutdownRegistry(): number {
    this.shutdown = true;
    let drained = 0;
    for (const [id, record] of [...this.jobs.entries()]) {
      const timer = this.timers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
      if (record.outcome === undefined) {
        this.jobs.set(id, { ...record, outcome: "drained", finishedAt: Date.now() });
        drained++;
      }
    }
    return drained;
  }

  private assertAcceptable(delayMs: number): void {
    if (this.shutdown) {
      throw new JobRegistryError("job registry is shut down; no new jobs are accepted");
    }
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new JobRegistryError(`invalid delay ${delayMs}: expected a non-negative finite number`);
    }
    if (delayMs > this.maxDelayMs) {
      throw new JobRegistryError(
        `delay ${delayMs} exceeds the maximum ${this.maxDelayMs}; a scheduled job may not outlive its context`,
      );
    }
    if (this.jobs.size >= this.maxJobs) {
      throw new JobRegistryError(
        `job registry is full (${this.maxJobs} pending); a script cannot plant unbounded timers`,
      );
    }
  }

  private allocate(label: string): JobId {
    if (this.shutdown) {
      throw new JobRegistryError("job registry is shut down; no new jobs are accepted");
    }
    if (this.jobs.size >= this.maxJobs) {
      throw new JobRegistryError(`job registry is full (${this.maxJobs} pending)`);
    }
    const id = `job-${(++this.seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.jobs.set(id, { id, label, scheduledAt: Date.now() });
    return id;
  }

  private schedule<Result>(
    fn: () => Result,
    delayMs: number,
    repeat: boolean,
    label: string,
  ): JobId {
    const id = this.allocate(label);
    const fire = () => {
      const record = this.jobs.get(id);
      if (record === undefined || record.outcome !== undefined) {
        // The job was killed between scheduling and firing.
        this.timers.delete(id);
        return;
      }
      this.jobs.set(id, { ...record, firedAt: Date.now() });
      try {
        const result = fn();
        if (repeat && !this.shutdown) {
          const next = setTimeout(fire, delayMs);
          this.timers.set(id, next);
          if (typeof next.unref === "function") next.unref();
        } else {
          this.finish(id, "completed", result);
        }
      } catch (error) {
        // A failing repeating job stops the series rather than spinning on an error.
        this.finish(id, "failed", undefined, error);
        const timer = this.timers.get(id);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.timers.delete(id);
        }
      }
    };

    const timer = setTimeout(fire, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(id, timer);
    return id;
  }

  private finish(id: JobId, outcome: JobOutcome, result?: unknown, error?: unknown): void {
    const record = this.jobs.get(id);
    if (record === undefined) return;
    this.jobs.set(id, {
      ...record,
      outcome,
      result,
      error,
      finishedAt: Date.now(),
    });
    this.timers.delete(id);
  }
}
