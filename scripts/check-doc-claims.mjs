#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const STATUSES = new Set(["Shipped", "Experimental/unconsumed", "Documented"]);

function localFile(root, relative) {
  if (typeof relative !== "string" || !relative) throw new Error("missing repository path");
  const absolute = path.resolve(root, relative);
  const escaped = path.relative(root, absolute);
  if (escaped.startsWith("..") || path.isAbsolute(escaped) || !statSync(absolute).isFile())
    throw new Error(`invalid repository file: ${relative}`);
  return absolute;
}

function source(root, relative) {
  const file = localFile(root, relative);
  const parsed = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  if (parsed.parseDiagnostics.length) throw new Error(`invalid source syntax: ${relative}`);
  return parsed;
}

function importedFile(root, from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(localFile(root, from)), specifier);
  const candidates = /\.js$/.test(base)
    ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base]
    : [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      return localFile(root, path.relative(root, candidate));
    } catch {}
  }
  return null;
}

function runtimeEdges(root, file) {
  return source(root, file).statements.filter((node) => {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return false;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return false;
    if (node.isTypeOnly || node.importClause?.isTypeOnly) return false;
    const bindings = node.importClause?.namedBindings ?? node.exportClause;
    if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)))
      return bindings.elements.some((element) => !element.isTypeOnly);
    return true;
  });
}

function checkRuntimeChain(root, evidence, implementation) {
  const { chain, entryConfig, symbol } = evidence;
  if (!Array.isArray(chain) || chain.length < 2 || chain.at(-1) !== implementation)
    throw new Error("runtime chain must end at the implementation and contain a consumer");
  if (typeof symbol !== "string" || !symbol) throw new Error("runtime chain needs a called symbol");
  const config = source(root, entryConfig);
  const entry = localFile(root, chain[0]);
  let declared = false;
  function visitConfig(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(config) === "entry" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      declared ||= node.initializer.elements.some(
        (value) =>
          ts.isStringLiteral(value) &&
          path.resolve(path.dirname(config.fileName), value.text) === entry,
      );
    }
    ts.forEachChild(node, visitConfig);
  }
  visitConfig(config);
  if (!declared)
    throw new Error(`${chain[0]} is not a declared runtime build entry in ${entryConfig}`);
  let binding;
  for (let index = 0; index < chain.length - 1; index++) {
    const next = localFile(root, chain[index + 1]);
    const edge = runtimeEdges(root, chain[index]).find(
      (node) => importedFile(root, chain[index], node.moduleSpecifier.text) === next,
    );
    if (!edge)
      throw new Error(`missing runtime import/export: ${chain[index]} -> ${chain[index + 1]}`);
    if (index === chain.length - 2) {
      if (!ts.isImportDeclaration(edge))
        throw new Error("final runtime edge must consume an import");
      const named = edge.importClause?.namedBindings;
      binding =
        named &&
        ts.isNamedImports(named) &&
        named.elements.find(
          (element) =>
            !element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === symbol,
        )?.name.text;
    }
  }
  if (!binding) throw new Error(`consumer does not import ${symbol}`);
  const consumerPath = localFile(root, chain.at(-2));
  const program = ts.createProgram([consumerPath, localFile(root, implementation)], {
    noResolve: true,
    noLib: true,
    allowJs: true,
    target: ts.ScriptTarget.Latest,
  });
  const checker = program.getTypeChecker();
  const implementationSource = program.getSourceFile(localFile(root, implementation));
  const implementationModule = checker.getSymbolAtLocation(implementationSource);
  if (
    !implementationModule ||
    !checker.getExportsOfModule(implementationModule).some((item) => item.name === symbol)
  )
    throw new Error(`implementation does not export ${symbol}`);
  const consumer = program.getSourceFile(consumerPath);
  let importedSymbol;
  for (const statement of consumer.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      importedFile(root, chain.at(-2), statement.moduleSpecifier.text) !==
        localFile(root, implementation)
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      const element = named.elements.find((item) => item.name.text === binding);
      if (element) importedSymbol = checker.getSymbolAtLocation(element.name);
    }
  }
  let called = false;
  function visit(node) {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      importedSymbol &&
      checker.getSymbolAtLocation(node.expression) === importedSymbol
    )
      called = true;
    ts.forEachChild(node, visit);
  }
  visit(consumer);
  if (!called) throw new Error(`consumer never calls ${symbol}`);
}

function checkLink(root, link) {
  const [relative, anchor] = link.split("#");
  const file = localFile(root, relative);
  if (!anchor) return;
  const text = readFileSync(file, "utf8");
  const headings = text
    .split(/\r?\n/)
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6} /, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
        .replace(/\s/g, "-"),
    );
  if (!headings.includes(anchor)) throw new Error(`missing evidence anchor: ${link}`);
}

export function checkDocClaims(root, ledgerPath = "docs/status-ledger.json") {
  const issues = [];
  let ledger;
  let text;
  try {
    text = readFileSync(localFile(root, ledgerPath), "utf8");
    ledger = JSON.parse(text);
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.claims))
      throw new Error("expected schemaVersion 1 and claims array");
  } catch (error) {
    return { ok: false, issues: [`${ledgerPath}:1: ${error.message}`] };
  }
  const ids = new Set();
  for (const claim of ledger.claims) {
    const offset = text.indexOf(JSON.stringify(claim.id));
    const line = offset < 0 ? 1 : text.slice(0, offset).split("\n").length;
    try {
      if (typeof claim.id !== "string" || !claim.id || ids.has(claim.id))
        throw new Error("missing or duplicate claim id");
      ids.add(claim.id);
      if (!STATUSES.has(claim.status)) throw new Error(`unsupported status: ${claim.status}`);
      localFile(root, claim.implementation);
      if (!Array.isArray(claim.links) || !claim.links.length)
        throw new Error("claim needs evidence links");
      for (const link of claim.links) checkLink(root, link);
      if (claim.status === "Shipped") {
        if (claim.evidence?.kind !== "runtime-chain")
          throw new Error("Shipped needs a proven runtime chain");
        checkRuntimeChain(root, claim.evidence, claim.implementation);
      } else if (typeof claim.reason !== "string" || !claim.reason.trim()) {
        throw new Error("non-runtime status needs a reason");
      }
    } catch (error) {
      issues.push(`${ledgerPath}:${line}: ${claim.id ?? "claim"}: ${error.message}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkDocClaims(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  for (const issue of report.issues) console.error(issue);
  if (report.ok) console.log("Documentation status claims have valid paths and runtime evidence.");
  process.exitCode = report.ok ? 0 : 1;
}
