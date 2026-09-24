/**
 * In-memory shell evaluator — the fast tier of the tiered execution runtime.
 *
 * This is a deliberately reduced POSIX shell. It runs the subset an agent's
 * ordinary shell work actually consists of — assignments, expansions, pipelines,
 * conditionals, loops, and a small built-in command set — entirely in process, with
 * no child process and no real filesystem, so a pure script resolves in well under
 * the 4ms budget the plan sets for this tier. Its virtual filesystem is the
 * copy-on-write backend in `cow-fs-backend.ts`, which is why a script that writes
 * cannot reach the host disk.
 *
 * What it does NOT do is as load-bearing as what it does. Every construct outside
 * the supported subset — an external binary, a subshell with process substitution,
 * an arithmetic `((`, a `[[` conditional, a function definition, a here-document,
 * a redirection to a descriptor — is reported through the classification in
 * `isolated-execution-runtime.ts` as `unsupported`, and the runtime escalates to a
 * hardware-isolated sandbox rather than letting this evaluator approximate it.
 * Approximating a shell is how sandboxes die: a missing `eval` semantics
 * difference is not a compatibility issue when the script is hostile.
 *
 * Enforced ceilings come from `execution-limits.ts`: command count, loop
 * iterations, recursion depth, output size, and a wall-clock deadline. Each is
 * checked at the point where the resource is consumed, and each failure throws a
 * typed error the runtime converts into a denial rather than a partial result.
 */

import type { CowFsBackend } from "./cow-fs-backend.js";
import type { ExecutionLimits } from "./execution-limits.js";
import { resolveLimits } from "./execution-limits.js";
import { tokenizeShell, Token, TokenType, isReservedWord } from "./shell-lexer.js";

/** Reasons the evaluator declined to run a script. The runtime maps these to escalation. */
export type UnsupportedReason =
  | "external_command"
  | "subshell"
  | "arithmetic_group"
  | "conditional_group"
  | "function_definition"
  | "heredoc"
  | "redirection"
  | "background_job"
  | "case_statement"
  | "select_statement"
  | "coproc"
  | "unbalanced_group";

/**
 * The evaluator's verdict on a script: run it here, or escalate it.
 *
 * A discriminated union rather than one interface with optional fields: when
 * `inMemorySafe` is false a caller always wants the reason, and the union is what
 * makes the compiler prove it is there instead of trusting an assertion.
 */
export type Classification =
  | { readonly inMemorySafe: true; readonly tokens: Token[] }
  | {
      readonly inMemorySafe: false;
      /** The first reason the script is not in-memory safe. */
      readonly reason: UnsupportedReason;
      /** The token the reason was discovered at, for the denial message. */
      readonly at?: Token;
      readonly tokens: Token[];
    };

/**
 * Token types that make a script unsafe to run in the fast tier. Each one means
 * the script needs something this evaluator does not model: a real process, a real
 * descriptor, a real kernel arithmetic unit, or a construct whose semantics are
 * not the ones implemented here.
 */
const UNSAFE_TOKEN_TYPES: ReadonlyMap<TokenType, UnsupportedReason> = new Map([
  [TokenType.DPAREN_START, "arithmetic_group"],
  [TokenType.DPAREN_END, "arithmetic_group"],
  [TokenType.DBRACK_START, "conditional_group"],
  [TokenType.DBRACK_END, "conditional_group"],
  [TokenType.LPAREN, "subshell"],
  [TokenType.RPAREN, "subshell"],
  [TokenType.DLESS, "heredoc"],
  [TokenType.DLESSDASH, "heredoc"],
  [TokenType.TLESS, "heredoc"],
  [TokenType.LESS, "redirection"],
  [TokenType.GREAT, "redirection"],
  [TokenType.DGREAT, "redirection"],
  [TokenType.LESSAND, "redirection"],
  [TokenType.GREATAND, "redirection"],
  [TokenType.LESSGREAT, "redirection"],
  [TokenType.CLOBBER, "redirection"],
  [TokenType.AND_GREAT, "redirection"],
  [TokenType.AND_DGREAT, "redirection"],
  [TokenType.AMP, "background_job"],
  [TokenType.CASE, "case_statement"],
  [TokenType.ESAC, "case_statement"],
  [TokenType.SELECT, "select_statement"],
  [TokenType.COPROC, "coproc"],
  [TokenType.FUNCTION, "function_definition"],
]);

/** Built-in commands the evaluator implements itself, so they need no process. */
const BUILTINS: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "true",
  "false",
  "cd",
  "pwd",
  "export",
  "unset",
  "exit",
  "return",
  "set",
  "shift",
  "colon",
  ":",
  "test",
  "[",
  "read",
  "sleep",
  "wait",
  "jobs",
  "kill",
  "type",
  "command",
  "help",
]);

/** Error thrown when a workload trips a configured ceiling. */
export class ExecutionLimitError extends Error {
  constructor(
    message: string,
    public readonly kind: "iterations" | "recursion" | "commands" | "output" | "time" | "memory",
  ) {
    super(message);
    this.name = "ExecutionLimitError";
  }
}

/** Error thrown when a script uses a construct this evaluator does not run. */
export class UnsupportedConstructError extends Error {
  constructor(
    public readonly reason: UnsupportedReason,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedConstructError";
  }
}

/** The result of evaluating one script. */
export interface EvaluationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Commands actually executed. Bounded by maxCommandCount. */
  commandCount: number;
  /** The classification that admitted the script to this tier. */
  classification: Classification;
}

export interface EvaluatorOptions {
  /** Limits; omitted fields use the `normal` profile defaults. */
  limits?: ExecutionLimits;
  /** Limit profile for the omitted fields. */
  profile?: "normal" | "hardened";
  /** Virtual filesystem. When absent the evaluator runs filesystem-free. */
  fs?: CowFsBackend;
  /** Initial environment. */
  env?: Record<string, string>;
  /** Initial working directory inside the virtual filesystem. */
  cwd?: string;
  /** Aborts evaluation; checked at every command and loop iteration. */
  signal?: AbortSignal;
  /** Monotonic clock, injectable so deadline tests are deterministic. */
  now?: () => number;
}

interface PipelineCommand {
  argv: string[];
  /** True when every word of the command was unquoted (subject to splitting). */
  unquoted: boolean[];
}

/**
 * Tokens that end a simple command. The word following one of these is a command
 * name again — the one position where a word names a binary rather than an
 * argument, an option, or a redirection target.
 */
const COMMAND_SEPARATORS: ReadonlySet<TokenType> = new Set<TokenType>([
  TokenType.SEMICOLON,
  TokenType.SEMI_AND,
  TokenType.SEMI_SEMI_AND,
  TokenType.DSEMI,
  TokenType.AND_AND,
  TokenType.OR_OR,
  TokenType.PIPE,
  TokenType.PIPE_AMP,
  TokenType.LBRACE,
  TokenType.BANG,
  TokenType.IF,
  TokenType.THEN,
  TokenType.ELIF,
  TokenType.ELSE,
  TokenType.DO,
  TokenType.FOR,
  TokenType.WHILE,
  TokenType.UNTIL,
  TokenType.CASE,
  TokenType.IN,
  TokenType.SELECT,
  TokenType.COPROC,
  TokenType.TIME,
  TokenType.FUNCTION,
  // A newline ends a command the same way `;` does; without it here, the first word of every
  // line after the first would be read as an argument of the previous command.
  TokenType.NEWLINE,
]);

/**
 * Classify a script without running it. Pure — no filesystem, no environment —
 * which is what lets the runtime decide a tier before committing to one.
 */
export function classifyScript(source: string): Classification {
  const tokens = tokenizeShell(source);
  let depth = 0;
  // The first word of the script is a command name. Every word after a separator is
  // too; a word anywhere else is an argument, and an argument is never an escalation
  // no matter what it spells.
  let commandPosition = true;

  for (const token of tokens) {
    if (token.type === TokenType.LBRACE) depth++;
    else if (token.type === TokenType.RBRACE) depth--;

    if (depth < 0) {
      return { inMemorySafe: false, reason: "unbalanced_group", at: token, tokens };
    }

    const reason = UNSAFE_TOKEN_TYPES.get(token.type);
    if (reason) {
      return { inMemorySafe: false, reason, at: token, tokens };
    }

    if (commandPosition && (token.type === TokenType.NAME || token.type === TokenType.WORD)) {
      // A word in command position names a binary unless it is a built-in or a
      // reserved word. Quoting does not matter here: the evaluator does not expand
      // command names at all in this tier, so `"rm"` is as external as `rm`.
      if (!BUILTINS.has(token.value) && !isReservedWord(token.value)) {
        return { inMemorySafe: false, reason: "external_command", at: token, tokens };
      }
    }

    // A word has filled the command-name slot, so the next word is an argument. A
    // leading assignment does not — `a=1 b=2 pwd` still names its command at `pwd` —
    // and neither does an fd prefix, whose word follows the operator it belongs to.
    if (token.type === TokenType.NAME || token.type === TokenType.WORD) {
      commandPosition = false;
    } else if (COMMAND_SEPARATORS.has(token.type)) {
      commandPosition = true;
    }
  }

  if (depth !== 0) {
    return { inMemorySafe: false, reason: "unbalanced_group", tokens };
  }
  return { inMemorySafe: true, tokens };
}

/**
 * The in-memory evaluator. One instance per evaluation so that a limit error in one
 * script cannot leave counters set for the next.
 */
export class ShellEvaluator {
  private readonly limits: Required<ExecutionLimits>;
  private readonly env: Record<string, string>;
  private cwd: string;
  private readonly fs?: CowFsBackend;
  private readonly signal?: AbortSignal;
  private readonly now: () => number;
  private readonly startedAt: number;
  private commands = 0;
  private stdout = "";
  private stderr = "";
  private exitCode = 0;
  private lastStatus = 0;
  /**
   * Set by the `exit` builtin. `runPipelineList` stops at the next separator, so
   * `exit 3; echo after` does not run `after` — and the status `exit` was called with
   * survives as the script's exit code instead of being overwritten by the commands
   * that should never have run.
   */
  private exiting = false;

  constructor(private readonly options: EvaluatorOptions = {}) {
    this.limits = resolveLimits(options.limits, options.profile ?? "normal");
    this.env = { ...(options.env ?? {}) };
    this.cwd = options.cwd ?? "/";
    this.fs = options.fs;
    this.signal = options.signal;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  /**
   * Evaluate a script. The script must already have passed classification; a script
   * containing an unsupported construct throws rather than being approximated.
   */
  async evaluate(source: string): Promise<EvaluationResult> {
    const classification = classifyScript(source);
    if (!classification.inMemorySafe) {
      const at = classification.at;
      throw new UnsupportedConstructError(
        classification.reason,
        `script uses ${classification.reason} at line ${at?.line ?? 0} column ${at?.column ?? 0}`,
      );
    }

    // Per-evaluation state: a reused instance must not carry a terminal signal out of a
    // previous script, or an `exit` in one call would truncate the next.
    this.exiting = false;

    await this.runPipelineList(classification.tokens);

    return {
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      durationMs: this.now() - this.startedAt,
      commandCount: this.commands,
      classification,
    };
  }

  private checkBudget(): void {
    if (this.signal?.aborted) {
      throw new ExecutionLimitError("execution aborted", "time");
    }
    if (this.now() - this.startedAt > this.limits.maxExecutionTimeMs) {
      throw new ExecutionLimitError(
        `execution exceeded ${this.limits.maxExecutionTimeMs}ms deadline`,
        "time",
      );
    }
  }

  private chargeCommand(): void {
    this.checkBudget();
    if (++this.commands > this.limits.maxCommandCount) {
      throw new ExecutionLimitError(
        `command count exceeded (${this.limits.maxCommandCount})`,
        "commands",
      );
    }
  }

  private writeStdout(text: string): void {
    if (this.stdout.length + text.length > this.limits.maxOutputSize) {
      throw new ExecutionLimitError(`output exceeded ${this.limits.maxOutputSize} bytes`, "output");
    }
    this.stdout += text;
  }

  private writeStderr(text: string): void {
    if (this.stderr.length + text.length > this.limits.maxOutputSize) {
      throw new ExecutionLimitError(`output exceeded ${this.limits.maxOutputSize} bytes`, "output");
    }
    this.stderr += text;
  }

  /**
   * Split the token list into pipelines separated by `;`, `&&`, `||`, and newline,
   * then run each in order. The control operators set the status the next pipeline
   * conditionally executes on, which is the whole of `&&` / `||` semantics.
   */
  private async runPipelineList(tokens: Token[]): Promise<void> {
    let current: Token[] = [];
    let separator: TokenType | null = null;

    const isSeparator = (type: TokenType): boolean =>
      type === TokenType.SEMICOLON ||
      type === TokenType.AND_AND ||
      type === TokenType.OR_OR ||
      type === TokenType.NEWLINE;

    // A command runs only if the operator that preceded it allows it: `&&` requires the
    // prior status to be zero, `||` requires non-zero, everything else runs unconditionally.
    // The separator is retained across word tokens — resetting it on every push destroyed
    // the operator context by the time the next separator landed, so the guards below never
    // fired and `false && echo nope` printed `nope`.
    const separatorAllows = (preceding: TokenType | null): boolean => {
      if (preceding === TokenType.AND_AND) return this.lastStatus === 0;
      if (preceding === TokenType.OR_OR) return this.lastStatus !== 0;
      return true;
    };

    for (const token of tokens) {
      if (isSeparator(token.type)) {
        if (current.length > 0 && separatorAllows(separator)) {
          await this.runPipeline(current);
        }
        current = [];
        separator = token.type;
        // `exit` terminated the script at the previous command; anything after this
        // separator must not run, and `exitCode` must not be overwritten.
        if (this.exiting) return;
        continue;
      }
      current.push(token);
    }

    if (!this.exiting && current.length > 0 && separatorAllows(separator))
      await this.runPipeline(current);
  }

  /** Run one pipeline: a sequence of commands joined by `|`. */
  private async runPipeline(tokens: Token[]): Promise<void> {
    const commands: Token[][] = [[]];
    for (const token of tokens) {
      if (token.type === TokenType.PIPE || token.type === TokenType.PIPE_AMP) {
        commands.push([]);
        continue;
      }
      commands[commands.length - 1]!.push(token);
    }

    let status = 0;
    for (const commandTokens of commands) {
      if (commandTokens.length === 0) continue;
      this.chargeCommand();
      status = await this.runCommand(commandTokens);
      this.lastStatus = status;
      if (status !== 0 && commands.length > 1) {
        // A failing stage aborts the rest of the pipeline, as in POSIX shells.
        break;
      }
    }
    this.exitCode = status;
  }

  /** Run one simple command: leading assignments, then a built-in (or nothing). */
  private async runCommand(tokens: Token[]): Promise<number> {
    const words: string[] = [];
    const unquoted: boolean[] = [];
    let first = 0;

    // Leading assignment words apply to the command's environment and do not
    // themselves become arguments.
    for (; first < tokens.length; first++) {
      const token = tokens[first]!;
      if (token.type !== TokenType.ASSIGNMENT_WORD) break;
      const eq = token.value.indexOf("=");
      const name = token.value.slice(0, eq);
      const rawValue = token.value.slice(eq + 1);
      this.env[name] = await this.expand(rawValue, token);
    }

    for (let i = first; i < tokens.length; i++) {
      const token = tokens[i]!;
      const expanded = await this.expand(token.value, token);
      if (!token.quoted) {
        for (const part of this.splitWords(expanded)) words.push(part);
        unquoted.push(true);
      } else {
        words.push(expanded);
        unquoted.push(false);
      }
    }

    if (words.length === 0) return 0;

    const name = words[0]!;
    if (!BUILTINS.has(name)) {
      // Classification should have caught this; reaching it means the classifier
      // and the evaluator disagree, which is a bug, not a runtime choice.
      throw new UnsupportedConstructError(
        "external_command",
        `command ${name} is not an in-memory built-in`,
      );
    }

    return this.runBuiltin(name, words.slice(1));
  }

  /**
   * Parameter expansion. Supported forms are the ones a script can use without
   * reaching outside the process: `$VAR`, `${VAR}`, `${VAR:-default}`,
   * `${VAR-default}`, `${VAR:+alt}`, `${VAR?error}`, `$$` (pid surrogate),
   * `$?` (last status), and `$(...)` is *not* supported — command substitution is
   * what makes a script able to reach a binary, so classification rejects it and
   * this function never sees one.
   */
  private async expand(raw: string, token: Token): Promise<string> {
    let out = "";
    let i = 0;
    while (i < raw.length) {
      const char = raw[i]!;
      if (char === "$") {
        const expansion = this.expandAt(raw, i, token);
        out += expansion.value;
        i = expansion.next;
        continue;
      }
      if (char === "\\" && !token.singleQuoted) {
        const next = raw[i + 1];
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
      }
      out += char;
      i++;
    }
    return out;
  }

  private expandAt(raw: string, index: number, token: Token): { value: string; next: number } {
    if (raw[index + 1] === "{") {
      const end = raw.indexOf("}", index + 2);
      if (end === -1) {
        throw new ExecutionLimitError("unterminated parameter expansion", "iterations");
      }
      const body = raw.slice(index + 2, end);
      return { value: this.expandParameter(body, token), next: end + 1 };
    }
    if (raw[index + 1] === "?") return { value: String(this.lastStatus), next: index + 2 };
    if (raw[index + 1] === "$") return { value: "0", next: index + 2 };
    if (raw[index + 1] === "#") return { value: String(process.argv.length - 2), next: index + 2 };

    let j = index + 1;
    let name = "";
    while (j < raw.length && /[A-Za-z0-9_]/.test(raw[j]!)) {
      name += raw[j];
      j++;
    }
    if (name === "") return { value: "$", next: index + 1 };
    return { value: this.env[name] ?? "", next: j };
  }

  /**
   * Expand one `${...}` body. The operators handled are the two a script uses to
   * spell a fallback or a guard; the rest fall through to "unset is empty", which
   * is POSIX's plain `${VAR}` semantics and never a security decision.
   */
  private expandParameter(body: string, token: Token): string {
    const operators = [":-", ":+", "-", "+", ":?", "?"] as const;
    for (const op of operators) {
      const at = body.indexOf(op);
      if (at > 0) {
        const name = body.slice(0, at);
        const word = body.slice(at + op.length);
        const isSet = name in this.env && this.env[name] !== "";
        if (op === ":-") return isSet ? this.env[name]! : word;
        if (op === "-") return name in this.env ? this.env[name]! : word;
        if (op === ":+") return isSet ? word : "";
        if (op === "+") return name in this.env ? word : "";
        if (op === ":?" || op === "?") {
          if (!isSet) {
            this.writeStderr(`${name}: ${word || "parameter null or not set"}\n`);
            this.exitCode = 1;
          }
          return this.env[name] ?? "";
        }
      }
    }
    return this.env[body] ?? "";
  }

  /** Unquoted-field splitting on the IFS characters (space, tab, newline). */
  private splitWords(value: string): string[] {
    return value.split(/[ \t\n]+/).filter((part) => part !== "");
  }

  /**
   * The built-in command set. Each returns an exit status; none of them spawns a
   * process or touches the real filesystem. `cd` and `pwd` operate on the virtual
   * cwd so a script's notion of "here" is the sandbox's, not the host's.
   */
  private async runBuiltin(name: string, args: string[]): Promise<number> {
    switch (name) {
      case "echo":
      case "printf": {
        const newline = name === "echo" && !args.includes("-n");
        const text = args.join(" ");
        this.writeStdout(`${newline ? `${text}\n` : text}`);
        return 0;
      }
      case ":":
      case "colon":
      case "true":
        return 0;
      case "false":
        return 1;
      case "test":
      case "[": {
        // `[` requires a closing `]`; a missing bracket is a syntax error in POSIX,
        // and reporting it keeps a malformed conditional from silently passing.
        if (name === "[") {
          const last = args[args.length - 1];
          if (last !== "]") {
            this.writeStderr("[: missing `]'\n");
            return 2;
          }
          args = args.slice(0, -1);
        }
        return this.runTest(args);
      }
      case "pwd": {
        this.writeStdout(`${this.cwd}\n`);
        return 0;
      }
      case "cd": {
        const target = args[0] ?? this.env["HOME"] ?? "/";
        const resolved = this.resolveVirtualPath(target);
        if (this.fs) {
          const stat = await this.fs.stat(resolved);
          if (stat === undefined || !stat.isDirectory) {
            this.writeStderr(`cd: ${target}: No such file or directory\n`);
            return 1;
          }
        }
        this.cwd = resolved;
        this.env["PWD"] = resolved;
        return 0;
      }
      case "export": {
        for (const arg of args) {
          const eq = arg.indexOf("=");
          if (eq === -1) continue;
          this.env[arg.slice(0, eq)] = arg.slice(eq + 1);
        }
        return 0;
      }
      case "unset": {
        for (const arg of args) delete this.env[arg];
        return 0;
      }
      case "set":
        // `set` is accepted and ignored: the evaluator does not implement shell
        // options, and silently accepting `-e`/`-u` would change exit semantics the
        // scripts using them expect to be enforced.
        return 0;
      case "shift": {
        const count = Number(args[0] ?? 1);
        if (!Number.isSafeInteger(count) || count < 0) {
          this.writeStderr(`shift: ${args[0]}: numeric argument required\n`);
          return 1;
        }
        return 0;
      }
      case "exit": {
        // `exit` ends the script with the status it was given (the last status by default).
        // It must both record that status — `runPipelineList` stops here rather than letting a
        // later command overwrite `exitCode` — and return it so the builtin's caller sees it.
        // The status is preserved as given: like the statuses other builtins already emit (`2`
        // from `shift` misuse, `127` for a missing command), it is the caller's signal, and a
        // real shell's `exit 3` is reported as 3. Booleanizing to 0/1 discarded the value the
        // script asked to exit with, so `exit 3` and `exit 1` were indistinguishable.
        const code = Number(args[0] ?? this.lastStatus);
        this.exiting = true;
        if (!Number.isSafeInteger(code)) return 1;
        // POSIX truncates an out-of-range status to the low 8 bits, and a negative one is
        // reported as 256 + n (as `exit -1` → 255 in sh/bash).
        return ((Math.trunc(code) % 256) + 256) % 256;
      }
      case "return":
        return Number(args[0] ?? 0) === 0 ? 0 : 1;
      case "type":
      case "command": {
        for (const arg of args) {
          if (BUILTINS.has(arg)) {
            this.writeStdout(`${arg} is a shell builtin\n`);
          } else {
            this.writeStderr(`${arg}: not found\n`);
          }
        }
        return 0;
      }
      case "help":
        this.writeStdout(`builtins: ${[...BUILTINS].sort().join(", ")}\n`);
        return 0;
      case "sleep": {
        const seconds = Number(args[0] ?? 0);
        if (!Number.isFinite(seconds) || seconds < 0) {
          this.writeStderr(`sleep: ${args[0]}: numeric argument required\n`);
          return 1;
        }
        return 0;
      }
      case "read":
      case "wait":
      case "jobs":
      case "kill":
        // Job control and reads need real descriptors; the in-memory tier reports
        // them as no-ops with a non-zero status so a script relying on them fails
        // loudly instead of continuing on empty input.
        this.writeStderr(`${name}: not available in the in-memory tier\n`);
        return 1;
      default:
        this.writeStderr(`${name}: command not found\n`);
        return 127;
    }
  }

  /**
   * `[` / `test`: the file and string tests a conditional needs. Only the string
   * comparisons and the `-z`/`-n`/`-e`/`-d`/`-f` tests are implemented, and the
   * file tests consult the *virtual* filesystem — a real `test -d /` would answer
   * about the host.
   */
  private async runTest(args: string[]): Promise<number> {
    if (args.length === 0) return 1;
    if (args.length === 1) return args[0] === "" ? 1 : 0;

    if (args.length === 2) {
      const [op, operand] = args as [string, string];
      if (op === "-z") return operand === "" ? 0 : 1;
      if (op === "-n") return operand !== "" ? 0 : 1;
      if (op === "-e" || op === "-f" || op === "-d") {
        if (!this.fs) return 1;
        const stat = await this.fs.stat(this.resolveVirtualPath(operand));
        if (stat === undefined) return 1;
        if (op === "-d") return stat.isDirectory ? 0 : 1;
        if (op === "-f") return stat.isFile ? 0 : 1;
        return 0;
      }
      this.writeStderr(`test: unknown unary operator: ${op}\n`);
      return 2;
    }

    if (args.length === 3) {
      const [left, op, right] = args as [string, string, string];
      if (op === "=" || op === "==") return left === right ? 0 : 1;
      if (op === "!=") return left !== right ? 0 : 1;
      if (op === "-eq") return Number(left) === Number(right) ? 0 : 1;
      if (op === "-ne") return Number(left) !== Number(right) ? 0 : 1;
      if (op === "-lt") return Number(left) < Number(right) ? 0 : 1;
      if (op === "-gt") return Number(left) > Number(right) ? 0 : 1;
      if (op === "-le") return Number(left) <= Number(right) ? 0 : 1;
      if (op === "-ge") return Number(left) >= Number(right) ? 0 : 1;
      this.writeStderr(`test: unknown binary operator: ${op}\n`);
      return 2;
    }

    this.writeStderr("test: too many arguments\n");
    return 2;
  }

  private resolveVirtualPath(path: string): string {
    if (path.startsWith("/")) return path;
    if (this.cwd === "/") return `/${path}`;
    return `${this.cwd}/${path}`;
  }
}
