/**
 * The cleaner is a tool that deletes directories, so the tests are mostly about what it must
 * NOT do. A cleanup script that can remove a tracked file or a user's data root is worse than no
 * script at all, and neither failure shows up until the day it is used for real.
 *
 * Every test builds a throwaway git repository, so the tracked-file refusal is exercised against
 * a real `git ls-files` rather than a stub.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { applyClean, containsTracked, main, readTrackedFiles, scan } from "./clean-workspace.mjs";

const roots = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function fileAt(root, rel, contents = "x") {
  const full = join(root, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

/** A minimal git repo with one committed file, so `git ls-files` has something true to say. */
function repo({ commit = ["src/keep.ts"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "clean-workspace-"));
  roots.push(root);
  git(["init", "-q"], root);
  for (const rel of commit) fileAt(root, rel, `// ${rel}\n`);
  git(["add", "-A"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], root);
  return root;
}

test("report mode finds debris and deletes nothing", () => {
  const root = repo();
  fileAt(root, "packages/web/test-results/.last-run.json", "{}");
  fileAt(root, "packages/web/playwright-report/index.html", "<html>");
  mkdirSync(join(root, "node_modules/.vite/deps"), { recursive: true });
  fileAt(root, "node_modules/.vite/deps/_metadata.json", "{}");
  fileAt(root, "e2e/_probe-render.spec.mjs", "// scratch");
  fileAt(root, "audit-evidence/debug-login.png", "png");

  const report = scan(root);
  const paths = report.items.map((i) => i.path).sort();
  assert.deepEqual(paths, [
    "audit-evidence/debug-login.png",
    "e2e/_probe-render.spec.mjs",
    "node_modules/.vite",
    "packages/web/playwright-report",
    "packages/web/test-results",
  ]);

  // Report mode must not mutate. The files are still on disk.
  for (const p of paths) {
    const res = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    assert.ok(res.stdout !== null);
  }
  assert.ok(main([], { root, log: () => {} }) === 0);
  // Re-scan: everything is still there, so the first scan really did not delete.
  assert.equal(scan(root).items.length, paths.length);
});

test("refuses to delete a directory that contains a tracked file", () => {
  const root = repo({ commit: ["src/keep.ts", "dist/committed.js"] });
  fileAt(root, "dist/committed.js", "// committed build output\n");
  fileAt(root, "dist/big.js", "// also here\n");

  const report = scan(root, { includeDist: true });
  const dist = report.items.find((i) => i.path === "dist");
  assert.ok(dist, "dist should still be found so the report is honest about it");
  assert.equal(dist.protected, "tracked");
  // Protected means it is excluded from the removable set — the whole directory, not just the
  // untracked file inside it, because we cannot delete part of a tracked directory tree.
  assert.equal(
    report.removable.some((i) => i.path === "dist"),
    false,
  );

  const result = applyClean(root, report);
  assert.equal(
    result.removed.some((i) => i.path === "dist"),
    false,
  );
  assert.ok(
    scan(root, { includeDist: true }).items.some((i) => i.path === "dist"),
    "the tracked file must still exist after an apply",
  );
});

test("deletes untracked debris with --apply", () => {
  const root = repo();
  fileAt(root, "packages/web/test-results/.last-run.json", "{}");
  fileAt(root, "e2e/_probe.spec.mjs", "// scratch");

  const report = scan(root);
  const result = applyClean(root, report);
  const removed = result.removed.map((i) => i.path).sort();
  assert.deepEqual(removed, ["e2e/_probe.spec.mjs", "packages/web/test-results"]);
  assert.equal(scan(root).items.length, 0);
  // The committed file is untouched.
  assert.ok(scan(root).gitAvailable);
  assert.match(git(["status", "--porcelain"], root).stdout, /^$/);
});

test("never touches untracked-but-intentional paths", () => {
  const root = repo();
  // All of these are untracked. Only "untracked" is what makes them cleanup candidates; these are
  // the ones where that would be wrong, because they are meant to be there and are ignored by git.
  fileAt(root, "AGENTS.md", "# local instructions\n");
  fileAt(root, "design/spec.md", "# design\n");
  fileAt(root, ".data/sessions/keep.json", "{}");
  fileAt(root, "assets/logo.png", "png");
  fileAt(root, "JEV-Family/notes.md", "# external reference\n");

  const report = scan(root);
  const paths = report.items.map((i) => i.path);
  for (const forbidden of ["AGENTS.md", "design", ".data", "assets", "JEV-Family"]) {
    assert.equal(paths.includes(forbidden), false, `${forbidden} must never be a candidate`);
  }
  applyClean(root, report);
  // Still present after an apply.
  assert.ok(scan(root).gitAvailable);
  const status = git(["status", "--porcelain"], root).stdout;
  // Untracked-but-ignored paths do not appear; AGENTS.md does, and must not have been removed.
  assert.match(status, /AGENTS\.md/);
});

test("does not treat committed pngs as scratch screenshots", () => {
  const root = repo({ commit: ["audit-evidence/committed.png"] });
  fileAt(root, "audit-evidence/committed.png", "png");

  const report = scan(root);
  const item = report.items.find((i) => i.path === "audit-evidence/committed.png");
  assert.ok(item, "still reported");
  assert.equal(item.protected, "tracked");
  applyClean(root, report);
  assert.ok(scan(root).items.some((i) => i.path === "audit-evidence/committed.png"));
});

test("dist and target are opt-in", () => {
  const root = repo();
  fileAt(root, "packages/core/dist/index.js", "js");
  fileAt(root, "crates/foo/target/debug/app", "bin");

  assert.deepEqual(scan(root).items, [], "not offered by default");

  const withDist = scan(root, { includeDist: true });
  assert.deepEqual(
    withDist.items.map((i) => i.path),
    ["packages/core/dist"],
  );
  const withBoth = scan(root, { includeDist: true, includeTarget: true });
  assert.deepEqual(withBoth.items.map((i) => i.path).sort(), [
    "crates/foo/target",
    "packages/core/dist",
  ]);
});

test("refuses to run when git cannot answer", () => {
  const root = mkdtempSync(join(tmpdir(), "clean-workspace-nogit-"));
  roots.push(root);
  mkdirSync(join(root, "test-results"), { recursive: true });

  const errors = [];
  const code = main(["--apply"], { root, log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1, "must exit non-zero rather than guess");
  assert.match(errors.join("\n"), /git ls-files/);
  // And the directory is still there: an unanswered git means nothing was deleted.
  assert.equal(scan(root, { tracked: new Set() }).items.length, 1);
});

test("containsTracked treats an unknown tracked set as fully protected", () => {
  assert.equal(containsTracked("dist", null), true);
  assert.equal(containsTracked("dist", new Set(["src/a.ts"])), false);
  assert.equal(containsTracked("dist", new Set(["dist/a.js"])), true);
  // A sibling with the same prefix must not match.
  assert.equal(containsTracked("dist", new Set(["distribution/a.js"])), false);
});

test("readTrackedFiles returns the real tracked set", () => {
  const root = repo();
  const tracked = readTrackedFiles(root);
  assert.ok(tracked instanceof Set);
  assert.equal(tracked.has("src/keep.ts"), true);
});

test("the human report shows git-protected items as refused, not silently", () => {
  // Regression: protected entries were filtered out of the display, so a tracked file inside a
  // cleanup candidate was invisible in report mode and the [REFUSED] marker was dead code. The
  // operator has to be able to see that something was found and deliberately not deleted.
  const root = repo({ commit: ["dist/committed.js"] });
  fileAt(root, "dist/committed.js", "// tracked\n");

  const lines = [];
  const code = main(["--include-dist"], { root, log: (m) => lines.push(m) });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /REFUSED/);
  assert.match(out, /dist/);
  assert.match(out, /refused: git tracks them/);
});
