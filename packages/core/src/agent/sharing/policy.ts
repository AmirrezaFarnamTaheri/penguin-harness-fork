/**
 * Which operations may be shared with another agent's run, decided from the invocation alone.
 *
 * THE RULE THIS ENFORCES: if it cannot be shown to be observably free of effects, it is not
 * shared. That is a refusal-first design, which is the opposite of how a cache normally works and
 * is the reason this module is a closed allowlist rather than a list of known-bad commands. A
 * denylist is one typo away from sharing a `build`; an allowlist of programs whose read-only
 * invocation shapes are enumerated here cannot be.
 *
 * WHY PROGRAM-SHAPED AND NOT "THE CALLER PROMISED". A caller can declare
 * `effects: "read-only"` and be right about the tool and wrong about the argument: `tsc` does not
 * write, `tsc` without `--noEmit` writes, and the difference is one token. So the declaration is
 * a *necessary* condition and the argv is the one that decides. `"unknown"` is the default for the
 * declaration, so forgetting it is a refusal rather than a silent grant.
 *
 * WHAT IS DELIBERATELY REFUSED, AND WHY IT IS NOT AN OVERSIGHT
 *
 * - **Package-manager and shell wrappers** (`pnpm`, `npx`, `bash -c`, `cmd /c`). The wrapper's own
 *   arguments do not describe the work, and `bash -c "vitest run"` can be any command at all.
 *   Callers pass the resolved binary, which is also how this repository runs its own gates.
 * - **Builds, installs, formatters with a write flag, migrations, VCS writes, anything with a
 *   watch loop.** Each of those either mutates the tree or never terminates, and the second kind is
 *   worse than a slow run: a joiner would wait its whole budget on something that cannot finish.
 * - **Test runners and the shell test harness.** Admitted, with a stated limit: this decision is
 *   about the *invocation shape*, never about the code the invocation runs, and a test file can
 *   write whatever it likes. What bounds that is not this file — it is the fingerprint covering
 *   the roots the run can touch plus the post-run re-check in the registry, which discards a
 *   result whose tree moved while it ran. A caller whose tests write outside its fingerprinted
 *   roots is outside what this can see, and `OperationShareRegistry.invalidateAll()` is the
 *   honest response at that boundary.
 * - **Web search and browser sessions.** Excluded by construction and not by an accident of this
 *   table: sharing requires a fingerprint of the dependencies, and a live web page has none that
 *   can be hashed. There is no way to tell a fresh search result from a stale one, so a share key
 *   for one would be a guess. That is the same reason the key carries a content hash, and the
 *   product request that asked for it is answered by declining it rather than by weakening the
 *   guard for everything else.
 *
 * LIKE `internal/command-policy.ts`, this is an accident guardrail and not a security boundary:
 * it matches argument text, and a determined caller can always construct a command it does not
 * recognise. It is built to make the *ordinary* mistake impossible, not the adversarial one.
 */

/** What the caller asserts about the operation. `"unknown"` is the default and is a refusal. */
export type EffectDeclaration = "read-only" | "writes" | "unknown";

/** Why an operation was not shareable. A closed set: these index a summary map. */
export type ExcludeReason =
  /** The caller declared `writes`, or left the declaration at its `unknown` default. */
  | "declared-effects"
  /** The program is not on the read-only allowlist. */
  | "unknown-program"
  /** The program is known but this argument vector makes it write, repair, or never finish. */
  | "command-shape"
  /** The program only stays read-only when a specific flag is present, and it was not. */
  | "tool-requires-flag"
  /** No fingerprint of the dependencies could be computed, so nothing can be staleness-guarded. */
  | "no-fingerprint";

/** The operation classes that are shareable. Mirrors `VerificationKind` in the fingerprint. */
export type ShareableKind = "test-runner" | "linter" | "typecheck";

export interface ShareOperationSpec {
  /**
   * The full argument vector INCLUDING argv[0]. Order is preserved deliberately — see
   * `shareKey`. Pass the resolved binary, not a package-manager wrapper.
   */
  readonly argv: readonly string[];
  /** Directory the operation runs in. It is the result's scope, so it is part of the key. */
  readonly cwd: string;
  readonly effects?: EffectDeclaration;
  /**
   * Set false for an operation that may be shared while it runs but whose result must not be
   * retained for anyone after it. A real request — a very large one-off nobody else should be
   * holding in this process — and it is the only way to get in-flight sharing without retention,
   * so it is not treated as a refusal here: `admitOperation` stays about effects, and the
   * registry skips the store.
   */
  readonly cacheResult?: boolean;
}

export type ShareDecision =
  | { readonly admitted: true; readonly kind: ShareableKind; readonly program: string }
  | { readonly admitted: false; readonly reason: ExcludeReason; readonly detail: string };

interface ProgramRule {
  readonly kind: ShareableKind;
  /** Lower-cased basenames, extension stripped. */
  readonly names: readonly string[];
  /** At least one of these must appear, or the tool defaults to a writing or interactive mode. */
  readonly requiresAny?: readonly string[];
  /** Refuse the whole operation if any of these appear as an argument. */
  readonly refuses?: readonly string[];
  /** Refuse if any argument STARTS WITH one of these — how `--fix`, `--fix-type` and
   *  `--fix-suggestions` are all covered by one entry instead of a list that grows by report. */
  readonly refusePrefixes?: readonly string[];
  /** For tools dispatched on a subcommand, the only ones that are read-only. */
  readonly subcommands?: readonly string[];
}

/**
 * The allowlist. Every row is a claim about one tool: "these programs, in these argument shapes,
 * do nothing but read and report."
 *
 * A row that needs three separate conditions to be safe is a row whose safety is not understood
 * well enough to be here, so the list stays short and the reasoning is written down where it can
 * be argued with.
 */
const READ_ONLY_PROGRAMS: readonly ProgramRule[] = [
  {
    kind: "test-runner",
    names: ["vitest"],
    // Bare `vitest` enters watch mode when a TTY is attached, which does not finish. `run`,
    // `related` and `bench` are the batch forms.
    requiresAny: ["run", "related", "bench"],
    refuses: ["--watch", "-w", "--ui", "--update", "-u", "--coverage", "--outputFile"],
  },
  {
    kind: "test-runner",
    names: ["jest"],
    // Jest runs once by default and only watches when asked or when interactive with changes;
    // requiring `--ci` here would have excluded the tool's ordinary non-TTY invocation.
    refuses: ["--watch", "-w", "-u", "--update", "--coverage", "--outputFile", "--cache"],
  },
  {
    kind: "test-runner",
    names: ["node"],
    // `node` is a general-purpose interpreter and is admitted only for its two batch modes that
    // run a file without executing it as a program of its own accord.
    requiresAny: ["--test", "--check"],
    refuses: ["-e", "--eval", "-p", "--print", "--inspect", "--test-reporter-coverage"],
  },
  {
    kind: "linter",
    names: ["eslint"],
    // `--cache` writes `.eslintcache` into the tree, which is a write the caller did not ask for
    // and a file the next run would then depend on.
    refuses: ["--cache", "--cache-location", "--output-file", "--stats", "--json-file"],
    refusePrefixes: ["--fix"],
  },
  {
    kind: "linter",
    names: ["oxlint"],
    refuses: ["--generate-config", "--init", "--save"],
    refusePrefixes: ["--fix"],
  },
  {
    kind: "linter",
    names: ["biome"],
    subcommands: ["lint", "check", "ci"],
    refuses: ["--write", "--apply", "--apply-unsafe", "--init", "--reporter", "--reporter-json"],
    refusePrefixes: ["--fix"],
  },
  {
    kind: "linter",
    names: ["prettier"],
    // Prettier WRITES by default. `--check` and `--list-different` are the two forms that only
    // report, so absence of one of them is a refusal rather than a silent write.
    requiresAny: ["--check", "-c", "--list-different", "-l"],
    refuses: ["--write", "-w"],
  },
  {
    kind: "typecheck",
    names: ["tsc", "tsgo"],
    // `tsc` emits JavaScript unless told not to, and its incremental modes persist a buildinfo
    // file even alongside `--noEmit` in some versions. Both are refused by name.
    requiresAny: ["--noEmit"],
    refuses: [
      "-b",
      "--build",
      "--incremental",
      "--tsBuildInfoFile",
      "--emitDeclarationOnly",
      "--declaration",
      "--outDir",
      "--outFile",
      "--composite",
      "--watch",
      "-w",
    ],
  },
];

/**
 * Programs refused with a specific reason instead of the generic "not on the allowlist".
 *
 * The value is the sentence a caller needs, not a label. Every entry here is a thing someone
 * will plausibly try to share, and the reason it cannot be is specific: a wrapper hides the
 * command, a mutator changes state, a monitor never terminates. `test/agent/sharing/policy.test.ts`
 * asserts every key here is refused, which is what keeps this table from becoming decoration.
 */
export const REFUSED_PROGRAM_NOTES: Readonly<Record<string, string>> = {
  sh: "a shell wrapper's arguments do not describe the work; pass the resolved binary",
  bash: "a shell wrapper's arguments do not describe the work; pass the resolved binary",
  zsh: "a shell wrapper's arguments do not describe the work; pass the resolved binary",
  cmd: "a shell wrapper's arguments do not describe the work; pass the resolved binary",
  powershell: "a shell wrapper's arguments do not describe the work; pass the resolved binary",
  pwsh: "a shell wrapper's arguments do not describe the work; pass the resolved binary",
  npm: "a package manager resolves and may install; run the binary in node_modules/.bin directly",
  npx: "a package manager resolves and may install; run the binary in node_modules/.bin directly",
  pnpm: "a package manager resolves and may install; run the binary in node_modules/.bin directly",
  yarn: "a package manager resolves and may install; run the binary in node_modules/.bin directly",
  bun: "a package manager resolves and may install; run the binary in node_modules/.bin directly",
  bunx: "a package manager resolves and may install; run the binary in node_modules/.bin directly",
  git: "git subcommands include irreversible writes and network side effects",
  make: "a task runner's recipe is not visible in its arguments",
  just: "a task runner's recipe is not visible in its arguments",
  task: "a task runner's recipe is not visible in its arguments",
  cargo: "cargo builds and writes to target/; `cargo check` writes build artifacts too",
  go: "go commands write build and module cache state",
  rm: "deletes files",
  mv: "moves files",
  cp: "writes files",
  touch: "writes files",
  mkdir: "writes the filesystem",
  tee: "writes files",
  truncate: "writes files",
  dd: "writes files",
  chmod: "changes file metadata",
  chown: "changes file metadata",
  docker: "container commands have daemon state and network side effects",
  psql: "a database client mutates whatever query it is given",
  mysql: "a database client mutates whatever query it is given",
  sqlite3: "a database client mutates whatever query it is given",
  web_search: "a live web result has no hashable dependency, so it cannot be staleness-guarded",
  curl: "a network fetch has no hashable dependency and writes whatever the response says",
  wget: "a network fetch has no hashable dependency and writes whatever the response says",
};

/**
 * The program name a rule is matched on: the basename, lower-cased, with a Windows executable
 * extension removed.
 *
 * The extension matters more than it looks. This repository's own gates run
 * `node_modules/.bin/tsc.CMD` and `vitest.CMD` on Windows, and a basename comparison that left
 * `.cmd` attached would refuse every gate on the platform where the suite is slowest.
 */
export function normalizeProgramName(argv0: string): string {
  const base = argv0.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
}

/** The flag spelling of a token, so `--fix=true` is caught by a `--fix` rule. */
function baseFlag(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * Decides whether one operation may be shared. Pure and total — no I/O, no throw, and no
 * dependence on anything but `spec`. The fingerprint is not consulted here; a fingerprint that
 * cannot be computed is refused by the registry, which is the only place that knows.
 */
export function admitOperation(spec: ShareOperationSpec): ShareDecision {
  const effects = spec.effects ?? "unknown";
  if (effects === "writes") {
    return {
      admitted: false,
      reason: "declared-effects",
      detail: "the caller declared this operation mutates state",
    };
  }
  if (effects !== "read-only") {
    return {
      admitted: false,
      reason: "declared-effects",
      detail:
        'the effect declaration defaults to "unknown", and an operation that cannot be shown ' +
        "to be observably free of effects is not shared",
    };
  }
  const argv0 = spec.argv[0];
  if (argv0 === undefined || argv0.trim() === "") {
    return {
      admitted: false,
      reason: "unknown-program",
      detail: "the operation has no command to identify",
    };
  }
  const program = normalizeProgramName(argv0);
  const note = REFUSED_PROGRAM_NOTES[program];
  if (note !== undefined) {
    return { admitted: false, reason: "unknown-program", detail: note };
  }

  const rule = READ_ONLY_PROGRAMS.find((candidate) => candidate.names.includes(program));
  if (rule === undefined) {
    return {
      admitted: false,
      reason: "unknown-program",
      detail: `"${program}" is not on the read-only verification allowlist`,
    };
  }

  const flags = spec.argv.slice(1).map(baseFlag);
  const refused = (rule.refuses ?? []).find((flag) => flags.includes(flag));
  if (refused !== undefined) {
    return {
      admitted: false,
      reason: "command-shape",
      detail: `${program} with "${refused}" writes, repairs, or never finishes`,
    };
  }
  const prefixed = (rule.refusePrefixes ?? []).find((prefix) =>
    flags.some((flag) => flag.startsWith(prefix)),
  );
  if (prefixed !== undefined) {
    return {
      admitted: false,
      reason: "command-shape",
      detail: `${program} rewrites its inputs when given "${prefixed}*"; the read-only form has no such flag`,
    };
  }
  if (rule.subcommands !== undefined) {
    const subcommand = spec.argv.slice(1).find((token) => !token.startsWith("-"));
    if (subcommand === undefined || !rule.subcommands.includes(subcommand)) {
      return {
        admitted: false,
        reason: "command-shape",
        detail: `${program} ${subcommand ?? "<no subcommand>"} is not a read-only mode (${rule.subcommands.join(", ")})`,
      };
    }
  }
  const required = rule.requiresAny;
  if (required !== undefined && !required.some((flag) => flags.includes(flag))) {
    return {
      admitted: false,
      reason: "tool-requires-flag",
      detail: `${program} needs ${required.map((flag) => `"${flag}"`).join(" or ")} to stay read-only`,
    };
  }

  return { admitted: true, kind: rule.kind, program };
}
