import { randomUUID } from "node:crypto";

export type CompactionPhase = "turn-start" | "in-loop" | "agent-session";
export type CompactionTrigger = "manual" | "auto";
export type CompactionStatus = "compacting" | "done" | "skipped";

export interface CompactionAnchorData {
  anchorId: string;
  status: CompactionStatus;
  phase: CompactionPhase;
  trigger: CompactionTrigger;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  foldedCount?: number;
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface ConversationMessage {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ContextCompactorOptions {
  /** Token budget threshold to trigger auto-compaction (default: 80,000 tokens). */
  tokenThreshold?: number;
  /** Number of most recent user-started turns to preserve intact (default: 4). */
  keepRecentTurns?: number;
  /** Keep system instructions intact at index 0 (default: true). */
  preserveSystemPrompt?: boolean;
}

export class ContextCompactor {
  public readonly tokenThreshold: number;
  public readonly keepRecentTurns: number;
  public readonly preserveSystemPrompt: boolean;

  constructor(options: ContextCompactorOptions = {}) {
    this.tokenThreshold = options.tokenThreshold ?? 80000;
    this.keepRecentTurns = options.keepRecentTurns ?? 4;
    this.preserveSystemPrompt = options.preserveSystemPrompt ?? true;
  }

  public shouldCompact(currentEstimatedTokens: number): boolean {
    return currentEstimatedTokens >= this.tokenThreshold;
  }

  public estimateTokens(messages: ConversationMessage[]): number {
    let charCount = 0;
    for (const msg of messages) {
      charCount += (msg.content || "").length + (msg.role || "").length + 10;
    }
    return Math.ceil(charCount / 4);
  }

  /**
   * Return the start index of the suffix containing the requested number of complete, user-started
   * turns. Tool calls/results and all assistant follow-ups remain attached to their user message.
   */
  private recentTurnStart(messages: ConversationMessage[]): number {
    if (this.keepRecentTurns <= 0) return messages.length;

    let turns = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "user") continue;
      turns++;
      if (turns === this.keepRecentTurns) return i;
    }
    return 0;
  }

  private boundSummary(summary: string, folded: ConversationMessage[]): string {
    const sourceChars = folded.reduce((sum, message) => sum + message.content.length, 0);
    const maxChars = Math.min(16_000, Math.max(256, Math.floor(sourceChars * 0.5)));
    if (summary.length <= maxChars) return summary;
    return `${summary.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[summary truncated]`;
  }

  public async compact(
    messages: ConversationMessage[],
    trigger: CompactionTrigger = "auto",
    phase: CompactionPhase = "turn-start",
    customSummarizer?: (folded: ConversationMessage[]) => Promise<string> | string
  ): Promise<{
    compactedMessages: ConversationMessage[];
    anchor: CompactionAnchorData;
  }> {
    const anchorId = `compaction-anchor:${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const preTokens = this.estimateTokens(messages);

    let systemMessage: ConversationMessage | null = null;
    let pool = [...messages];

    const firstMessage = pool[0];
    if (this.preserveSystemPrompt && firstMessage?.role === "system") {
      systemMessage = firstMessage;
      pool = pool.slice(1);
    }

    const foldSliceIndex = this.recentTurnStart(pool);
    if (foldSliceIndex <= 0) {
      return {
        compactedMessages: [...messages],
        anchor: {
          anchorId,
          status: "skipped",
          phase,
          trigger,
          preTokens,
          postTokens: preTokens,
          durationMs: Date.now() - startTime,
          foldedCount: 0,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    }

    const messagesToFold = pool.slice(0, foldSliceIndex);
    const recentMessages = pool.slice(foldSliceIndex);
    if (messagesToFold.length === 0) {
      return {
        compactedMessages: [...messages],
        anchor: {
          anchorId,
          status: "skipped",
          phase,
          trigger,
          preTokens,
          postTokens: preTokens,
          durationMs: Date.now() - startTime,
          foldedCount: 0,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    }

    const rawSummary = customSummarizer
      ? await customSummarizer(messagesToFold)
      : this.defaultSummary(messagesToFold);
    const summaryText = this.boundSummary(rawSummary, messagesToFold);

    const summaryMessage: ConversationMessage = {
      id: `compaction-summary-${randomUUID().slice(0, 8)}`,
      role: "user",
      content: `[Context Compaction Summary - ${messagesToFold.length} earlier messages folded]\n${summaryText}`,
    };

    const candidate: ConversationMessage[] = [];
    if (systemMessage) candidate.push(systemMessage);
    candidate.push(summaryMessage, ...recentMessages);

    const postTokens = this.estimateTokens(candidate);
    const reduction = preTokens - postTokens;
    const minUsefulReduction = Math.max(1, Math.ceil(preTokens * 0.05));
    const crossedBudget = preTokens >= this.tokenThreshold && postTokens < this.tokenThreshold;

    // A compaction operation must actually relieve pressure. Do not replace context with a larger
    // or negligibly smaller representation and still report success.
    if (reduction < minUsefulReduction && !crossedBudget) {
      return {
        compactedMessages: [...messages],
        anchor: {
          anchorId,
          status: "skipped",
          phase,
          trigger,
          preTokens,
          postTokens: preTokens,
          durationMs: Date.now() - startTime,
          foldedCount: 0,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    }

    return {
      compactedMessages: candidate,
      anchor: {
        anchorId,
        status: "done",
        phase,
        trigger,
        preTokens,
        postTokens,
        durationMs: Date.now() - startTime,
        foldedCount: messagesToFold.length,
        startedAt,
        completedAt: new Date().toISOString(),
        summary: summaryText,
      },
    };
  }

  private defaultSummary(messages: ConversationMessage[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      const preview = (msg.content || "")
        .replace(/\s+/g, " ")
        .slice(0, 120)
        .trim();
      if (preview.length > 0) lines.push(`- [${msg.role}]: ${preview}`);
    }
    return lines.join("\n");
  }
}
