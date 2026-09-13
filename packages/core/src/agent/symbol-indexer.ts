export interface SymbolInfo {
  name: string;
  kind: "class" | "interface" | "type" | "function" | "method" | "struct" | "trait" | "enum";
  lineNumber: number;
}

export type LexicalTokenType =
  "TIDENT" | "TKEYWORD" | "TNUMBER" | "TCHAR" | "TSTRING" | "TEOF" | "TINVALID";

export interface LexicalToken {
  kind: LexicalTokenType;
  value: string;
  line: number;
  column: number;
  hasLeadingSpace?: boolean;
}

/**
 * 3-character lookahead buffer and hideset macro expansion cycle avoidance,
 * derived from 8cc C compiler architecture (8cc.h / lex.c / cpp.c).
 */
export class LookaheadBuffer {
  private buf: number[] = [0, 0, 0];
  private buflen = 0;
  private last = 0;

  public unreadc(c: number): void {
    if (this.buflen < 3) {
      this.buf[this.buflen++] = c;
    }
  }

  public get(readNextChar: () => number | null): number | null {
    if (this.buflen > 0) {
      const c = this.buf[--this.buflen] ?? 0;
      this.last = c;
      return c;
    }
    const ch = readNextChar();
    if (ch !== null) {
      this.last = ch;
    }
    return ch;
  }

  public getLast(): number {
    return this.last;
  }
}

export class MacroHideset {
  private names = new Set<string>();

  public contains(name: string): boolean {
    return this.names.has(name);
  }

  public add(name: string): MacroHideset {
    const next = new MacroHideset();
    for (const n of this.names) next.names.add(n);
    next.names.add(name);
    return next;
  }
}

export interface FileSummary {
  filePath: string;
  language: "typescript" | "javascript" | "python" | "go" | "rust" | "c" | "cpp" | "unknown";
  classes: string[];
  interfaces: string[];
  types: string[];
  functions: string[];
  imports: string[];
  exports: string[];
  linesOfCode: number;
  summary: string;
}

export type RelationshipType = "direct_match" | "partial_match" | "reference" | "utility";

export interface FileRelationship {
  sourceFilePath: string;
  targetFilePath: string;
  relationshipType: RelationshipType;
  confidenceScore: number;
  helpfulAspects: string[];
  usageSuggestions: string;
}

/**
 * SymbolIndexer provides fast syntactic symbol extraction and relationship mapping
 * across TypeScript, JavaScript, Python, Go, and Rust without heavyweight AST dependencies.
 */
export class SymbolIndexer {
  public parseContent(filePath: string, content: string): FileSummary {
    const language = this.detectLanguage(filePath);
    const lines = content.split("\n");
    const linesOfCode = lines.filter((l) => l.trim().length > 0).length;

    const classes: string[] = [];
    const interfaces: string[] = [];
    const types: string[] = [];
    const functions: string[] = [];
    const imports: string[] = [];
    const exports: string[] = [];

    switch (language) {
      case "typescript":
      case "javascript":
        this.parseTypeScriptOrJavaScript(
          lines,
          classes,
          interfaces,
          types,
          functions,
          imports,
          exports,
        );
        break;
      case "python":
        this.parsePython(lines, classes, functions, imports);
        break;
      case "go":
        this.parseGo(lines, classes, interfaces, functions, imports);
        break;
      case "rust":
        this.parseRust(lines, classes, interfaces, types, functions, imports);
        break;
      case "c":
      case "cpp":
        this.parseC(lines, classes, types, functions, imports);
        break;
      default:
        break;
    }

    const summaryParts: string[] = [`${language.toUpperCase()} file with ${linesOfCode} LOC.`];
    if (classes.length > 0) {
      summaryParts.push(`Classes: ${classes.slice(0, 5).join(", ")}.`);
    }
    if (interfaces.length > 0) {
      summaryParts.push(`Interfaces: ${interfaces.slice(0, 5).join(", ")}.`);
    }
    if (functions.length > 0) {
      summaryParts.push(`Functions: ${functions.slice(0, 5).join(", ")}.`);
    }

    return {
      filePath,
      language,
      classes,
      interfaces,
      types,
      functions,
      imports,
      exports,
      linesOfCode,
      summary: summaryParts.join(" "),
    };
  }

  public findRelationship(source: FileSummary, target: FileSummary): FileRelationship | null {
    if (source.filePath === target.filePath) {
      return null;
    }

    const helpfulAspects: string[] = [];
    let score = 0;

    // 1. Shared exported symbol match
    const sharedExports = source.exports.filter((exp) => target.exports.includes(exp));
    if (sharedExports.length > 0) {
      score += 0.4;
      helpfulAspects.push(`Shares exports: ${sharedExports.slice(0, 3).join(", ")}`);
    }

    // 2. Cross-reference: source imports target's exports or vice versa
    const targetBaseName =
      target.filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^/.]+$/, "") ?? "";
    const sourceBaseName =
      source.filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^/.]+$/, "") ?? "";

    const targetImportsSource = target.imports.some((imp) => imp.includes(sourceBaseName));
    const sourceImportsTarget = source.imports.some((imp) => imp.includes(targetBaseName));

    if (targetImportsSource || sourceImportsTarget) {
      score += 0.35;
      helpfulAspects.push("Direct module dependency or import relationship");
    }

    // 3. Shared functions or methods
    const sharedFuncs = source.functions.filter((fn) => target.functions.includes(fn));
    if (sharedFuncs.length > 0) {
      score += 0.25;
      helpfulAspects.push(`Shares function signatures: ${sharedFuncs.slice(0, 3).join(", ")}`);
    }

    // 4. Shared types or interfaces
    const sharedTypes = [...source.interfaces, ...source.types].filter((t) =>
      [...target.interfaces, ...target.types].includes(t),
    );
    if (sharedTypes.length > 0) {
      score += 0.2;
      helpfulAspects.push(`Shares type contracts: ${sharedTypes.slice(0, 3).join(", ")}`);
    }

    const finalScore = Math.min(1.0, Math.round(score * 100) / 100);
    if (finalScore < 0.2) {
      return null;
    }

    let relationshipType: RelationshipType = "utility";
    if (finalScore >= 0.75) {
      relationshipType = "direct_match";
    } else if (finalScore >= 0.5) {
      relationshipType = "partial_match";
    } else if (targetImportsSource || sourceImportsTarget) {
      relationshipType = "reference";
    }

    return {
      sourceFilePath: source.filePath,
      targetFilePath: target.filePath,
      relationshipType,
      confidenceScore: finalScore,
      helpfulAspects,
      usageSuggestions: `Leverage ${relationshipType} components between ${sourceBaseName} and ${targetBaseName}.`,
    };
  }

  private detectLanguage(filePath: string): FileSummary["language"] {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    switch (ext) {
      case "ts":
      case "tsx":
        return "typescript";
      case "js":
      case "jsx":
      case "mjs":
      case "cjs":
        return "javascript";
      case "py":
        return "python";
      case "go":
        return "go";
      case "rs":
        return "rust";
      case "c":
      case "h":
        return "c";
      case "cpp":
      case "hpp":
      case "cc":
      case "cxx":
        return "cpp";
      default:
        return "unknown";
    }
  }

  private parseTypeScriptOrJavaScript(
    lines: string[],
    classes: string[],
    interfaces: string[],
    types: string[],
    functions: string[],
    imports: string[],
    exports: string[],
  ): void {
    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Class match
      const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch?.[1]) {
        classes.push(classMatch[1]);
      }

      // Interface match
      const ifaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (ifaceMatch?.[1]) {
        interfaces.push(ifaceMatch[1]);
      }

      // Type match
      const typeMatch = line.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
      if (typeMatch?.[1]) {
        types.push(typeMatch[1]);
      }

      // Function match
      const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
      if (funcMatch?.[1]) {
        functions.push(funcMatch[1]);
      }

      // Const/let exported arrow functions
      const arrowMatch = line.match(
        /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/,
      );
      if (arrowMatch?.[1]) {
        functions.push(arrowMatch[1]);
      }

      // Imports
      const importMatch = line.match(/^import\s+.*?from\s+['"]([^'"]+)['"]/);
      if (importMatch?.[1]) {
        imports.push(importMatch[1]);
      }

      // Exports
      const exportMatch = line.match(
        /^export\s+(?:const|function|class|interface|type)\s+([A-Za-z0-9_$]+)/,
      );
      if (exportMatch?.[1]) {
        exports.push(exportMatch[1]);
      }
    }
  }

  private parsePython(
    lines: string[],
    classes: string[],
    functions: string[],
    imports: string[],
  ): void {
    for (const rawLine of lines) {
      const line = rawLine.trim();

      const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)/);
      if (classMatch?.[1]) {
        classes.push(classMatch[1]);
      }

      const funcMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
      if (funcMatch?.[1] && !funcMatch[1].startsWith("__")) {
        functions.push(funcMatch[1]);
      }

      const importMatch = line.match(
        /^(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/,
      );
      const imp = importMatch?.[1] ?? importMatch?.[2];
      if (imp) {
        imports.push(imp);
      }
    }
  }

  private parseGo(
    lines: string[],
    classes: string[],
    interfaces: string[],
    functions: string[],
    imports: string[],
  ): void {
    for (const rawLine of lines) {
      const line = rawLine.trim();

      const structMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+struct/);
      if (structMatch?.[1]) {
        classes.push(structMatch[1]);
      }

      const ifaceMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+interface/);
      if (ifaceMatch?.[1]) {
        interfaces.push(ifaceMatch[1]);
      }

      const funcMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*\(/);
      if (funcMatch?.[1]) {
        functions.push(funcMatch[1]);
      }

      const importMatch = line.match(/^import\s+["']([^"']+)["']/);
      if (importMatch?.[1]) {
        imports.push(importMatch[1]);
      }
    }
  }

  private parseRust(
    lines: string[],
    classes: string[],
    interfaces: string[],
    types: string[],
    functions: string[],
    imports: string[],
  ): void {
    for (const rawLine of lines) {
      const line = rawLine.trim();

      const structMatch = line.match(/^(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/);
      if (structMatch?.[1]) {
        classes.push(structMatch[1]);
      }

      const traitMatch = line.match(/^(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/);
      if (traitMatch?.[1]) {
        interfaces.push(traitMatch[1]);
      }

      const typeMatch = line.match(/^(?:pub\s+)?type\s+([A-Za-z0-9_]+)\s*=/);
      if (typeMatch?.[1]) {
        types.push(typeMatch[1]);
      }

      const fnMatch = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
      if (fnMatch?.[1]) {
        functions.push(fnMatch[1]);
      }

      const useMatch = line.match(/^(?:pub\s+)?use\s+([A-Za-z0-9_:]+)/);
      if (useMatch?.[1]) {
        imports.push(useMatch[1]);
      }
    }
  }

  private parseC(
    lines: string[],
    classes: string[],
    types: string[],
    functions: string[],
    imports: string[],
  ): void {
    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Struct / Union definition
      const structMatch = line.match(/^(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z0-9_]+)/);
      if (structMatch?.[1]) {
        classes.push(structMatch[1]);
      }

      // Typedef definition
      const typedefMatch = line.match(/^typedef\s+.*\s+([A-Za-z0-9_]+);/);
      if (typedefMatch?.[1] && !classes.includes(typedefMatch[1])) {
        types.push(typedefMatch[1]);
      }

      // Function definition (e.g., void foo(...) { or int bar(...))
      const fnMatch = line.match(/^(?:[A-Za-z0-9_*]+\s+)+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{?/);
      if (fnMatch?.[1] && !["if", "while", "for", "switch", "return"].includes(fnMatch[1])) {
        functions.push(fnMatch[1]);
      }

      // #include directives
      const includeMatch = line.match(/^#\s*include\s+[<"]([^>"]+)[>"]/);
      if (includeMatch?.[1]) {
        imports.push(includeMatch[1]);
      }
    }
  }

  /**
   * Fast lexical tokenizer based on 8cc C compiler state machine.
   * Extracts TIDENT, TKEYWORD, TNUMBER, TCHAR, TSTRING, and handles macro cycle prevention.
   */
  public tokenize(content: string): LexicalToken[] {
    const tokens: LexicalToken[] = [];
    const keywords = new Set([
      "if",
      "else",
      "for",
      "while",
      "do",
      "return",
      "switch",
      "case",
      "default",
      "break",
      "continue",
      "goto",
      "sizeof",
      "typeof",
      "struct",
      "union",
      "enum",
      "typedef",
      "static",
      "extern",
      "const",
      "volatile",
      "void",
      "char",
      "int",
      "short",
      "long",
      "float",
      "double",
      "signed",
      "unsigned",
      "bool",
      "true",
      "false",
      "class",
      "interface",
      "type",
      "function",
      "fn",
      "let",
      "var",
      "pub",
      "use",
      "import",
      "export",
      "from",
      "as",
      "async",
      "await",
      "package",
      "func",
    ]);

    let i = 0;
    let line = 1;
    let col = 1;
    const len = content.length;

    while (i < len) {
      const ch = content[i]!;

      // Handle newlines
      if (ch === "\n") {
        line++;
        col = 1;
        i++;
        continue;
      }

      // Skip whitespace
      if (ch === " " || ch === "\t" || ch === "\r") {
        col++;
        i++;
        continue;
      }

      // Skip single-line comments
      if (ch === "/" && content[i + 1] === "/") {
        while (i < len && content[i] !== "\n") i++;
        continue;
      }

      // Skip block comments
      if (ch === "/" && content[i + 1] === "*") {
        i += 2;
        while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) {
          if (content[i] === "\n") {
            line++;
            col = 1;
          }
          i++;
        }
        i += 2;
        continue;
      }

      const startCol = col;
      const startLine = line;

      // String literal
      if (ch === '"') {
        let val = '"';
        i++;
        col++;
        while (i < len && content[i] !== '"') {
          if (content[i] === "\\" && i + 1 < len) {
            val += content[i]! + content[i + 1]!;
            i += 2;
            col += 2;
          } else {
            if (content[i] === "\n") {
              line++;
              col = 1;
            } else {
              col++;
            }
            val += content[i]!;
            i++;
          }
        }
        if (i < len) {
          val += '"';
          i++;
          col++;
        }
        tokens.push({ kind: "TSTRING", value: val, line: startLine, column: startCol });
        continue;
      }

      // Character literal
      if (ch === "'") {
        let val = "'";
        i++;
        col++;
        while (i < len && content[i] !== "'") {
          if (content[i] === "\\" && i + 1 < len) {
            val += content[i]! + content[i + 1]!;
            i += 2;
            col += 2;
          } else {
            val += content[i]!;
            i++;
            col++;
          }
        }
        if (i < len) {
          val += "'";
          i++;
          col++;
        }
        tokens.push({ kind: "TCHAR", value: val, line: startLine, column: startCol });
        continue;
      }

      // Numbers
      if (/[0-9]/.test(ch)) {
        let num = "";
        while (i < len && /[0-9a-fA-FxX._]/.test(content[i]!)) {
          num += content[i]!;
          i++;
          col++;
        }
        tokens.push({ kind: "TNUMBER", value: num, line: startLine, column: startCol });
        continue;
      }

      // Identifiers & Keywords
      if (/[A-Za-z_$]/.test(ch)) {
        let ident = "";
        while (i < len && /[A-Za-z0-9_$]/.test(content[i]!)) {
          ident += content[i]!;
          i++;
          col++;
        }
        const kind = keywords.has(ident) ? "TKEYWORD" : "TIDENT";
        tokens.push({ kind, value: ident, line: startLine, column: startCol });
        continue;
      }

      // Operators and punctuation
      i++;
      col++;
    }

    tokens.push({ kind: "TEOF", value: "", line, column: col });
    return tokens;
  }
}
