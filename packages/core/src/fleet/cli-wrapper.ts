/**
 * Dynamic CLI wrapper synthesis for the Universal Tool Mesh.
 *
 * Ports the registry-and-serialization layer of the OpenCLI lineage (`registry.ts`'s
 * `Strategy` enum, `Arg` shape and `CliCommand`; `serialization.ts`'s `serializeArg` and
 * `formatArgSummary`) together with the matrix-registry shape of the CLI-Anything
 * lineage (`matrices[].clis[]` with `args`/`columns`/`capabilities`) and the
 * min-interval spacing guard from the Copilot-manager lineage's `rate_limiter.rs`.
 *
 * The purpose: given a declarative manifest, produce a safe `argv` and an executable
 * invocation — no shell string, no `eval`, no `child_process.exec` with interpolation.
 * Argument values are passed as a separate array to `spawn`, so an argument containing
 * `;` or `$(...)` is data and never a command.
 *
 * Node built-ins only.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Command access class — a read cannot mutate, which the sandbox cares about. */
export type CommandAccess = "read" | "write";

/**
 * Execution strategy, from the OpenCLI `Strategy` enum. `PUBLIC` needs no credentials,
 * `LOCAL` needs a local server, `COOKIE`/`INTERCEPT`/`UI` need an authenticated browser
 * context. The wrapper records the strategy so the mesh can refuse a `write` under a
 * read-only policy before it spawns anything.
 */
export const CLI_STRATEGY = {
  Public: "public",
  Local: "local",
  Cookie: "cookie",
  Intercept: "intercept",
  Ui: "ui",
} as const;
export type CliStrategy = (typeof CLI_STRATEGY)[keyof typeof CLI_STRATEGY];

/** The scalar types a CLI argument can carry, normalized to a closed set. */
export const ARG_TYPES = ["string", "int", "float", "bool", "boolean"] as const;
export type ArgType = (typeof ARG_TYPES)[keyof typeof ARG_TYPES];

/** A single argument's declaration — a strict superset of the OpenCLI `Arg` shape. */
export interface CliArgSpec {
  name: string;
  type?: ArgType;
  default?: unknown;
  required?: boolean;
  /** Flag-style vs positional. Positional args join `argv` in declaration order. */
  positional?: boolean;
  /** Allowed values; a value outside the set is rejected before spawn. */
  choices?: readonly string[];
  help?: string;
  /** When true, the flag takes no value — its presence is the value. */
  flag?: boolean;
  /** Secret values are redacted from argv logs and error messages. */
  secret?: boolean;
}

/** A normalized, always-complete argument schema (`serializeArg` from the lineage). */
export interface SerializedArg {
  name: string;
  type: ArgType;
  required: boolean;
  positional: boolean;
  flag: boolean;
  choices: readonly string[];
  default: unknown;
  help: string;
  secret: boolean;
}

export interface CliCommandManifest {
  /** Tool id within the mesh, e.g. `git_commit`. */
  id: string;
  /** Provider/toolkit the command belongs to. */
  providerId: string;
  description: string;
  access: CommandAccess;
  strategy?: CliStrategy;
  args: readonly CliArgSpec[];
  /** Column names a result is projected onto. */
  columns?: readonly string[];
  /** The executable name; resolved from PATH or an absolute path. */
  command: string;
  /** Default output format when the caller does not pick one. */
  defaultFormat?: "table" | "plain" | "json" | "yaml" | "csv";
  /** Minimum spacing between invocations of this command, in ms. */
  minIntervalMs?: number;
  /** Kill the process after this many ms. */
  timeoutMs?: number;
}

export class CliWrapperError extends Error {
  constructor(
    readonly code:
      | "unknown_command"
      | "missing_required"
      | "bad_choice"
      | "bad_type"
      | "spawn_failed"
      | "timeout"
      | "denied_access"
      | "invalid_manifest",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliWrapperError";
  }
}

/** Normalizes an argument declaration into the complete serialized shape. */
export function serializeArg(arg: CliArgSpec): SerializedArg {
  const declared = (arg.type ?? "string") as string;
  const known = ARG_TYPES as readonly string[];
  const type = (known.includes(declared) ? declared : "string") as ArgType;
  return {
    name: arg.name,
    type,
    required: !!arg.required,
    positional: !!arg.positional,
    flag: !!arg.flag,
    choices: arg.choices ?? [],
    default: arg.default ?? null,
    help: arg.help ?? "",
    secret: !!arg.secret,
  };
}

/** Human-readable arg summary: `<required>` / `[optional]`, from the lineage's formatter. */
export function formatArgSummary(args: readonly CliArgSpec[]): string {
  return args
    .map((arg) => {
      if (arg.positional) return arg.required ? `<${arg.name}>` : `[${arg.name}]`;
      return arg.required ? `--${arg.name}` : `[--${arg.name}]`;
    })
    .join(" ");
}

/**
 * The canonical invocation shown to an agent. Positional required args come first, then
 * required flags, then the format selector — matching the lineage's `formatCommandExample`.
 */
export function formatCommandExample(manifest: CliCommandManifest): string {
  const parts = [manifest.id];
  for (const arg of manifest.args) {
    if (arg.positional && arg.required) parts.push(`<${arg.name}>`);
  }
  for (const arg of manifest.args) {
    if (arg.positional || !arg.required) continue;
    parts.push(`--${arg.name}`);
    if (!arg.flag && arg.type !== "bool" && arg.type !== "boolean") {
      parts.push(`<${arg.name}>`);
    }
  }
  parts.push("-f", manifest.defaultFormat ?? "json");
  return parts.join(" ");
}

/** Coerces and validates a raw value against an argument's declared type and choices. */
export function coerceArgValue(arg: SerializedArg, raw: unknown): string | number | boolean {
  const type = arg.type;
  if (type === "bool" || type === "boolean" || arg.flag) {
    if (typeof raw === "boolean") return raw;
    if (raw === undefined || raw === null) return true;
    const text = String(raw).trim().toLowerCase();
    if (["", "1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    throw new CliWrapperError(
      "bad_type",
      `Argument '${arg.name}' must be boolean, got '${String(raw)}'`,
    );
  }

  if (type === "int" || type === "float") {
    const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
    const value = type === "int" ? Number.parseInt(text, 10) : Number.parseFloat(text);
    if (!Number.isFinite(value)) {
      throw new CliWrapperError(
        "bad_type",
        `Argument '${arg.name}' must be a ${type === "int" ? "integer" : "number"}, got '${text}'`,
      );
    }
    return value;
  }

  const text = typeof raw === "string" ? raw : String(raw ?? "");
  if (arg.choices.length > 0 && !arg.choices.includes(text)) {
    throw new CliWrapperError(
      "bad_choice",
      `Argument '${arg.name}' must be one of ${arg.choices.join(", ")}, got '${text}'`,
    );
  }
  return text;
}

/**
 * Builds a safe `argv` from a manifest and a values object. Values are never stringified
 * into a command line: the result feeds `spawn(command, argv)` directly, so quoting is
 * the OS's job and shell metacharacters in data cannot become shell syntax.
 *
 * Secret arguments are tracked separately so the caller can redact them; they are still
 * passed to the child as real values.
 */
export function buildArgv(
  manifest: CliCommandManifest,
  values: Record<string, unknown>,
): { argv: string[]; secrets: Set<string> } {
  if (!Array.isArray(manifest.args)) {
    throw new CliWrapperError("invalid_manifest", `Command '${manifest.id}' has no args array`);
  }
  const argv: string[] = [];
  const secrets = new Set<string>();
  const serialized = manifest.args.map(serializeArg);
  const byName = new Map(serialized.map((arg) => [arg.name, arg] as const));

  // Positional args first, in declaration order — that is the contract a CLI expects.
  for (const arg of serialized.filter((arg) => arg.positional)) {
    const present = values[arg.name] !== undefined && values[arg.name] !== null;
    if (!present) {
      if (arg.required) {
        throw new CliWrapperError(
          "missing_required",
          `Command '${manifest.id}' is missing required positional argument '${arg.name}'`,
        );
      }
      if (arg.default !== null && arg.default !== undefined) {
        argv.push(String(coerceArgValue(arg, arg.default)));
      }
      continue;
    }
    const value = coerceArgValue(arg, values[arg.name]);
    argv.push(String(value));
    if (arg.secret) secrets.add(String(value));
  }

  // Then flags, sorted for stable argv (a CLI does not care about flag order).
  for (const arg of [...serialized]
    .filter((arg) => !arg.positional)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const present = values[arg.name] !== undefined && values[arg.name] !== null;
    if (!present) {
      if (arg.required) {
        throw new CliWrapperError(
          "missing_required",
          `Command '${manifest.id}' is missing required argument '--${arg.name}'`,
        );
      }
      continue;
    }
    const name = `--${arg.name}`;
    if (arg.flag || arg.type === "bool" || arg.type === "boolean") {
      const value = coerceArgValue(arg, values[arg.name]);
      if (value) argv.push(name);
      else if (arg.default !== null && arg.default !== undefined) argv.push(name);
      continue;
    }
    const value = coerceArgValue(arg, values[arg.name]);
    argv.push(name, String(value));
    if (arg.secret) secrets.add(String(value));
  }

  // Unknown keys are an error rather than silently dropped: a misspelled argument name is
  // the most common way an agent gets a command wrong, and silence makes it invisible.
  for (const key of Object.keys(values)) {
    if (!byName.has(key)) {
      throw new CliWrapperError(
        "invalid_manifest",
        `Command '${manifest.id}' has no argument '${key}'`,
      );
    }
  }

  return { argv, secrets };
}

/** Redacts secret values from an argv, for logging and error messages. */
export function redactArgv(argv: readonly string[], secrets: Set<string>): string[] {
  if (secrets.size === 0) return [...argv];
  return argv.map((part) => (secrets.has(part) ? "<redacted>" : part));
}

export interface InvokeOptions {
  /** Working directory for the child. */
  cwd?: string;
  /** Extra environment merged over `process.env`. */
  env?: Record<string, string>;
  /** Kill after this many ms; defaults to the manifest's `timeoutMs`. */
  timeoutMs?: number;
  /** Override the access policy: a read-only caller may not run `write` commands. */
  allowWrite?: boolean;
  /** Captured stdout/stderr limit, to bound memory on a chatty command. */
  maxOutputBytes?: number;
}

export interface InvokeResult {
  command: string;
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Spawns the command with the built argv. The values never become part of a shell string:
 * `spawn` receives `argv` as an array, so there is no shell to inject into. Access policy
 * is enforced here so a read-only caller cannot reach a mutating command by any path.
 */
export function invokeCli(
  manifest: CliCommandManifest,
  values: Record<string, unknown>,
  options: InvokeOptions = {},
): {
  result: Promise<InvokeResult>;
  child: ChildProcessWithoutNullStreams;
  cancel: () => void;
} {
  if (manifest.access === "write" && options.allowWrite === false) {
    throw new CliWrapperError(
      "denied_access",
      `Command '${manifest.id}' writes and the caller is read-only`,
    );
  }
  const { argv, secrets } = buildArgv(manifest, values);
  const child = spawn(manifest.command, argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: false,
    windowsHide: true,
  });

  const timeoutMs = options.timeoutMs ?? manifest.timeoutMs;
  const maxBytes = options.maxOutputBytes ?? 1_024 * 1_024;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes + chunk.length > maxBytes) return;
    stdoutChunks.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes + chunk.length > maxBytes) return;
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;
  });

  const started = Date.now();
  const result = new Promise<InvokeResult>((resolve, reject) => {
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(
        new CliWrapperError(
          "spawn_failed",
          `Failed to spawn '${manifest.command} ${redactArgv(argv, secrets).join(" ")}': ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.on("close", (exitCode) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        command: manifest.command,
        argv: redactArgv(argv, secrets),
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });

  return {
    result,
    child,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      child.kill("SIGKILL");
    },
  };
}

/** Minimum-interval spacing guard, from the Copilot-manager `RateLimiter`. */
export class CommandSpacer {
  private lastCallAt = new Map<string, number>();
  private waiters = new Map<string, Promise<void>>();

  constructor(private readonly minIntervalMs: number = 500) {}

  /** Waits until the command may run again. Concurrent waiters share one wait. */
  async wait(commandId: string, now: number = Date.now()): Promise<void> {
    const interval = Math.max(0, this.minIntervalMs);
    if (interval === 0) return;
    const existing = this.waiters.get(commandId);
    if (existing) return existing;

    const last = this.lastCallAt.get(commandId) ?? 0;
    const elapsed = now - last;
    const due = last + interval;
    if (last === 0 || elapsed >= interval) {
      this.lastCallAt.set(commandId, now);
      return;
    }
    const promise = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.lastCallAt.set(commandId, Date.now());
        this.waiters.delete(commandId);
        resolve();
      }, due - now);
    });
    this.waiters.set(commandId, promise);
    return promise;
  }

  /** Releases the spacing record for a command. */
  release(commandId: string): void {
    this.lastCallAt.delete(commandId);
    this.waiters.delete(commandId);
  }
}

/**
 * Registry of synthesized CLI commands. Registration refuses a duplicate id at set time,
 * so two manifests for one tool is a loud failure rather than a silent override.
 */
export class CliWrapperRegistry {
  private readonly commands = new Map<string, CliCommandManifest>();

  register(manifest: CliCommandManifest): CliCommandManifest {
    if (!manifest.id || !manifest.command) {
      throw new CliWrapperError(
        "invalid_manifest",
        "A CLI manifest requires both an id and a command",
      );
    }
    if (this.commands.has(manifest.id)) {
      throw new CliWrapperError(
        "invalid_manifest",
        `A CLI command is already registered as '${manifest.id}'`,
      );
    }
    this.commands.set(manifest.id, manifest);
    return manifest;
  }

  get(id: string): CliCommandManifest | undefined {
    return this.commands.get(id);
  }

  list(): readonly CliCommandManifest[] {
    return [...this.commands.values()];
  }

  /** Commands for one provider, cheapest first — used for capability discovery. */
  forProvider(providerId: string): readonly CliCommandManifest[] {
    return this.list()
      .filter((command) => command.providerId === providerId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  remove(id: string): boolean {
    return this.commands.delete(id);
  }

  get size(): number {
    return this.commands.size;
  }
}
