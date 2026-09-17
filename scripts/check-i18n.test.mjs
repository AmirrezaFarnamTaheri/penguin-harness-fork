import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkI18n } from "./check-i18n.mjs";

const script = fileURLToPath(new URL("./check-i18n.mjs", import.meta.url));
const fixtureDirs = [];
after(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: tmpdir(), // The default dictionary paths must not depend on the caller's cwd.
    encoding: "utf8",
    timeout: 30_000,
  });
}

function fixtures(en, zh) {
  const dir = mkdtempSync(join(tmpdir(), "penguin-i18n-"));
  fixtureDirs.push(dir);
  const enPath = join(dir, "en.ts");
  const zhPath = join(dir, "zh.ts");
  writeFileSync(enPath, en);
  writeFileSync(zhPath, zh);
  return ["--en", enPath, "--zh", zhPath];
}

test("accepts translated strings, reordered keys, nested arrays, and callable leaves without executing them", () => {
  const neverCall = (value) => {
    throw new Error(`must not call ${value}`);
  };
  assert.deepEqual(
    checkI18n(
      { title: "Hello", nested: { rows: [["{{NAME}}", "Name"]], format: neverCall } },
      { nested: { format: neverCall, rows: [["{{NAME}}", "名字"]] }, title: "你好" },
    ),
    [],
  );
});

test("reports missing and extra deeply nested keys in deterministic path order", () => {
  assert.deepEqual(
    checkI18n({ nav: { absent: "A", shared: "S" } }, { nav: { extra: "多", shared: "同" } }),
    ["$.nav.absent: missing in zh", "$.nav.extra: missing in en"],
  );
});

test("distinguishes objects, arrays, functions, and strings", () => {
  assert.deepEqual(checkI18n({ a: "text", b: [], c: () => "text" }, { a: {}, b: {}, c: "文本" }), [
    "$.a: kind mismatch (en=string, zh=object)",
    "$.b: kind mismatch (en=array, zh=object)",
    "$.c: kind mismatch (en=function, zh=string)",
  ]);
});

test("checks array length and recursively checks every tuple element", () => {
  assert.deepEqual(checkI18n({ rows: [["key", "label"], "last"] }, { rows: [["键", {}]] }), [
    "$.rows: array length mismatch (en=2, zh=1)",
    "$.rows[0][1]: kind mismatch (en=string, zh=object)",
    "$.rows[1]: missing in zh",
  ]);
});

test("does not treat inherited properties or array holes as translations", () => {
  assert.deepEqual(checkI18n({ toString: "title" }, {}), ["$.toString: missing in zh"]);
  assert.deepEqual(checkI18n({ rows: ["title"] }, { rows: new Array(1) }), [
    "$.rows[0]: missing in zh",
  ]);
});

test("rejects unsupported leaves even when both locales have the same invalid type", () => {
  for (const value of [null, undefined, 1, true, new Date(0)]) {
    const issues = checkI18n({ invalid: value }, { invalid: value });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /^\$\.invalid: unsupported dictionary value/);
  }
});

test("rejects invalid roots and empty dictionaries instead of vacuously passing", () => {
  for (const value of [undefined, null, [], "text", {}]) {
    assert.ok(checkI18n(value, value).length > 0);
  }
});

test("detects cycles but permits reused subtrees", () => {
  const shared = { label: "text" };
  assert.deepEqual(checkI18n({ a: shared, b: shared }, { a: shared, b: shared }), []);
  const cycle = {};
  cycle.self = cycle;
  assert.deepEqual(checkI18n({ nested: cycle }, { nested: cycle }), [
    "$.nested.self: cyclic dictionary value",
  ]);
});

test("checks function arity with only the documented real menu-name exception", () => {
  assert.deepEqual(checkI18n({ format: (a) => a }, { format: (a, b) => `${a}${b}` }), [
    "$.format: function arity mismatch (en=1, zh=2)",
  ]);
  assert.deepEqual(
    checkI18n(
      { chat: { thinkingLevelMenuName: (name) => name } },
      { chat: { thinkingLevelMenuName: (name, level) => `${name} (${level})` } },
    ),
    [],
  );
  assert.deepEqual(
    checkI18n(
      { chat: { thinkingLevelMenuName: () => "name" } },
      { chat: { thinkingLevelMenuName: (name, level) => `${name} (${level})` } },
    ),
    ["$.chat.thinkingLevelMenuName: function arity mismatch (en=0, zh=2)"],
  );
});

test("preserves named double-brace tokens, allowing reordered/repeated mentions", () => {
  assert.deepEqual(
    checkI18n({ text: "{{FIRST}} {{SECOND}} {{FIRST}}" }, { text: "{{SECOND}} {{FIRST}}" }),
    [],
  );
  assert.deepEqual(checkI18n({ text: "{{NAME}}" }, { text: "{{RENAMED}}" }), [
    '$.text: placeholder mismatch (en=["{{NAME}}"], zh=["{{RENAMED}}"])',
  ]);
});

test("CLI reports real dictionary parity from another working directory", () => {
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /i18n parity check passed/);
});

test("CLI loads TypeScript fixtures and exits nonzero on mismatches", () => {
  const result = run(
    ...fixtures('export const en = { nav: { title: "Hello" } };', "export const zh = { nav: {} };"),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\$\.nav\.title: missing in zh/);
  assert.doesNotMatch(result.stdout, /passed/);
});

test("CLI accepts passing TypeScript fixtures", () => {
  const result = run(
    ...fixtures(
      'export const en: { title: string } = { title: "Hello" };',
      'export const zh = { title: "你好" };',
    ),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /i18n parity check passed/);
});

test("CLI fails closed on wrong exports, syntax errors, and missing modules", () => {
  for (const source of ['export const wrong = { title: "text" };', "export const en = ;"]) {
    const result = run(...fixtures(source, 'export const zh = { title: "文本" };'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /i18n parity check failed/);
    assert.doesNotMatch(result.stdout, /passed/);
  }
  const result = run("--en", join(tmpdir(), "penguin-i18n-nonexistent", "missing.ts"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /i18n parity check failed/);
});

test("CLI rejects unknown, duplicate, and missing arguments", () => {
  for (const args of [
    ["--unknown"],
    ["--en"],
    ["--en", "--zh"],
    ["--en", "a.ts", "--en", "b.ts"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stdout, /passed/);
  }
});
