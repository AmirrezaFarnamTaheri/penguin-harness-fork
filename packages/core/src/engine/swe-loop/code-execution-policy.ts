/**
 * Code-execution policy — the guard model, not the interpreter.
 *
 * Source: `smolagents`' `local_python_executor.py`, which protects a Python
 * interpreter with a layered guard model rather than with a sandbox process.
 * The instruction for this track is explicit: port the *guard model*, not
 * Python. So this module is a language-neutral policy engine. It takes a
 * description of the code an agent wants to run (imports it declares,
 * qualified functions it calls, attributes it reaches for, the shape of its
 * loops and its output) and decides whether that code may execute, against
 * the same rule set — and returning the same rule id a caller can report.
 *
 * The rules ported, one for one:
 *  - **dunder denial** (`nodunder_getattr`, `ALLOWED_DUNDER_METHODS`): an
 *    attribute whose name starts and ends with `__` is forbidden unless it is
 *    on the allow-list, because dunder access is how you escape an object
 *    model into the interpreter itself;
 *  - **module blocklist** (`DANGEROUS_MODULES`): os, sys, subprocess, socket,
 *    shutil, multiprocessing, pty, io, pathlib, builtins — the process and
 *    filesystem surface;
 *  - **qualified-function blocklist** (`DANGEROUS_FUNCTIONS`): builtins.eval,
 *    builtins.exec, builtins.compile, builtins.globals, builtins.locals,
 *    os.popen, os.system — matched on *both* module and function name, so a
 *    user-defined `eval` is not confused with the builtin;
 *  - **authorized-import tree** (`build_import_tree` / `check_import_authorized`):
 *    an import is permitted iff some authorized prefix owns it, and the tree
 *    is a real nested structure, so authorizing `numpy` admits `numpy.linalg`
 *    but not `numpy.core.multiarray` unless that too is listed;
 *  - **resource ceilings** (`DEFAULT_MAX_LEN_OUTPUT`, `MAX_OPERATIONS`,
 *    `MAX_WHILE_ITERATIONS`, `MAX_EXECUTION_TIME_SECONDS`): a static estimate
 *    rejects a loop whose iteration count is provably over budget;
 *  - **result guard** (`check_safer_result`): a *returned value* carrying a
 *    module or function identity is re-checked, because a function that
 *    returns `os.system` hands the caller the forbidden primitive after the
 *    call-site check already passed.
 */

export type CodeLanguage = "python" | "javascript" | "typescript" | "shell" | "unknown";

export interface CodeArtifact {
  language: CodeLanguage;
  source: string;
  imports: string[];
  calls: Array<{ module?: string; function: string; attributePath?: string[] }>;
  /** Literal loop bounds a static reader extracted, if any. */
  loopBounds?: Array<{ kind: "for" | "while"; iterations?: number }>;
  estimatedOutputBytes?: number;
}

export interface CodeExecutionPolicy {
  allowedDunderMethods: ReadonlySet<string>;
  forbiddenModules: ReadonlySet<string>;
  forbiddenFunctions: ReadonlySet<string>;
  authorizedImports: ReadonlySet<string>;
  maxOutputLength: number;
  maxOperations: number;
  maxWhileIterations: number;
  maxExecutionTimeSeconds: number;
}

export interface CodeExecutionViolation {
  ruleId: string;
  severity: "block" | "warn";
  detail: string;
}

export interface CodeExecutionAssessment {
  allowed: boolean;
  violations: CodeExecutionViolation[];
  warnings: CodeExecutionViolation[];
  /** Estimated execution-time budget consumed, for caller-side scheduling. */
  estimatedTimeSeconds: number;
  policyName: string;
}

export const ALLOWED_DUNDER_METHODS: readonly string[] = Object.freeze([
  "__init__",
  "__str__",
  "__repr__",
]);

export const DANGEROUS_MODULES: readonly string[] = Object.freeze([
  "builtins",
  "io",
  "multiprocessing",
  "os",
  "pathlib",
  "pty",
  "shutil",
  "socket",
  "subprocess",
  "sys",
]);

export const DANGEROUS_FUNCTIONS: readonly string[] = Object.freeze([
  "builtins.compile",
  "builtins.eval",
  "builtins.exec",
  "builtins.globals",
  "builtins.locals",
  "builtins.__import__",
  "os.popen",
  "os.system",
  "posix.system",
]);

export const DEFAULT_AUTHORIZED_IMPORTS: readonly string[] = Object.freeze([
  "math",
  "statistics",
  "json",
  "re",
  "datetime",
  "collections",
  "itertools",
  "functools",
  "string",
  "fractions",
  "decimal",
]);

export const DEFAULT_CODE_EXECUTION_POLICY: CodeExecutionPolicy = Object.freeze({
  allowedDunderMethods: new Set(ALLOWED_DUNDER_METHODS),
  forbiddenModules: new Set(DANGEROUS_MODULES),
  forbiddenFunctions: new Set(DANGEROUS_FUNCTIONS),
  authorizedImports: new Set(DEFAULT_AUTHORIZED_IMPORTS),
  maxOutputLength: 50_000,
  maxOperations: 10_000_000,
  maxWhileIterations: 1_000_000,
  maxExecutionTimeSeconds: 30,
});

/** The parameterized defaults, the way a caller composes a stricter tier. */
export function strictCodeExecutionPolicy(
  overrides: Partial<CodeExecutionPolicy> = {},
): CodeExecutionPolicy {
  return Object.freeze({
    ...DEFAULT_CODE_EXECUTION_POLICY,
    maxOutputLength: 10_000,
    maxOperations: 1_000_000,
    maxWhileIterations: 100_000,
    maxExecutionTimeSeconds: 10,
    ...overrides,
  });
}

/**
 * The authorized-import tree, ported from `build_import_tree`. Each authorized
 * dotted path becomes a nested map; `checkImportAuthorized` walks one path down
 * the tree and requires every segment to exist under an authorized root. So
 * authorizing `numpy` admits `numpy.linalg` and `numpy.core.multiarray` —
 * everything beneath an authorized prefix is trusted — while a path whose root
 * is not in the tree at all (`django.core`, `evil.module`) is refused at its
 * first segment and never silently admitted. The tree is the structure that
 * makes that refusal a lookup rather than a scan over every authorized path.
 */
export type ImportTree = Map<string, ImportTree>;

export function buildImportTree(authorized: Iterable<string>): ImportTree {
  const root: ImportTree = new Map();
  for (const raw of authorized) {
    const path = raw.trim();
    if (!path) continue;
    let level = root;
    for (const segment of path.split(".")) {
      if (!segment) continue;
      const child = level.get(segment) ?? new Map();
      level.set(segment, child);
      level = child;
    }
  }
  return root;
}

export function checkImportAuthorized(
  importPath: string,
  tree: ImportTree,
  authorizedSet: ReadonlySet<string>,
): boolean {
  const path = importPath.trim();
  if (!path) return false;
  if (authorizedSet.has(path)) return true;
  // Walk as far as the tree admits; a prefix that is itself authorized is
  // sufficient, a segment the tree does not contain is a refusal.
  const segments = path.split(".").filter((segment) => segment.length > 0);
  let level: ImportTree | undefined = tree;
  let walked = "";
  for (const segment of segments) {
    walked = walked ? `${walked}.${segment}` : segment;
    if (authorizedSet.has(walked)) return true;
    const child: ImportTree | undefined = level?.get(segment);
    if (child === undefined) return false;
    level = child;
  }
  return true;
}

function isDunder(name: string): boolean {
  return name.length > 4 && name.startsWith("__") && name.endsWith("__");
}

export class CodeExecutionPolicyEngine {
  public readonly policy: CodeExecutionPolicy;
  private readonly importTree: ImportTree;
  public readonly policyName: string;

  constructor(policy: Partial<CodeExecutionPolicy> = {}, name = "standard") {
    const merged: CodeExecutionPolicy = {
      ...DEFAULT_CODE_EXECUTION_POLICY,
      ...policy,
      allowedDunderMethods: new Set(policy.allowedDunderMethods ?? ALLOWED_DUNDER_METHODS),
      forbiddenModules: new Set(policy.forbiddenModules ?? DANGEROUS_MODULES),
      forbiddenFunctions: new Set(policy.forbiddenFunctions ?? DANGEROUS_FUNCTIONS),
      authorizedImports: new Set(policy.authorizedImports ?? DEFAULT_AUTHORIZED_IMPORTS),
    };
    this.policy = Object.freeze(merged);
    this.importTree = buildImportTree(merged.authorizedImports);
    this.policyName = name;
    this.validate(merged);
  }

  /**
   * Assesses a code artifact against every rule. `allowed` is false on any
   * blocking violation; warnings are reported separately and never gate.
   */
  public assess(artifact: CodeArtifact): CodeExecutionAssessment {
    const violations: CodeExecutionViolation[] = [];
    const warnings: CodeExecutionViolation[] = [];

    for (const imported of artifact.imports) {
      this.checkImport(imported, violations, warnings);
    }
    for (const call of artifact.calls) {
      this.checkCall(call, violations, warnings);
    }
    if (artifact.estimatedOutputBytes !== undefined) {
      this.checkOutputSize(artifact.estimatedOutputBytes, violations, warnings);
    }
    if (artifact.loopBounds) {
      this.checkLoopBudgets(artifact.loopBounds, violations, warnings);
    }

    // Computed last: the time-budget check below can itself add a blocking
    // violation, so `allowed` must not be decided before it runs.
    const estimatedTimeSeconds = this.estimateTime(artifact);
    if (estimatedTimeSeconds > this.policy.maxExecutionTimeSeconds) {
      violations.push({
        ruleId: "TIME_BUDGET",
        severity: "block",
        detail: `estimated ${estimatedTimeSeconds.toFixed(1)}s exceeds the ${this.policy.maxExecutionTimeSeconds}s ceiling`,
      });
    }

    const blocking = violations.filter((violation) => violation.severity === "block");
    return {
      allowed: blocking.length === 0,
      violations: blocking,
      warnings: warnings.concat(violations.filter((violation) => violation.severity === "warn")),
      estimatedTimeSeconds,
      policyName: this.policyName,
    };
  }

  /**
   * The result guard, ported from `check_safer_result`. A returned value that
   * *is* a module, or a function with a dangerous qualified name, is a
   * smuggling attempt: the check at the call site passed, then the forbidden
   * primitive came back as a value.
   */
  public checkResult(result: {
    module?: string;
    qualifiedFunction?: string;
    functionName?: string;
    staticTools?: ReadonlySet<string>;
  }): CodeExecutionViolation | null {
    if (result.module) {
      const isAuthorized = checkImportAuthorized(
        result.module,
        this.importTree,
        this.policy.authorizedImports,
      );
      if (!isAuthorized || this.policy.forbiddenModules.has(result.module)) {
        return {
          ruleId: "RESULT_FORBIDDEN_MODULE",
          severity: "block",
          detail: `returned value exposes module '${result.module}' which the policy does not authorize`,
        };
      }
    }
    if (result.qualifiedFunction) {
      for (const forbidden of this.policy.forbiddenFunctions) {
        const [moduleName, functionName] = splitQualified(forbidden);
        const isStaticTool = result.staticTools?.has(functionName) === true;
        if (isStaticTool) continue;
        if (result.functionName === functionName && result.qualifiedFunction === forbidden) {
          return {
            ruleId: "RESULT_FORBIDDEN_FUNCTION",
            severity: "block",
            detail: `returned value exposes forbidden function '${forbidden}'`,
          };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- internals

  private validate(policy: CodeExecutionPolicy): void {
    if (!(policy.maxOutputLength > 0)) throw new Error("maxOutputLength must be positive");
    if (!(policy.maxOperations > 0)) throw new Error("maxOperations must be positive");
    if (!(policy.maxWhileIterations > 0)) throw new Error("maxWhileIterations must be positive");
    if (!(policy.maxExecutionTimeSeconds > 0)) {
      throw new Error("maxExecutionTimeSeconds must be positive");
    }
  }

  private checkImport(
    imported: string,
    violations: CodeExecutionViolation[],
    warnings: CodeExecutionViolation[],
  ): void {
    const root = imported.split(".")[0]?.trim() ?? "";
    if (this.policy.forbiddenModules.has(root)) {
      violations.push({
        ruleId: "IMPORT_FORBIDDEN_MODULE",
        severity: "block",
        detail: `import '${imported}' reaches forbidden module '${root}'`,
      });
      return;
    }
    if (!checkImportAuthorized(imported, this.importTree, this.policy.authorizedImports)) {
      violations.push({
        ruleId: "IMPORT_NOT_AUTHORIZED",
        severity: "block",
        detail: `import '${imported}' is not under any authorized import prefix`,
      });
      return;
    }
    if (imported.split(".").length > 3) {
      warnings.push({
        ruleId: "DEEP_IMPORT",
        severity: "warn",
        detail: `import '${imported}' reaches four or more segments deep; prefer a shallower surface`,
      });
    }
  }

  private checkCall(
    call: { module?: string; function: string; attributePath?: string[] },
    violations: CodeExecutionViolation[],
    warnings: CodeExecutionViolation[],
  ): void {
    for (const attribute of call.attributePath ?? []) {
      if (isDunder(attribute) && !this.policy.allowedDunderMethods.has(attribute)) {
        violations.push({
          ruleId: "DUNDER_ACCESS_DENIED",
          severity: "block",
          detail: `attribute access on '${attribute}' is a dunder outside the allow-list ${[
            ...this.policy.allowedDunderMethods,
          ].join(", ")}`,
        });
      }
    }

    if (call.module) {
      if (this.policy.forbiddenModules.has(call.module)) {
        violations.push({
          ruleId: "CALL_FORBIDDEN_MODULE",
          severity: "block",
          detail: `call to '${call.module}.${call.function}' reaches a forbidden module`,
        });
        return;
      }
      for (const forbidden of this.policy.forbiddenFunctions) {
        const [moduleName, functionName] = splitQualified(forbidden);
        if (call.module === moduleName && call.function === functionName) {
          violations.push({
            ruleId: "CALL_FORBIDDEN_FUNCTION",
            severity: "block",
            detail: `call to forbidden function '${forbidden}'`,
          });
          return;
        }
      }
      return;
    }

    // Unqualified call: only the builtin family of dangerous functions can
    // match, and they match on name alone since they have no module qualifier.
    for (const forbidden of this.policy.forbiddenFunctions) {
      const [moduleName, functionName] = splitQualified(forbidden);
      if (moduleName === "builtins" && call.function === functionName) {
        violations.push({
          ruleId: "CALL_FORBIDDEN_BUILTIN",
          severity: "block",
          detail: `unqualified call to builtin '${functionName}' is forbidden`,
        });
        return;
      }
    }
    if (/^(open|input|breakpoint)$/.test(call.function)) {
      warnings.push({
        ruleId: "IO_SIDE_EFFECT",
        severity: "warn",
        detail: `call to '${call.function}' has a filesystem or console side effect`,
      });
    }
  }

  private checkOutputSize(
    bytes: number,
    violations: CodeExecutionViolation[],
    _warnings: CodeExecutionViolation[],
  ): void {
    if (bytes > this.policy.maxOutputLength) {
      violations.push({
        ruleId: "OUTPUT_TOO_LARGE",
        severity: "block",
        detail: `estimated output of ${bytes} bytes exceeds the ${this.policy.maxOutputLength} byte ceiling`,
      });
    }
  }

  /**
   * A loop whose iteration count is statically known is checked against the
   * real budget; one whose count is unknown is warned about, not blocked —
   * the runtime ceiling is what catches it, not a guess.
   */
  private checkLoopBudgets(
    bounds: Array<{ kind: "for" | "while"; iterations?: number }>,
    violations: CodeExecutionViolation[],
    warnings: CodeExecutionViolation[],
  ): void {
    let staticOperations = 0;
    let unboundedLoops = 0;

    for (const bound of bounds) {
      if (bound.iterations === undefined) {
        unboundedLoops++;
        continue;
      }
      if (bound.kind === "while" && bound.iterations > this.policy.maxWhileIterations) {
        violations.push({
          ruleId: "WHILE_ITERATION_BUDGET",
          severity: "block",
          detail: `while loop with ${bound.iterations} iterations exceeds the ${this.policy.maxWhileIterations} iteration ceiling`,
        });
        continue;
      }
      staticOperations += bound.iterations;
    }

    if (staticOperations > this.policy.maxOperations) {
      violations.push({
        ruleId: "OPERATION_BUDGET",
        severity: "block",
        detail: `estimated ${staticOperations} operations exceeds the ${this.policy.maxOperations} operation ceiling`,
      });
    }
    if (unboundedLoops > 0) {
      warnings.push({
        ruleId: "UNBOUNDED_LOOP",
        severity: "warn",
        detail: `${unboundedLoops} loop(s) have no statically known iteration count; the runtime ceiling is the only guard`,
      });
    }
  }

  private estimateTime(artifact: CodeArtifact): number {
    let operations = 0;
    for (const bound of artifact.loopBounds ?? []) {
      operations += bound.iterations ?? 1_000;
    }
    operations = Math.max(operations, artifact.calls.length);
    // 10M operations per second is the same order smolagents assumes when it
    // pairs MAX_OPERATIONS with MAX_EXECUTION_TIME_SECONDS.
    return operations / 10_000_000;
  }
}

function splitQualified(qualified: string): [string, string] {
  const index = qualified.lastIndexOf(".");
  if (index < 0) return ["", qualified];
  return [qualified.slice(0, index), qualified.slice(index + 1)];
}
