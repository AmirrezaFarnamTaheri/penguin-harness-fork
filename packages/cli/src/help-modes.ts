/**
 * Tiered CLI help: one registry, three modes, and a width the output respects.
 *
 * `penguin --help` is the first thing most people read, and it had grown into an exhaustive
 * dump: every command, every global option, every alias. The card's requirement is a *usable
 * concise default* with the full inventory still reachable, and this module is the contract:
 *
 * | mode      | commands                        | options                  | how to ask                       |
 * | --------- | ------------------------------- | ------------------------ | -------------------------------- |
 * | `simple`  | the few a first session needs    | help / version / mode    | `penguin --help-mode simple`     |
 * | `default` | simple plus everyday operations  | help / version / mode    | `penguin --help`                 |
 * | `full`    | every registered command, aliases| every global option      | `penguin --help-mode full`       |
 *
 * Three properties this module exists to guarantee, because each one is otherwise easy to lose:
 *
 *   1. **The inventory is the live registry.** Filtering happens over the commander tree at
 *      render time, never over a second hand-maintained list. A command that is registered but
 *      not classified still appears in `default` and `full` (fail-open — help must never hide a
 *      command), and {@link unclassifiedCommands} names it so the gap is visible rather than
 *      silent; the test suite asserts that list is empty.
 *   2. **Width is a policy, not a hope.** Output is rendered through
 *      {@link renderCommandHelp} with a clamped width ({@link helpWidth}), and descriptions are
 *      shortened by whole words so a long localized sentence cannot blow the layout apart in a
 *      narrow terminal.
 *   3. **Exit semantics are untouched.** `--help`, bare `penguin`, and `--version` keep exit 0
 *      (commander's own path); a malformed `--help-mode` value is a usage error with the same
 *      localized sentence and usage line as every other typed-wrong command, and it never echoes
 *      the value back.
 *
 * Deliberately free of commander's `Help` class internals: the renderer takes the few facts it
 * needs (`usage()`, `commands`, `options`, `description()`) so the behavior is provable by a
 * pure test as well as by a `cli()` snapshot.
 */
import type { Command, Option } from "commander";
import type { Messages } from "./i18n.js";

/** The three inventories. `default` is what `--help` shows. */
export type HelpMode = "simple" | "default" | "full";

/** The flag that selects a mode; also listed in the help output itself. */
export const HELP_MODE_FLAG = "--help-mode";

/** Where a command sits in the tiers. `simple` ⊂ `default` ⊂ `full` by construction. */
export const COMMAND_TIERS: Readonly<Record<string, "simple" | "default">> = {
  // A first session: get in, talk, run one task, read what happened.
  auth: "simple",
  server: "simple",
  chat: "simple",
  run: "simple",
  logs: "simple",
  recall: "simple",
  version: "simple",
  // Everyday operations beyond the first session.
  web: "default",
  ls: "default",
  input: "default",
  agent: "default",
  project: "default",
  config: "default",
  cost: "default",
  schedule: "default",
  org: "default",
  update: "default",
};

/** Parses the flag's value. `undefined` (flag absent) means `default`; anything else unknown is null. */
export function parseHelpMode(raw: string | undefined): HelpMode | null {
  if (raw === undefined) return "default";
  if (raw === "simple" || raw === "default" || raw === "full") return raw;
  return null;
}

/**
 * The mode named on the command line, without parsing the rest of argv.
 *
 * The help renderer is configured before commander parses (its own `--help` path writes and exits
 * from inside the parse), so the mode has to be readable beforehand. Both spellings work
 * (`--help-mode full`, `--help-mode=full`), and the last one wins — the same rule commander uses
 * for a repeated option.
 */
export function helpModeFromArgv(argv: readonly string[]): { mode: HelpMode; raw: string | null } {
  let raw: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === HELP_MODE_FLAG) {
      const value = argv[index + 1];
      raw = value !== undefined && !value.startsWith("-") ? value : "";
    } else if (token.startsWith(`${HELP_MODE_FLAG}=`)) {
      raw = token.slice(HELP_MODE_FLAG.length + 1);
    }
  }
  return { mode: (raw === null ? "default" : parseHelpMode(raw)) ?? "default", raw };
}

/** True when the value the user typed is not a mode at all (used to fail with a usage error). */
export function isMalformedHelpMode(raw: string | null): boolean {
  return raw !== null && parseHelpMode(raw) === null;
}

/** Clamps a terminal width to the range help stays readable in. Unknown width = 80 columns. */
export function helpWidth(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return 80;
  return Math.max(56, Math.min(100, Math.floor(columns)));
}

/** Does this command belong in this mode's inventory? Unclassified commands fail open. */
export function commandInMode(name: string, mode: HelpMode): boolean {
  if (mode === "full") return true;
  const tier = COMMAND_TIERS[name];
  if (tier === undefined) return true;
  return mode === "simple" ? tier === "simple" : true;
}

/**
 * Registered top-level commands the tier table does not classify.
 *
 * `commandInMode` fails open so help never hides a command; this is how the *other* half of that
 * decision stays visible — the test asserts the list is empty, so adding a command without
 * thinking about its tier fails a test instead of quietly bloating (or vanishing from) a mode.
 */
export function unclassifiedCommands(program: Command): string[] {
  return program.commands
    .map((command) => command.name())
    .filter((name) => COMMAND_TIERS[name] === undefined)
    .sort();
}

/**
 * The global options a mode shows.
 *
 * `simple` and `default` show the three flags a reader needs to navigate help itself; `full` adds
 * everything else (so `full` is also the place to discover `--root` and friends). Options a
 * subcommand declares for itself are always shown — hiding a command's own flags would make help
 * useless exactly where it is needed.
 */
export function optionInMode(
  option: Option,
  mode: HelpMode,
  context: { isRoot: boolean; inherited: boolean },
): boolean {
  if (!context.isRoot || !context.inherited) return true;
  const flag = option.long ?? option.short ?? "";
  const navigational = ["-h", "--help", "-v", "--version", HELP_MODE_FLAG];
  if (mode === "full") return true;
  return navigational.includes(flag);
}

/**
 * Shortens a description for the mode and width by whole words.
 *
 * In `full`, and whenever the text fits, the description is returned unchanged: shortening is a
 * concession to narrow terminals, not a rewrite of the copy. A description that had to be cut
 * ends with an ellipsis so a reader can tell the sentence continues in `--help-mode full`.
 */
export function fitDescription(description: string, mode: HelpMode, width: number): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (mode === "full" || text.length <= width) return text;
  if (width <= 1) return "…";
  const cut = text.slice(0, width - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > width / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** One rendered line block: a name column and a description column, wrapping inside `width`. */
function row(name: string, description: string, width: number, indent: number): string[] {
  const nameColumn = indent;
  const descriptionColumn = Math.min(indent + 22, Math.floor(width / 2));
  const nameText = `${" ".repeat(nameColumn)}${name}`;
  if (description === "") return [nameText];
  const wrapWidth = Math.max(16, width - descriptionColumn);
  const words = description.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > wrapWidth && current !== "") {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  const pad = " ".repeat(Math.max(1, descriptionColumn - nameText.length));
  return lines.map((line, index) =>
    index === 0 ? `${nameText}${pad}${line}` : `${" ".repeat(descriptionColumn)}${line}`,
  );
}

/** The facts the renderer needs from a command; `Command` satisfies it structurally. */
export interface HelpRenderableCommand {
  name(): string;
  aliases(): readonly string[];
  usage(): string;
  description(): string;
  commands: readonly HelpRenderableCommand[];
  options: readonly Option[];
  parent: HelpRenderableCommand | null;
  /** Commander keeps the built-in `-h, --help` outside `options`; the renderer has to ask for it. */
  _getHelpOption?(): Option | null;
}

/**
 * Options declared by ancestors of this command.
 *
 * Commander resolves a root option like `--agent-id` while parsing a subcommand but does not copy
 * it into that subcommand's `options`, so a nested help page would otherwise be the one place a
 * user cannot discover the global flags their command accepts. Named here so `full` can show them
 * and the concise modes can point at `full`.
 */
function ancestorOptions(command: HelpRenderableCommand): Option[] {
  const own = new Set(displayedOptions(command).map((option) => option.flags));
  const inherited: Option[] = [];
  for (let parent = command.parent; parent !== null; parent = parent.parent) {
    for (const option of displayedOptions(parent)) {
      if (NAVIGATIONAL_OPTIONS.includes(option.flags)) continue; // help/version/mode are pinned
      if (!own.has(option.flags) && !inherited.some((seen) => seen.flags === option.flags)) {
        inherited.push(option);
      }
    }
  }
  return inherited;
}

/** Flags that navigate help rather than describe work; they are shown once, pinned, never "global". */
const NAVIGATIONAL_OPTIONS = ["-h, --help", "-v, --version", `${HELP_MODE_FLAG} <mode>`];

/** Wraps a plain sentence (the `full` pointer) inside the width, breaking at spaces. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > width && current !== "") {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** `penguin schedule add` — the full spelling a reader can copy. */
function commandPath(command: HelpRenderableCommand): string {
  const parts: string[] = [];
  for (
    let current: HelpRenderableCommand | null = command;
    current !== null;
    current = current.parent
  ) {
    parts.unshift(current.name());
  }
  return parts.join(" ");
}

/** The options to display: declared ones plus the built-in help flag. */
function displayedOptions(command: HelpRenderableCommand): Option[] {
  const options = [...command.options];
  const helpOption = command._getHelpOption?.() ?? null;
  if (helpOption !== null) options.push(helpOption);
  return options;
}

/** Which commands an option's `inherit` marker applies to (commander's own bookkeeping). */
function isInheritedOption(option: Option, command: HelpRenderableCommand): boolean {
  return command.options.includes(option);
}

/**
 * Renders one command's help in a mode at a width.
 *
 * Sections in the order a reader needs them: usage, description, the command list (filtered),
 * the options (filtered), and — for the root in `simple`/`default` only — the pointer at the
 * fuller inventory, so "how do I see the rest" is answered on the page that raised the question.
 */
export function renderCommandHelp(
  command: HelpRenderableCommand,
  mode: HelpMode,
  width: number,
  t: Messages,
): string {
  const isRoot = command.parent === null;
  const lines: string[] = [];
  lines.push(`${t.help.usageLabel}`, `  ${commandPath(command)} ${command.usage()}`, "");
  const description = fitDescription(command.description(), mode, width);
  if (description !== "") lines.push(description, "");

  if (isRoot) {
    const visible = command.commands.filter((child) => commandInMode(child.name(), mode));
    if (visible.length > 0) {
      lines.push(`${t.help.commandsLabel}`);
      for (const child of visible) {
        const name = `${child.name()}${child.aliases().length > 0 && mode === "full" ? ` (${child.aliases().join(", ")})` : ""}`;
        lines.push(...row(name, fitDescription(child.description(), mode, width), width, 2));
      }
      lines.push("");
    }
  } else if (command.commands.length > 0) {
    lines.push(`${t.help.subcommandsLabel}`);
    for (const child of command.commands) {
      lines.push(...row(child.name(), fitDescription(child.description(), mode, width), width, 2));
    }
    lines.push("");
  }

  const options = displayedOptions(command).filter((option) =>
    optionInMode(option, mode, { isRoot, inherited: isInheritedOption(option, command) }),
  );
  if (options.length > 0) {
    lines.push(`${t.help.optionsLabel}`);
    for (const option of options) {
      lines.push(...row(option.flags, fitDescription(option.description, mode, width), width, 2));
    }
    lines.push("");
  }

  const globals = ancestorOptions(command);
  if (!isRoot && mode === "full" && globals.length > 0) {
    lines.push(`${t.help.globalOptionsLabel}`);
    for (const option of globals) {
      lines.push(...row(option.flags, fitDescription(option.description, mode, width), width, 2));
    }
    lines.push("");
  }
  if (mode !== "full" && (isRoot || globals.length > 0)) {
    lines.push(...wrapText(t.help.moreCommands, width), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Applies the mode to a whole command tree (root plus every nested command).
 *
 * Commander copies help configuration to commands created after `configureHelp`, but this CLI
 * registers every command before the mode is known, so the configuration has to be walked down.
 * Nested help keeps its own full command list (a subcommand's children are not tiered — typing
 * `penguin agent --help` means you are already looking for that command's surface) while the
 * width and description policy still apply.
 */
export function applyHelpMode(program: Command, mode: HelpMode, width: number, t: Messages): void {
  const configure = (command: Command, isRoot: boolean): void => {
    command.configureHelp({
      helpWidth: width,
      commandUsage: (cmd) => cmd.usage(),
      commandDescription: (cmd) => fitDescription(cmd.description(), mode, width),
      visibleCommands: (cmd) =>
        (isRoot
          ? cmd.commands.filter((child) => commandInMode(child.name(), mode))
          : cmd.commands
        ).slice(),
      visibleOptions: (cmd) =>
        displayedOptions(cmd as unknown as HelpRenderableCommand)
          .filter((option) =>
            optionInMode(option, mode, { isRoot, inherited: isInheritedOption(option, cmd) }),
          )
          .slice(),
      formatHelp: (cmd) =>
        renderCommandHelp(cmd as unknown as HelpRenderableCommand, mode, width, t),
    });
    for (const child of command.commands) configure(child, false);
  };
  configure(program, true);
}
