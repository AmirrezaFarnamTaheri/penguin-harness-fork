import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const CORE_PACKAGE = "@prismshadow/penguin-core";
export const SENTINEL_FILE = "dist/workspace-sentinel.json";

export function digestFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function sourceFingerprint(root) {
  const core = path.join(root, "packages/core");
  const files = ["package.json", "tsup.config.ts"];
  function visit(relative) {
    for (const entry of readdirSync(path.join(core, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  visit("src");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(path.join(core, file)))
      .update("\0");
  }
  hash.update(readFileSync(path.join(root, "pnpm-lock.yaml")));
  return hash.digest("hex");
}

export function checkoutRevision(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function coreExportEntries(root) {
  const core = path.join(root, "packages/core");
  const manifest = JSON.parse(readFileSync(path.join(core, "package.json"), "utf8"));
  const entries = {};
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const entry = typeof target === "string" ? target : (target.import ?? target.default);
    if (typeof entry !== "string") continue;
    const absolute = path.resolve(core, entry);
    const relative = path.relative(core, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(absolute).isFile()) {
      throw new Error(`Invalid core export ${subpath}: ${absolute}`);
    }
    entries[subpath] = { path: entry, sha256: digestFile(absolute) };
  }
  return { manifest, entries };
}

export function createCoreSentinel(root) {
  const { manifest, entries } = coreExportEntries(root);
  return {
    schemaVersion: 1,
    name: manifest.name,
    version: manifest.version,
    revision: checkoutRevision(root),
    sourceSha256: sourceFingerprint(root),
    exports: entries,
  };
}
