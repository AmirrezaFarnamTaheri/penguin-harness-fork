/**
 * Advisory per-agent repeat-call detector and loop guard.
 * Ported and synthesized from deepseek-harness guard/repeat-tool-reminder.
 *
 * Tracks consecutive identical tool calls using deep key-sorted JSON canonicalization.
 * Injects gentle reminders at initial threshold and escalating detailed reminders at
 * higher thresholds, breaking autonomous agent loops without forcefully crashing the session.
 */

export interface RepeatToolGuardOptions {
  /** Consecutive-repeat counts that trigger a reminder (default [3, 5, 8]). */
  thresholds?: number[];
  /** Tool-name wildcard patterns to track (empty means track all). */
  include?: string[];
  /** Tool-name wildcard patterns to ignore (transparent to the chain). */
  exclude?: string[];
  /** Maximum characters of canonical arguments quoted in the detailed reminder (default 500). */
  argumentsPreviewChars?: number;
}

export interface RepeatToolReminder {
  toolName: string;
  count: number;
  isGentle: boolean;
  message: string;
  argumentsPreview: string;
}

export interface RepeatChainState {
  key: string;
  toolName: string;
  count: number;
  lastTimestamp: number;
}

/**
 * Deep recursive key-sort of an arbitrary JSON-compatible object so two argument
 * objects that differ only in property order canonicalize to identical JSON strings.
 */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical string form of tool call arguments: deep key-sort, then stringify.
 */
export function canonicalizeArguments(argumentsValue: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(argumentsValue));
  } catch {
    return String(argumentsValue);
  }
}

/**
 * Compile a wildcard string pattern with '*' wildcards into an anchored RegExp.
 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

/**
 * Head-truncate canonical arguments for quoting in detailed reminders,
 * noting the number of omitted characters.
 */
export function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) {
    return canonical;
  }
  return `${canonical.slice(0, cap)}... (+${canonical.length - cap} more chars)`;
}

const GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is " +
  "not complete, try a different approach or different arguments instead of " +
  "repeating the call.";

function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return (
    "Repeated tool call detected:\n" +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    "The repeated calls are not making progress. Do not call this tool with " +
    "these exact arguments again. Inspect the latest result and choose a " +
    "different action, different arguments, or finish the task if enough " +
    "evidence has been gathered."
  );
}

/**
 * RepeatToolGuard evaluates tool calls and generates non-blocking advisory reminders
 * when repetitive invocations are detected across agent steps.
 */
export class RepeatToolGuard {
  public readonly thresholds: readonly number[];
  private readonly thresholdSet: Set<number>;
  private readonly includePatterns: RegExp[];
  private readonly excludePatterns: RegExp[];
  public readonly argumentsPreviewChars: number;

  /** agentId -> chain state */
  private readonly chains = new Map<string, RepeatChainState>();

  constructor(options: RepeatToolGuardOptions = {}) {
    const rawThresholds = options.thresholds ?? [3, 5, 8];
    if (rawThresholds.length === 0) {
      throw new Error("RepeatToolGuard: `thresholds` must not be empty");
    }
    for (const val of rawThresholds) {
      if (!Number.isInteger(val) || val < 2) {
        throw new Error(`RepeatToolGuard: invalid threshold ${val} - every threshold must be an integer >= 2`);
      }
    }
    if (new Set(rawThresholds).size !== rawThresholds.length) {
      throw new Error("RepeatToolGuard: `thresholds` must not contain duplicates");
    }

    this.thresholds = Object.freeze([...rawThresholds].sort((a, b) => a - b));
    this.thresholdSet = new Set(this.thresholds);
    this.includePatterns = (options.include ?? []).map(wildcardToRegExp);
    this.excludePatterns = (options.exclude ?? []).map(wildcardToRegExp);
    this.argumentsPreviewChars = options.argumentsPreviewChars ?? 500;

    if (!Number.isInteger(this.argumentsPreviewChars) || this.argumentsPreviewChars < 1) {
      throw new Error(`RepeatToolGuard: invalid argumentsPreviewChars ${this.argumentsPreviewChars} - must be integer >= 1`);
    }
  }

  /**
   * Tests whether a tool should participate in repeat tracking.
   */
  public isTracked(toolName: string): boolean {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((p) => p.test(toolName))) {
      return false;
    }
    return !this.excludePatterns.some((p) => p.test(toolName));
  }

  /**
   * Observes a tool call for a given agent. If a repetition threshold is met,
   * returns a structured reminder. Returns undefined if no threshold is met or
   * if the tool is not tracked.
   */
  public observe(agentId: string, toolName: string, toolArguments: unknown): RepeatToolReminder | undefined {
    if (!this.isTracked(toolName)) {
      return undefined;
    }

    const canonical = canonicalizeArguments(toolArguments);
    const key = `${toolName}:${canonical}`;
    const chain = this.chains.get(agentId);

    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1;
    this.chains.set(agentId, {
      key,
      toolName,
      count,
      lastTimestamp: Date.now(),
    });

    if (!this.thresholdSet.has(count)) {
      return undefined;
    }

    const isGentle = count === this.thresholds[0];
    const argumentsPreview = previewArguments(canonical, this.argumentsPreviewChars);
    const message = isGentle
      ? GENTLE_REMINDER
      : detailedReminder(toolName, count, argumentsPreview);

    return {
      toolName,
      count,
      isGentle,
      message,
      argumentsPreview,
    };
  }

  /**
   * Resets the repeat tracking chain for a specific agent (e.g. after user interjection).
   */
  public reset(agentId: string): void {
    this.chains.delete(agentId);
  }

  /**
   * Clears all tracking state across all agents.
   */
  public clear(): void {
    this.chains.clear();
  }

  /**
   * Inspects current chain state for an agent.
   */
  public getChain(agentId: string): RepeatChainState | undefined {
    return this.chains.get(agentId);
  }
}
