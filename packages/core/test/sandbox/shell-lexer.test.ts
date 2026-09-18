import { describe, expect, it } from "vitest";

import {
  isReservedWord,
  isValidAssignmentLhs,
  ShellLexer,
  tokenizeShell,
  Token,
  TokenType,
} from "../../src/sandbox/shell-lexer.js";

describe("shell-lexer", () => {
  describe("operators", () => {
    it("emits one token per operator, longest first", () => {
      const tokens = tokenizeShell("a && b || c |& d");
      const types = tokens.map((t) => t.type);
      expect(types).toEqual([
        TokenType.NAME,
        TokenType.AND_AND,
        TokenType.NAME,
        TokenType.OR_OR,
        TokenType.NAME,
        TokenType.PIPE_AMP,
        TokenType.NAME,
      ]);
    });

    it("tokenizes the redirection operators distinctly", () => {
      const types = tokenizeShell("> >> < << >& <& <> >| <<< &> &>>").map((t) => t.type);
      expect(types).toEqual([
        TokenType.GREAT,
        TokenType.DGREAT,
        TokenType.LESS,
        TokenType.DLESS,
        TokenType.GREATAND,
        TokenType.LESSAND,
        TokenType.LESSGREAT,
        TokenType.CLOBBER,
        TokenType.TLESS,
        TokenType.AND_GREAT,
        TokenType.AND_DGREAT,
      ]);
    });

    it("tokenizes compound-command operators", () => {
      const types = tokenizeShell(";; ;& ;;& ( ) { } !").map((t) => t.type);
      expect(types).toEqual([
        TokenType.DSEMI,
        TokenType.SEMI_AND,
        TokenType.SEMI_SEMI_AND,
        TokenType.LPAREN,
        TokenType.RPAREN,
        TokenType.LBRACE,
        TokenType.RBRACE,
        TokenType.BANG,
      ]);
    });

    it("does not read the second character of a lone & as part of a longer operator", () => {
      const types = tokenizeShell("sleep 5 & echo done").map((t) => t.type);
      expect(types).toEqual([
        TokenType.NAME,
        TokenType.WORD,
        TokenType.AMP,
        TokenType.NAME,
        TokenType.NAME,
      ]);
    });

    it("classifies a bare number as NUMBER only when a redirection follows", () => {
      expect(tokenizeShell("2>file")[0]?.type).toBe(TokenType.NUMBER);
      expect(tokenizeShell("echo 5")[1]?.type).toBe(TokenType.WORD);
    });
  });

  describe("reserved words and names", () => {
    it("recognizes every reserved word", () => {
      const words = [
        "if",
        "then",
        "elif",
        "else",
        "fi",
        "for",
        "while",
        "until",
        "do",
        "done",
        "case",
        "esac",
        "in",
        "function",
        "select",
        "time",
        "coproc",
      ];
      for (const word of words) {
        expect(isReservedWord(word)).toBe(true);
        expect(tokenizeShell(word)[0]?.type).not.toBe(TokenType.WORD);
      }
    });

    it("does not treat prototype-inherited keys as reserved", () => {
      // A plain object lookup would have answered these with inherited properties.
      expect(isReservedWord("constructor")).toBe(false);
      expect(isReservedWord("__proto__")).toBe(false);
      expect(isReservedWord("toString")).toBe(false);
    });

    it("classifies a bare identifier as NAME", () => {
      const token = tokenizeShell("variable")[0]!;
      expect(token.type).toBe(TokenType.NAME);
      expect(token.value).toBe("variable");
    });

    it("classifies a word with a dash as WORD, not NAME", () => {
      expect(tokenizeShell("my-command")[0]?.type).toBe(TokenType.WORD);
    });
  });

  describe("assignment words", () => {
    it("recognizes a simple assignment", () => {
      const token = tokenizeShell("FOO=bar")[0]!;
      expect(token.type).toBe(TokenType.ASSIGNMENT_WORD);
      expect(token.value).toBe("FOO=bar");
    });

    it("recognizes an append assignment", () => {
      expect(tokenizeShell("FOO+=bar")[0]?.type).toBe(TokenType.ASSIGNMENT_WORD);
    });

    it("recognizes array-subscript left-hand sides", () => {
      expect(isValidAssignmentLhs("a[0]")).toBe(true);
      expect(isValidAssignmentLhs("a[x+1]")).toBe(true);
      expect(isValidAssignmentLhs("a[a[0]]")).toBe(true);
    });

    it("rejects an unbalanced subscript", () => {
      expect(isValidAssignmentLhs("a[1=")).toBe(false);
      expect(isValidAssignmentLhs("not-a-name=ok")).toBe(false);
      expect(isValidAssignmentLhs("1abc=x")).toBe(false);
    });
  });

  describe("quoting", () => {
    it("records that a single-quoted word was quoted", () => {
      const token = tokenizeShell("'hello world'")[0]!;
      expect(token.type).toBe(TokenType.WORD);
      expect(token.value).toBe("hello world");
      expect(token.quoted).toBe(true);
      expect(token.singleQuoted).toBe(true);
    });

    it("records that a double-quoted word was quoted but not single-quoted", () => {
      const token = tokenizeShell('"hello world"')[0]!;
      expect(token.value).toBe("hello world");
      expect(token.quoted).toBe(true);
      expect(token.singleQuoted).toBe(false);
    });

    it("preserves a literal backslash-pair inside double quotes", () => {
      // `\\` inside double quotes collapses to `\`; `\n` stays as `\n` (backslash not
      // special before `n` inside double quotes, so both characters are kept).
      const token = tokenizeShell('"a\\nb\\\\"')[0]!;
      expect(token.value).toBe("a\\nb\\");
    });

    it("removes a backslash before any character outside quotes", () => {
      // `\;` is a *literal* semicolon, not a command separator: the backslash
      // removes the character's special meaning, so the result is one word whose
      // value is `;` — the same word `echo \;` prints in bash.
      const token = tokenizeShell("\\;")[0]!;
      expect(token.type).toBe(TokenType.WORD);
      expect(token.value).toBe(";");
    });

    it("allows a single quote inside a double-quoted word", () => {
      const token = tokenizeShell('"it\'s"')[0]!;
      expect(token.value).toBe("it's");
    });

    it("allows a double quote inside a single-quoted word", () => {
      const token = tokenizeShell("'say \"hi\"'")[0]!;
      expect(token.value).toBe('say "hi"');
    });

    it("throws on an unterminated single quote", () => {
      expect(() => tokenizeShell("echo 'unterminated")).toThrow(
        /unexpected EOF while looking for matching/,
      );
    });

    it("throws on an unterminated double quote", () => {
      expect(() => tokenizeShell('echo "unterminated')).toThrow(/matching `"/);
    });
  });

  describe("comments and whitespace", () => {
    it("drops comments and newlines from the tokenized stream", () => {
      const tokens = tokenizeShell("a # this is a comment\nb");
      expect(tokens.map((t) => t.value)).toEqual(["a", "b"]);
    });

    it("treats # as a word character when not at a word start", () => {
      const token = tokenizeShell("a#b")[0]!;
      expect(token.value).toBe("a#b");
    });
  });

  describe("positions", () => {
    it("records byte offsets and line/column numbers", () => {
      const lexer = new ShellLexer("ab\ncd");
      const tokens = lexer.tokenize().filter((t) => t.type !== TokenType.EOF);
      const first = tokens[0]!;
      expect(first.start).toBe(0);
      expect(first.end).toBe(2);
      expect(first.line).toBe(1);

      const second = tokens.find((t) => t.value === "cd")!;
      expect(second.start).toBe(3);
      expect(second.line).toBe(2);
    });
  });

  describe("fd variables", () => {
    it("recognizes a {name} fd variable before a redirection", () => {
      const tokens = tokenizeShell("{fd}>out")[0];
      expect(tokens?.type).toBe(TokenType.FD_VARIABLE);
      expect(tokens?.value).toBe("{fd}");
    });

    it("does not treat a brace group as an fd variable", () => {
      const types = tokenizeShell("{ echo hi; }").map((t) => t.type);
      expect(types).toContain(TokenType.LBRACE);
      expect(types).not.toContain(TokenType.FD_VARIABLE);
    });
  });

  describe("here-documents", () => {
    it("reads a here-document body up to its delimiter", () => {
      const lexer = new ShellLexer("cat <<EOF\nhello\nworld\nEOF\n");
      // Skip past the operator so readHeredoc is exercised on its own.
      lexer.tokenize();
      const second = new ShellLexer("hello\nworld\nEOF\n");
      const body = second.readHeredoc("EOF", false);
      expect(body.type).toBe(TokenType.HEREDOC_CONTENT);
      expect(body.value).toBe("hello\nworld\n");
      expect(body.heredocTerminated).toBe(true);
    });

    it("strips leading tabs with the <<- form", () => {
      const lexer = new ShellLexer("\thello\n\tEOF\n");
      const body = lexer.readHeredoc("EOF", true);
      expect(body.value).toBe("hello\n");
      expect(body.heredocTerminated).toBe(true);
    });

    it("records an unterminated here-document", () => {
      const lexer = new ShellLexer("no terminator here\n");
      const body = lexer.readHeredoc("MISSING", false);
      expect(body.heredocTerminated).toBe(false);
    });

    it("refuses a here-document larger than the configured maximum", () => {
      const lexer = new ShellLexer(`${"x".repeat(100)}\n`, { maxHeredocSize: 10 });
      expect(() => lexer.readHeredoc("EOF", false)).toThrow(/exceeded 10 bytes/);
    });
  });

  describe("token stream shape", () => {
    it("ends every token stream with EOF", () => {
      const tokens = new ShellLexer("hello").tokenize();
      const last = tokens[tokens.length - 1] as Token;
      expect(last.type).toBe(TokenType.EOF);
    });

    it("tokenizes an empty script to EOF alone", () => {
      expect(tokenizeShell("")).toEqual([]);
    });
  });
});
