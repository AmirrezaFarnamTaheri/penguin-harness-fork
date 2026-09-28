/**
 * The admission decision: which operations may be shared with another agent's run.
 *
 * Two halves, and the second half is the one that keeps the first honest. The accepted corpus is
 * the ordinary shapes of this repository's own gates. The refused corpus is the interesting half,
 * because the failure this feature could cause is not "an agent waited a moment too long", it is
 * "two agents acted on one answer about work that was never shared" — a build that never
 * happened, a migration applied once and believed twice. So each refusal is asserted by name
 * rather than left to a comment, including every entry in the refused-program table, which is what
 * stops that table from quietly becoming decoration.
 */
import { describe, expect, it } from "vitest";

import {
  admitOperation,
  normalizeProgramName,
  REFUSED_PROGRAM_NOTES,
  type ExcludeReason,
  type ShareDecision,
  type ShareOperationSpec,
} from "../../../src/agent/sharing/index.js";

function spec(argv: string[], overrides: Partial<ShareOperationSpec> = {}): ShareOperationSpec {
  return { argv, cwd: "/repo", effects: "read-only", ...overrides };
}

function reasonOf(decision: ShareDecision): ExcludeReason | null {
  return decision.admitted ? null : decision.reason;
}

describe("policy: the read-only allowlist", () => {
  const accepted: { argv: string[]; kind: string }[] = [
    { argv: ["vitest", "run"], kind: "test-runner" },
    { argv: ["vitest", "run", "test/agent/sharing/registry.test.ts"], kind: "test-runner" },
    { argv: ["vitest", "related", "src/agent/sharing/index.ts"], kind: "test-runner" },
    { argv: ["jest", "test/a.test.ts"], kind: "test-runner" },
    { argv: ["node", "--test", "test/a.test.ts"], kind: "test-runner" },
    { argv: ["node", "--check", "dist/index.js"], kind: "test-runner" },
    { argv: ["eslint", "src"], kind: "linter" },
    { argv: ["oxlint", "--deny-warnings", "src/agent/sharing"], kind: "linter" },
    { argv: ["biome", "lint", "src"], kind: "linter" },
    { argv: ["biome", "check", "src"], kind: "linter" },
    { argv: ["biome", "ci", "src"], kind: "linter" },
    { argv: ["prettier", "--check", "src"], kind: "linter" },
    { argv: ["prettier", "-l", "src"], kind: "linter" },
    { argv: ["tsc", "--noEmit", "-p", "tsconfig.json"], kind: "typecheck" },
    { argv: ["tsgo", "--noEmit"], kind: "typecheck" },
  ];

  for (const { argv, kind } of accepted) {
    it(`admits ${argv.join(" ")} as ${kind}`, () => {
      const decision = admitOperation(spec(argv));
      expect(decision.admitted, `${argv.join(" ")}: ${JSON.stringify(decision)}`).toBe(true);
      if (decision.admitted) expect(decision.kind).toBe(kind);
    });
  }

  it("admits a bare `jest` — its batch mode is the default, so requiring a flag would exclude it", () => {
    expect(admitOperation(spec(["jest"])).admitted).toBe(true);
  });
});

describe("policy: refusals that are not optional", () => {
  it("refuses by default, because the effect declaration is `unknown` until proven", () => {
    // Forgetting the declaration must cost a duplicate run, never a shared wrong answer.
    const decision = admitOperation({ argv: ["vitest", "run"], cwd: "/repo" });
    expect(reasonOf(decision)).toBe("declared-effects");
  });

  it("refuses an operation the caller admits writes", () => {
    expect(reasonOf(admitOperation(spec(["vitest", "run"], { effects: "writes" })))).toBe(
      "declared-effects",
    );
  });

  it("refuses an operation with no command at all", () => {
    expect(reasonOf(admitOperation(spec([])))).toBe("unknown-program");
  });

  it("refuses a program that is not on the list, and names it", () => {
    const decision = admitOperation(spec(["my-project-lint", "src"]));
    expect(reasonOf(decision)).toBe("unknown-program");
    if (!decision.admitted) expect(decision.detail).toContain("my-project-lint");
  });
});

describe("policy: a tool that only stays read-only with the right flag", () => {
  const needsFlag: { argv: string[]; why: string }[] = [
    { argv: ["vitest"], why: "bare vitest enters watch mode" },
    { argv: ["prettier", "src"], why: "prettier writes by default" },
    { argv: ["tsc"], why: "tsc emits by default" },
    { argv: ["tsc", "-p", "tsconfig.json"], why: "a project is not a flag that stops emission" },
    { argv: ["node", "script.js"], why: "node runs the program" },
  ];

  for (const { argv, why } of needsFlag) {
    it(`refuses \`${argv.join(" ")}\` — ${why}`, () => {
      const decision = admitOperation(spec(argv));
      expect(decision.admitted, `${argv.join(" ")}: ${JSON.stringify(decision)}`).toBe(false);
    });
  }

  it("accepts `prettier --check` with no paths, and still `tsc --noEmit` alone", () => {
    expect(admitOperation(spec(["prettier", "--check"])).admitted).toBe(true);
    expect(admitOperation(spec(["tsc", "--noEmit"])).admitted).toBe(true);
  });
});

describe("policy: shapes that write, repair, or never finish", () => {
  const refused: { argv: string[]; why: string }[] = [
    { argv: ["vitest", "run", "--watch"], why: "watch never terminates" },
    { argv: ["vitest", "run", "-w"], why: "the short form of --watch" },
    { argv: ["vitest", "run", "--coverage"], why: "writes a coverage report" },
    { argv: ["vitest", "run", "-u"], why: "rewrites snapshots" },
    { argv: ["vitest", "run", "--outputFile", "junit.xml"], why: "writes a file" },
    { argv: ["jest", "--cache"], why: "writes .eslintcache-style state into the tree" },
    { argv: ["eslint", "src", "--fix"], why: "rewrites the source it linted" },
    {
      argv: ["eslint", "src", "--fix-dry-run"],
      why: "the fix path, and the flag is a prefix match",
    },
    { argv: ["eslint", "src", "--fix=true"], why: "a flag with a value is still the flag" },
    { argv: ["oxlint", "--fix-suggestions", "src"], why: "rewrites the source" },
    { argv: ["oxlint", "--generate-config", "src"], why: "writes a config file" },
    {
      argv: ["prettier", "--check", "--write"],
      why: "the check flag does not cancel the write flag",
    },
    { argv: ["prettier", "-w", "src"], why: "prettier's short write flag" },
    { argv: ["biome", "format", "src"], why: "formatting is a write" },
    { argv: ["biome", "check", "--apply", "src"], why: "applies fixes" },
    { argv: ["biome", "--apply-unsafe", "check", "src"], why: "applies unsafe fixes" },
    { argv: ["tsc", "--noEmit", "-b"], why: "build mode writes" },
    { argv: ["tsc", "--noEmit", "--incremental"], why: "writes a buildinfo file" },
    {
      argv: ["tsc", "--noEmit", "--tsBuildInfoFile", "x.tsbuildinfo"],
      why: "writes a buildinfo file",
    },
    { argv: ["tsc", "--noEmit", "--outDir", "dist"], why: "an output directory is a write" },
  ];

  for (const { argv, why } of refused) {
    it(`refuses \`${argv.join(" ")}\` — ${why}`, () => {
      const decision = admitOperation(spec(argv));
      expect(decision.admitted, `${argv.join(" ")}: ${JSON.stringify(decision)}`).toBe(false);
    });
  }
});

describe("policy: the refused-program table is data, and every row is refused", () => {
  // The table is the reason a caller gets a sentence instead of "no". If a row stopped being
  // refused, the note would be a lie, and this is the test that says so.
  for (const program of Object.keys(REFUSED_PROGRAM_NOTES)) {
    it(`refuses ${program} with its stated reason`, () => {
      const decision = admitOperation(spec([program, "anything"]));
      expect(decision.admitted, program).toBe(false);
      if (!decision.admitted) {
        expect(decision.reason).toBe("unknown-program");
        expect(decision.detail).toBe(REFUSED_PROGRAM_NOTES[program]);
      }
    });
  }

  it("refuses a shell wrapper even when the wrapped command is read-only", () => {
    // `bash -c "vitest run"` can be any command at all, and its own arguments do not say which.
    const decision = admitOperation(spec(["bash", "-c", "vitest run"]));
    expect(reasonOf(decision)).toBe("unknown-program");
    if (!decision.admitted) expect(decision.detail).toMatch(/resolved binary/);
  });

  it("refuses a package manager, whose arguments do not name the binary", () => {
    expect(reasonOf(admitOperation(spec(["pnpm", "vitest", "run"])))).toBe("unknown-program");
    expect(reasonOf(admitOperation(spec(["npx", "tsc", "--noEmit"])))).toBe("unknown-program");
  });

  it("refuses the web-search and browser cases the product request asked about", () => {
    // Not by policy preference: sharing requires a hashable dependency, and a live page has none.
    // A key without a fingerprint is a guess, and a guessed search result is a fabricated fact.
    expect(reasonOf(admitOperation(spec(["web_search", "--query", "vitest docs"])))).toBe(
      "unknown-program",
    );
    expect(reasonOf(admitOperation(spec(["curl", "https://example.com"])))).toBe("unknown-program");
  });
});

describe("policy: program normalisation", () => {
  it("strips a path and a Windows executable extension, which this repo's gates use", () => {
    // Without this, `node_modules/.bin/tsc.CMD` is a different program from `tsc` and every gate
    // is unshareable on the platform where the suite is slowest.
    expect(normalizeProgramName("node_modules/.bin/tsc.CMD")).toBe("tsc");
    expect(normalizeProgramName("node_modules\\.bin\\vitest.cmd")).toBe("vitest");
    expect(normalizeProgramName("C:\\repo\\node_modules\\.bin\\oxlint.EXE")).toBe("oxlint");
    expect(normalizeProgramName("oxlint")).toBe("oxlint");
  });

  it("admits the Windows spelling of this repository's own typecheck gate", () => {
    const decision = admitOperation(
      spec(["../../node_modules/.bin/tsc.CMD", "--noEmit", "-p", "tsconfig.json"]),
    );
    expect(decision.admitted).toBe(true);
    if (decision.admitted) expect(decision.program).toBe("tsc");
  });
});

describe("policy: the decision is pure and total", () => {
  it("throws for nothing, including degenerate input", () => {
    const inputs: ShareOperationSpec[] = [
      { argv: [""], cwd: "" },
      { argv: ["vitest", "run"], cwd: "", effects: "read-only" },
      { argv: ["biome"], cwd: "/repo", effects: "read-only" },
      { argv: ["tsc", "--noEmit", "--noEmit"], cwd: "/repo", effects: "read-only" },
    ];
    for (const input of inputs) {
      expect(() => admitOperation(input)).not.toThrow();
    }
  });

  it("refuses a biome invocation with no subcommand, rather than defaulting to one", () => {
    expect(reasonOf(admitOperation(spec(["biome", "src"])))).toBe("command-shape");
  });
});
