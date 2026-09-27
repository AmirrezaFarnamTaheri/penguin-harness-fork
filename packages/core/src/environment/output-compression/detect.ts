/**
 * Deciding *which* outputs are worth compressing, and deciding that before the tool runs.
 *
 * ## Why the decision is made up front
 *
 * Environment streams a tool's deltas to the frontend live and guarantees that concatenating the
 * streamed deltas reproduces the complete `tool_call_output` exactly. Compression replaces the
 * text, so it cannot be applied to a prefix that has already been streamed. A call therefore has
 * to be classified *before* the first delta, which means the classification is made from the
 * tool name and its arguments — `vitest run`, `git log`, a `.log` path — not from the output.
 *
 * That is also the conservative ordering the whole feature rests on: a command is recognised
 * here, and then the *output* has to confirm the shape before anything is dropped
 * (`compressOutput` returns `null` on any mismatch). An unrecognised command gets no buffer, no
 * latency, and byte-identical behaviour to a build without this module.
 *
 * The cost of being wrong in the permissive direction is bounded: a `git status` on a clean tree
 * buffers for a few hundred milliseconds and then ships unchanged.
 */
import { EXEC_COMMAND_NAME } from "../tools/exec-command.js";
import { INPUT_COMMAND_NAME } from "../tools/input-command.js";
import { READ_FILE_NAME } from "../tools/read-file.js";
import type { OutputKind } from "./strategies.js";

/** Shell operators that end one simple command and begin the next. */
const SEGMENT_SPLIT = /\|\||&&|;|\||\n|\r/;

/** Leading words that are not the command: variable assignments, `env`, privilege wrappers. */
const LEADING_NOISE = new Set(["env", "sudo", "doas", "command", "exec", "nohup", "time", "nice"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Test-runner programs. Matching the *program* (not the whole command line) is what makes
 * `pnpm vitest run`, `npx jest --ci` and `./node_modules/.bin/vitest run` all land on the same
 * strategy without enumerating every wrapper a package manager invents.
 */
const TEST_RUNNERS = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "tap",
  "karma",
  "pytest",
  "py.test",
  "rspec",
  "phpunit",
  "tox",
  "nextest",
]);

/**
 * A package-manager script name is treated as a test run when it mentions "test" anywhere:
 * `test`, `test:unit`, `unit-test` and `tests` are all the same intent, and a project is free to
 * pick any of them. The cost of a false positive is one unchanged output; the cost of a false
 * negative is a full test log in the context window.
 */
const TEST_SCRIPT_NAME = /test/i;

/**
 * `npm run lint` / `pnpm run typecheck` are as common as calling the linter directly, and the
 * script name is the only clue. A false positive costs one unchanged output.
 */
const LINT_SCRIPT_NAME = /(^|[-:_/])(lint|typecheck|check-types?|tsc)($|[-:_/])/i;

/** Linters whose findings are all signal; the strategies only strip presentation around them. */
const LINTERS = new Set([
  "oxlint",
  "eslint",
  "biome",
  "ruff",
  "golangci-lint",
  "tsc",
  "shellcheck",
  "stylelint",
  "flake8",
  "pylint",
  "rubocop",
  "hadolint",
  "markdownlint",
  "yamllint",
  "detekt",
  "swiftlint",
]);

/** Programs whose output is a log tail, where repeated lines are the norm rather than a bug. */
const LOG_READERS = new Set(["cat", "tail", "bat"]);

/** Splitting a shell line into its simple-command segments, each as an array of words. */
function commandWords(command: string): string[][] {
  return command
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .map((segment): string[] => {
      const words = segment.split(/\s+/).filter((word) => !ASSIGNMENT.test(word));
      while (words.length > 0 && LEADING_NOISE.has(words[0]!.toLowerCase())) words.shift();
      return words;
    })
    .filter((words) => words.length > 0);
}

/** The program's own name, with a `.exe` suffix and any directory stripped. */
function programOf(word: string): string {
  const base = word.slice(word.lastIndexOf("/") + 1).replace(/\.(exe|cmd|bat|ps1)$/i, "");
  return base.toLowerCase();
}

/** A launcher whose next word is the real program: `npx jest`, `bunx vitest`, `uvx ruff`. */
const LAUNCHERS = new Set(["npx", "bunx", "pnpx", "uvx", "pipx", "poetryx", "uv", "rye"]);

/** Package managers, which are a launcher for a *script* and a launcher for a *binary* at once. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pnpx"]);

/** Interpreters that can run a module by name, where the module is the program. */
const INTERPRETERS = new Set(["python", "python3", "py", "python2"]);

interface Invocation {
  program: string;
  /** What follows the program, lower-cased — the sub-command for git/go/cargo, "" otherwise. */
  sub: string;
  /** Everything after the program, for argument sniffing (`tail app.log`). */
  args: string[];
  /** Set when a package manager was told to run a named script, e.g. `pnpm run test:unit`. */
  script: string | null;
}

/** Index of the first word at or after `from` that is not a `-`-prefixed flag. */
function skipFlags(words: string[], from: number): number {
  let i = from;
  while (i < words.length && words[i]!.startsWith("-")) i += 1;
  return i;
}

/**
 * Peels launchers off one segment and reports the program that will actually produce the output.
 *
 * Without this, `pnpm vitest run`, `npx jest --ci` and `python -m pytest` all classify as unknown
 * and stream unchanged — which is safe but leaves the three most common ways a JavaScript or
 * Python project runs its tests uncompressed.
 */
function invocationOf(words: string[]): Invocation {
  const none: Invocation = { program: "", sub: "", args: [], script: null };
  if (words.length === 0) return none;
  let program = programOf(words[0]!);
  let index = 1;

  if (PACKAGE_MANAGERS.has(program)) {
    const verb = (words[1] ?? "").toLowerCase();
    if (verb === "test" || verb === "t") {
      return { program: "test", sub: "", args: words.slice(2), script: null };
    }
    if (verb === "run") {
      return { program: "script", sub: "", args: words.slice(2), script: words[2] ?? "" };
    }
    // `pnpm exec vitest` and `bun x vitest` name the binary after the verb; `pnpm vitest run` and
    // `npm jest` pass one through in its place. Both forms exist and both are common.
    index =
      verb === "exec" || verb === "dlx" || verb === "x" ? skipFlags(words, 2) : skipFlags(words, 1);
    program = programOf(words[index] ?? "");
  } else if (INTERPRETERS.has(program) && (words[1] ?? "").toLowerCase() === "-m") {
    index = 2;
    program = programOf(words[index] ?? "");
  } else if (LAUNCHERS.has(program)) {
    index = skipFlags(words, 1);
    program = programOf(words[index] ?? "");
  }

  if (program === "") return none;
  return {
    program,
    sub: (words[index] ?? "").toLowerCase(),
    // Everything after the program, including the sub-command: for `cat build.log` the file is
    // the sub-command, and for `tail -200 app.log` it is an argument. Both have to be sniffed.
    args: words.slice(index > 1 ? index : 1),
    script: null,
  };
}

/** True when the command targets a log file somewhere in its arguments. */
function mentionsLogFile(args: string[]): boolean {
  return args.some((word) => /\.(log|log\.\d+|out)(\s|$)/i.test(word));
}

/**
 * Classifies one exec_command / input_command invocation, or returns null to mean "stream it
 * exactly as it is today".
 *
 * Every segment is examined, not only the first: `cd repo && git log` and `pnpm lint; git status`
 * both end in the command whose output matters. A pipeline needs no special case — `git log |
 * head -5` really is git log output, and if it is too short to compress the strategy says so.
 */
function classifyCommand(command: string): OutputKind | null {
  for (const words of commandWords(command)) {
    const call = invocationOf(words);
    switch (call.program) {
      case "":
        continue;
      case "test":
        return "test-runner";
      case "script":
        if (TEST_SCRIPT_NAME.test(call.script ?? "")) return "test-runner";
        if (LINT_SCRIPT_NAME.test(call.script ?? "")) return "lint";
        continue;
      case "git":
        if (call.sub === "log") return "git-log";
        if (call.sub === "status") return "git-status";
        if (call.sub === "diff") return "git-diff";
        continue;
      case "go":
      case "cargo":
      case "dotnet":
      case "mvn":
      case "gradle":
      case "node":
        if (call.sub === "test" || (call.program === "node" && call.args.includes("--test"))) {
          return "test-runner";
        }
        if (call.program === "cargo" && call.sub === "nextest") return "test-runner";
        continue;
      default:
        if (TEST_RUNNERS.has(call.program)) return "test-runner";
        if (LINTERS.has(call.program)) return "lint";
        if (LOG_READERS.has(call.program) && mentionsLogFile(call.args)) return "log-dedup";
        continue;
    }
  }
  return null;
}

/** What a tool call's arguments say about its output type; null means "no compression". */
export function classifyToolOutput(
  toolName: string,
  args: Record<string, unknown>,
): OutputKind | null {
  if (toolName === EXEC_COMMAND_NAME || toolName === INPUT_COMMAND_NAME) {
    const raw = args["cmd"] ?? args["command"];
    if (typeof raw !== "string" || raw.trim() === "") return null;
    return classifyCommand(raw);
  }
  if (toolName === READ_FILE_NAME) {
    const filePath = args["file_path"];
    // Only log files. A source file that happens to repeat a line is still a source file, and
    // deduplicating it would hand the model a file that is not the file on disk.
    if (typeof filePath !== "string") return null;
    return /\.(log|out)$/i.test(filePath) ? "log-dedup" : null;
  }
  return null;
}
