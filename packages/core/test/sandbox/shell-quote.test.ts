import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { tokenizeShell } from "../../src/sandbox/shell-lexer.js";
import {
  requiresShellQuoting,
  shellJoinArgs,
  shellQuoteArg,
} from "../../src/sandbox/shell-quote.js";

/** Locate a real shell once; `null` when the runner has none. */
const bash: string | null = (() => {
  try {
    const probe = spawnSync("bash", ["--version"], { encoding: "utf-8" });
    return probe.error === undefined && probe.status === 0 ? "bash" : null;
  } catch {
    return null;
  }
})();

/**
 * Payloads that mean something to a POSIX shell. Every one is a word-split, glob,
 * expansion or command-substitution hazard if it reaches a command line unquoted; the
 * battery below proves quoting neutralizes all of them. None of them consists solely
 * of `requiresShellQuoting`'s safe characters — that is asserted separately.
 */
const HOSTILE_PAYLOADS: readonly string[] = [
  "; rm -rf /",
  "x; whoami; echo '",
  "&& echo pwned",
  "| cat /etc/passwd",
  "|| true",
  "`id`",
  "$(id)",
  "$(rm -rf /)",
  "$(printf %s x)",
  "${IFS}",
  "${x:-y}",
  "$HOME",
  "$?",
  '"$(whoami)"',
  "it's a trap",
  "'",
  "''",
  "'''",
  "a'b'c",
  "a\\'b",
  "*.txt",
  "??",
  "[a-z]",
  "~root",
  "#comment",
  "a b  c",
  "a\tb",
  "a\nb",
  "\\",
  '"\\',
  "!history",
  "2>file",
  "a>b",
  "café",
  "`",
  "$",
];

/**
 * Values made only of characters a POSIX shell treats as ordinary word characters —
 * the set `requiresShellQuoting` admits. These still get quoted by `shellQuoteArg`,
 * which is the point: the predicate is a diagnostic, not the security decision.
 */
const SAFE_PAYLOADS: readonly string[] = [
  "ls",
  "my-command",
  "my_command2",
  "/usr/local/bin/tool",
  "a@b.com",
  "100%",
  "a+b:c=d,e/f-g",
  "-rf",
  "--option=value",
  "FOO=bar",
  "1.2.3",
];

describe("shell-quote", () => {
  describe("shellQuoteArg", () => {
    it("wraps a plain word in single quotes", () => {
      expect(shellQuoteArg("hello")).toBe("'hello'");
    });

    it("quotes an empty string rather than emitting a bare empty word", () => {
      // An unquoted empty word disappears in a shell; `''` is the one way to pass one.
      expect(shellQuoteArg("")).toBe("''");
    });

    it("quotes a value that needs no quoting — there is no safe fast path", () => {
      for (const value of SAFE_PAYLOADS) {
        expect(shellQuoteArg(value)).toBe(`'${value}'`);
      }
    });

    it("escapes an embedded single quote as `'\\''`", () => {
      expect(shellQuoteArg("it's")).toBe("'it'\\''s'");
    });

    it("escapes a payload that is only single quotes", () => {
      expect(shellQuoteArg("'")).toBe("''\\'''");
      // Each payload quote becomes `'\''` between the wrappers, so two of them
      // run the escapes back to back: `''` + `'\''` + `'\''` + `'`.
      expect(shellQuoteArg("''")).toBe("''\\'''\\'''");
    });

    it("escapes every embedded single quote, however many there are", () => {
      expect(shellQuoteArg("a'b'c")).toBe("'a'\\''b'\\''c'");
      // n payload quotes -> 3n + 2 quotes in the output (2 wrappers + 3 per escape).
      for (let n = 0; n < 6; n++) {
        const payload = "'".repeat(n);
        const output = shellQuoteArg(payload);
        const quotes = [...output.match(/'/gu)!].length;
        expect(quotes).toBe(3 * n + 2);
      }
    });

    it("leaves every other shell metacharacter untouched inside the single quotes", () => {
      // Single quotes are the one shell context with no escape processing at all, so
      // backslash, backticks, `$`, double quotes and whitespace all pass through raw —
      // none of them can mean anything between the wrappers.
      const payload = '$HOME `whoami` "q" \\ ; & | * ? < > # ! ~ \n\t';
      expect(shellQuoteArg(payload)).toBe(`'${payload}'`);
    });

    it("passes arbitrary text through byte for byte apart from the quote escaping", () => {
      const payload = "héllo—世界 $({}[])";
      expect(shellQuoteArg(payload)).toBe(`'${payload}'`);
    });

    it("produces output that starts and ends with a single quote", () => {
      for (const payload of HOSTILE_PAYLOADS) {
        const output = shellQuoteArg(payload);
        expect(output.startsWith("'")).toBe(true);
        expect(output.endsWith("'")).toBe(true);
      }
    });

    it("round-trips through a POSIX lexer: the output re-parses as one literal word", () => {
      // The round trip is the claim: quote the payload, hand the result to an
      // independent POSIX word parser, and require exactly one word back whose value
      // is the original payload. A breakout would surface as extra words, operators,
      // or a mangled value.
      for (const payload of HOSTILE_PAYLOADS) {
        const tokens = tokenizeShell(shellQuoteArg(payload));
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.value).toBe(payload);
        expect(tokens[0]!.quoted).toBe(true);
        expect(tokens[0]!.singleQuoted).toBe(true);
      }
    });

    it("round-trips a safe value, and quotes it even though it needs no quoting", () => {
      for (const payload of SAFE_PAYLOADS) {
        const tokens = tokenizeShell(shellQuoteArg(payload));
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.value).toBe(payload);
        expect(tokens[0]!.singleQuoted).toBe(true);
      }
    });

    it("defeats injection: an embedded quote cannot terminate the literal", () => {
      // `foo'bar $(id)` is the classic attempt to close the quoted string and resume
      // writing syntax. After quoting it re-parses to one word, `foo'bar $(id)`.
      const tokens = tokenizeShell(shellQuoteArg("foo'bar $(id)"));
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.value).toBe("foo'bar $(id)");
    });

    it("lets no payload place a quote outside a balanced `'\\''` escape", () => {
      // Strip the two wrappers and undo the escape: what remains must be the payload.
      // If a payload could smuggle in an unpaired quote, this would not be invertible.
      for (const payload of [...HOSTILE_PAYLOADS, ...SAFE_PAYLOADS]) {
        const output = shellQuoteArg(payload);
        const restored = output.slice(1, -1).split("'\\''").join("'");
        expect(restored).toBe(payload);
        expect(output.slice(1, -1).split("'\\''")).toHaveLength(payload.split("'").length);
      }
    });
  });

  describe("the lexer oracle is discriminating", () => {
    // A round-trip test is only meaningful if the parser it uses would have split an
    // *unquoted* metacharacter payload. These cases prove the oracle is not a rubber
    // stamp — the same payloads, unquoted, do not come back as one word.
    it("splits an unquoted payload on metacharacters", () => {
      expect(tokenizeShell("a b c")).toHaveLength(3);
      expect(tokenizeShell("a;b")).toHaveLength(3);
      expect(tokenizeShell("a && b")).toHaveLength(3);
      expect(tokenizeShell("a>b")).toHaveLength(3);
    });

    it("reads an unquoted command substitution as syntax, not one word", () => {
      // `(` and `)` terminate words, so an unquoted `$(id)` splits into the words
      // `$` and `id` separated by the paren operators — exactly the fate quoting
      // exists to prevent.
      expect(tokenizeShell("$(id)").map((t) => t.value)).toEqual(["$", "(", "id", ")"]);
      expect(tokenizeShell("a b")).toHaveLength(2);
    });
  });

  describe("shellJoinArgs", () => {
    it("emits an empty string for an empty list", () => {
      expect(shellJoinArgs([])).toBe("");
    });

    it("quotes a single element", () => {
      expect(shellJoinArgs(["hello world"])).toBe("'hello world'");
    });

    it("quotes every element and joins with a single space", () => {
      expect(shellJoinArgs(["a", "b c", "d'e"])).toBe("'a' 'b c' 'd'\\''e'");
    });

    it("accepts a readonly argv", () => {
      const args = ["alpha", "beta gamma"] as const;
      expect(shellJoinArgs(args)).toBe("'alpha' 'beta gamma'");
    });

    it("round-trips a list of hostile arguments through a POSIX lexer", () => {
      const args = ["safe", "; rm -rf /", "$(id)", "a'b", "*.txt", "a\\'b", "  "];
      const tokens = tokenizeShell(shellJoinArgs(args));
      expect(tokens.map((t) => t.value)).toEqual(args);
      for (const token of tokens) {
        expect(token.singleQuoted).toBe(true);
      }
    });

    it("cannot be made to synthesize an extra argument", () => {
      // No element can break out of its own word and inject a new one.
      const args = ["one", "two'; touch /tmp/pwned; echo '"];
      const tokens = tokenizeShell(shellJoinArgs(args));
      expect(tokens).toHaveLength(2);
      expect(tokens[1]!.value).toBe(args[1]!);
    });

    it("quotes elements that need no quoting, so the join stays unambiguous", () => {
      // Quoting only dangerous-looking elements would let a caller-supplied
      // `--output=file` or `FOO=bar` element change shape once joined and re-parsed.
      const joined = shellJoinArgs(["-rf", "/tmp", "FOO=bar"]);
      expect(tokenizeShell(joined).map((t) => t.value)).toEqual(["-rf", "/tmp", "FOO=bar"]);
    });
  });

  describe("requiresShellQuoting", () => {
    it("is false for a plain identifier", () => {
      expect(requiresShellQuoting("hello")).toBe(false);
      expect(requiresShellQuoting("my_command2")).toBe(false);
    });

    it("is false for the characters the safe set admits", () => {
      // Letters, digits, underscore, and `@ % + = : , . / -` are the characters a
      // POSIX shell treats as ordinary word characters in every context.
      for (const value of SAFE_PAYLOADS) {
        expect(requiresShellQuoting(value)).toBe(false);
      }
    });

    it("is true for whitespace and word-splitting characters", () => {
      expect(requiresShellQuoting("hello world")).toBe(true);
      expect(requiresShellQuoting("a\tb")).toBe(true);
      expect(requiresShellQuoting("a\nb")).toBe(true);
    });

    it("is true for every other shell metacharacter", () => {
      for (const value of [
        "$HOME",
        "`id`",
        "$(id)",
        "a;b",
        "a&&b",
        "a|b",
        "a&b",
        "*.txt",
        "?.txt",
        "[a-z]",
        "~root",
        "a>b",
        "a<b",
        "a>>b",
        "#comment",
        "!bang",
        "a(b",
        "a{b",
        'a"b',
        "a'b",
        "a\\b",
      ]) {
        expect(requiresShellQuoting(value)).toBe(true);
      }
    });

    it("flags every payload in the hostile battery", () => {
      // The predicate is a diagnostic, not the security decision — but it must agree
      // with the battery about which values are dangerous.
      for (const payload of HOSTILE_PAYLOADS) {
        expect(requiresShellQuoting(payload)).toBe(true);
      }
    });

    it("is true for a non-ASCII character, since \\w is ASCII-only", () => {
      expect(requiresShellQuoting("café")).toBe(true);
      expect(requiresShellQuoting("日本語")).toBe(true);
      expect(requiresShellQuoting("a—b")).toBe(true);
    });

    it("is false for an empty string, which still needs quoting to survive", () => {
      // There is no character for the negated character class to match, so the answer
      // is "needs no quoting" — yet `''` is exactly what an empty argv element
      // requires. This is why `shellQuoteArg` is used regardless of the predicate.
      expect(requiresShellQuoting("")).toBe(false);
      expect(shellQuoteArg("")).toBe("''");
    });

    it("is stateless across repeated calls on the same value", () => {
      // A global-flagged pattern would advance `lastIndex` and flip answers between
      // calls; the predicate must be repeatable.
      for (const value of ["hello", "a b", "$(id)", "safe-path"]) {
        const first = requiresShellQuoting(value);
        expect(requiresShellQuoting(value)).toBe(first);
        expect(requiresShellQuoting(value)).toBe(first);
      }
    });
  });
});

/**
 * The strongest available evidence that quoting defeats injection: hand the quoted
 * output to a real bash and let it split the command line into words. If any payload
 * escaped its quotes, the word list would not come back identical. Skipped on runners
 * with no shell on PATH.
 */
describe.skipIf(bash === null)("shell-quote against a real POSIX shell", () => {
  const shell = bash as string;

  /** Have a real shell split `line` into words the way it would before executing it. */
  const splitWithRealShell = (line: string): string[] => {
    const result = spawnSync(shell, ["-c", `printf '%s\\0' ${line}`], {
      encoding: "utf-8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return result.stdout.split("\x00").slice(0, -1);
  };

  it("round-trips every hostile payload through a real bash", () => {
    for (const payload of HOSTILE_PAYLOADS) {
      expect(splitWithRealShell(shellQuoteArg(payload))).toEqual([payload]);
    }
  });

  it("round-trips a joined argv, including empty words, through a real bash", () => {
    const args = ["safe", "; rm -rf /", "$(id)", "a'b", "  ", "", "*.txt", ""];
    expect(splitWithRealShell(shellJoinArgs(args))).toEqual(args);
  });

  it("would have split the same payloads unquoted", () => {
    // Negative control: the harness is not passing because the shell is unopinionated.
    expect(splitWithRealShell("a b c")).toEqual(["a", "b", "c"]);
    expect(splitWithRealShell("$(echo hi)")).toEqual(["hi"]);
  });
});
