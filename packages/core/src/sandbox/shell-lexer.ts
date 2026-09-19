/**
 * Shell lexer — the tokenizer for the in-memory shell evaluator.
 *
 * Ported from the donor in-memory bash implementation's parser layer: the token
 * vocabulary, the reserved-word table, the quote-state machine, the
 * assignment-word and redirection-number recognition, and the heredoc size bound
 * all come across. What is deliberately absent is the donor's full POSIX grammar
 * (here-document bodies, arithmetic `((`/`[[` internal parsers, process
 * substitution): the escalation model in `isolated-execution-runtime.ts` uses the
 * lexer to *classify* a script and to feed a reduced evaluator, and any construct
 * the evaluator cannot run safely is reported as `unsupported` so the runtime
 * escalates to a hardware-isolated sandbox instead of approximating it.
 *
 * Security-relevant details carried over verbatim:
 * - the reserved-word table is a `Map`, never a plain object, because reserved
 *   words are looked up with untrusted text and a plain object's `constructor` /
 *   `__proto__` keys would have been reachable from script content;
 * - every token records its source span, so a denial or an error message can name
 *   the exact bytes that caused it instead of a whole script;
 * - quote state is recorded per word, because an evaluator that expands an
 *   unquoted word and a quoted word identically is one `rm *` away from a
 *   filesystem incident.
 */

/** Default maximum heredoc size to prevent memory exhaustion (10 MiB). */
const DEFAULT_MAX_HEREDOC_SIZE = 10_485_760;

export interface LexerOptions {
  /** Maximum here-document size in bytes (default: 10 MiB). */
  maxHeredocSize?: number;
}

export enum TokenType {
  EOF = "EOF",
  NEWLINE = "NEWLINE",
  SEMICOLON = "SEMICOLON",
  AMP = "AMP",
  PIPE = "PIPE",
  PIPE_AMP = "PIPE_AMP",
  AND_AND = "AND_AND",
  OR_OR = "OR_OR",
  BANG = "BANG",
  LESS = "LESS",
  GREAT = "GREAT",
  DLESS = "DLESS",
  DGREAT = "DGREAT",
  LESSAND = "LESSAND",
  GREATAND = "GREATAND",
  LESSGREAT = "LESSGREAT",
  DLESSDASH = "DLESSDASH",
  CLOBBER = "CLOBBER",
  TLESS = "TLESS",
  AND_GREAT = "AND_GREAT",
  AND_DGREAT = "AND_DGREAT",
  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  LBRACE = "LBRACE",
  RBRACE = "RBRACE",
  DSEMI = "DSEMI",
  SEMI_AND = "SEMI_AND",
  SEMI_SEMI_AND = "SEMI_SEMI_AND",
  DBRACK_START = "DBRACK_START",
  DBRACK_END = "DBRACK_END",
  DPAREN_START = "DPAREN_START",
  DPAREN_END = "DPAREN_END",
  IF = "IF",
  THEN = "THEN",
  ELSE = "ELSE",
  ELIF = "ELIF",
  FI = "FI",
  FOR = "FOR",
  WHILE = "WHILE",
  UNTIL = "UNTIL",
  DO = "DO",
  DONE = "DONE",
  CASE = "CASE",
  ESAC = "ESAC",
  IN = "IN",
  FUNCTION = "FUNCTION",
  SELECT = "SELECT",
  TIME = "TIME",
  COPROC = "COPROC",
  WORD = "WORD",
  NAME = "NAME",
  NUMBER = "NUMBER",
  ASSIGNMENT_WORD = "ASSIGNMENT_WORD",
  FD_VARIABLE = "FD_VARIABLE",
  COMMENT = "COMMENT",
  HEREDOC_CONTENT = "HEREDOC_CONTENT",
}

export interface Token {
  type: TokenType;
  value: string;
  /** Original byte offset in the source. */
  start: number;
  end: number;
  line: number;
  column: number;
  /** True when any part of the word was quoted. */
  quoted?: boolean;
  singleQuoted?: boolean;
  /** Quote-removed value for a here-document delimiter token. */
  heredocDelimiter?: string;
  /** Whether a here-document content token ended at its delimiter. */
  heredocTerminated?: boolean;
}

/** Error thrown when the lexer encounters input it cannot tokenize. */
export class LexerError extends Error {
  constructor(
    message: string,
    public line: number,
    public column: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "LexerError";
  }
}

/**
 * Reserved words. A `Map` rather than a plain object on purpose: the lookup key is
 * untrusted script text, and a plain object would have answered `constructor` and
 * `__proto__` with inherited properties instead of "not reserved".
 */
const RESERVED_WORDS = new Map<string, TokenType>([
  ["if", TokenType.IF],
  ["then", TokenType.THEN],
  ["else", TokenType.ELSE],
  ["elif", TokenType.ELIF],
  ["fi", TokenType.FI],
  ["for", TokenType.FOR],
  ["while", TokenType.WHILE],
  ["until", TokenType.UNTIL],
  ["do", TokenType.DO],
  ["done", TokenType.DONE],
  ["case", TokenType.CASE],
  ["esac", TokenType.ESAC],
  ["in", TokenType.IN],
  ["function", TokenType.FUNCTION],
  ["select", TokenType.SELECT],
  ["time", TokenType.TIME],
  ["coproc", TokenType.COPROC],
]);

const RESERVED_WORD_TOKEN_TYPES = new Set(RESERVED_WORDS.values());

export function isReservedWordToken(type: TokenType): boolean {
  return RESERVED_WORD_TOKEN_TYPES.has(type);
}

export function isReservedWord(word: string): boolean {
  return RESERVED_WORDS.has(word);
}

/** A valid shell variable name: letter or underscore first, then word characters. */
const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Valid assignment left-hand side with an optional nested array subscript:
 * `VAR`, `VAR+`, `a[0]`, `a[x]`, `a[a[0]]`, `a[x+1]`. Balanced brackets are
 * required, which is what keeps an unbalanced `a[1=` from being classified as an
 * assignment (it is a plain word, and the evaluator reports it as a bad command
 * name rather than binding anything).
 */
export function isValidAssignmentLhs(str: string): boolean {
  const match = str.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!match) return false;

  // match[0] is a length, not an index: slice() would coerce the string to NaN and
  // slice from 0, which makes every LHS look like it had no name at all.
  const afterName = str.slice(match[0]!.length);
  if (afterName === "" || afterName === "+") return true;

  if (!afterName.startsWith("[")) return false;

  let depth = 0;
  for (const char of afterName) {
    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Characters that end a word when unquoted. */
function isWordTerminator(char: string): boolean {
  switch (char) {
    case " ":
    case "\t":
    case "\n":
    case ";":
    case "&":
    case "|":
    case "<":
    case ">":
    case "(":
    case ")":
      return true;
    default:
      return false;
  }
}

/**
 * Multi-character operators, longest first so the lexer never reads the second `&`
 * of `&&` as a standalone background operator.
 */
const OPERATORS: ReadonlyArray<readonly [string, TokenType]> = [
  [";;&", TokenType.SEMI_SEMI_AND],
  ["<<-", TokenType.DLESSDASH],
  ["<<<", TokenType.TLESS],
  ["&>>", TokenType.AND_DGREAT],
  ["&&", TokenType.AND_AND],
  ["||", TokenType.OR_OR],
  ["|&", TokenType.PIPE_AMP],
  [";;", TokenType.DSEMI],
  [";&", TokenType.SEMI_AND],
  [">>", TokenType.DGREAT],
  ["<<", TokenType.DLESS],
  ["<&", TokenType.LESSAND],
  [">&", TokenType.GREATAND],
  ["<>", TokenType.LESSGREAT],
  [">|", TokenType.CLOBBER],
  ["&>", TokenType.AND_GREAT],
  ["[[", TokenType.DBRACK_START],
  ["]]", TokenType.DBRACK_END],
  ["((", TokenType.DPAREN_START],
  ["))", TokenType.DPAREN_END],
  [";", TokenType.SEMICOLON],
  ["&", TokenType.AMP],
  ["|", TokenType.PIPE],
  ["<", TokenType.LESS],
  [">", TokenType.GREAT],
  ["(", TokenType.LPAREN],
  [")", TokenType.RPAREN],
  ["!", TokenType.BANG],
];

/**
 * The lexer itself. Stateless across scripts — one instance per `tokenize()` call —
 * so a failing tokenization cannot leak quote state into the next script.
 */
export class ShellLexer {
  private readonly source: string;
  private position = 0;
  private line = 1;
  private column = 1;
  private readonly maxHeredocSize: number;

  constructor(source: string, options?: LexerOptions) {
    this.source = source;
    this.maxHeredocSize = options?.maxHeredocSize ?? DEFAULT_MAX_HEREDOC_SIZE;
  }

  /** Tokenize the whole script into a flat token list, ending with `EOF`. */
  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.nextToken();
      tokens.push(token);
      if (token.type === TokenType.EOF) return tokens;
    }
  }

  private peek(offset = 0): string {
    return this.source[this.position + offset] ?? "";
  }

  private advance(): string {
    const char = this.source[this.position++] ?? "";
    if (char === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return char;
  }

  private atEnd(): boolean {
    return this.position >= this.source.length;
  }

  private makeToken(
    type: TokenType,
    value: string,
    start: number,
    startLine: number,
    startColumn: number,
  ): Token {
    return {
      type,
      value,
      start,
      end: this.position,
      line: startLine,
      column: startColumn,
    };
  }

  private matchOperator(): Token | null {
    for (const [literal, type] of OPERATORS) {
      if (this.source.startsWith(literal, this.position)) {
        const start = this.position;
        const startLine = this.line;
        const startColumn = this.column;
        for (let i = 0; i < literal.length; i++) this.advance();
        return this.makeToken(type, literal, start, startLine, startColumn);
      }
    }
    return null;
  }

  /**
   * Read a `{varname}` token that precedes a redirection operator (`{fd}> file`),
   * returning null when the braces do not enclose a valid name. Recognized so the
   * evaluator can allocate a real descriptor rather than silently writing to a
   * variable the script expected to be set.
   */
  private readFdVariable(): Token | null {
    if (this.peek() !== "{") return null;
    const start = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    let depth = 0;
    let name = "";
    let matched = false;
    while (!this.atEnd()) {
      const char = this.peek();
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          matched = true;
          this.advance();
          break;
        }
      } else if (char === "\n") {
        break;
      }
      if (char !== "{") name += char;
      this.advance();
    }
    if (!matched || !NAME_PATTERN.test(name)) return null;
    return this.makeToken(TokenType.FD_VARIABLE, `{${name}}`, start, startLine, startColumn);
  }

  /** Read a word, tracking quote state so the evaluator can tell `*` from `"*"`. */
  private readWord(): Token {
    const start = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    let value = "";
    let quoted = false;
    let singleQuoted = false;
    while (!this.atEnd()) {
      const char = this.peek();

      if (char === "'") {
        quoted = true;
        singleQuoted = true;
        this.advance();
        while (!this.atEnd() && this.peek() !== "'") {
          value += this.advance();
        }
        if (this.atEnd()) {
          throw new LexerError(
            "unexpected EOF while looking for matching `''",
            this.line,
            this.column,
          );
        }
        this.advance();
        continue;
      }

      if (char === '"') {
        quoted = true;
        this.advance();
        while (!this.atEnd() && this.peek() !== '"') {
          const inner = this.peek();
          if (inner === "\\") {
            this.advance();
            const escaped = this.advance();
            // Inside double quotes a backslash only escapes $ ` " \ and newline;
            // every other pair keeps both characters, which bash also does.
            if (
              escaped === "$" ||
              escaped === "`" ||
              escaped === '"' ||
              escaped === "\\" ||
              escaped === "\n"
            ) {
              value += escaped;
            } else {
              value += `\\${escaped}`;
            }
            continue;
          }
          value += this.advance();
        }
        if (this.atEnd()) {
          throw new LexerError(
            'unexpected EOF while looking for matching `"',
            this.line,
            this.column,
          );
        }
        this.advance();
        continue;
      }

      if (char === "\\") {
        quoted = true;
        this.advance();
        if (this.atEnd()) {
          throw new LexerError(
            "unexpected EOF while expecting escaped character",
            this.line,
            this.column,
          );
        }
        value += this.advance();
        continue;
      }

      if (isWordTerminator(char)) break;

      value += this.advance();
    }

    if (value === "") {
      throw new LexerError("empty word", this.line, this.column);
    }

    // A bare number followed by a redirection operator is the fd: `2>file`.
    if (!quoted && /^\d+$/.test(value) && this.isRedirectionAhead()) {
      return this.makeToken(TokenType.NUMBER, value, start, startLine, startColumn);
    }

    if (!quoted && isValidAssignmentLhs(value.split("=")[0] ?? "") && value.includes("=")) {
      const token = this.makeToken(TokenType.ASSIGNMENT_WORD, value, start, startLine, startColumn);
      token.quoted = quoted;
      token.singleQuoted = singleQuoted;
      return token;
    }

    if (!quoted && NAME_PATTERN.test(value)) {
      const token = this.makeToken(TokenType.NAME, value, start, startLine, startColumn);
      token.quoted = quoted;
      token.singleQuoted = singleQuoted;
      return token;
    }

    const token = this.makeToken(TokenType.WORD, value, start, startLine, startColumn);
    token.quoted = quoted;
    token.singleQuoted = singleQuoted;
    return token;
  }

  private looksLikeFdVariable(): boolean {
    let depth = 0;
    let offset = 0;
    while (this.position + offset < this.source.length) {
      const char = this.source[this.position + offset]!;
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          const after = this.source[this.position + offset + 1] ?? "";
          return after === "<" || after === ">";
        }
      } else if (char === "\n") {
        return false;
      }
      offset++;
    }
    return false;
  }

  private isRedirectionAhead(): boolean {
    const next = this.peek();
    return next === "<" || next === ">";
  }

  /**
   * Read a here-document body up to its terminating delimiter. The delimiter is
   * already quote-removed by the caller; the body is raw, because expansions inside
   * a here-document are the evaluator's business, not the lexer's. The size bound
   * is what stops a hostile `cat <<EOF` from allocating unbounded memory.
   */
  readHeredoc(delimiter: string, stripTabs: boolean): Token {
    const start = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    let body = "";
    let terminated = false;

    while (!this.atEnd()) {
      let lineContent = "";
      if (stripTabs) {
        while (this.peek() === "\t") this.advance();
      }
      while (!this.atEnd() && this.peek() !== "\n") {
        lineContent += this.advance();
      }
      // Consume the terminator as part of the line. Without this, an empty line
      // leaves the position on its own newline and the loop never advances.
      if (!this.atEnd()) {
        lineContent += "\n";
        this.advance();
      }

      if (lineContent.trimEnd() === delimiter) {
        terminated = true;
        break;
      }
      body += lineContent;
      if (body.length > this.maxHeredocSize) {
        throw new LexerError(
          `here-document exceeded ${this.maxHeredocSize} bytes`,
          this.line,
          this.column,
        );
      }
    }

    const token = this.makeToken(TokenType.HEREDOC_CONTENT, body, start, startLine, startColumn);
    token.heredocTerminated = terminated;
    return token;
  }

  private nextToken(): Token {
    if (this.atEnd()) {
      return this.makeToken(TokenType.EOF, "", this.position, this.line, this.column);
    }

    const char = this.peek();

    if (char === " " || char === "\t" || char === "\r") {
      this.advance();
      return this.nextToken();
    }

    if (char === "\n") {
      const start = this.position;
      const startLine = this.line;
      const startColumn = this.column;
      this.advance();
      return this.makeToken(TokenType.NEWLINE, "\n", start, startLine, startColumn);
    }

    if (char === "#") {
      const start = this.position;
      const startLine = this.line;
      const startColumn = this.column;
      let comment = "";
      while (!this.atEnd() && this.peek() !== "\n") {
        comment += this.advance();
      }
      return this.makeToken(TokenType.COMMENT, comment, start, startLine, startColumn);
    }

    // A `{name}` immediately followed by a redirection operator is an fd-variable
    // (`{fd}>file`), tested before the grouping-brace branch so the brace is not
    // swallowed into the token stream as LBRACE.
    if (char === "{" && this.looksLikeFdVariable()) {
      const fd = this.readFdVariable();
      if (fd) return fd;
    }

    const operator = this.matchOperator();
    if (operator) return operator;

    if (char === "{" || char === "}") {
      const start = this.position;
      const startLine = this.line;
      const startColumn = this.column;
      this.advance();
      return this.makeToken(
        char === "{" ? TokenType.LBRACE : TokenType.RBRACE,
        char,
        start,
        startLine,
        startColumn,
      );
    }

    return this.readWord();
  }
}

/**
 * Convenience entry point: tokenize a script and drop comment/EOF tokens the evaluator does not
 * act on, leaving the meaningful stream. Newlines are kept: a newline ends a command as surely as
 * a `;` does, so dropping them would join two lines into one and hide the second line's command
 * name from the tier classifier. Used by the runtime's classifier, which needs the token kinds but
 * not the punctuation noise.
 */
export function tokenizeShell(source: string, options?: LexerOptions): Token[] {
  const lexer = new ShellLexer(source, options);
  return lexer
    .tokenize()
    .filter((token) => token.type !== TokenType.COMMENT && token.type !== TokenType.EOF);
}
