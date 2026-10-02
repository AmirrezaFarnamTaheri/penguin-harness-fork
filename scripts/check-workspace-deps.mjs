#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkoutRevision,
  coreExportEntries,
  CORE_PACKAGE,
  digestFile,
  SENTINEL_FILE,
  sourceFingerprint,
} from "./workspace-core-sentinel.mjs";

const CONSUMERS = ["server", "web", "cli"];

/** Inspect the exact ESM resolution used by each consumer without importing application code. */
export function checkWorkspaceDeps(root) {
  const issues = [];
  const resolved = [];
  const sentinelPath = path.join(root, "packages/core", SENTINEL_FILE);
  let sentinel;
  let current;
  try {
    sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
    current = coreExportEntries(root);
    if (
      sentinel.schemaVersion !== 1 ||
      sentinel.name !== CORE_PACKAGE ||
      sentinel.version !== current.manifest.version ||
      sentinel.sourceSha256 !== sourceFingerprint(root) ||
      sentinel.revision !== checkoutRevision(root)
    ) {
      issues.push(`${sentinelPath}: core build does not match this checkout's source/revision`);
    }
    if (JSON.stringify(sentinel.exports) !== JSON.stringify(current.entries)) {
      issues.push(`${sentinelPath}: core export files or manifest changed after the build`);
    }
  } catch (error) {
    issues.push(`${sentinelPath}: ${error.message}`);
    return { ok: false, issues, resolved };
  }

  const specifiers = Object.keys(current.entries).map((subpath) =>
    subpath === "." ? CORE_PACKAGE : `${CORE_PACKAGE}${subpath.slice(1)}`,
  );
  const resolver = `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map(specifier => ({specifier, url: import.meta.resolve(specifier)}))))`;
  for (const consumer of CONSUMERS) {
    const consumerPath = path.join(root, "packages", consumer);
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", resolver], {
      cwd: consumerPath,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status !== 0) {
      issues.push(
        `${consumerPath}: cannot resolve core exports (${result.error?.message ?? result.stderr.trim()})`,
      );
      continue;
    }
    try {
      for (const entry of JSON.parse(result.stdout)) {
        const exportPath = fileURLToPath(entry.url);
        const subpath =
          entry.specifier === CORE_PACKAGE ? "." : `.${entry.specifier.slice(CORE_PACKAGE.length)}`;
        const sha256 = digestFile(exportPath);
        const expectedSha256 = current.entries[subpath].sha256;
        resolved.push({
          consumer,
          specifier: entry.specifier,
          path: exportPath,
          sha256,
          expectedSha256,
        });
        if (sha256 !== expectedSha256) {
          issues.push(
            `${consumerPath}: ${entry.specifier} resolves stale content at ${exportPath}`,
          );
        }
      }
    } catch (error) {
      issues.push(`${consumerPath}: ${error.message}`);
    }
  }
  return { ok: issues.length === 0, issues, resolved };
}

export function main(root, log = console.log) {
  const report = checkWorkspaceDeps(root);
  for (const entry of report.resolved)
    log(
      `${entry.consumer}: ${entry.specifier} -> ${entry.path}\n  resolved SHA256 ${entry.sha256}; build SHA256 ${entry.expectedSha256}`,
    );
  for (const issue of report.issues) log(`STALE: ${issue}`);
  if (!report.ok) {
    log(
      "Restore workspace links with pnpm install --force, then rebuild with pnpm --filter @prismshadow/penguin-core --filter @prismshadow/penguin-cli build.",
    );
    return 1;
  }
  log("Workspace core exports match the current build and checkout.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
