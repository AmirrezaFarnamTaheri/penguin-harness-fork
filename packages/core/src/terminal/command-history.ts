/**
 * Shell command history: a ring buffer with prefix search and session restore.
 *
 * Ported from the Rust terminal emulator's history layer
 * (`app/src/terminal/history.rs` and `rich_history.rs`): entries are newest
 * last, consecutive duplicates collapse, navigation is by cursor with a
 * partial-prefix match, and the persisted form is the trimmed command list.
 */

export interface HistoryEntry {
  readonly command: string;
  /** Unix epoch milliseconds when the command was accepted. */
  readonly timestamp: number;
  /** Exit status reported by the shell, when known. */
  readonly exitCode: number | null;
  /** Working directory the command ran in, when known. */
  readonly workingDirectory: string | null;
}

export interface CommandHistoryOptions {
  /** Maximum retained entries. */
  capacity?: number;
  /** Deduplicate only exact, case-sensitive repeats when true. */
  caseSensitiveDedupe?: boolean;
}

export class CommandHistory {
  readonly entries: HistoryEntry[] = [];
  readonly capacity: number;
  private readonly caseSensitiveDedupe: boolean;

  constructor(options: CommandHistoryOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 10_000);
    this.caseSensitiveDedupe = options.caseSensitiveDedupe ?? true;
  }

  get length(): number {
    return this.entries.length;
  }

  /** Newest entry, or `null` when empty. */
  get last(): HistoryEntry | null {
    return this.entries.length === 0 ? null : this.entries[this.entries.length - 1]!;
  }

  /**
   * Push a command. An exact duplicate of the most recent entry is dropped
   * rather than re-recorded, matching the shell behaviour of not filling the
   * history with repeated `ls` calls.
   */
  push(
    command: string,
    timestamp = Date.now(),
    exitCode: number | null = null,
    workingDirectory: string | null = null,
  ): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;
    const last = this.last;
    if (last) {
      const same = this.caseSensitiveDedupe
        ? last.command === trimmed
        : last.command.toLowerCase() === trimmed.toLowerCase();
      if (same) return;
    }
    this.entries.push({ command: trimmed, timestamp, exitCode, workingDirectory });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /** All commands, oldest first. */
  commands(): string[] {
    return this.entries.map((e) => e.command);
  }

  /**
   * Entries whose command starts with `prefix`, newest first. The source
   * project's reverse-i-search does a substring scan; prefix matching is the
   * behaviour of the up-arrow history walk.
   */
  prefixSearch(prefix: string, limit = 50): HistoryEntry[] {
    if (prefix.length === 0) return [];
    const needle = prefix.toLowerCase();
    const matches: HistoryEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && matches.length < limit; i--) {
      const entry = this.entries[i]!;
      if (entry.command.toLowerCase().startsWith(needle)) matches.push(entry);
    }
    return matches;
  }

  /** Substring search, newest first — the reverse-i-search behaviour. */
  substringSearch(substring: string, limit = 50): HistoryEntry[] {
    if (substring.length === 0) return [];
    const needle = substring.toLowerCase();
    const matches: HistoryEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && matches.length < limit; i--) {
      const entry = this.entries[i]!;
      if (entry.command.toLowerCase().includes(needle)) matches.push(entry);
    }
    return matches;
  }

  /** Entries for one working directory, newest first. */
  forDirectory(workingDirectory: string, limit = 50): HistoryEntry[] {
    const matches: HistoryEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && matches.length < limit; i--) {
      const entry = this.entries[i]!;
      if (entry.workingDirectory === workingDirectory) matches.push(entry);
    }
    return matches;
  }

  /**
   * Entries whose command actually failed, newest first. A status of 128 or
   * more means the process was ended by a signal (130 is Ctrl-C), so an
   * interrupted command is reported here as little as one the shell accepted.
   */
  failures(limit = 50): HistoryEntry[] {
    const matches: HistoryEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && matches.length < limit; i--) {
      const entry = this.entries[i]!;
      if (entry.exitCode !== null && entry.exitCode !== 0 && entry.exitCode < 128)
        matches.push(entry);
    }
    return matches;
  }

  /**
   * Cursor navigation: walk backwards from the newest entry matching
   * `prefix`. Returns `null` past the oldest entry, which clears the
   * in-progress input.
   */
  navigate(cursor: HistoryCursor, prefix = ""): HistoryCursor {
    const start = cursor.index === null ? this.entries.length : cursor.index;
    for (let i = start - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (prefix.length === 0 || entry.command.toLowerCase().startsWith(prefix.toLowerCase())) {
        return { index: i, command: entry.command };
      }
    }
    return { index: null, command: "" };
  }

  /** Forward counterpart to `navigate`, from the oldest entry when unpositioned. */
  navigateForward(cursor: HistoryCursor, prefix = ""): HistoryCursor {
    const start = cursor.index === null ? -1 : cursor.index;
    for (let i = start + 1; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (prefix.length === 0 || entry.command.toLowerCase().startsWith(prefix.toLowerCase())) {
        return { index: i, command: entry.command };
      }
    }
    return { index: null, command: "" };
  }

  /** Remove every entry, e.g. for `history -c`. */
  clear(): void {
    this.entries.length = 0;
  }

  /** Persisted form: the command list, oldest first. */
  serialize(): string[] {
    return this.commands();
  }

  /** Restore from a persisted command list, stamping timestamps in order. */
  restore(commands: readonly string[], baseTimestamp = Date.now()): void {
    this.clear();
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i]!;
      if (command.trim().length === 0) continue;
      this.entries.push({
        command,
        timestamp: baseTimestamp - (commands.length - i) * 1000,
        exitCode: null,
        workingDirectory: null,
      });
    }
  }
}

export interface HistoryCursor {
  /** Index into `entries`, or `null` when not currently positioned. */
  index: number | null;
  command: string;
}

export function emptyCursor(): HistoryCursor {
  return { index: null, command: "" };
}

/**
 * Completion suggestions for the current input: distinct commands in the
 * history that extend the word at the cursor. The source project's
 * dynamic suggestion engine ranks these by recency.
 */
export function suggestCompletions(history: CommandHistory, input: string, limit = 8): string[] {
  const word = currentWord(input);
  if (word.length === 0) return [];
  const lower = word.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = history.entries.length - 1; i >= 0 && out.length < limit; i--) {
    const command = history.entries[i]!.command;
    if (!command.toLowerCase().startsWith(lower)) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    out.push(command);
  }
  return out;
}

/** The word being typed: everything after the last unquoted whitespace. */
export function currentWord(input: string): string {
  let inSingle = false;
  let inDouble = false;
  let wordStart = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === " " && !inSingle && !inDouble) wordStart = i + 1;
  }
  return input.slice(wordStart);
}

/**
 * Expand `!` history references the way a shell does: `!!` is the previous
 * command, `!n` the nth entry, `!prefix` the most recent command containing
 * the prefix, and `!$` the last word of the previous command.
 */
export function expandHistoryRef(history: CommandHistory, input: string): string {
  if (!input.includes("!")) return input;
  const last = history.last;
  // The leading `!` is matched literally and the group takes the designator:
  // for `!!` that designator is a single `!`, so the alternative is one bang,
  // not two — a pair here can never match after the literal one is consumed.
  return input.replace(/!(!|\$|-?\d+|[^\s!]*)/g, (match, ref: string) => {
    if (ref === "!") {
      return last ? last.command : match;
    }
    if (ref === "$") {
      if (!last) return match;
      const words = last.command.split(/\s+/);
      return words[words.length - 1] ?? "";
    }
    if (/^-?\d+$/.test(ref)) {
      const n = Number.parseInt(ref, 10);
      const index = n < 0 ? history.entries.length + n : n - 1;
      const entry = history.entries[index];
      return entry ? entry.command : match;
    }
    if (ref.length > 0) {
      const found = history.substringSearch(ref, 1)[0];
      return found ? found.command : match;
    }
    return match;
  });
}
