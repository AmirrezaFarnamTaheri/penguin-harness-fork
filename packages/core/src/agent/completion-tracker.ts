/**
 * Completion Tracker & Verification Gate Kernel.
 *
 * Enforces verifiable evidence standards before an agent can claim task completion.
 * Requires concrete test passes, clean typechecks, or explicit validation receipts
 * to prevent hallucinated completion claims.
 */

export type VerificationKind =
  "test_suite" | "typecheck" | "file_exists" | "git_status" | "code_review" | "user_approval";

export interface CompletionVerificationItem {
  id: string;
  kind: VerificationKind;
  description: string;
  required: boolean;
  status: "pending" | "passed" | "failed" | "skipped";
  evidence?: string;
  timestamp?: number;
}

export interface CompletionReceipt {
  taskId: string;
  agentId: string;
  verified: boolean;
  summary: string;
  items: CompletionVerificationItem[];
  startedAt: number;
  completedAt: number;
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

export class CompletionTracker {
  private readonly taskId: string;
  private readonly agentId: string;
  private readonly startedAt: number;
  private readonly items = new Map<string, CompletionVerificationItem>();

  constructor(taskId: string, agentId: string) {
    this.taskId = taskId;
    this.agentId = agentId;
    this.startedAt = Date.now();
  }

  public addRequirement(item: {
    id: string;
    kind: VerificationKind;
    description: string;
    required?: boolean;
  }): void {
    this.items.set(item.id, {
      id: item.id,
      kind: item.kind,
      description: item.description,
      required: item.required !== false,
      status: "pending",
    });
  }

  public recordEvidence(id: string, passed: boolean, evidence: string): CompletionVerificationItem {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Verification requirement "${id}" is not registered`);
    }
    const normalizedEvidence = evidence.trim();
    if (passed && normalizedEvidence.length === 0) {
      throw new Error(`Passing verification requirement "${id}" requires non-empty evidence`);
    }

    const updated: CompletionVerificationItem = {
      ...existing,
      status: passed ? "passed" : "failed",
      evidence: normalizedEvidence,
      timestamp: Date.now(),
    };

    this.items.set(id, updated);
    return updated;
  }

  public skipRequirement(id: string, reason: string): CompletionVerificationItem {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Verification requirement "${id}" is not registered`);
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      throw new Error(`Skipping verification requirement "${id}" requires a reason`);
    }

    const updated: CompletionVerificationItem = {
      ...existing,
      status: "skipped",
      evidence: `Skipped: ${normalizedReason}`,
      timestamp: Date.now(),
    };

    this.items.set(id, updated);
    return updated;
  }

  public verifyAll(): {
    verified: boolean;
    pendingCount: number;
    failedItems: CompletionVerificationItem[];
    passedItems: CompletionVerificationItem[];
  } {
    const allItems = Array.from(this.items.values());
    const failedItems: CompletionVerificationItem[] = [];
    const passedItems: CompletionVerificationItem[] = [];
    let pendingCount = 0;

    for (const item of allItems) {
      if (item.status === "passed") {
        if (!item.evidence?.trim()) {
          if (item.required) failedItems.push(item);
          continue;
        }
        passedItems.push(item);
      } else if (item.status === "pending") {
        if (item.required) {
          pendingCount++;
          failedItems.push(item);
        }
      } else if (item.required) {
        // A required failed or skipped gate is not verification. Waivers must be modeled by
        // making the gate optional before execution rather than silently converting a skip to pass.
        failedItems.push(item);
      }
    }

    const verified = failedItems.length === 0 && pendingCount === 0;

    return {
      verified,
      pendingCount,
      failedItems,
      passedItems,
    };
  }

  public generateReceipt(
    summary: string,
    diffStats?: { filesChanged: number; insertions: number; deletions: number },
  ): CompletionReceipt {
    const check = this.verifyAll();

    return {
      taskId: this.taskId,
      agentId: this.agentId,
      verified: check.verified,
      summary,
      items: Array.from(this.items.values()),
      startedAt: this.startedAt,
      completedAt: Date.now(),
      diffStats,
    };
  }
}
