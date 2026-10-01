/**
 * Commander's own parse failures, said in the user's language.
 *
 * With `exitOverride()` commander still WRITES its English line before throwing
 * (`error: missing required argument 'sessionId'`), so `cli()` silences that output
 * channel and prints from here instead: one localized sentence naming what is wrong, and
 * — for every way a command can be typed wrong — that command's own usage plus a pointer
 * at its `--help`. Exit codes are commander's, unchanged.
 *
 * Identifiers from the registered grammar (argument names and required option flags) may be
 * shown. Unknown command/option spellings and invalid values are never echoed; a unique close
 * match may be suggested from the command's registered vocabulary.
 */
import type { Command, CommanderError } from "commander";
import type { Messages } from "./i18n.js";
import { suggestKnownToken } from "./arg-suggestions.js";

/** Commander codes that mean "the command line was typed wrong" — these earn the usage line. */
const USAGE_ERROR_CODES = new Set([
  "commander.missingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.optionMissingArgument",
  "commander.unknownOption",
  "commander.unknownCommand",
  "commander.invalidArgument",
  "commander.excessArguments",
  "commander.conflictingOption",
]);

/**
 * The deepest registered command this argv actually named, so the usage line quotes
 * `penguin schedule add` rather than `penguin`. Registered option arity is used to skip
 * values; an unknown flag stops the walk before its value can be mistaken for a command.
 */
export function commandForArgv(program: Command, argv: string[]): Command {
  let cmd = program;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token.startsWith("-")) {
      const inlineValue = token.includes("=");
      const flag = token.split("=", 1)[0]!;
      const option = optionForCommand(cmd, flag);
      // An unknown flag may be followed by a value that happens to be a real command name.
      // Stop here so that value can never select a sibling command's vocabulary.
      if (option === undefined) break;
      if (!inlineValue && (option.required || option.optional)) {
        const value = argv[index + 1];
        if (value !== undefined && (option.required || !value.startsWith("-"))) index += 1;
      }
      continue;
    }
    const next = cmd.commands.find((c) => c.name() === token || c.aliases().includes(token)) as
      Command | undefined;
    if (next === undefined) break;
    cmd = next;
  }
  return cmd;
}

function optionForCommand(command: Command, flag: string) {
  for (let current: Command | null = command; current !== null; current = current.parent) {
    const option = current.options.find(
      (candidate) => candidate.short === flag || candidate.long === flag,
    );
    if (option !== undefined) return option;
  }
  return undefined;
}

/** Full spelling of a command including its ancestors (`penguin schedule add`). */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c !== null; c = c.parent) parts.unshift(c.name());
  return parts.join(" ");
}

/** The single-quoted identifier in a commander message, when it has one. */
function quotedIdentifier(message: string): string | null {
  const m = /'([^']+)'/.exec(message);
  return m === null ? null : m[1]!;
}

function suggestionLine(message: string, candidate: string | undefined, t: Messages): string {
  return candidate === undefined ? message : `${message}. ${t.usage.suggestion(candidate)}`;
}

function commandVocabulary(command: Command): string[] {
  return command.commands.map((child) => child.name()).filter(Boolean);
}

function commandOptions(command: Command): string[] {
  const flags = new Set<string>();
  for (let current: Command | null = command; current !== null; current = current.parent) {
    for (const option of current.options) {
      if (option.short) flags.add(option.short);
      if (option.long) flags.add(option.long);
    }
  }
  return [...flags].sort();
}

function unknownCommandToken(program: Command, argv: string[]): string | undefined {
  let current = program;
  for (const token of argv) {
    if (token.startsWith("-")) continue;
    const child = current.commands.find(
      (candidate) => candidate.name() === token || candidate.aliases().includes(token),
    );
    if (child === undefined) return token;
    current = child;
  }
  return undefined;
}

function suggestCommand(token: string | undefined, command: Command): string | undefined {
  return token === undefined ? undefined : suggestKnownToken(token, commandVocabulary(command));
}

function suggestOption(token: string | undefined, command: Command): string | undefined {
  if (token === undefined) return undefined;
  // Commander may include an inline value in the quoted token. Strip it before matching and
  // never put the supplied spelling back into an error message.
  const flag = token.split("=", 1)[0]!;
  return suggestKnownToken(flag, commandOptions(command));
}

/** The localized sentence for one commander failure. */
function usageErrorLine(
  err: CommanderError,
  argv: string[],
  program: Command,
  command: Command,
  atRoot: boolean,
  t: Messages,
): string {
  // `penguin <typo>`: bare `penguin` prints help, so the root carries an action handler
  // and commander calls a stray word "too many arguments". For a program that is nothing
  // but subcommands, the true diagnosis is an unknown command — say that instead.
  if (err.code === "commander.excessArguments" && atRoot) {
    const word = unknownCommandToken(program, argv);
    return suggestionLine(t.usage.unknownCommand(), suggestCommand(word, program), t);
  }
  const detail = err.message.replace(/^error:\s*/, "");
  const token = quotedIdentifier(err.message);
  switch (err.code) {
    case "commander.missingArgument":
      return token === null ? t.usage.invalidArgument() : t.usage.missingArgument(token);
    case "commander.missingMandatoryOptionValue":
      return token === null ? t.usage.invalidArgument() : t.usage.missingOption(token);
    case "commander.optionMissingArgument":
      return token === null ? t.usage.invalidArgument() : t.usage.optionMissingArgument(token);
    case "commander.unknownOption":
      return suggestionLine(
        t.usage.unknownOption(),
        suggestOption(token ?? argv.findLast((arg) => arg.startsWith("-")), command),
        t,
      );
    case "commander.unknownCommand":
      return suggestionLine(
        t.usage.unknownCommand(),
        suggestCommand(token ?? unknownCommandToken(program, argv), command),
        t,
      );
    case "commander.invalidArgument":
      return t.usage.invalidArgument();
    case "commander.excessArguments":
      return t.usage.excessArguments();
    case "commander.conflictingOption":
      return t.usage.conflictingOptions();
    default:
      return USAGE_ERROR_CODES.has(err.code) ? t.usage.invalidArgument() : t.usage.other(detail);
  }
}

/**
 * Reports one CommanderError and returns the exit code to hand back. `--help` and
 * `--version` travel this path too (exit code 0): they have already written their own
 * output, so nothing more is printed.
 */
export function reportCommanderError(
  err: CommanderError,
  program: Command,
  argv: string[],
  t: Messages,
): number {
  if (err.exitCode === 0) return err.exitCode;
  const cmd = commandForArgv(program, argv);
  // The Commander error's command is the precise parser owner even when a positional value
  // makes the grammar-free argv walk stop at its parent.
  process.stderr.write(`${t.error(usageErrorLine(err, argv, program, cmd, cmd === program, t))}\n`);
  if (USAGE_ERROR_CODES.has(err.code)) {
    process.stderr.write(`${t.usage.hint(commandPath(cmd), cmd.usage())}\n`);
  }
  return err.exitCode;
}
