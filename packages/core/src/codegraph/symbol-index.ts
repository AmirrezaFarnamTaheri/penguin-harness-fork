/**
 * Global symbol index and import resolver.
 *
 * Donor lineage (algorithms only): FastCode's `global_index_builder` (file_map / module_map /
 * export_map, including the Class.Method export entry fix), `symbol_resolver` (local → imported
 * resolution strategy, alias match, member match for `Class.Method`, module-prefix match) and
 * `module_resolver` (relative-import level arithmetic, including the `__init__.py` package rule:
 * from a package root, `from .` stays in the current directory, so `strip = level - 1`).
 */

import type { GraphSymbol, ImportRecord } from "./types.js";

/** Normalize a path separator to POSIX. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Strip a code extension so `foo.ts` and `foo` resolve to the same module. */
export function stripCodeExtension(p: string): string {
  return normalizePath(p).replace(
    /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|c|cpp|h|hpp|cc|cxx)$/i,
    "",
  );
}

/** True when the path is a package root (`__init__.py`), which changes relative-import arithmetic. */
export function isPackageRoot(filePath: string): boolean {
  return /(^|\/)__init__\.py$/.test(normalizePath(filePath));
}

/** Convert a file path to a dotted module path relative to a repo root (Python convention). */
export function filePathToModulePath(filePath: string, repoRoot: string): string {
  const norm = stripCodeExtension(normalizePath(filePath));
  const root = stripCodeExtension(normalizePath(repoRoot));
  const rel = norm.startsWith(root) ? norm.slice(root.length) : norm;
  return rel.replace(/^\/+/, "").replace(/\//g, ".");
}

/** Resolve a relative import to a target module path, mirroring the donor's level arithmetic. */
export function resolveRelativeModulePath(
  currentModulePath: string,
  importName: string,
  level: number,
  isPackage: boolean,
): string | undefined {
  const parts = currentModulePath.split(".").filter((part) => part.length > 0);
  // From a package root, `from .` refers to the current package; elsewhere it refers to the parent.
  const stripCount = isPackage ? level - 1 : level;
  if (stripCount > parts.length) return undefined;
  const parent = stripCount > 0 ? parts.slice(0, parts.length - stripCount) : parts;
  if (importName) return [...parent, importName].join(".");
  return parent.length ? parent.join(".") : undefined;
}

/**
 * Resolve a path-style relative import (`./x`, `../y`) against the importing file's directory.
 * Used for JavaScript/TypeScript-style imports; mirrors the donor's fallback string matching but
 * is precise about directory arithmetic and index modules.
 */
export function resolvePathStyleImport(fromFile: string, importSpec: string): string {
  const normFrom = normalizePath(fromFile);
  const parts = normFrom.split("/");
  parts.pop();
  for (const seg of normalizePath(importSpec).split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
    } else parts.push(seg);
  }
  return stripCodeExtension(parts.join("/"));
}

/** Lookup tables backing symbol resolution. */
export class SymbolIndex {
  /** symbol id -> symbol */
  readonly byId = new Map<string, GraphSymbol>();
  /** file path -> symbols defined in that file */
  readonly byFile = new Map<string, GraphSymbol[]>();
  /** dotted module path -> file path */
  readonly moduleMap = new Map<string, string>();
  /** dotted module path -> { symbol name / qualified name -> symbol id } */
  readonly exportMap = new Map<string, Map<string, string>>();
  /** plain or qualified name -> symbol ids (global fallback) */
  readonly byName = new Map<string, string[]>();

  /** Register a file's symbols, rebuilding that file's export entries. */
  registerFile(filePath: string, symbols: GraphSymbol[], repoRoot: string): void {
    this.byFile.set(filePath, symbols);
    const modulePath = filePathToModulePath(filePath, repoRoot);
    if (modulePath) this.moduleMap.set(modulePath, filePath);

    const exports = new Map<string, string>();
    for (const symbol of symbols) {
      this.byId.set(symbol.id, symbol);
      // Class.Method export entries: a method is reachable as `ClassName.method` in its module.
      if (symbol.className) exports.set(`${symbol.className}.${symbol.name}`, symbol.id);
      if (
        symbol.isExported ||
        symbol.kind === "class" ||
        symbol.kind === "interface" ||
        symbol.kind === "type"
      ) {
        exports.set(symbol.name, symbol.id);
      }
      const bucket = this.byName.get(symbol.qualifiedName);
      if (bucket) bucket.push(symbol.id);
      else this.byName.set(symbol.qualifiedName, [symbol.id]);
      if (symbol.qualifiedName !== symbol.name) {
        const plain = this.byName.get(symbol.name);
        if (plain) plain.push(symbol.id);
        else this.byName.set(symbol.name, [symbol.id]);
      }
    }
    if (modulePath) this.exportMap.set(modulePath, exports);
  }

  /** Drop a file's symbols and export entries. */
  unregisterFile(filePath: string, repoRoot: string): void {
    const symbols = this.byFile.get(filePath);
    if (symbols) {
      for (const symbol of symbols) {
        this.byId.delete(symbol.id);
        for (const key of [symbol.qualifiedName, symbol.name]) {
          const bucket = this.byName.get(key);
          if (bucket) {
            const next = bucket.filter((id) => id !== symbol.id);
            if (next.length) this.byName.set(key, next);
            else this.byName.delete(key);
          }
        }
      }
    }
    this.byFile.delete(filePath);
    const modulePath = filePathToModulePath(filePath, repoRoot);
    if (modulePath) {
      this.moduleMap.delete(modulePath);
      this.exportMap.delete(modulePath);
    }
  }

  /** Look up an exported symbol id within a module. */
  getExportedSymbolId(modulePath: string, symbolName: string): string | undefined {
    return this.exportMap.get(modulePath)?.get(symbolName);
  }

  /** Resolve a symbol defined locally in the given file. */
  resolveLocal(symbolName: string, currentFilePath: string): string | undefined {
    const symbols = this.byFile.get(currentFilePath);
    if (!symbols) return undefined;
    const exact = symbols.find((symbol) => symbol.qualifiedName === symbolName);
    if (exact) return exact.id;
    const plain = symbols.find((symbol) => symbol.name === symbolName);
    return plain?.id;
  }

  /**
   * Resolve a symbol through the importing file's imports.
   * Handles: exact `from x import y`, alias `as`, member `Class.Method`, module-prefix `x.y`,
   * and path-style relative imports for JS/TS.
   */
  resolveImported(
    symbolName: string,
    imports: ImportRecord[],
    currentFilePath: string,
  ): string | undefined {
    for (const imp of imports) {
      if (!matchesImport(symbolName, imp)) continue;
      if (imp.level > 0) {
        // Python-style relative import.
        const currentModule = filePathToModulePath(
          currentFilePath,
          currentFilePath.split("/").slice(0, -1).join("/"),
        );
        const targetModule = resolveRelativeModulePath(
          currentModule,
          imp.module,
          imp.level,
          isPackageRoot(currentFilePath),
        );
        if (targetModule) {
          const resolved = this.matchInModule(targetModule, symbolName, imp);
          if (resolved) return resolved;
        }
        continue;
      }
      if (imp.module.startsWith(".")) {
        // Path-style relative import (JS/TS).
        const targetFile = resolvePathStyleImport(currentFilePath, imp.module);
        const resolved = this.matchInFile(targetFile, symbolName, imp);
        if (resolved) return resolved;
        continue;
      }
      // Absolute import: try dotted module, then path-suffix match, then global name fallback.
      const direct = this.matchInModule(imp.module, symbolName, imp);
      if (direct) return direct;
      const bySuffix = this.matchByPathSuffix(imp.module, symbolName, imp);
      if (bySuffix) return bySuffix;
    }
    return undefined;
  }

  private matchInModule(
    modulePath: string,
    symbolName: string,
    imp: ImportRecord,
  ): string | undefined {
    const exports = this.exportMap.get(modulePath);
    if (!exports) return undefined;
    if (imp.names.length) {
      if (imp.names.includes(symbolName)) return exports.get(symbolName);
      const alias = imp.alias;
      if (alias && symbolName === alias) {
        return exports.get(imp.names[0] ?? symbolName);
      }
      for (const name of imp.names) {
        if (symbolName.startsWith(`${name}.`)) return exports.get(symbolName) ?? exports.get(name);
      }
    }
    return exports.get(symbolName);
  }

  private matchInFile(
    targetFile: string,
    symbolName: string,
    imp: ImportRecord,
  ): string | undefined {
    const symbols = this.byFile.get(targetFile);
    if (!symbols) return undefined;
    if (imp.names.length) {
      if (imp.names.includes(symbolName)) {
        return symbols.find((symbol) => symbol.name === symbolName)?.id;
      }
      for (const name of imp.names) {
        if (symbolName.startsWith(`${name}.`)) {
          return (
            symbols.find((symbol) => symbol.qualifiedName === symbolName)?.id ??
            symbols.find((symbol) => symbol.name === name)?.id
          );
        }
      }
    }
    return symbols.find((symbol) => symbol.name === symbolName)?.id;
  }

  /** Fall back to matching `imp.module` against the tail of indexed file paths. */
  private matchByPathSuffix(
    module: string,
    symbolName: string,
    imp: ImportRecord,
  ): string | undefined {
    const needle = stripCodeExtension(module);
    for (const modulePath of this.exportMap.keys()) {
      const asPath = modulePath.replaceAll(".", "/");
      if (asPath === needle || asPath.endsWith(`/${needle}`) || needle.endsWith(`/${asPath}`)) {
        const resolved = this.matchInModule(modulePath, symbolName, imp);
        if (resolved) return resolved;
      }
    }
    return undefined;
  }

  /** Full resolution strategy: local first, then imported, then same-name global fallback. */
  resolveSymbol(
    symbolName: string,
    currentFilePath: string,
    imports: ImportRecord[],
  ): string | undefined {
    if (!symbolName) return undefined;
    const local = this.resolveLocal(symbolName, currentFilePath);
    if (local) return local;
    const imported = this.resolveImported(symbolName, imports, currentFilePath);
    if (imported) return imported;
    const global = this.byName.get(symbolName);
    if (global?.length) {
      // Prefer a definition in the same file's directory to reduce cross-project collisions.
      const sameDir = global.find((id) => {
        const symbol = this.byId.get(id);
        return symbol && sameDirectory(symbol.filePath, currentFilePath);
      });
      return sameDir ?? global[0];
    }
    return undefined;
  }
}

/** Predicate from the donor's `_matches_import`. */
function matchesImport(symbolName: string, imp: ImportRecord): boolean {
  if (imp.names.includes(symbolName)) return true;
  if (imp.alias && symbolName === imp.alias) return true;
  if (imp.module && symbolName.startsWith(`${imp.module}.`)) return true;
  for (const name of imp.names) {
    if (symbolName.startsWith(`${name}.`)) return true;
  }
  return false;
}

function sameDirectory(a: string, b: string): boolean {
  const dirA = normalizePath(a).split("/").slice(0, -1).join("/");
  const dirB = normalizePath(b).split("/").slice(0, -1).join("/");
  return dirA === dirB;
}
