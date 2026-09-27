/**
 * Autonomous Multi-Agent Swarm Coordinator & Quorum Deliberation Pipeline.
 *
 * Orchestrates autonomous multi-agent pipelines (Orchestrator -> Coder -> Reviewer)
 * by integrating MailboxBureau leases, QuorumConsensus evidence gates, TurnLedger
 * audit trails, ShellGuardian security barriers, and LoopDetector stall prevention.
 */

import { randomUUID } from "node:crypto";
import {
  MailboxKernel,
  type MailboxMessage,
  type MailboxSummary,
  normalizeMailboxOwnerName,
} from "./mailbox.js";
import {
  QuorumConsensusEngine,
  type TopicStanding,
  type QuorumPolicy,
} from "./quorum-consensus.js";
import { TurnLedger, type TerminalSummary, type ReplayView } from "./turn-ledger.js";
import { LoopDetector, type LoopDetectorOptions } from "./loop-detector.js";
import { ShellGuardian, type ShellSafetyAssessment } from "./shell-guardian.js";
import { SandboxedCommandRunner, type SandboxExecutionResult } from "./sandbox-runner.js";
import { TaskWatchdog, type WatchdogConfig, type WatchdogStatus } from "./task-watchdog.js";
import { AgentNameRegistry } from "./agent-name-registry.js";

/**
 * How long a step deadline waits for a handler that is still in flight once its deadline has
 * fired. A step that resolves microseconds late must be reported as its real outcome, not as a
 * timeout; a handler that then rejects must surface that error rather than have it swallowed.
 */
const STEP_GRACE_MS = 100;

export type SwarmRole = "orchestrator" | "coder" | "reviewer" | "researcher" | "tester";

export interface SwarmTaskDefinition {
  id?: string;
  goal: string;
  workspaceDir?: string;
  files?: string[];
  constraints?: string[];
  quorumThreshold?: number;
  maxRounds?: number;
  proposedCommands?: string[];
  simulate?: boolean;
}

export interface SwarmAgentState {
  id: string;
  /** Human-distinct display name from the curated pool; unique among live agents. */
  name?: string;
  /** What this agent is for, so peers address it deliberately. */
  description?: string;
  role: SwarmRole;
  status: "idle" | "active" | "waiting_approval" | "handoff" | "completed" | "failed";
  tasksCompleted: number;
  currentTask?: string;
  handoffTarget?: string;
}

export interface SwarmEdgeState {
  from: string;
  to: string;
  kind: "directive" | "handoff" | "review_gate";
  activeCount: number;
}

export interface SwarmArtifact {
  path: string;
  summary: string;
  content?: string;
}

export type SwarmEventType =
  | "task_started"
  | "step_started"
  | "step_completed"
  | "review_requested"
  | "consensus_endorsed"
  | "consensus_refuted"
  | "consensus_settled"
  | "command_evaluated"
  | "command_executed"
  | "directive_dispatched"
  | "loop_detected"
  | "task_completed"
  | "task_failed";

export interface SwarmEvent {
  type: SwarmEventType;
  taskId: string;
  timestamp: number;
  agentId?: string;
  payload: Record<string, unknown>;
}

export interface SwarmHandlerContext {
  signal: AbortSignal;
}

export interface SwarmExecutionResult {
  taskId: string;
  status:
    | "settled"
    | "refuted"
    | "max_rounds_exceeded"
    | "loop_aborted"
    | "error"
    | "unhandled"
    | "timed_out";
  rounds: number;
  standing?: TopicStanding;
  terminalSummary?: TerminalSummary;
  artifacts: SwarmArtifact[];
  safetyFindings: ShellSafetyAssessment[];
  log: string[];
}

export interface SwarmRoleHandlers {
  onPlan?: (
    task: SwarmTaskDefinition,
    context?: SwarmHandlerContext,
  ) => Promise<{ steps: string[]; targetFiles?: string[] }>;
  onExecute?: (
    task: SwarmTaskDefinition,
    step: string,
    round: number,
    context?: SwarmHandlerContext,
  ) => Promise<{
    artifacts: SwarmArtifact[];
    proposedCommands?: string[];
    summary: string;
  }>;
  onReview?: (
    task: SwarmTaskDefinition,
    artifacts: SwarmArtifact[],
    round: number,
    context?: SwarmHandlerContext,
  ) => Promise<{
    approved: boolean;
    grounds: string;
  }>;
}

export class SwarmCoordinator {
  public readonly mailbox: MailboxKernel;
  public readonly consensus: QuorumConsensusEngine;
  public readonly ledger: TurnLedger;
  public loopDetector: LoopDetector;
  public readonly shellGuardian: ShellGuardian;
  public readonly sandboxRunner: SandboxedCommandRunner;
  public readonly watchdog: TaskWatchdog;

  private agents = new Map<string, SwarmAgentState>();
  private readonly nameRegistry = new AgentNameRegistry();
  private edges = new Map<string, SwarmEdgeState>();
  private listeners = new Set<(event: SwarmEvent) => void>();
  private activeTaskId: string | null = null;
  private logMessages: string[] = [];
  private taskQueue: Promise<unknown> = Promise.resolve();
  private loopOptions: LoopDetectorOptions;
  private readonly maxPendingTasks: number;
  private pendingTaskCount = 0;
  /**
   * In-flight step handlers of the running task, so an interruption reaches the work that is
   * actually awaiting rather than only the deliberation loop that is about to call it. Held
   * across awaits (a handler can run for its whole step timeout), hence the membership set
   * rather than a single controller.
   */
  private activeStepControllers = new Set<AbortController>();
  /**
   * Why the running task must stop, or null while it may continue. Set by an external abort()
   * and by the watchdog reaching a terminal state. One field for both so the loop has a single
   * condition to honour — see the comment at the loop for why the watchdog's verdict has to be
   * latched here rather than only reported.
   */
  private interruption: string | null = null;

  constructor(options?: {
    quorumPolicy?: Partial<QuorumPolicy>;
    loopOptions?: LoopDetectorOptions;
    watchdogConfig?: Partial<WatchdogConfig>;
    sessionId?: string;
    sandboxRunner?: SandboxedCommandRunner;
    shellGuardian?: ShellGuardian;
    maxPendingTasks?: number;
  }) {
    const sessionId = options?.sessionId ?? `swarm-session-${Date.now()}`;
    this.mailbox = new MailboxKernel();
    this.consensus = new QuorumConsensusEngine(
      options?.quorumPolicy ?? { threshold: 2, requireGrounded: true },
    );
    this.ledger = new TurnLedger(sessionId);
    this.loopOptions = options?.loopOptions ?? { maxRepeats: 4, timeoutSeconds: 300 };
    this.loopDetector = new LoopDetector(this.loopOptions);
    this.shellGuardian = options?.shellGuardian ?? new ShellGuardian();
    this.sandboxRunner =
      options?.sandboxRunner ?? new SandboxedCommandRunner({ guardian: this.shellGuardian });
    this.watchdog = new TaskWatchdog(options?.watchdogConfig ?? { maxStepCount: 40 });
    this.maxPendingTasks = options?.maxPendingTasks ?? 10;

    this.registerStandardSwarmAgents();
  }

  public getPendingTaskCount(): number {
    return this.pendingTaskCount;
  }

  public getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  public hasAgent(id: string): boolean {
    const norm = normalizeMailboxOwnerName(id);
    return this.agents.has(norm);
  }

  /**
   * Executes a shell command inside an OS-adaptive sandbox interlocked with ShellGuardian.
   */
  public async executeCommand(
    command: string,
    options?: { workingDirectory?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<SandboxExecutionResult> {
    const result = await this.sandboxRunner.execute(command, options);

    const hasActiveTurn = this.ledger.getActiveTurnId() !== null;
    let ephemeralTurn = false;
    if (!hasActiveTurn) {
      this.ledger.begin("ephemeral-exec");
      ephemeralTurn = true;
    }

    this.ledger.append(
      "tool_dispatch",
      {
        tool: "sandboxed_command",
        command,
        allowed: result.allowed,
        exitCode: result.exitCode,
        isolationMode: result.isolationMode,
        durationMs: result.durationMs,
      },
      "running",
    );

    if (ephemeralTurn) {
      this.ledger.append(
        "turn_done",
        { status: result.exitCode === 0 ? "completed" : "failed" },
        result.exitCode === 0 ? "completed" : "failed",
      );
    }

    this.emit("command_executed", this.activeTaskId ?? "unassigned", "coder", {
      command,
      allowed: result.allowed,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      isolationMode: result.isolationMode,
    });
    return result;
  }

  private registerStandardSwarmAgents(): void {
    const defaultAgents: Array<{ id: string; role: SwarmRole }> = [
      { id: "orchestrator", role: "orchestrator" },
      { id: "coder", role: "coder" },
      { id: "reviewer", role: "reviewer" },
      { id: "tester", role: "tester" },
      { id: "researcher", role: "researcher" },
    ];

    for (const a of defaultAgents) {
      this.agents.set(a.id, {
        id: a.id,
        name: this.nameRegistry.assign(a.id),
        role: a.role,
        status: "idle",
        tasksCompleted: 0,
      });
    }

    this.addEdge("orchestrator", "coder", "directive");
    this.addEdge("coder", "reviewer", "handoff");
    this.addEdge("reviewer", "orchestrator", "review_gate");
    this.addEdge("reviewer", "coder", "review_gate");
    this.addEdge("coder", "tester", "handoff");
  }

  public subscribe(listener: (event: SwarmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(
    type: SwarmEventType,
    taskId: string,
    agentId?: string,
    payload: Record<string, unknown> = {},
  ): void {
    const event: SwarmEvent = {
      type,
      taskId,
      timestamp: Date.now(),
      agentId,
      payload,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[SwarmCoordinator] Listener error:", err);
      }
    }
  }

  private addEdge(from: string, to: string, kind: "directive" | "handoff" | "review_gate"): void {
    const key = `${from}->${to}`;
    if (!this.edges.has(key)) {
      this.edges.set(key, { from, to, kind, activeCount: 0 });
    }
  }

  private incrementEdge(from: string, to: string): void {
    const key = `${from}->${to}`;
    const edge = this.edges.get(key);
    if (edge) edge.activeCount++;
  }

  public getAgents(): SwarmAgentState[] {
    return Array.from(this.agents.values()).map((a) => ({ ...a }));
  }

  public getEdges(): SwarmEdgeState[] {
    return Array.from(this.edges.values()).map((e) => ({ ...e }));
  }

  public getMailboxSummaries(): Record<string, MailboxSummary> {
    const result: Record<string, MailboxSummary> = {};
    for (const agentId of this.agents.keys()) {
      result[agentId] = this.mailbox.getSummary(agentId);
    }
    return result;
  }

  public getStandings(): TopicStanding[] {
    return this.consensus.listStandings();
  }

  public getWatchdogStatus(): WatchdogStatus {
    return this.watchdog.checkHealth();
  }

  /**
   * Records progress and latches the watchdog's verdict when it has reached one.
   *
   * The latch is the whole point. `TaskWatchdog.heartbeat` deliberately only *reports* a
   * terminal state — it never aborts by itself, so a host that merely polls cannot wedge a run.
   * That contract is right for the kernel and wrong for a caller that then throws the answer
   * away: `totalTimeoutMs` and `maxStepCount` were configured but never acted on, so a task ran
   * to its round cap (round cap × steps × step timeout) no matter what budget it was given. The
   * verdict is latched into `interruption` here, where the loop actually reads it, and the
   * in-flight handlers are aborted so a step already awaiting stops too.
   */
  private noteProgress(action: string): void {
    const status = this.watchdog.heartbeat({ action });
    if (
      status.state !== "timed_out" &&
      status.state !== "max_steps_exceeded" &&
      status.state !== "aborted" &&
      status.state !== "stalled"
    ) {
      return;
    }
    if (this.interruption !== null) return;
    this.interruption = status.abortReason ?? `Swarm task ${status.state}`;
    this.record(`Task interrupted after '${action}': ${this.interruption}`);
    this.abortActiveSteps();
  }

  /**
   * Aborts every step handler this task currently awaits.
   *
   * A handler that respects its signal stops here. One that ignores it still cannot hold the
   * loop past its own step deadline, and `runWithDeadline` removes the controller from the set
   * in its `finally`, so a later abort() only ever reaches work that is still in flight.
   */
  private abortActiveSteps(): void {
    for (const controller of this.activeStepControllers) {
      try {
        controller.abort();
      } catch {
        // Already aborted — the desired end state.
      }
    }
  }

  /**
   * Stops the running task: latches the reason so the deliberation loop exits at its next
   * boundary, and aborts every in-flight step handler so a handler currently awaiting — rather
   * than one about to be called — is interrupted too. Idempotent, and a no-op when idle.
   *
   * This is the only way a host can stop a swarm it did not start in-process: `runTask` owns its
   * own step timeouts but nothing else ends it early, so deleting the Session (or unmounting the
   * view) that spawned one had no way to reach the work and the task ran to its round cap.
   * Returns whether a task was actually running, so a caller can tell a real stop from a no-op.
   */
  public abort(reason: string): boolean {
    if (this.activeTaskId === null) return false;
    if (this.interruption === null) {
      this.interruption = reason;
      this.record(`Task interrupted: ${reason}`);
    }
    this.watchdog.abort(reason);
    this.abortActiveSteps();
    return true;
  }

  /**
   * Appends one timestamped line to the current task's log.
   *
   * A method rather than the closure inside runTask because the interruption has to be recorded
   * from `noteProgress`/`abort` too, and the caller is handed `result.log` as the run's narrative:
   * a run that stopped without saying why in that log is the "it just ended" case this whole
   * mechanism exists to replace.
   */
  private record(message: string): void {
    this.logMessages.push(`[${new Date().toISOString()}] ${message}`);
  }

  public getReplayView(): ReplayView {
    return this.ledger.replay(0);
  }

  /**
   * Dispatches a live inter-agent directive into the destination agent's Mailbox queue,
   * updates edge telemetry, and emits a directive_dispatched event.
   */
  public dispatchDirective(from: string, to: string, content: string): MailboxMessage {
    const fromId = from.trim() || "operator";
    const toId = to.trim() || "coder";
    if (!this.hasAgent(toId)) {
      throw new Error(`Recipient agent '${toId}' is not registered in swarm`);
    }
    const msg = this.mailbox.send(toId, fromId, "directive", { content });
    this.addEdge(fromId, toId, "directive");
    this.incrementEdge(fromId, toId);
    this.emit("directive_dispatched", this.activeTaskId ?? "inter-agent", fromId, {
      from: fromId,
      to: toId,
      content,
      messageId: msg.id,
    });
    return msg;
  }

  /**
   * Executes an autonomous coding task with end-to-end multi-agent deliberation.
   * Tasks are serialized through an internal FIFO promise queue to prevent concurrency races.
   */
  public async runTask(
    task: SwarmTaskDefinition,
    handlers?: SwarmRoleHandlers,
  ): Promise<SwarmExecutionResult> {
    if (this.pendingTaskCount >= this.maxPendingTasks) {
      const err = new Error(
        `Swarm task queue limit reached (${this.maxPendingTasks}). Project is under backpressure.`,
      ) as Error & { status?: number; statusCode?: number };
      err.status = 429;
      err.statusCode = 429;
      throw err;
    }

    this.pendingTaskCount++;
    const run = () => this.executeTask(task, handlers);
    const queued = this.taskQueue.then(run, run).finally(() => {
      this.pendingTaskCount = Math.max(0, this.pendingTaskCount - 1);
    });
    this.taskQueue = queued;
    return queued as Promise<SwarmExecutionResult>;
  }

  private async executeTask(
    task: SwarmTaskDefinition,
    handlers?: SwarmRoleHandlers,
  ): Promise<SwarmExecutionResult> {
    const taskId = task.id ?? `task-${randomUUID().slice(0, 8)}`;
    this.activeTaskId = taskId;
    this.logMessages = [];
    // Cleared at entry, not left to the finally: a coordinator is reusable, and a latch left
    // over from a previous task would stop this one before its first step.
    this.interruption = null;
    this.loopDetector = new LoopDetector(this.loopOptions);
    const safetyFindings: ShellSafetyAssessment[] = [];
    const collectedArtifacts: SwarmArtifact[] = [];

    const log = (msg: string): void => this.record(msg);

    log(`Starting Swarm task '${taskId}': ${task.goal}`);
    this.watchdog.start();
    const activeTurnId = this.ledger.begin(taskId);
    let turnClosed = false;

    const watchdogConfig = this.watchdog.getConfig();
    const stepTimeoutMs = watchdogConfig.stepTimeoutMs || 60_000;

    // Rounds are tracked outside the try so a failure deep in the deliberation loop can still
    // report how far it got, instead of reporting zero.
    let currentRound = 0;

    // One controller per step: a shared controller makes one slow step abort in-flight work
    // belonging to every other step. Steps are collected so a task that bails out still
    // interrupts whatever handler it left running.
    const stepAbortControllers: AbortController[] = [];

    const runWithDeadline = async <T>(
      factory: (signal: AbortSignal) => Promise<T>,
      actionName: string,
      timeoutMs: number,
    ): Promise<T> => {
      const stepController = new AbortController();
      stepAbortControllers.push(stepController);
      this.activeStepControllers.add(stepController);
      const promise = factory(stepController.signal);

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          stepController.abort();
          reject(new Error(`Swarm task step '${actionName}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      try {
        return await Promise.race([promise, deadline]);
      } catch (deadlineError) {
        // The deadline won, but the handler may still be about to settle. Give it one short
        // grace window and prefer its real outcome over reporting a timeout that did not
        // happen — and surface a rejection that arrives there instead of swallowing it.
        const outcome = await Promise.race([
          promise.then(
            (value) => ({ kind: "resolved" as const, value }),
            (error) => ({ kind: "rejected" as const, error }),
          ),
          new Promise<null>((resolve) => {
            const grace = setTimeout(() => resolve(null), STEP_GRACE_MS);
            grace.unref?.();
          }),
        ]);
        if (outcome?.kind === "resolved") return outcome.value;
        if (outcome?.kind === "rejected") throw outcome.error;
        throw deadlineError;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.activeStepControllers.delete(stepController);
      }
    };

    try {
      this.emit("task_started", taskId, "orchestrator", { goal: task.goal });

      // Step 1: Orchestrator initializes consensus topic & issues directive
      const orchestrator = this.agents.get("orchestrator")!;
      orchestrator.status = "active";
      orchestrator.currentTask = task.goal;
      this.noteProgress("orchestrator_plan");

      this.ledger.append(
        "text",
        { role: "orchestrator", text: `Analyzing task: ${task.goal}` },
        "running",
      );

      this.consensus.proposeTopic({
        topicId: taskId,
        topic: task.goal,
        proposerId: "orchestrator",
        initialGrounds: `Plan formulation grounded in target files: ${(task.files ?? []).join(", ") || "workspace root"}`,
        policy: {
          threshold: task.quorumThreshold ?? 2,
          requireGrounded: true,
          refutationCap: 1,
        },
      });

      // Plan steps
      let steps = ["implement_solution", "run_verification"];
      if (handlers?.onPlan) {
        const planRes = await runWithDeadline(
          (signal) => handlers.onPlan!(task, { signal }),
          "orchestrator_plan",
          stepTimeoutMs,
        );
        if (planRes.steps.length > 0) steps = planRes.steps;
      }

      // Send task message via Mailbox to Coder
      this.mailbox.send("coder", "orchestrator", "task_assignment", {
        taskId,
        goal: task.goal,
        steps,
        files: task.files,
        constraints: task.constraints,
      });
      this.incrementEdge("orchestrator", "coder");
      orchestrator.status = "handoff";
      orchestrator.handoffTarget = "coder";

      // Loop through deliberation rounds (Coder -> Reviewer)
      const maxRounds = task.maxRounds ?? 4;
      let settled = false;
      let refuted = false;

      // `interruption` is the loop's stop condition for BOTH external abort() and a terminal
      // watchdog verdict, so a task cannot outlive the budget it was given (see noteProgress).
      while (currentRound < maxRounds && !settled && !refuted && this.interruption === null) {
        currentRound++;
        log(`Deliberation round ${currentRound}/${maxRounds}`);

        // Loop check: check consecutive identical actions for this task
        const loopCheck = this.loopDetector.checkToolCall("coder_execution", {
          taskId,
          goal: task.goal,
        });
        if (loopCheck.shouldStop) {
          log(`Loop Breaker triggered: ${loopCheck.message}`);
          this.emit("loop_detected", taskId, "coder", { message: loopCheck.message });
          this.ledger.append("turn_done", loopCheck.message, "interrupted");
          turnClosed = true;
          return {
            taskId,
            status: "loop_aborted",
            rounds: currentRound,
            standing: this.consensus.getStanding(taskId),
            terminalSummary: this.ledger.getSummaries().find((s) => s.turnId === activeTurnId),
            artifacts: collectedArtifacts,
            safetyFindings,
            log: this.logMessages,
          };
        }

        // 2. Coder polls mailbox and claims lease
        const coder = this.agents.get("coder")!;
        coder.status = "active";
        coder.currentTask = `Coding round ${currentRound}`;
        this.noteProgress(`coder_round_${currentRound}`);

        const coderPoll = this.mailbox.pollAndLease<{ goal: string; steps: string[] }>(
          "coder",
          15000,
        );
        let leaseToken: string | null = coderPoll?.lease.leaseToken ?? null;

        // Check safety of proposed commands (ensure strings)
        const rawCommands = Array.isArray(task.proposedCommands) ? task.proposedCommands : [];
        const commandsToCheck = rawCommands.filter(
          (cmd): cmd is string => typeof cmd === "string" && cmd.trim().length > 0,
        );
        for (const cmd of commandsToCheck) {
          const assessment = this.shellGuardian.analyzeCommand(cmd);
          safetyFindings.push(assessment);
          this.emit("command_evaluated", taskId, "coder", {
            command: cmd,
            risk: assessment.riskLevel,
            isSafe: assessment.isSafe,
          });

          if (assessment.suggestedAction === "block") {
            log(
              `Shell Guardian blocked dangerous command: '${cmd}' (Rule: ${assessment.findings[0]?.ruleId})`,
            );
            this.consensus.refuteTopic(
              taskId,
              "coder",
              `Shell Guardian policy blocked critical command '${cmd}': ${assessment.findings[0]?.description}`,
            );
            refuted = true;
            break;
          }
        }

        if (refuted) break;

        // Coder produces implementation
        let artifacts: SwarmArtifact[] = [];
        let summary = `Implementation generated for ${task.goal}`;

        if (handlers?.onExecute) {
          const execRes = await runWithDeadline(
            (signal) =>
              handlers.onExecute!(task, steps[0] ?? "implement", currentRound, { signal }),
            `coder_round_${currentRound}`,
            stepTimeoutMs,
          );
          artifacts = execRes.artifacts;
          summary = execRes.summary;
        } else if (task.simulate === true) {
          artifacts = [
            {
              path: (task.files && task.files[0]) || "src/solution.ts",
              summary: `Automated patch for '${task.goal}' created in round ${currentRound}`,
              content: `// Solution for: ${task.goal}\n// Verified by Penguin Harness Swarm (simulation)\n`,
            },
          ];
        } else {
          log(`No execution handler provided for swarm task and simulation mode is disabled`);
          this.consensus.refuteTopic(
            taskId,
            "coder",
            "No role execution handler attached to swarm coordinator and simulate !== true",
          );
          this.ledger.append("turn_done", "No execution handler provided", "failed");
          turnClosed = true;
          this.emit("task_failed", taskId, "coder", {
            reason: "no_execution_handler",
          });
          return {
            taskId,
            status: "unhandled",
            rounds: currentRound,
            standing: this.consensus.getStanding(taskId),
            terminalSummary: this.ledger.getSummaries().find((s) => s.turnId === activeTurnId),
            artifacts: collectedArtifacts,
            safetyFindings,
            log: this.logMessages,
          };
        }

        for (const art of artifacts) {
          collectedArtifacts.push(art);
        }

        this.ledger.append(
          "tool_dispatch",
          { tool: "coder_patch", summary, artifactCount: artifacts.length },
          "running",
        );

        // Coder endorses topic with implementation grounds as a peer participant
        const coderGrounds = `Coder implemented ${artifacts.length} artifact(s) in round ${currentRound}: ${summary}`;
        this.consensus.endorseTopic(taskId, "coder", coderGrounds);
        this.emit("consensus_endorsed", taskId, "coder", { grounds: coderGrounds });

        // Release lease and hand off to Reviewer
        if (leaseToken) {
          try {
            this.mailbox.releaseLease("coder", leaseToken);
          } catch {
            // ignore
          }
        }
        coder.tasksCompleted++;
        coder.status = "handoff";
        coder.handoffTarget = "reviewer";

        this.mailbox.send("reviewer", "coder", "review_request", {
          taskId,
          round: currentRound,
          artifacts,
        });
        this.incrementEdge("coder", "reviewer");
        this.emit("review_requested", taskId, "coder", { round: currentRound, artifacts });

        // 3. Reviewer claims lease and audits changes
        const reviewer = this.agents.get("reviewer")!;
        reviewer.status = "active";
        reviewer.currentTask = `Reviewing round ${currentRound}`;
        this.noteProgress(`reviewer_round_${currentRound}`);

        const revPoll = this.mailbox.pollAndLease<{ round: number; artifacts: SwarmArtifact[] }>(
          "reviewer",
          15000,
        );
        let revLeaseToken: string | null = revPoll?.lease.leaseToken ?? null;

        let reviewPassed = true;
        let reviewGrounds = `Verified invariants and types for round ${currentRound} across ${artifacts.length} file(s)`;

        if (handlers?.onReview) {
          const revRes = await runWithDeadline(
            (signal) => handlers.onReview!(task, artifacts, currentRound, { signal }),
            `reviewer_round_${currentRound}`,
            stepTimeoutMs,
          );
          reviewPassed = revRes.approved;
          reviewGrounds = revRes.grounds;
        } else if (task.simulate === true) {
          reviewPassed = true;
          reviewGrounds = `Verified invariants and types for round ${currentRound} across ${artifacts.length} file(s) (simulation)`;
        } else {
          log(`No review handler provided for swarm task and simulation mode is disabled`);
          reviewPassed = false;
          reviewGrounds = "No review handler provided and simulation mode is disabled";
        }

        // A review step that hit its deadline throws from runWithDeadline before reaching
        // here, so the outcome alone decides whether the topic is endorsed.
        if (reviewPassed) {
          log(`Reviewer endorsed topic: ${reviewGrounds}`);
          const updatedStanding = this.consensus.endorseTopic(taskId, "reviewer", reviewGrounds);
          this.emit("consensus_endorsed", taskId, "reviewer", { grounds: reviewGrounds });

          if (updatedStanding.status === "settled") {
            settled = true;
            this.emit("consensus_settled", taskId, "reviewer", { standing: updatedStanding });
            log(`Quorum consensus settled successfully with threshold met!`);
          }
        } else {
          if (currentRound >= maxRounds) {
            log(`Reviewer refuted changes (max rounds reached): ${reviewGrounds}`);
            const updatedStanding = this.consensus.refuteTopic(taskId, "reviewer", reviewGrounds);
            this.emit("consensus_refuted", taskId, "reviewer", { grounds: reviewGrounds });
            if (updatedStanding.status === "refuted") {
              refuted = true;
            }
          } else {
            log(`Reviewer requested revisions for round ${currentRound}: ${reviewGrounds}`);
            this.emit("review_requested", taskId, "reviewer", {
              round: currentRound,
              feedback: reviewGrounds,
              approved: false,
            });
            this.mailbox.send("coder", "reviewer", "revision_request", {
              taskId,
              round: currentRound,
              feedback: reviewGrounds,
            });
            this.incrementEdge("reviewer", "coder");
          }
        }

        if (revLeaseToken) {
          try {
            this.mailbox.releaseLease("reviewer", revLeaseToken);
          } catch {
            // ignore
          }
        }
        reviewer.tasksCompleted++;
        reviewer.status = settled ? "completed" : "idle";
      }

      // Finalize status
      let finalStatus: SwarmExecutionResult["status"] = "settled";
      // An interruption outranks every other verdict: the task stopped because it was told to
      // or because its budget ran out, not because deliberation reached a conclusion. Reporting
      // "max_rounds_exceeded" for a task that actually timed out on round 1 would report the
      // round cap as the cause and hide a budget that is not being enforced.
      if (this.interruption !== null) finalStatus = "timed_out";
      else if (refuted) finalStatus = "refuted";
      else if (!settled && currentRound >= maxRounds) finalStatus = "max_rounds_exceeded";

      const terminalOutcome =
        this.interruption !== null
          ? `Execution interrupted: ${this.interruption}`
          : settled
            ? `Consensus settled across ${currentRound} round(s)`
            : `Execution concluded with status: ${finalStatus}`;

      this.ledger.append(
        "turn_done",
        terminalOutcome,
        settled && this.interruption === null ? "completed" : "interrupted",
      );
      turnClosed = true;
      this.emit(
        settled && this.interruption === null ? "task_completed" : "task_failed",
        taskId,
        "orchestrator",
        {
          status: finalStatus,
          rounds: currentRound,
        },
      );

      return {
        taskId,
        status: finalStatus,
        rounds: currentRound,
        standing: this.consensus.getStanding(taskId),
        terminalSummary: this.ledger.getSummaries().find((s) => s.turnId === activeTurnId),
        artifacts: collectedArtifacts,
        safetyFindings,
        log: this.logMessages,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errMsg.includes("timed out") || errMsg.includes("aborted");
      log(`Swarm task failure: ${errMsg}`);
      this.watchdog.abort(errMsg);
      this.ledger.append("turn_done", errMsg, isTimeout ? "interrupted" : "failed");
      turnClosed = true;
      const finalStatus: SwarmExecutionResult["status"] = isTimeout ? "timed_out" : "error";
      this.emit("task_failed", taskId, "orchestrator", {
        reason: errMsg,
        status: finalStatus,
      });
      return {
        taskId,
        status: finalStatus,
        rounds: currentRound,
        standing: this.consensus.getStanding(taskId),
        terminalSummary: this.ledger.getSummaries().find((s) => s.turnId === activeTurnId),
        artifacts: collectedArtifacts,
        safetyFindings,
        log: this.logMessages,
      };
    } finally {
      // Interrupt any handler still running after the task decided its outcome.
      for (const controller of stepAbortControllers) controller.abort();
      // The step set is the task's; leaving it populated would let a later abort() reach
      // controllers this task already finished with.
      this.activeStepControllers.clear();
      if (!turnClosed && this.ledger.getActiveTurnId() !== null) {
        this.ledger.append("turn_done", "Task interrupted or aborted", "interrupted");
      }
      this.watchdog.stop();
      this.activeTaskId = null;
      for (const a of this.agents.values()) {
        a.status = "idle";
        a.currentTask = undefined;
        a.handoffTarget = undefined;
      }
    }
  }
}
