/**
 * What a shared result depends on, hashed — the staleness guard, and the reason this module
 * exists at all.
 *
 * THE HAZARD THIS ADDRESSES. Two agents run `vitest` in the same repository at different moments
 * in its history. If the second reuses the first's result without checking anything, it is
 * reasoning about code that changed in between, and it cannot tell: the inherited result is
 * byte-identical to a fresh one. Today that costs a few wasted minutes. Once sharing exists it
 * costs a *confident wrong conclusion*, which is the failure mode this codebase keeps paying
 * for elsewhere. So the unit of sharing is not the command — it is the command together with a
 * fingerprint of everything that can change its answer, and two callers share only on an exact
 * match of that whole thing.
 *
 * WHAT THE FINGERPRINT COVERS, AND WHAT IT DELIBERATELY DOES NOT. It covers the working tree a
 * caller names, and the toolchain material it names, by CONTENT. The threat model is the one
 * that actually exists: agents editing source while another agent verifies it, a config file
 * being rewritten, a lockfile moving. It does not cover the internals of installed dependencies
 * (`node_modules` is excluded by default — hashing a hundred thousand vendored files on every
 * verification would cost more than the verification), so a dependency is changed by reinstalling
 * it. Callers who cross that boundary call `OperationShareRegistry.invalidateAll()`. The exclusion
 * list is a parameter, not a constant, so a caller who needs a different trade can have it.
 *
 * WHY A CONTENT HASH AND NOT MTIMES. A metadata-only fingerprint (path, size, mtime) is roughly
 * an order of magnitude cheaper and is wrong in a specific, reachable way: `cp -p`, `tar -x` and
 * `rsync -t` all restore content under a preserved timestamp, and an editor that writes in place
 * can land two different contents inside one mtime tick's resolution on coarse filesystems. The
 * brief for this feature is that a stale answer is worse than a slow one, and a fingerprint that
 * is *probably* fresh is exactly the failure that rule exists to prevent. Content it is, with one
 * documented narrowing: a single file above `maxInlineBytes` falls back to size+mtime, because
 * reading a 200 MiB bundle on every `tsc` to defend against an attack that does not apply to
 * bundles is a bad trade. Those fallbacks are counted (`degradedFiles`) rather than hidden.
 *
 * WHY A WALK FAILURE IS NOT A FINGERPRINT. If the tree is being rewritten fast enough that a
 * file vanishes between listing and reading it, this returns "unavailable" and the caller does
 * not share. That is the correct answer, and it is worth stating as a feature: a tree that will
 * not hold still for one walk is a tree whose verdict must not be passed to anyone else.
 *
 * PROVENANCE OF THE SHAPE. The content-addressed id — sha256 over `name ‖ "\0" ‖ body`, truncated
 * to 12 hex chars — is the one already minted in `environment/output-compression`'s recall store
 * (`truncated-tool-output-archive.ts`, 12 hex because 48 bits is not a practical collision risk
 * inside that store's own entry bound). The bounded, total, closed-vocabulary discipline is the
 * one already written in `jev/observation.ts`. Neither was reinvented here.
 */

import { createHash, type Hash } from "node:crypto";
import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Hex characters in a share key. Twelve, for the same reason the recall store uses twelve:
 * 48 bits of SHA-256 is not a practical accidental collision inside a registry whose entry
 * bound is {@link OperationShareRegistryLimits.maxEntries}, and it is short enough to quote in a
 * log line without costing real tokens.
 */
export const SHARE_KEY_HEX_LENGTH = 12;

/**
 * Directory names skipped by the walk, matched on the entry name so they apply at any depth.
 *
 * Generated and vendored trees, none of which an agent edits during a verification run. The two
 * exclusions that carry real consequences are `node_modules` and `dist`-shaped names: a change
 * there is invisible to the fingerprint by design, so reinstalling a dependency is a boundary
 * that needs an explicit `invalidateAll()`. See the module header.
 */
export const DEFAULT_EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
]);

/** Files larger than this are hashed by size+mtime instead of by content. See module header. */
export const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;

/** Walk budget. A repo that exceeds it gets no fingerprint and therefore no sharing. */
export const DEFAULT_MAX_FILES = 100_000;

/** Total bytes the walk will read. Also a budget: exceeding it fails closed. */
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * How a dependency fingerprint failed, or the identity of one that succeeded.
 *
 * `budget-exhausted` and `tree-moving` are the two a caller will actually see, and both mean the
 * same thing operationally: do not share. There is deliberately no "partial" success — a
 * fingerprint of some of a tree is a fingerprint of the wrong thing.
 */
export type FingerprintResult =
  | {
      readonly ok: true;
      /** Full sha256 hex. The share key truncates it; comparison uses all of it. */
      readonly hex: string;
      /** Files folded into the digest. */
      readonly files: number;
      /** File bytes actually read. */
      readonly bytes: number;
      /** Files hashed by size+mtime because they exceeded `maxInlineBytes`. */
      readonly degradedFiles: number;
    }
  | { readonly ok: false; readonly reason: FingerprintFailure };

export type FingerprintFailure =
  /** A named root does not exist, or is not readable as a directory. */
  | "root-missing"
  /** No roots given: an operation with nothing to watch cannot be staleness-guarded. */
  | "no-roots"
  /** The walk hit `maxFiles` or `maxTotalBytes`. */
  | "budget-exhausted"
  /** A file or directory moved or became unreadable during the walk. */
  | "tree-moving";

/**
 * One named dependency. A fact is a string the caller asserts about the environment (a toolchain
 * version, an env var); a file contributes its CONTENT, hashed under its name.
 *
 * A `path` that does not exist is not an error. Deleting `tsconfig.json` changes what `tsc`
 * does, so "absent" is a state the fingerprint must be able to represent, and it is hashed as
 * such rather than skipped — skipping it would make adding a config file invisible.
 */
export type FingerprintMaterial =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly path: string };

export interface FingerprintInput {
  /**
   * Files and directories whose content the result depends on. Directories are walked. Paths are
   * resolved with `path.resolve` and then `realpath`, so two spellings of one workspace (a drive
   * letter, a symlink, `/tmp` vs `/private/tmp`) produce one digest rather than two.
   */
  readonly roots: readonly string[];
  /** Named facts and config files, hashed in name order. */
  readonly materials?: readonly FingerprintMaterial[];
  /** `"content"` (default) or `"metadata"`. See module header before choosing. */
  readonly strategy?: "content" | "metadata";
  readonly maxInlineBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  /** Directory names to skip. Defaults to {@link DEFAULT_EXCLUDED_DIR_NAMES}. */
  readonly excludedNames?: ReadonlySet<string>;
}

interface ResolvedOptions {
  readonly strategy: "content" | "metadata";
  readonly maxInlineBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly excludedNames: ReadonlySet<string>;
}

interface WalkState {
  files: number;
  bytes: number;
  degraded: number;
  failure: FingerprintFailure | null;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Hashes everything the result depends on, or explains why it cannot.
 *
 * Total by construction: every path through it either resolves to a digest or to one of four
 * failure reasons, and none of them throws. A throw escaping into a caller's turn because a
 * directory was renamed under it would be a worse outcome than a missed share.
 */
export async function fingerprintOperation(input: FingerprintInput): Promise<FingerprintResult> {
  const options: ResolvedOptions = {
    strategy: input.strategy ?? "content",
    maxInlineBytes: positive(input.maxInlineBytes, DEFAULT_MAX_INLINE_BYTES),
    maxFiles: positive(input.maxFiles, DEFAULT_MAX_FILES),
    maxTotalBytes: positive(input.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    excludedNames: input.excludedNames ?? DEFAULT_EXCLUDED_DIR_NAMES,
  };

  const hash = createHash("sha256");
  // A version tag so the digest's recipe is part of what is hashed. Changing how a fingerprint is
  // computed must invalidate every fingerprint computed the old way, and a bare digest cannot
  // express that; two entries in this process can never disagree about it if it is in the input.
  hash.update("penguin.share.fingerprint.v1\0");

  if (input.roots.length === 0) return { ok: false, reason: "no-roots" };

  const roots = input.roots.map((root) => path.resolve(root)).sort();
  const state: WalkState = { files: 0, bytes: 0, degraded: 0, failure: null };

  for (const root of roots) {
    let real: string;
    try {
      real = await realpath(root);
    } catch {
      // An unresolvable root is almost always a caller passing a path this platform cannot see
      // (a MSYS-style `/d/...` handed to Node on Windows resolves to the current drive). Failing
      // closed here is what stops that from silently producing a second, wrong digest for the
      // same repository.
      state.failure = "root-missing";
      break;
    }
    const label = path.basename(real);
    hash.update(`root\0${label}\0${real}\0`);
    try {
      const info = await stat(real);
      if (info.isFile()) {
        await feedFile(real, label, hash, state, options);
      } else {
        await feedDirectory(real, label, hash, state, options);
      }
    } catch {
      state.failure = "tree-moving";
    }
    if (state.failure !== null) break;
  }

  if (state.failure === null) {
    await feedMaterials(hash, input.materials ?? []);
  }
  if (state.failure !== null) return { ok: false, reason: state.failure };

  return {
    ok: true,
    hex: hash.digest("hex"),
    files: state.files,
    bytes: state.bytes,
    degradedFiles: state.degraded,
  };
}

/**
 * Folds one file into the digest.
 *
 * The separator is `\0` between the path and the body and the path cannot contain one, so two
 * different trees cannot concatenate into the same byte stream. That is why a per-file
 * sub-hash is not used here: it would be a second hash to keep correct for no collision benefit
 * over a delimiter a filesystem already forbids.
 */
async function feedFile(
  absolute: string,
  rel: string,
  hash: Hash,
  state: WalkState,
  options: ResolvedOptions,
): Promise<void> {
  const info = await stat(absolute);
  if (!info.isFile()) {
    // A directory reached by a path named as a root (a symlink to one) is a structural fact.
    hash.update(`${rel}\0D\0`);
    await feedDirectory(absolute, rel, hash, state, options);
    return;
  }
  if (options.strategy === "metadata" || info.size > options.maxInlineBytes) {
    if (options.strategy === "content") state.degraded += 1;
    hash.update(`${rel}\0M\0${info.size}\0${info.mtimeMs}\0`);
    state.files += 1;
    return;
  }
  if (state.bytes + info.size > options.maxTotalBytes) {
    state.failure = "budget-exhausted";
    return;
  }
  const content = await readFile(absolute);
  hash.update(`${rel}\0C\0${info.size}\0`);
  hash.update(content);
  hash.update("\0");
  state.bytes += content.length;
  state.files += 1;
}

async function feedDirectory(
  dirAbs: string,
  rel: string,
  hash: Hash,
  state: WalkState,
  options: ResolvedOptions,
): Promise<void> {
  if (state.files >= options.maxFiles) {
    state.failure = "budget-exhausted";
    return;
  }
  const entries = await readdir(dirAbs, { withFileTypes: true });
  // Sorted so the digest depends on the tree's content and not on the order the filesystem
  // happened to hand entries back. Without this, two identical trees can hash differently and
  // the only symptom is a share that never happens.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (state.failure !== null) return;
    if (entry.isDirectory() && options.excludedNames.has(entry.name)) continue;
    if (state.files >= options.maxFiles) {
      state.failure = "budget-exhausted";
      return;
    }
    const childRel = `${rel}/${entry.name}`;
    const childAbs = path.join(dirAbs, entry.name);
    if (entry.isSymbolicLink()) {
      // The link's own target, not the target's content: a link is a small file in the tree and
      // following it would re-walk (or loop on) whatever it points at.
      hash.update(`${childRel}\0L\0${await readlink(childAbs)}\0`);
    } else if (entry.isDirectory()) {
      await feedDirectory(childAbs, childRel, hash, state, options);
      continue;
    } else {
      await feedFile(childAbs, childRel, hash, state, options);
      continue;
    }
    state.files += 1;
  }
}

/**
 * Folds materials in NAME order, so a caller's ordering is not part of the identity and two
 * callers who list the same materials differently still share.
 */
async function feedMaterials(hash: Hash, materials: readonly FingerprintMaterial[]): Promise<void> {
  const sorted = [...materials].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const material of sorted) {
    if ("value" in material) {
      hash.update(`m\0${material.name}\0${material.value}\0`);
      continue;
    }
    let resolved: string;
    try {
      resolved = await realpath(path.resolve(material.path));
    } catch {
      // Absent is a state, not an error: see FingerprintMaterial.
      hash.update(`m\0${material.name}\0absent\0`);
      continue;
    }
    try {
      const content = await readFile(resolved);
      hash.update(`m\0${material.name}\0C\0`);
      hash.update(content);
      hash.update("\0");
    } catch {
      // A material that is a directory, a socket, or otherwise unreadable as bytes contributes
      // its presence and nothing more, which is the same treatment a symlink gets.
      hash.update(`m\0${material.name}\0present\0`);
    }
  }
}

/**
 * The share key: the identity two callers must match exactly to share anything.
 *
 * Every component earns its place, and the reason is the same for all of them — remove one and
 * two runs that must not be equated become equated:
 *
 * - `program` and `argv`, in their original order. Sorting argv would fold `vitest run a b` and
 *   `vitest run b a`, which are different invocations. The trade is deliberately asymmetric:
 *   missing a share costs a duplicate run, and inventing one costs a wrong answer.
 * - `scope`, the resolved workspace root. Two repositories in one process would otherwise
 *   produce the same key for the same command over different trees.
 * - `fingerprintHex`, the whole point. The same command over a tree that changed is a different
 *   question and must not be answered from the previous run.
 * - `version`, inside the fingerprint itself, so a change to the fingerprint recipe retires every
 *   key minted by the old recipe.
 */
export interface ShareKeyInput {
  readonly program: string;
  readonly argv: readonly string[];
  readonly scope: string;
  readonly fingerprintHex: string;
}

/** Mints the key. Truncated for the same reason and with the same bound as the recall id. */
export function shareKey(input: ShareKeyInput): string {
  return createHash("sha256")
    .update(input.program)
    .update("\0")
    .update(input.argv.join("\0"))
    .update("\0")
    .update(path.resolve(input.scope))
    .update("\0")
    .update(input.fingerprintHex)
    .digest("hex")
    .slice(0, SHARE_KEY_HEX_LENGTH);
}

/** The operation classes this registry will share, and the material each one depends on. */
export type VerificationKind = "test-runner" | "linter" | "typecheck";

/**
 * The config and toolchain files a verification of `kind` in this repository's layout reads
 * besides the source it covers, as materials for {@link FingerprintInput}.
 *
 * This is a CONVENTION, not a rule, and it is a convenience for the common case rather than a
 * substitute for the caller's judgement. The roots are deliberately NOT supplied here: what a
 * verification covers is the single fact the caller knows best, and guessing it from a kind name
 * is how a fingerprint ends up watching the wrong half of a monorepo. Supply roots; take the
 * materials here, and pass more when the invocation needs them.
 */
export function repoFingerprintMaterials(
  root: string,
  kind: VerificationKind,
  nodeVersion: string = process.version,
): FingerprintMaterial[] {
  const file = (name: string): FingerprintMaterial => ({ name, path: path.join(root, name) });
  const materials: FingerprintMaterial[] = [
    file("package.json"),
    file("pnpm-lock.yaml"),
    { name: "node", value: nodeVersion },
    { name: "platform", value: `${process.platform}-${process.arch}` },
  ];
  if (kind === "typecheck") {
    materials.push(file("tsconfig.json"), file("tsconfig.base.json"));
  } else if (kind === "linter") {
    materials.push(file(".oxlintrc.json"), file("eslint.config.js"), file("biome.json"));
  } else if (kind === "test-runner") {
    materials.push(file("vitest.config.ts"), file("jest.config.js"), file("vitest.workspace.ts"));
  }
  return materials;
}
