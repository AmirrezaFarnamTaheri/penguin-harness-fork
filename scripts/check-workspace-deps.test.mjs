import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkWorkspaceDeps } from "./check-workspace-deps.mjs";
import { createCoreSentinel, SENTINEL_FILE } from "./workspace-core-sentinel.mjs";

function write(root, relative, text) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function pnpm(root, args) {
  args = ["--config.manage-package-manager-versions=false", ...args];
  const result = spawnSync(
    process.platform === "win32" ? "cmd.exe" : "pnpm",
    process.platform === "win32" ? ["/d", "/s", "/c", `pnpm ${args.join(" ")}`] : args,
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function install(root, force = false) {
  return pnpm(root, ["install", "--offline", "--ignore-scripts", ...(force ? ["--force"] : [])]);
}

test("a stale resolved snapshot fails and a supported offline reinstall restores freshness", () => {
  const root = mkdtempSync(path.join(tmpdir(), "penguin-workspace-deps-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "fixture", private: true }));
    write(
      root,
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\ninjectWorkspacePackages: true\ndedupeInjectedDeps: false\nsyncInjectedDepsAfterScripts:\n  - build\n",
    );
    const manifest = {
      name: "@prismshadow/penguin-core",
      version: "0.0.1",
      type: "module",
      scripts: { build: 'node --eval "0"' },
      exports: { ".": { import: "./dist/index.js" }, "./browser": { import: "./dist/browser.js" } },
    };
    write(root, "packages/core/package.json", JSON.stringify(manifest));
    write(root, "packages/core/tsup.config.ts", "export default {};\n");
    write(root, "packages/core/src/index.ts", "export const current = true;\n");
    write(root, "packages/core/dist/index.js", "export const current = true;\n");
    write(root, "packages/core/dist/browser.js", "export const browser = true;\n");
    for (const name of ["server", "web", "cli"]) {
      write(
        root,
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `fixture-${name}`,
          private: true,
          dependencies: { "@prismshadow/penguin-core": "workspace:*" },
        }),
      );
    }
    install(root);
    write(root, `packages/core/${SENTINEL_FILE}`, JSON.stringify(createCoreSentinel(root)));
    assert.equal(checkWorkspaceDeps(root).ok, true);

    // A build replaces files, leaving the package manager's injected hardlinks on old bytes.
    // Only canonical fixture output changes; installed package state stays untouched.
    for (const entry of ["index", "browser"]) {
      const built = path.resolve(root, `packages/core/dist/${entry}.js`);
      assert.ok(built.startsWith(`${root}${path.sep}`));
      rmSync(built);
      write(root, `packages/core/dist/${entry}.js`, "export const rebuilt = true;\n");
    }
    write(root, `packages/core/${SENTINEL_FILE}`, JSON.stringify(createCoreSentinel(root)));
    const stale = checkWorkspaceDeps(root);
    assert.equal(stale.ok, false);
    assert.ok(
      stale.issues.some((issue) => issue.includes("server") && issue.includes("stale content")),
    );

    const reinstall = install(root, true);
    // The repository's build hook asks pnpm to resync injected outputs after compilation.
    pnpm(root, ["--filter", "@prismshadow/penguin-core", "run", "build"]);
    write(root, `packages/core/${SENTINEL_FILE}`, JSON.stringify(createCoreSentinel(root)));
    const refreshed = checkWorkspaceDeps(root);
    assert.equal(refreshed.ok, true, JSON.stringify({ issues: refreshed.issues, reinstall }));

    write(root, "packages/core/src/index.ts", "export const changed = true;\n");
    const changed = checkWorkspaceDeps(root);
    assert.equal(changed.ok, false);
    assert.ok(changed.issues.some((issue) => issue.includes("source/revision")));
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
