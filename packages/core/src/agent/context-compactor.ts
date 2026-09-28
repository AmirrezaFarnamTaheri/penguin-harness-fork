import { randomUUID } from "node:crypto";
import { approximateTokens } from "../llm/context-limits.js";

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

/** A line that opens a top-level code declaration worth keeping verbatim in a summary. */
const DECLARATION_START =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+[A-Za-z_$][\w$]*/;

/**
 * Id prefix marking the synthetic summary a compaction emits. The summary carries `role: "user"`
 * so the model treats it as context, but it is not a real turn: `recentTurnStart` skips it so the
 * turn count is correct by construction rather than by the accident of the summary's position.
 */
const COMPACTION_SUMMARY_ID_PREFIX = "compaction-summary-";

/**
 * Per-message overhead for role framing and separators. The previous counter added 10 characters
 * to a total it then divided by 4, so the real charge was 2.5 tokens; 3 is that cost rounded up,
 * which is the direction that keeps the estimate from being optimistic.
 */
const MESSAGE_FRAMING_TOKENS = 3;

function isCompactionSummary(message: ConversationMessage): boolean {
  return typeof message.id === "string" && message.id.startsWith(COMPACTION_SUMMARY_ID_PREFIX);
}

export interface ContextCompactorOptions {
  /** Token budget threshold to trigger auto-compaction (default: 80,000 tokens). */
  tokenThreshold?: number;
  /** Number of most recent user-started turns to preserve intact (default: 4). */
  keepRecentTurns?: number;
  /** Keep system instructions intact at index 0 (default: true). */
  preserveSystemPrompt?: boolean;
  /**
   * Extract code declarations and test failures into the summary verbatim, regardless of
   * where they sit in a folded message, instead of relying on the 120-character flattening
   * preview (default: false).
   */
  astAware?: boolean;
}

export class ContextCompactor {
  public readonly tokenThreshold: number;
  public readonly keepRecentTurns: number;
  public readonly preserveSystemPrompt: boolean;
  public readonly astAware: boolean;

  constructor(options: ContextCompactorOptions = {}) {
    this.tokenThreshold = options.tokenThreshold ?? 80000;
    this.keepRecentTurns = options.keepRecentTurns ?? 4;
    this.preserveSystemPrompt = options.preserveSystemPrompt ?? true;
    this.astAware = options.astAware ?? false;
  }

  public shouldCompact(currentEstimatedTokens: number): boolean {
    return currentEstimatedTokens >= this.tokenThreshold;
  }

  /**
   * Estimated size of the context, in tokens.
   *
   * Delegates to the same `approximateTokens` the per-request output clamp uses
   * (`llm/context-limits.ts`) rather than keeping a second counter. That is the whole point: the
   * two numbers have to describe the same conversation, and while this one used `length / 4` over
   * UTF-16 code units they disagreed by **four times** on CJK text and two times on emoji — a
   * Chinese conversation estimated at a quarter of its real size. That error did not merely
   * misreport a gauge, it moved the trigger: compaction fired when the *estimate* crossed the
   * threshold, so on a 128k window a CJK session could reach roughly 4x the intended threshold
   * before anything happened, and the request that finally crossed the real window limit was
   * rejected by the provider as a non-retryable 400. The direction is the one that must never be
   * wrong here — an over-estimate shrinks work early, an under-estimate costs a turn.
   *
   * The per-message framing charge is the old one, made explicit: 10 characters ÷ 4 was 2.5
   * tokens of role/separator overhead, now a flat 3 — the same cost rounded up, which keeps the
   * safe direction for the rounding itself.
   */
  public estimateTokens(messages: ConversationMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total +=
        approximateTokens(msg.content ?? "") +
        approximateTokens(msg.role ?? "") +
        MESSAGE_FRAMING_TOKENS;
    }
    return total;
  }

  /**
   * Return the start index of the suffix containing the requested number of complete, user-started
   * turns. Tool calls/results and all assistant follow-ups remain attached to their user message.
   *
   * A compaction summary carries `role: "user"` but is not a turn, so it is skipped. In practice the
   * summary is always the first message of the pool, which makes skipping it a no-op — the reverse
   * scan reaches it last and it can only be counted when fewer real turns remain than
   * `keepRecentTurns`, a case that returns 0 either way. The skip is kept so the count does not
   * depend on that positional invariant: a caller that ever places a summary mid-list must still
   * get the right window.
   */
  private recentTurnStart(messages: ConversationMessage[]): number {
    if (this.keepRecentTurns <= 0) return messages.length;

    let turns = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      if (isCompactionSummary(message)) continue;
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
    customSummarizer?: (folded: ConversationMessage[]) => Promise<string> | string,
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
      : this.astAware
        ? this.astAwareSummary(messagesToFold)
        : this.defaultSummary(messagesToFold);
    const summaryText = this.boundSummary(rawSummary, messagesToFold);

    const summaryMessage: ConversationMessage = {
      id: `${COMPACTION_SUMMARY_ID_PREFIX}${randomUUID().slice(0, 8)}`,
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
      const preview = (msg.content || "").replace(/\s+/g, " ").slice(0, 120).trim();
      if (preview.length > 0) lines.push(`- [${msg.role}]: ${preview}`);
    }
    return lines.join("\n");
  }

  /**
   * The `astAware` summarizer: function/class/const declarations and test-runner failure
   * lines are carried into the summary verbatim from anywhere in a folded message — the
   * 120-character flattening preview cannot reach a signature buried behind tool chatter.
   *
   * Self-contained structural extraction (declaration keywords + brace balancing) rather than
   * the full TypeScript compiler: core's dist must not bundle a multi-megabyte parser for what
   * is a summary quality feature, and a caller needing deeper analysis already owns the
   * `customSummarizer` seam. Falls back to the default summary when nothing salient is found.
   */
  private astAwareSummary(messages: ConversationMessage[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.role === "system") continue;
      for (const line of this.extractSalientLines(msg.content)) {
        lines.push(`- [${msg.role}]: ${line}`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : this.defaultSummary(messages);
  }

  /** Verbatim salient lines of one message: test failures and code declarations, in source order. */
  private extractSalientLines(content: string): string[] {
    const salient: string[] = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const trimmed = (lines[i] ?? "").trim();
      if (this.isTestFailureLine(trimmed)) {
        salient.push(trimmed);
        continue;
      }
      if (!DECLARATION_START.test(trimmed)) continue;
      // A declaration may span lines only until its first brace balance — capture the whole
      // single-line form, and for multi-line ones keep reading until braces balance.
      let candidate = trimmed;
      let depth = this.braceDelta(candidate);
      while (depth !== 0 && i + 1 < lines.length) {
        i++;
        candidate += `\n${(lines[i] ?? "").trim()}`;
        depth += this.braceDelta(lines[i] ?? "");
      }
      if (depth === 0) salient.push(candidate);
    }
    return salient;
  }

  /** Whether a line opens a declaration the summary must keep (signature or type shape). */
  private isTestFailureLine(trimmed: string): boolean {
    if (trimmed.length === 0 || trimmed.length > 300) return false;
    return (
      /^(?:Tests? failed\b|FAIL\b|AssertionError)/.test(trimmed) ||
      /AssertionError:/.test(trimmed) ||
      /\bexpected .+ to (?:be|equal) /.test(trimmed)
    );
  }

  /** Net brace change of one line, ignoring braces inside string literals. */
  private braceDelta(line: string): number {
    let delta = 0;
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") delta++;
      else if (ch === "}") delta--;
    }
    return delta;
  }
}
