import { describe, expect, it } from "vitest";

import {
  ALLOWED_DUNDER_METHODS,
  DEFAULT_CODE_EXECUTION_POLICY,
  DANGEROUS_FUNCTIONS,
  DANGEROUS_MODULES,
  CodeExecutionPolicyEngine,
  buildImportTree,
  checkImportAuthorized,
  strictCodeExecutionPolicy,
  type CodeArtifact,
} from "../../../src/engine/swe-loop/code-execution-policy.js";

function clean(overrides: Partial<CodeArtifact> = {}): CodeArtifact {
  return {
    language: "python",
    source: "x = 1",
    imports: ["math"],
    calls: [{ module: "math", function: "sqrt" }],
    ...overrides,
  };
}

describe("CodeExecutionPolicyEngine dunder denial", () => {
  it("blocks a dunder attribute outside the allow-list", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(
      clean({ calls: [{ module: "obj", function: "getattr", attributePath: ["__class__"] }] }),
    );
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
      "DUNDER_ACCESS_DENIED",
    );
  });

  it("permits the allow-listed dunders", () => {
    const engine = new CodeExecutionPolicyEngine();
    for (const allowed of ALLOWED_DUNDER_METHODS) {
      const assessment = engine.assess(
        clean({ calls: [{ module: "obj", function: "getattr", attributePath: [allowed] }] }),
      );
      expect(assessment.violations.map((violation) => violation.ruleId)).not.toContain(
        "DUNDER_ACCESS_DENIED",
      );
    }
  });

  it("does not mistake a mere underscore prefix for a dunder", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(
      clean({ calls: [{ module: "obj", function: "getattr", attributePath: ["_private"] }] }),
    );
    expect(assessment.allowed).toBe(true);
  });
});

describe("CodeExecutionPolicyEngine module and function blocklists", () => {
  it("blocks an import of a forbidden module", () => {
    const engine = new CodeExecutionPolicyEngine();
    for (const forbidden of DANGEROUS_MODULES) {
      const assessment = engine.assess(clean({ imports: [forbidden] }));
      expect(assessment.allowed).toBe(false);
      expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
        "IMPORT_FORBIDDEN_MODULE",
      );
    }
  });

  it("blocks a qualified call to a forbidden function", () => {
    // `os` itself is blocklisted, so that call trips the module rule first;
    // the function rule is reachable only for a module that is not blocked
    // outright but exports a forbidden qualified function.
    const engine = new CodeExecutionPolicyEngine({ forbiddenModules: new Set(["builtins"]) });
    const assessment = engine.assess(clean({ calls: [{ module: "os", function: "system" }] }));
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
      "CALL_FORBIDDEN_FUNCTION",
    );
  });

  it("blocks every forbidden function in the table", () => {
    const engine = new CodeExecutionPolicyEngine();
    for (const qualified of DANGEROUS_FUNCTIONS) {
      const [moduleName, functionName] = qualified.split(".");
      if (!functionName) continue;
      const assessment = engine.assess(
        clean({ calls: [{ module: moduleName, function: functionName }] }),
      );
      expect(assessment.allowed).toBe(false);
    }
  });

  it("does not confuse a user-defined function with the builtin of the same name", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(clean({ calls: [{ module: "myapp", function: "eval" }] }));
    expect(assessment.allowed).toBe(true);
  });

  it("blocks an unqualified call to a dangerous builtin", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(clean({ calls: [{ function: "exec" }] }));
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
      "CALL_FORBIDDEN_BUILTIN",
    );
  });

  it("warns, but does not block, on filesystem and console side effects", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(
      clean({ calls: [{ function: "open" }, { function: "breakpoint" }] }),
    );
    expect(assessment.allowed).toBe(true);
    expect(assessment.warnings.map((warning) => warning.ruleId)).toContain("IO_SIDE_EFFECT");
  });
});

describe("CodeExecutionPolicyEngine authorized imports", () => {
  it("admits an authorized module and everything beneath it", () => {
    const engine = new CodeExecutionPolicyEngine({
      authorizedImports: new Set(["numpy"]),
    });
    for (const imported of ["numpy", "numpy.linalg", "numpy.core.multiarray"]) {
      const assessment = engine.assess(clean({ imports: [imported] }));
      expect(assessment.allowed).toBe(true);
    }
  });

  it("refuses an import whose root is not authorized", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(clean({ imports: ["django.core.handlers"] }));
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
      "IMPORT_NOT_AUTHORIZED",
    );
  });

  it("warns on an import four or more segments deep", () => {
    const engine = new CodeExecutionPolicyEngine({ authorizedImports: new Set(["a.b.c.d"]) });
    const assessment = engine.assess(clean({ imports: ["a.b.c.d"] }));
    expect(assessment.allowed).toBe(true);
    expect(assessment.warnings.map((warning) => warning.ruleId)).toContain("DEEP_IMPORT");
  });
});

describe("buildImportTree / checkImportAuthorized", () => {
  it("builds a nested map and admits paths under an authorized root", () => {
    const tree = buildImportTree(["numpy", "os.path"]);
    expect([...tree.keys()].sort()).toEqual(["numpy", "os"]);
    const authorized = new Set(["numpy", "os.path"]);
    expect(checkImportAuthorized("numpy", tree, authorized)).toBe(true);
    expect(checkImportAuthorized("numpy.linalg", tree, authorized)).toBe(true);
    expect(checkImportAuthorized("os.path", tree, authorized)).toBe(true);
  });

  it("refuses a path whose first segment is unknown", () => {
    const tree = buildImportTree(["math"]);
    expect(checkImportAuthorized("math.sqrt", tree, new Set(["math"]))).toBe(true);
    expect(checkImportAuthorized("evil.module", tree, new Set(["math"]))).toBe(false);
    expect(checkImportAuthorized("", tree, new Set(["math"]))).toBe(false);
  });
});

describe("CodeExecutionPolicyEngine resource ceilings", () => {
  it("blocks a while loop over its iteration ceiling", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(
      clean({ loopBounds: [{ kind: "while", iterations: 10_000_000 }] }),
    );
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
      "WHILE_ITERATION_BUDGET",
    );
  });

  it("blocks a statically-known operation count over its ceiling", () => {
    const engine = new CodeExecutionPolicyEngine({ maxOperations: 100 });
    const assessment = engine.assess(
      clean({
        loopBounds: [
          { kind: "for", iterations: 200 },
          { kind: "for", iterations: 200 },
        ],
      }),
    );
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
      "OPERATION_BUDGET",
    );
  });

  it("warns on a loop with no statically known bound instead of guessing", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(clean({ loopBounds: [{ kind: "while" }] }));
    expect(assessment.allowed).toBe(true);
    expect(assessment.warnings.map((warning) => warning.ruleId)).toContain("UNBOUNDED_LOOP");
  });

  it("blocks an estimated output over the byte ceiling", () => {
    const engine = new CodeExecutionPolicyEngine({ maxOutputLength: 1_000 });
    const assessment = engine.assess(clean({ estimatedOutputBytes: 10_000 }));
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain(
      "OUTPUT_TOO_LARGE",
    );
  });

  it("blocks a run whose estimated time exceeds the execution ceiling", () => {
    const engine = new CodeExecutionPolicyEngine({
      maxOperations: 10 ** 9,
      maxWhileIterations: 10 ** 9,
      maxExecutionTimeSeconds: 1,
    });
    const assessment = engine.assess(
      clean({ loopBounds: [{ kind: "while", iterations: 50_000_000 }] }),
    );
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations.map((violation) => violation.ruleId)).toContain("TIME_BUDGET");
    expect(assessment.estimatedTimeSeconds).toBeGreaterThan(1);
  });

  it("estimates one thousand operations for a loop with no stated bound", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(clean({ loopBounds: [{ kind: "while" }] }));
    expect(assessment.estimatedTimeSeconds).toBeCloseTo(1_000 / 10_000_000, 8);
  });
});

describe("CodeExecutionPolicyEngine result smuggling guard", () => {
  it("blocks a returned value that exposes a forbidden module", () => {
    const engine = new CodeExecutionPolicyEngine();
    const violation = engine.checkResult({ module: "os" });
    expect(violation?.ruleId).toBe("RESULT_FORBIDDEN_MODULE");
    expect(violation?.severity).toBe("block");
  });

  it("blocks a returned value that exposes a forbidden function", () => {
    const engine = new CodeExecutionPolicyEngine();
    const violation = engine.checkResult({
      qualifiedFunction: "os.system",
      functionName: "system",
    });
    expect(violation?.ruleId).toBe("RESULT_FORBIDDEN_FUNCTION");
  });

  it("clears an authorized module and a harmless function", () => {
    const engine = new CodeExecutionPolicyEngine();
    expect(engine.checkResult({ module: "math" })).toBeNull();
    expect(engine.checkResult({ qualifiedFunction: "math.sqrt", functionName: "sqrt" })).toBeNull();
  });

  it("does not flag a user function whose name matches a forbidden builtin", () => {
    const engine = new CodeExecutionPolicyEngine();
    expect(
      engine.checkResult({ qualifiedFunction: "myapp.eval", functionName: "eval" }),
    ).toBeNull();
  });

  it("skips forbidden functions that are static tools on the result", () => {
    const engine = new CodeExecutionPolicyEngine();
    expect(
      engine.checkResult({
        qualifiedFunction: "builtins.eval",
        functionName: "eval",
        staticTools: new Set(["eval"]),
      }),
    ).toBeNull();
  });
});

describe("CodeExecutionPolicyEngine policy composition", () => {
  it("ships sensible defaults", () => {
    expect(DEFAULT_CODE_EXECUTION_POLICY.maxOutputLength).toBe(50_000);
    expect(DEFAULT_CODE_EXECUTION_POLICY.maxOperations).toBe(10_000_000);
    expect(DEFAULT_CODE_EXECUTION_POLICY.maxExecutionTimeSeconds).toBe(30);
    expect([...DEFAULT_CODE_EXECUTION_POLICY.allowedDunderMethods].sort()).toEqual(
      [...ALLOWED_DUNDER_METHODS].sort(),
    );
  });

  it("composes a stricter tier that still overrides cleanly", () => {
    const strict = strictCodeExecutionPolicy({ maxExecutionTimeSeconds: 5 });
    expect(strict.maxOutputLength).toBe(10_000);
    expect(strict.maxOperations).toBe(1_000_000);
    expect(strict.maxWhileIterations).toBe(100_000);
    expect(strict.maxExecutionTimeSeconds).toBe(5);
  });

  it("validates positive ceilings", () => {
    expect(() => new CodeExecutionPolicyEngine({ maxOutputLength: 0 })).toThrow(
      /maxOutputLength must be positive/,
    );
    expect(() => new CodeExecutionPolicyEngine({ maxOperations: -1 })).toThrow(
      /maxOperations must be positive/,
    );
    expect(() => new CodeExecutionPolicyEngine({ maxWhileIterations: 0 })).toThrow(
      /maxWhileIterations must be positive/,
    );
    expect(() => new CodeExecutionPolicyEngine({ maxExecutionTimeSeconds: 0 })).toThrow(
      /maxExecutionTimeSeconds must be positive/,
    );
  });

  it("carries its policy name onto every assessment", () => {
    const engine = new CodeExecutionPolicyEngine({}, "sandboxed");
    expect(engine.policyName).toBe("sandboxed");
    expect(engine.assess(clean()).policyName).toBe("sandboxed");
  });

  it("admits a clean artifact with no findings at all", () => {
    const engine = new CodeExecutionPolicyEngine();
    const assessment = engine.assess(clean());
    expect(assessment.allowed).toBe(true);
    expect(assessment.violations).toHaveLength(0);
    expect(assessment.warnings).toHaveLength(0);
  });
});
