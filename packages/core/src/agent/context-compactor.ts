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
  /** Number of most recent turns (user + assistant pairs) to preserve intact (default: 4). */
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

  /**
   * Estimate token count using a standard 4-chars-per-token heuristic.
   */
  public estimateTokens(messages: ConversationMessage[]): number {
    let charCount = 0;
    for (const msg of messages) {
      charCount += (msg.content || "").length + (msg.role || "").length + 10;
    }
    return Math.ceil(charCount / 4);
  }

  /**
   * Compactor that folds conversation history older than keepRecentTurns into a structured memory summary.
   */
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

    // Identify system prompt at index 0
    let systemMessage: ConversationMessage | null = null;
    let pool = [...messages];

    const firstMessage = pool[0];
    if (this.preserveSystemPrompt && firstMessage?.role === "system") {
      systemMessage = firstMessage;
      pool = pool.slice(1);
    }

    // Determine how many messages to keep from recent history
    // Each turn is approximately 2 messages (user + assistant) plus optional tool calls
    const recentMessagesCount = Math.max(2, this.keepRecentTurns * 2);

    if (pool.length <= recentMessagesCount) {
      // Nothing eligible to fold
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

    const foldSliceIndex = pool.length - recentMessagesCount;
    const messagesToFold = pool.slice(0, foldSliceIndex);
    const recentMessages = pool.slice(foldSliceIndex);

    // Generate summary of folded messages
    let summaryText: string;
    if (customSummarizer) {
      summaryText = await customSummarizer(messagesToFold);
    } else {
      summaryText = this.defaultSummary(messagesToFold);
    }

    const summaryMessage: ConversationMessage = {
      id: `compaction-summary-${randomUUID().slice(0, 8)}`,
      role: "user",
      content: `[Context Compaction Summary - ${messagesToFold.length} earlier turns folded]\n${summaryText}`,
    };

    const compactedMessages: ConversationMessage[] = [];
    if (systemMessage) {
      compactedMessages.push(systemMessage);
    }
    compactedMessages.push(summaryMessage);
    compactedMessages.push(...recentMessages);

    const postTokens = this.estimateTokens(compactedMessages);
    const durationMs = Date.now() - startTime;

    return {
      compactedMessages,
      anchor: {
        anchorId,
        status: "done",
        phase,
        trigger,
        preTokens,
        postTokens,
        durationMs,
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
      if (preview.length > 0) {
        lines.push(`- [${msg.role}]: ${preview}`);
      }
    }
    return lines.join("\n");
  }
}
