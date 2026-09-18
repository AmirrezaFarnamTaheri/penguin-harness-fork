/**
 * Injection-resistant shell quoting.
 *
 * One job: render an arbitrary string such that a POSIX shell re-parses it as a
 * single literal word. The single-quote form is used because it is the only shell
 * context in which *no* character is special — no expansion, no escape processing,
 * no glob — so nothing inside the payload can terminate it except a single quote
 * itself. That one case is closed by ending the quoted string, emitting an escaped
 * literal quote, and reopening it (`'\''`), which is three characters of syntax and
 * zero interpretation of the byte between them.
 *
 * This is the boundary the sandbox uses whenever it must hand a value it computed to
 * a real shell: argument vectors passed to an escalated native command, filenames
 * synthesized for a copy, identifiers embedded in a generated script. Double quotes
 * would have left `$`, backticks and `\` live; leaving the value unquoted would have
 * made every space a word split and every `*` a glob.
 */

/**
 * Quote one argument so a POSIX shell reads it as a single literal word.
 */
export function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Quote an argv-style list and join it with spaces into a shell-safe command line.
 * Every element is quoted — including ones that did not need it — so the join
 * cannot reintroduce a metacharacter the caller did not anticipate.
 */
export function shellJoinArgs(args: readonly string[]): string {
  return args.map(shellQuoteArg).join(" ");
}

/**
 * True when a string contains any character a POSIX shell would treat as special
 * outside of single quotes. Used to decide whether a value *must* be quoted before
 * it is placed in a command line; `shellQuoteArg` is used regardless when the value
 * is not already known to be a safe identifier, so this predicate exists for
 * diagnostics and fast paths, not as the security decision.
 */
const SHELL_METACHARACTERS = /[^\w@%+=:,./-]/;

export function requiresShellQuoting(value: string): boolean {
  return SHELL_METACHARACTERS.test(value);
}
