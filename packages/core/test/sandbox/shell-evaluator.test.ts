/**
 * Tests for the in-memory shell evaluator.
 *
 * The file this replaces was a manual probe: every code path wrapped in a
 * try/catch and handed to console.log, with no assertion anywhere. That made it a
 * test that could not fail for the one module that decides whether a script runs in
 * process or escalates to the hardware sandbox — so the assertions below cover the
 * classifier's verdicts and the evaluator's ceilings directly.
 *
 * A few cases are labelled CURRENT-BEHAVIOUR. They pin something the implementation
 * actually does that POSIX does not specify, and each one is a defect found while
 * writing this file (see the comments and the notes in the bug-swarm findings).
 * They assert the observed result so a fix in shell-evaluator.ts flips them loudly
 * instead of passing silently.
 */
import { describe, expect, it } from "vitest";

import type { CowFsBackend } from "../../src/sandbox/cow-fs-backend.js";
import {
  classifyScript,
  ExecutionLimitError,
  ShellEvaluator,
  UnsupportedConstructError,
  type EvaluatorOptions,
  type EvaluationResult,
  type UnsupportedReason,
} from "../../src/sandbox/shell-evaluator.js";

/** Run one script on a fresh evaluator. The module's contract is one instance per
 * evaluation — counters, the clock, and stdout are per-instance — so reusing an
 * instance would let one script's limits leak into the next. */
async function evaluate(source: string, options: EvaluatorOptions = {}): Promise<EvaluationResult> {
  return new ShellEvaluator(options).evaluate(source);
}

/** Run a script expected to fail and hand back exactly what it threw. */
async function failure(source: string, options: EvaluatorOptions = {}): Promise<unknown> {
  try {
    await evaluate(source, options);
  } catch (error) {
    return error;
  }
  return undefined;
}

async function stdoutOf(source: string, options: EvaluatorOptions = {}): Promise<string> {
  return (await evaluate(source, options)).stdout;
}

async function stderrOf(source: string, options: EvaluatorOptions = {}): Promise<string> {
  return (await evaluate(source, options)).stderr;
}

async function statusOf(source: string, options: EvaluatorOptions = {}): Promise<number> {
  return (await evaluate(source, options)).exitCode;
}

/** [script, reason, the token the reason was reported at.]
 *
 * The command in every script is a builtin: classification reports the first word in
 * command position as an external command before it ever looks at an operator, so a
 * `cat` here would be reported `external_command` and tell us nothing about the
 * operator rows. The four map entries the lexer can never reach — case_statement,
 * select_statement, coproc, function_definition — are covered separately below. */
const UNSAFE_TOKENS: ReadonlyArray<[string, UnsupportedReason, string]> = [
  ["(( 1 + 1 ))", "arithmetic_group", "(("],
  ["))", "arithmetic_group", "))"],
  ["[[ -e /etc ]]", "conditional_group", "[["],
  ["]]", "conditional_group", "]]"],
  ["(echo hi)", "subshell", "("],
  [")", "subshell", ")"],
  ["pwd <<EOF", "heredoc", "<<"],
  ["pwd <<-EOF", "heredoc", "<<-"],
  ["pwd <<< hi", "heredoc", "<<<"],
  ["echo hi > out", "redirection", ">"],
  ["echo hi >> out", "redirection", ">>"],
  ["pwd < in", "redirection", "<"],
  ["pwd <> in", "redirection", "<>"],
  ["echo hi >&2", "redirection", ">&"],
  ["pwd <&3", "redirection", "<&"],
  ["echo >| out", "redirection", ">|"],
  ["echo hi &> out", "redirection", "&>"],
  ["echo hi &>> out", "redirection", "&>>"],
  ["sleep 5 &", "background_job", "&"],
];

describe("shell-evaluator", () => {
  describe("classifyScript", () => {
    describe("unsafe token types", () => {
      it.each(UNSAFE_TOKENS)("rejects %s as %s at %s", (script, reason, token) => {
        const verdict = classifyScript(script);
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe(reason);
          // The reported token proves the verdict was found at the first offending
          // token rather than somewhere later in the script.
          expect(verdict.at?.value).toBe(token);
          expect(verdict.tokens.length).toBeGreaterThan(0);
        }
      });

      it("reports the first offending token, not the last", () => {
        // `>` is a redirection and `&&` is not unsafe at all, so the verdict must
        // name `>` and stop: reporting the later NAME would mean the scan ran on.
        const verdict = classifyScript("echo hi > out && pwd");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("redirection");
          expect(verdict.at?.value).toBe(">");
          expect(verdict.at?.line).toBe(1);
          expect(verdict.at?.column).toBe(9);
        }
      });
    });

    describe("reasons the token map can never produce", () => {
      // CURRENT-BEHAVIOUR / DEFECT: the lexer's readWord only ever emits WORD, NAME,
      // NUMBER, ASSIGNMENT_WORD, or FD_VARIABLE — a reserved word such as `case` or
      // `function` stays a plain NAME, and isReservedWord() is what keeps it out of
      // the external-command branch. So the four UNSAFE_TOKEN_TYPES entries keyed on
      // TokenType.CASE / ESAC / SELECT / COPROC / FUNCTION (shell-evaluator.ts:91-95)
      // are dead: no script can be reported case_statement, select_statement, coproc,
      // or function_definition. The consequence is escalation in the wrong direction —
      // every script below is admitted to the fast tier and then fails at runtime
      // with a misleading `external_command` error instead of being escalated by the
      // classifier, which is what the tier decision is supposed to rest on.
      it("admits the four constructs instead of escalating them", () => {
        for (const script of [
          "esac",
          "select x in a b; do echo x; done",
          "coproc grep lines",
          "function greet { echo hi; }",
        ]) {
          expect(classifyScript(script).inMemorySafe).toBe(true);
        }
      });

      it("escalates a case statement as a subshell instead", () => {
        // The `)` of the pattern is what trips the verdict, so the script is still
        // escalated — but as a subshell, not a case statement.
        const verdict = classifyScript("case x in a) echo b;; esac");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("subshell");
          expect(verdict.at?.value).toBe(")");
        }
      });

      it("then fails the admitted script at runtime", async () => {
        expect(classifyScript("function greet { echo hi; }").inMemorySafe).toBe(true);
        const error = await failure("function greet { echo hi; }");
        expect(error).toBeInstanceOf(UnsupportedConstructError);
        const typed = error as UnsupportedConstructError;
        expect(typed.reason).toBe("external_command");
        expect(typed.message).toBe("command function is not an in-memory built-in");
      });
    });

    describe("brace depth", () => {
      it("accepts a balanced brace group", () => {
        expect(classifyScript("{ echo hi; }").inMemorySafe).toBe(true);
        expect(classifyScript("{ { echo hi; }; echo bye; }").inMemorySafe).toBe(true);
      });

      it("rejects an unterminated group without a token to point at", () => {
        // A group left open to the end of the script has no offending token, so the
        // verdict carries the reason and the tokens but no `at`.
        const verdict = classifyScript("{ echo hi");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("unbalanced_group");
          expect(verdict.at).toBeUndefined();
        }
      });

      it("rejects a closer with nothing to close at the token that closed too far", () => {
        const verdict = classifyScript("echo hi }");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("unbalanced_group");
          expect(verdict.at?.value).toBe("}");
          expect(verdict.at?.line).toBe(1);
          expect(verdict.at?.column).toBe(9);
        }
      });

      it("rejects an unbalanced closer nested inside a group", () => {
        const verdict = classifyScript("{ echo hi } }");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) expect(verdict.reason).toBe("unbalanced_group");
      });
    });

    describe("command position", () => {
      it("rejects a non-builtin word as an external command", () => {
        const verdict = classifyScript("rm -rf /");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("external_command");
          expect(verdict.at?.value).toBe("rm");
        }
      });

      it("accepts the same word as a plain argument", () => {
        // `rm` in an argument slot names nothing, so the script is safe whatever it spells.
        expect(classifyScript("echo rm").inMemorySafe).toBe(true);
        expect(classifyScript("pwd rm rm rm").inMemorySafe).toBe(true);
      });

      it("rejects a quoted command name just the same", () => {
        // The evaluator does not expand command names at all, so `"rm"` is as
        // external as `rm`: quoting cannot smuggle a binary into the fast tier.
        const verdict = classifyScript('"rm" file');
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("external_command");
          expect(verdict.at?.value).toBe("rm");
        }
      });

      it("lets leading assignments pass without filling the command-name slot", () => {
        // `a=1 b=2 pwd` still names its command at `pwd`; only the word after the
        // assignment(s) is a command name.
        expect(classifyScript("FOO=bar pwd").inMemorySafe).toBe(true);
        const verdict = classifyScript("a=1 b=2 rm");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("external_command");
          expect(verdict.at?.value).toBe("rm");
        }
      });

      it("re-opens the command slot after every command separator", () => {
        // A word after `;`, `|`, or a newline names a binary again.
        for (const script of ["echo hi; rm", "echo hi | rm", "echo hi\nrm", "echo hi && rm"]) {
          const verdict = classifyScript(script);
          expect(verdict.inMemorySafe).toBe(false);
          if (!verdict.inMemorySafe) {
            expect(verdict.reason).toBe("external_command");
            expect(verdict.at?.value).toBe("rm");
          }
        }
      });

      it("treats a relative path as an external command", () => {
        const verdict = classifyScript("./run.sh");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) expect(verdict.reason).toBe("external_command");
      });

      it("escalates an assignment whose value is quoted", () => {
        // CURRENT-BEHAVIOUR / GAP: readWord marks a word quoted when any part of it
        // was quoted, and the ASSIGNMENT_WORD check requires an unquoted word, so
        // `X=""` and `X="two words"` are command words rather than assignments. This
        // one fails safe — the script escalates instead of binding a wrong value —
        // so it is a reachability gap and not a mis-binding.
        for (const script of ['X=""', 'X="two words"']) {
          const verdict = classifyScript(script);
          expect(verdict.inMemorySafe).toBe(false);
          if (!verdict.inMemorySafe) expect(verdict.reason).toBe("external_command");
        }
      });
    });

    describe("safe scripts", () => {
      it("accepts builtins, assignments, and pipelines", () => {
        for (const script of [
          "",
          "echo hi",
          "pwd",
          "FOO=bar",
          "FOO=bar echo hi",
          "echo hi | pwd",
          "echo one; echo two",
          "a=1 b=2 pwd | pwd",
          "{ echo hi; }",
          "echo hi # a comment\npwd",
        ]) {
          expect(classifyScript(script).inMemorySafe).toBe(true);
        }
      });

      it("hands the token stream to the caller", () => {
        const verdict = classifyScript("echo hi");
        expect(verdict.inMemorySafe).toBe(true);
        if (verdict.inMemorySafe) {
          expect(verdict.tokens.map((t) => t.value)).toEqual(["echo", "hi"]);
        }
      });
    });
  });

  describe("evaluate", () => {
    describe("the classification gate", () => {
      it("throws for a script the classifier rejected", async () => {
        const error = await failure("rm -rf /");
        expect(error).toBeInstanceOf(UnsupportedConstructError);
        const typed = error as UnsupportedConstructError;
        expect(typed.reason).toBe("external_command");
        expect(typed.message).toBe("script uses external_command at line 1 column 1");
        expect(typed.name).toBe("UnsupportedConstructError");
      });

      it("names the offending token's position in the message", async () => {
        const error = (await failure("echo hi\nrm file")) as UnsupportedConstructError;
        expect(error.reason).toBe("external_command");
        expect(error.message).toBe("script uses external_command at line 2 column 1");
      });

      // CURRENT-BEHAVIOUR / DEFECT: `if` is a reserved word, so the classifier
      // admits it, but the evaluator implements no control flow and has no `if`
      // builtin. It therefore reaches the "the classifier and the evaluator
      // disagree" branch of runCommand and throws. A script using `if`/`for`/`while`
      // ought to be escalated as unsupported at classification time instead —
      // classifyScript returning inMemorySafe:true for it is the gap (see
      // shell-evaluator.ts:243-250 versus 455-462).
      it("admits a reserved control-flow word, then throws running it", async () => {
        expect(classifyScript("if true; then echo hi; fi").inMemorySafe).toBe(true);
        const error = await failure("if true; then echo hi; fi");
        expect(error).toBeInstanceOf(UnsupportedConstructError);
        const typed = error as UnsupportedConstructError;
        expect(typed.reason).toBe("external_command");
        expect(typed.message).toBe("command if is not an in-memory built-in");
      });
    });

    describe("resource ceilings", () => {
      it("rejects an already-aborted script", async () => {
        const controller = new AbortController();
        controller.abort();
        const error = await failure("echo hi", { signal: controller.signal });
        expect(error).toBeInstanceOf(ExecutionLimitError);
        const typed = error as ExecutionLimitError;
        expect(typed.kind).toBe("time");
        expect(typed.message).toBe("execution aborted");
      });

      it("does not trip the deadline when the injected clock is inside it", async () => {
        // A pinned clock makes this a statement about the arithmetic, not a race
        // against the machine: 0ms elapsed against a 10ms budget passes.
        const result = await evaluate("pwd", {
          now: () => 5000,
          limits: { maxExecutionTimeMs: 10 },
        });
        expect(result.exitCode).toBe(0);
        expect(result.durationMs).toBe(0);
      });

      it("enforces the wall-clock deadline", async () => {
        let now = 1000;
        const error = await failure("pwd", {
          now: () => (now += 1000),
          limits: { maxExecutionTimeMs: 100 },
        });
        expect(error).toBeInstanceOf(ExecutionLimitError);
        const typed = error as ExecutionLimitError;
        expect(typed.kind).toBe("time");
        expect(typed.message).toBe("execution exceeded 100ms deadline");
      });

      it("enforces the command count", async () => {
        // Two commands fit; the third charge is the one that trips the ceiling.
        const error = await failure("echo a; echo b; echo c", {
          limits: { maxCommandCount: 2 },
        });
        expect(error).toBeInstanceOf(ExecutionLimitError);
        const typed = error as ExecutionLimitError;
        expect(typed.kind).toBe("commands");
        expect(typed.message).toBe("command count exceeded (2)");
      });

      it("enforces the output size on stdout in one write", async () => {
        const error = await failure("echo hello world", { limits: { maxOutputSize: 5 } });
        expect(error).toBeInstanceOf(ExecutionLimitError);
        const typed = error as ExecutionLimitError;
        expect(typed.kind).toBe("output");
        expect(typed.message).toBe("output exceeded 5 bytes");
      });

      it("enforces the output size on stdout across accumulated writes", async () => {
        // The first write alone fits (6 bytes against 10); the second does not once
        // the first is counted, which is what makes the ceiling cumulative.
        const error = await failure("echo 12345; echo 123456", {
          limits: { maxOutputSize: 10 },
        });
        expect(error).toBeInstanceOf(ExecutionLimitError);
        expect((error as ExecutionLimitError).kind).toBe("output");
      });

      it("enforces the output size on stderr", async () => {
        // `read` writes to stderr, so this exercises the other accumulator: a script
        // that never writes a byte to stdout can still trip the output ceiling.
        const error = await failure("read name", { limits: { maxOutputSize: 5 } });
        expect(error).toBeInstanceOf(ExecutionLimitError);
        const typed = error as ExecutionLimitError;
        expect(typed.kind).toBe("output");
        expect(typed.message).toBe("output exceeded 5 bytes");
      });
    });

    describe("parameter expansion", () => {
      it("expands a set variable and an unset one to empty", async () => {
        expect(await stdoutOf('echo "$VAR"', { env: { VAR: "v" } })).toBe("v\n");
        expect(await stdoutOf("echo $VAR")).toBe("\n");
        expect(await stdoutOf('echo "${VAR}"')).toBe("\n");
      });

      it("expands an assignment's value, not just arguments", async () => {
        const result = await evaluate('X=$VAR; echo "$X"', { env: { VAR: "v" } });
        expect(result.stdout).toBe("v\n");
        expect(result.commandCount).toBe(2);
      });

      it("applies :- (default when unset or empty)", async () => {
        expect(await stdoutOf('echo "${VAR:-d}"')).toBe("d\n");
        expect(await stdoutOf('echo "${VAR:-d}"', { env: { VAR: "" } })).toBe("d\n");
        expect(await stdoutOf('echo "${VAR:-d}"', { env: { VAR: "v" } })).toBe("v\n");
      });

      it("applies - (default only when unset)", async () => {
        // The colon-less form distinguishes empty from unset: an empty variable is a
        // value here, so the default does not fire.
        expect(await stdoutOf('echo "${VAR-d}"')).toBe("d\n");
        expect(await stdoutOf('echo "${VAR-d}"', { env: { VAR: "" } })).toBe("\n");
        expect(await stdoutOf('echo "${VAR-d}"', { env: { VAR: "v" } })).toBe("v\n");
      });

      it("applies :+ (alternate when set and non-empty)", async () => {
        expect(await stdoutOf('echo "${VAR:+a}"')).toBe("\n");
        expect(await stdoutOf('echo "${VAR:+a}"', { env: { VAR: "" } })).toBe("\n");
        expect(await stdoutOf('echo "${VAR:+a}"', { env: { VAR: "v" } })).toBe("a\n");
      });

      it("applies + (alternate when set, even when empty)", async () => {
        expect(await stdoutOf('echo "${VAR+a}"')).toBe("\n");
        expect(await stdoutOf('echo "${VAR+a}"', { env: { VAR: "" } })).toBe("a\n");
      });

      it("warns on :? when unset or empty", async () => {
        // CURRENT-BEHAVIOUR / DEFECT: the status is not 1. expandParameter sets
        // this.exitCode = 1 (shell-evaluator.ts:543) but runPipeline then overwrites
        // exitCode with the builtin's own status (line 420), and expansion only ever
        // happens inside a command — so the error status is unobservable and every
        // script that trips `:?` still exits 0 while complaining on stderr.
        expect(await stderrOf('echo "${VAR:?}"')).toBe("VAR: parameter null or not set\n");
        expect(await statusOf('echo "${VAR:?}"')).toBe(0);
        expect(await stderrOf('echo "${VAR:?missing}"')).toBe("VAR: missing\n");
        expect(await statusOf('echo "${VAR:?missing}"')).toBe(0);
        // A set variable does not warn and expands normally.
        const result = await evaluate('echo "${VAR:?missing}"', { env: { VAR: "v" } });
        expect(result.stdout).toBe("v\n");
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      });

      it("expands the pid surrogate, the arg count, and a bare dollar", async () => {
        // `$$` is a surrogate, not a real pid, and `$#` is the harness's argv — both
        // are asserted against the same expressions the module uses so a change to
        // either surfaces here.
        expect(await stdoutOf("echo $$")).toBe("0\n");
        expect(await stdoutOf("echo $#")).toBe(`${process.argv.length - 2}\n`);
        // A `$` followed by no name is a literal dollar.
        expect(await stdoutOf("echo $")).toBe("$\n");
      });

      it("expands $? to the status of the previous command", async () => {
        expect(await stdoutOf("false; echo $?")).toBe("1\n");
        expect(await stdoutOf("true; echo $?")).toBe("0\n");
        // `$?` is expanded from the evaluator's own status, not a shell variable, so
        // assigning to it cannot change what the next `$?` reads.
        expect(await stdoutOf('false; X=$?; echo "$X"')).toBe("1\n");
      });

      it("expands unset variables in unquoted and quoted positions alike", async () => {
        expect(await stdoutOf("echo [$MISSING]")).toBe("[]\n");
        expect(await stdoutOf('echo ["$MISSING"]')).toBe("[]\n");
      });

      // CURRENT-BEHAVIOUR / DEFECT: an unterminated `${` is a syntax error, but it
      // is reported as an ExecutionLimitError with kind "iterations" — a resource
      // limit — at shell-evaluator.ts:504. Escalating a parse error as a resource
      // ceiling is the wrong bucket, and the message says nothing about the syntax.
      it("rejects an unterminated parameter expansion as a limit error", async () => {
        const error = await failure("echo ${unclosed");
        expect(error).toBeInstanceOf(ExecutionLimitError);
        const typed = error as ExecutionLimitError;
        expect(typed.kind).toBe("iterations");
        expect(typed.message).toBe("unterminated parameter expansion");
      });
    });

    describe("field splitting", () => {
      it("splits an unquoted expansion into separate fields", async () => {
        // `type` answers per argument, so two fields produce two lines where one
        // quoted field produces a "not found" error.
        const env = { X: "echo pwd" };
        expect(await stdoutOf("type $X", { env })).toBe(
          "echo is a shell builtin\npwd is a shell builtin\n",
        );
        expect(await stderrOf('type "$X"', { env })).toBe("echo pwd: not found\n");
      });

      it("splits an unquoted empty expansion into no fields at all", async () => {
        // `-n ""` is false. `-n` with no operand at all should also be an error, and
        // the fact that it answers 0 here is what makes the two distinguishable —
        // and exposes the missing-operand defect in runTest (shell-evaluator.ts:688).
        // What the comparison proves is that the unquoted expansion vanished instead
        // of becoming an empty argument: that is the property keeping
        // `rm $UNSET` from receiving an empty filename.
        expect(await statusOf('test -n "$MISSING"')).toBe(1);
        expect(await statusOf("test -n $MISSING")).toBe(0);
      });
    });

    describe("conditional execution", () => {
      it("runs both sides of && when the left side succeeds", async () => {
        expect(await stdoutOf("true && echo yes")).toBe("yes\n");
        expect(await stdoutOf("true && echo yes; echo done")).toBe("yes\ndone\n");
      });

      it("runs only the recovering branch of ||", async () => {
        expect(await stdoutOf("false || echo recovered")).toBe("recovered\n");
        expect(await stdoutOf("true || echo nope")).toBe("");
      });

      it("skips the right-hand side of && when the left side failed", async () => {
        expect(await stdoutOf("false && echo nope")).toBe("");
        expect(await statusOf("false && echo nope")).toBe(1);
      });

      it("charges a command only for a right-hand side that actually runs", async () => {
        // `false && …` skips its right-hand side, so the whole script costs one charge and
        // completes under a ceiling of 1; `true && …` runs both, and the second charge
        // trips the same ceiling — direct evidence the skipped side never ran.
        expect(await statusOf("false && echo nope", { limits: { maxCommandCount: 1 } })).toBe(1);
        const ran = await failure("true && echo yes", { limits: { maxCommandCount: 1 } });
        expect(ran).toBeInstanceOf(ExecutionLimitError);
        expect((ran as ExecutionLimitError).kind).toBe("commands");
      });
    });

    describe("exit", () => {
      it("stops the script and keeps the status it was given", async () => {
        const result = await evaluate("exit 3; echo after");
        expect(result.stdout).toBe("");
        expect(result.exitCode).toBe(3);
        expect(await statusOf("exit 3")).toBe(3);
        expect(await statusOf("exit 0")).toBe(0);
        // No argument adopts the last command's status.
        expect(await statusOf("false; exit")).toBe(1);
        expect(await statusOf("true; exit")).toBe(0);
        // The status is not booleanized: `exit 1` and `exit 3` stay distinct, as in a real
        // shell, so a caller branching on the code can tell a usage error from a failure.
        expect(await statusOf("exit 127")).toBe(127);
        // Out-of-range statuses truncate to the low 8 bits, the way POSIX reports them.
        expect(await statusOf("exit 257")).toBe(1);
        expect(await statusOf("exit -1")).toBe(255);
      });
    });

    describe("builtins", () => {
      const STATUSES: ReadonlyArray<[string, number]> = [
        ["true", 0],
        ["false", 1],
        [":", 0],
        ["colon", 0],
        ["set -e", 0],
        ["set -u -o pipefail", 0],
        ["shift", 0],
        ["shift 0", 0],
        ["sleep 0", 0],
        ["exit 0", 0],
        ["return 0", 0],
        ["test", 1],
        ["test -n hi", 0],
        ["test 1 -eq 1", 0],
        ["test 1 -ne 2", 0],
        ["test 1 -lt 2", 0],
        ["test 1 -gt 0", 0],
        ["test 1 -le 1", 0],
        ["test 1 -ge 1", 0],
        ["test abc = abc", 0],
        ["[ -n hi ]", 0],
        ["[ -n hi", 2],
        ["test bad op x", 2],
      ];

      it.each(STATUSES)("gives %s the status %d", async (script, status) => {
        expect(await statusOf(script)).toBe(status);
      });

      it("answers an empty operand reached through an expansion", async () => {
        // The empty string comes from an expansion rather than a `""` literal, which
        // the lexer rejects as an "empty word" — see the findings for that defect.
        const empty = { env: { X: "" } };
        expect(await statusOf('test -z "$X"', empty)).toBe(0);
        expect(await statusOf('test -n "$X"', empty)).toBe(1);
        expect(await stdoutOf("echo [$X]", empty)).toBe("[]\n");
      });

      it("cannot reach the != string operator", () => {
        // CURRENT-BEHAVIOUR / DEFECT: the lexer matches `!` as the BANG operator
        // before reading the `=`, so `!=` never survives as one word. BANG is a
        // command separator, so the `=` after it lands in command position and the
        // classifier escalates — the not-equal branch runTest:704 implements is
        // unreachable for want of a `!=` operator in the lexer's table.
        const verdict = classifyScript("test abc != def");
        expect(verdict.inMemorySafe).toBe(false);
        if (!verdict.inMemorySafe) {
          expect(verdict.reason).toBe("external_command");
          expect(verdict.at?.value).toBe("=");
        }
      });

      it("echoes and printfs to stdout", async () => {
        expect(await stdoutOf("echo hello world")).toBe("hello world\n");
        // CURRENT-BEHAVIOUR / DEFECT: `echo -n` suppresses the trailing newline but
        // does not consume the flag, so `-n` is printed as text (shell-evaluator.ts:
        // 566-568). POSIX prints `hi`.
        expect(await stdoutOf("echo -n hi")).toBe("-n hi");
        expect(await stdoutOf("printf one two")).toBe("one two");
      });

      it("reports the virtual working directory", async () => {
        expect(await stdoutOf("pwd")).toBe("/\n");
        expect(await stdoutOf("pwd", { cwd: "/start" })).toBe("/start\n");
        expect(await stdoutOf("cd /work; pwd")).toBe("/work\n");
        expect(await stdoutOf("cd work; pwd", { cwd: "/start" })).toBe("/start/work\n");
        // A cd sets PWD for the rest of the script.
        expect(await stdoutOf("cd /work; echo $PWD")).toBe("/work\n");
      });

      it("exports and unsets the environment", async () => {
        expect(await stdoutOf("export VAR=v; echo $VAR")).toBe("v\n");
        expect(await stdoutOf("VAR=v; export VAR; echo $VAR")).toBe("v\n");
        expect(await stdoutOf("VAR=v; unset VAR; echo [$VAR]")).toBe("[]\n");
        // `export` with no `=` is not an assignment.
        expect(await statusOf("export VAR")).toBe(0);
      });

      it("answers about builtins with type", async () => {
        expect(await stdoutOf("type echo")).toBe("echo is a shell builtin\n");
        expect(await stderrOf("type rm")).toBe("rm: not found\n");
        expect(await statusOf("type rm")).toBe(0);
      });

      it("lists the builtin set from help", async () => {
        const output = await stdoutOf("help");
        expect(output).toMatch(/^builtins: /);
        expect(output).toContain("echo");
        expect(output).toContain("pwd");
      });

      it("reports the job-control builtins as unavailable", async () => {
        for (const script of ["read x", "wait", "jobs", "kill 1"]) {
          expect(await statusOf(script)).toBe(1);
        }
        expect(await stderrOf("read x")).toBe("read: not available in the in-memory tier\n");
      });

      it("rejects a bad numeric argument instead of silently accepting it", async () => {
        expect(await stderrOf("shift abc")).toBe("shift: abc: numeric argument required\n");
        expect(await statusOf("shift abc")).toBe(1);
        expect(await stderrOf("sleep soon")).toBe("sleep: soon: numeric argument required\n");
        expect(await statusOf("sleep soon")).toBe(1);
      });

      it("requires the closing bracket for [", async () => {
        expect(await stderrOf("[ -n hi")).toBe("[: missing `]'\n");
        expect(await statusOf("[ -n hi")).toBe(2);
        expect(await statusOf("[ ] ]")).toBe(0);
      });
    });

    describe("the virtual filesystem", () => {
      const noFs = { stat: async () => undefined } as unknown as CowFsBackend;
      const dirOnly = {
        stat: async (path: string) =>
          path === "/dir" ? { isFile: false, isDirectory: true } : undefined,
      } as unknown as CowFsBackend;

      it("cd checks the virtual filesystem when one is present", async () => {
        expect(await statusOf("cd /nope", { fs: noFs })).toBe(1);
        expect(await stderrOf("cd /nope", { fs: noFs })).toBe(
          "cd: /nope: No such file or directory\n",
        );
        // A failed cd leaves the script where it was; the exit status is the last
        // command's, which is why the failing cd is tested on its own above.
        const result = await evaluate("cd /nope; pwd", { fs: noFs });
        expect(result.stdout).toBe("/\n");
        expect(result.exitCode).toBe(0);
        expect(await stdoutOf("cd /dir; pwd", { fs: dirOnly })).toBe("/dir\n");
      });

      it("test -d consults the virtual filesystem, not the host", async () => {
        expect(await statusOf("test -d /dir", { fs: dirOnly })).toBe(0);
        expect(await statusOf("test -e /dir", { fs: dirOnly })).toBe(0);
        expect(await statusOf("test -f /dir", { fs: dirOnly })).toBe(1);
        expect(await statusOf("test -d /nope", { fs: dirOnly })).toBe(1);
        // Without a filesystem the file tests answer "not present" rather than
        // asking the host kernel.
        expect(await statusOf("test -d /dir", { fs: noFs })).toBe(1);
      });
    });

    describe("happy path", () => {
      it("evaluates a safe command and reports the result", async () => {
        const result = await evaluate("echo hello; pwd", { cwd: "/tmp" });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\n/tmp\n");
        expect(result.stderr).toBe("");
        expect(result.commandCount).toBe(2);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.classification.inMemorySafe).toBe(true);
      });

      it("evaluates an empty script to a clean zero", async () => {
        const result = await evaluate("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.commandCount).toBe(0);
      });

      it("propagates a failing pipeline's status", async () => {
        expect(await statusOf("false")).toBe(1);
        expect(await statusOf("echo hi; false")).toBe(1);
        expect(await statusOf("echo hi; false; echo more")).toBe(0);
        // A failing stage aborts the rest of the pipeline: the stage after `false`
        // never runs, and the pipeline's status is the failing stage's.
        expect(await stdoutOf("false | echo hi")).toBe("");
        expect(await statusOf("false | echo hi")).toBe(1);
        // A stage before a failing one does run.
        expect(await stdoutOf("echo hi | false")).toBe("hi\n");
        expect(await statusOf("echo hi | false")).toBe(1);
      });
    });
  });
});
