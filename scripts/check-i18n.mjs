import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function kind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? "object" : "non-plain object";
  }
  return typeof value;
}

function childPath(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function placeholders(text) {
  // These are the prompt tokens used by agent.placeholders and the injection lists.
  // Compare sets: prose can reorder or repeat a token without changing the contract.
  return JSON.stringify([...new Set(text.match(/\{\{[A-Z_][A-Z_0-9]*\}\}/g) ?? [])].sort());
}

/**
 * Compare the actual dictionaries, including dynamic Record keys and array entries
 * that the Strings annotation cannot enforce. Functions are never executed: arity
 * is a structural guard, not proof of parameter types or translated output. The
 * web typecheck remains responsible for the full TypeScript callable contract.
 * @param {unknown} en
 * @param {unknown} zh
 * @returns {string[]} deterministic, path-qualified diagnostics (empty means parity)
 */
export function checkI18n(en, zh) {
  const issues = [];
  const enAncestors = new Set();
  const zhAncestors = new Set();

  function visit(left, right, path) {
    const enKind = kind(left);
    const zhKind = kind(right);
    if (enKind !== zhKind) {
      issues.push(`${path}: kind mismatch (en=${enKind}, zh=${zhKind})`);
      return;
    }
    if (enKind === "string") {
      const a = placeholders(left);
      const b = placeholders(right);
      if (a !== b) issues.push(`${path}: placeholder mismatch (en=${a}, zh=${b})`);
      return;
    }
    if (enKind === "function") {
      // strings-en.ts explicitly omits the redundant wire value in English only.
      // Do not allow arbitrary drift at this path: the exception is exactly 1 vs 2.
      const menuException =
        path === "$.chat.thinkingLevelMenuName" && left.length === 1 && right.length === 2;
      if (left.length !== right.length && !menuException) {
        issues.push(`${path}: function arity mismatch (en=${left.length}, zh=${right.length})`);
      }
      return;
    }
    if (enKind !== "object" && enKind !== "array") {
      issues.push(`${path}: unsupported dictionary value (en=${enKind}, zh=${zhKind})`);
      return;
    }
    if (enAncestors.has(left) || zhAncestors.has(right)) {
      issues.push(`${path}: cyclic dictionary value`);
      return;
    }
    enAncestors.add(left);
    zhAncestors.add(right);
    if (enKind === "array" && left.length !== right.length) {
      issues.push(`${path}: array length mismatch (en=${left.length}, zh=${right.length})`);
    }
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const next =
        enKind === "array" && /^\d+$/.test(key) ? `${path}[${key}]` : childPath(path, key);
      if (!Object.hasOwn(left, key)) issues.push(`${next}: missing in en`);
      else if (!Object.hasOwn(right, key)) issues.push(`${next}: missing in zh`);
      else visit(left[key], right[key], next);
    }
    enAncestors.delete(left);
    zhAncestors.delete(right);
  }

  for (const [locale, dictionary] of [
    ["en", en],
    ["zh", zh],
  ]) {
    if (kind(dictionary) !== "object") {
      issues.push(`$: ${locale} must export a dictionary object`);
    }
  }
  if (issues.length === 0) {
    if (Object.keys(en).length === 0 && Object.keys(zh).length === 0) {
      issues.push("$: dictionaries must not both be empty");
    } else {
      visit(en, zh, "$");
    }
  }
  return issues;
}

async function main(args) {
  const paths = {
    en: new URL("../packages/web/src/lib/strings-en.ts", import.meta.url),
    zh: new URL("../packages/web/src/lib/strings-zh.ts", import.meta.url),
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--en", "--zh"].includes(flag) || seen.has(flag) || !value || value.startsWith("--")) {
      throw new Error("Usage: node scripts/check-i18n.mjs [--en path.ts] [--zh path.ts]");
    }
    seen.add(flag);
    paths[flag.slice(2)] = pathToFileURL(resolve(value));
  }
  // Node >=24 (the repository engine) loads erasable TypeScript natively. Paths
  // are trusted local source modules, not sandboxed input; imports execute code.
  const [enModule, zhModule] = await Promise.all([import(paths.en.href), import(paths.zh.href)]);
  const issues = checkI18n(enModule.en, zhModule.zh);
  if (issues.length > 0) throw new Error(issues.join("\n"));
  console.log(
    "i18n parity check passed (en ↔ zh: recursive keys, kinds, arrays, arity, prompt tokens)",
  );
}

// Importing this module in tests must not run the CLI or load either dictionary.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `i18n parity check failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
