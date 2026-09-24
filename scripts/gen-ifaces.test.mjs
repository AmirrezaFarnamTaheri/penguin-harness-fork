import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const script = fileURLToPath(new URL("./gen-ifaces.mjs", import.meta.url));
const source = (type) => `declare function Interface(): ClassDecorator;
@Interface()
export abstract class Example { abstract value: ${type}; }
`;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-ifaces-watch-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}');
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, experimentalDecorators: true, noEmit: true },
      include: ["*.ts"],
    }),
  );
  fs.writeFileSync(path.join(dir, "source.ts"), source("string"));
  return { dir, out: path.join(dir, "ifaces.json") };
}
function start(f, flags = []) {
  // Windows kill(SIGTERM) forcibly terminates Node. IPC dispatches the same Node
  // signal event there, allowing us to verify resource cleanup and natural exit.
  const preload =
    "data:text/javascript," +
    encodeURIComponent(
      'process.on("message", signal => { process.disconnect(); process.emit(signal); }); process.channel.unref();',
    );
  const child = spawn(
    process.execPath,
    [
      ...(flags.includes("--watch") ? ["--import", preload] : []),
      script,
      "--project",
      path.join(f.dir, "tsconfig.json"),
      "--out",
      f.out,
      ...flags,
    ],
    {
      stdio: flags.includes("--watch")
        ? ["ignore", "pipe", "pipe", "ipc"]
        : ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (data) => {
    log += data;
  });
  child.stderr.on("data", (data) => {
    log += data;
  });
  const closed = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  return { child, closed, log: () => log };
}
async function until(run, predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    assert.equal(run.child.exitCode, null, `exited while waiting for ${label}: ${run.log()}`);
    await delay(50);
  }
  assert.fail(`timeout waiting for ${label}: ${run.log()}`);
}
const read = (f) => JSON.parse(fs.readFileSync(f.out, "utf8"));
const value = (f) => read(f).ifaces["fixture#Example"]?.fields.value.data;

/** A project whose src and test both declare the same @Module class: the exact shape of
 * core's kernel-modules.test.ts, which used to make the generator die on "defined twice". */
function moduleFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-ifaces-modules-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}');
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    // include covers test alongside src the way packages/*/tsconfig.json does, so the
    // fixture exercises the generator's own test-file filter rather than the tsconfig's.
    JSON.stringify({
      compilerOptions: { strict: true, experimentalDecorators: true, noEmit: true },
      include: ["src", "test"],
    }),
  );
  const moduleClass = (name) => `declare function Module(): ClassDecorator;
@Module()
export abstract class ${name} {}
`;
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "real.ts"), moduleClass("RealModule"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test", "real.test.ts"), moduleClass("RealModule"));
  return { dir, out: path.join(dir, "ifaces.json") };
}

/** A package that declares nothing publishable: sources exist and typecheck, but no
 * @Interface() / @Module / @Component class is among them. */
function emptyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-ifaces-empty-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}');
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
  );
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "util.ts"), "export const answer = 42;\n");
  return { dir, out: path.join(dir, "ifaces.json") };
}
async function stop(run, signal) {
  if (process.platform === "win32") run.child.send(signal);
  else run.child.kill(signal);
  const result = await Promise.race([run.closed, delay(5000).then(() => "timeout")]);
  assert.notEqual(result, "timeout", `watch did not close: ${run.log()}`);
  assert.deepEqual(result, { code: 0, signal: null }, run.log());
}

test("one-shot writes, leaves unchanged output alone, and checks stale output", async (t) => {
  const f = fixture();
  const first = start(f);
  t.after(() => {
    if (first.child.exitCode === null) first.child.kill();
  });
  assert.equal((await first.closed).code, 0, first.log());
  assert.equal(value(f), "string");
  const before = fs.statSync(f.out).mtimeMs;
  const same = start(f);
  assert.equal((await same.closed).code, 0, same.log());
  assert.equal(fs.statSync(f.out).mtimeMs, before);
  const check = start(f, ["--check"]);
  assert.equal((await check.closed).code, 0, check.log());
  fs.writeFileSync(path.join(f.dir, "source.ts"), source("number"));
  const stale = start(f, ["--check"]);
  assert.equal((await stale.closed).code, 1, stale.log());
  assert.equal(value(f), "string");
});

test("watch regenerates, coalesces edits, ignores output, recovers, and closes", async (t) => {
  const f = fixture();
  const run = start(f, ["--watch"]);
  t.after(() => {
    if (run.child.exitCode === null) run.child.kill();
  });
  await until(run, () => fs.existsSync(f.out), "initial generation");
  assert.equal(value(f), "string");
  await delay(1000);
  assert.equal(run.child.exitCode, null, "--watch must stay alive");
  const completions = () => (run.log().match(/gen-ifaces: (?:wrote|unchanged)/g) ?? []).length;
  assert.equal(completions(), 1, run.log());
  const before = read(f).hash;
  for (const type of ["boolean", "number", "string", "number"])
    fs.writeFileSync(path.join(f.dir, "source.ts"), source(type));
  await until(run, () => value(f) === "number", "edited source");
  assert.notEqual(read(f).hash, before);
  await delay(1200);
  assert.equal(completions(), 2, "burst must produce one regeneration: " + run.log());
  const generated = fs.readFileSync(f.out, "utf8");
  fs.writeFileSync(f.out, generated + "\n");
  await delay(1200);
  assert.equal(completions(), 2, "output must not trigger generation: " + run.log());
  fs.writeFileSync(
    path.join(f.dir, "source.ts"),
    source("string").replace("abstract class", "class"),
  );
  await until(run, () => run.log().includes("must be an abstract class"), "projection error");
  assert.equal(fs.readFileSync(f.out, "utf8"), generated + "\n");
  fs.writeFileSync(path.join(f.dir, "source.ts"), source("boolean"));
  await until(run, () => value(f) === "boolean", "recovery");
  fs.writeFileSync(path.join(f.dir, "extra.ts"), source("number").replaceAll("Example", "Extra"));
  await until(run, () => !!read(f).ifaces["fixture#Extra"], "new root file");
  await stop(run, "SIGTERM");
  const stopped = fs.readFileSync(f.out, "utf8");
  fs.writeFileSync(path.join(f.dir, "source.ts"), source("string"));
  await delay(500);
  assert.equal(fs.readFileSync(f.out, "utf8"), stopped);
});

test("watch handles SIGINT and rejects --check combination", async (t) => {
  const f = fixture();
  const invalid = start(f, ["--watch", "--check"]);
  t.after(() => {
    if (invalid.child.exitCode === null) invalid.child.kill();
  });
  const result = await Promise.race([invalid.closed, delay(5000).then(() => "timeout")]);
  assert.notEqual(result, "timeout");
  assert.equal(result.code, 2, invalid.log());
  const run = start(f, ["--watch"]);
  t.after(() => {
    if (run.child.exitCode === null) run.child.kill();
  });
  await until(run, () => fs.existsSync(f.out), "initial generation");
  await stop(run, "SIGINT");
});

test("test files are not part of the published interface", async (t) => {
  // src and test declare the SAME module class. Before the scoping fix this was a hard
  // error ("module 'RealModule' is defined twice"); now the fixture copy is out of scope
  // and the published table carries the source declaration alone.
  const f = moduleFixture();
  const run = start(f);
  t.after(() => {
    if (run.child.exitCode === null) run.child.kill();
  });
  assert.equal((await run.closed).code, 0, run.log());
  assert.doesNotMatch(run.log(), /is defined twice/);
  assert.deepEqual(read(f).modules, {
    RealModule: { name: "RealModule", requires: {}, provides: {}, contributes: {}, children: [] },
  });
});

test("a package that declares no kernel modules reports an empty catalog with its reason", async (t) => {
  const f = emptyFixture();
  const run = start(f);
  t.after(() => {
    if (run.child.exitCode === null) run.child.kill();
  });
  // Empty is a correct result, not a failure: the generator must stay green and say so.
  const result = await run.closed;
  assert.equal(result.code, 0, run.log());
  const table = read(f);
  assert.deepEqual(table.ifaces, {});
  assert.deepEqual(table.types, {});
  assert.deepEqual(table.modules, {});
  assert.equal(table.empty, true);
  assert.match(
    table.note ?? "",
    /No @Interface\(\), @Module or @Component declarations/,
    "the file records why it is empty",
  );
  assert.match(run.log(), /empty catalog/, "the reason is reported on stderr too");
});
