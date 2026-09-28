/**
 * The fingerprint, and therefore the whole staleness guard.
 *
 * Every assertion here exists because something in the registry is only safe because of it. A
 * test that only proved "different content, different hash" would leave the interesting claims
 * untested: that identical content with a different mtime is NOT a different tree (which is what
 * separates this from a metadata cache), that an unwalkable tree produces no fingerprint rather
 * than a partial one, and that each component of the key actually changes the key — remove one
 * and two runs that must not be equated become equated.
 */
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXCLUDED_DIR_NAMES,
  fingerprintOperation,
  shareKey,
  SHARE_KEY_HEX_LENGTH,
  type FingerprintInput,
  type ShareKeyInput,
  type FingerprintResult,
} from "../../../src/agent/sharing/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "penguin-share-fp-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fingerprint(input: FingerprintInput): Promise<FingerprintResult> {
  return await fingerprintOperation(input);
}

function hexOf(result: FingerprintResult): string {
  if (!result.ok) throw new Error(`expected a fingerprint, got ${result.reason}`);
  return result.hex;
}

const SRC = (): FingerprintInput => ({ roots: [path.join(root, "src")] });

describe("fingerprint: content, not metadata", () => {
  it("is stable across repeated walks of an unchanged tree", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");

    const first = hexOf(await fingerprint(SRC()));
    const second = hexOf(await fingerprint(SRC()));
    expect(second).toBe(first);
  });

  it("changes when a file's content changes", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    const file = path.join(root, "src", "a.ts");
    await writeFile(file, "export const a = 1;\n");
    const before = hexOf(await fingerprint(SRC()));

    await writeFile(file, "export const a = 2;\n");
    expect(hexOf(await fingerprint(SRC()))).not.toBe(before);
  });

  it("does NOT change when only mtime changes — the distinction from a metadata cache", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    const file = path.join(root, "src", "a.ts");
    await writeFile(file, "export const a = 1;\n");
    const before = hexOf(await fingerprint(SRC()));

    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    expect(hexOf(await fingerprint(SRC()))).toBe(before);

    // The same edit under the metadata strategy IS a different tree, which is precisely why the
    // content strategy is the default. An mtime-only cache would report a stale answer here and
    // report it confidently.
    const metadataBefore = hexOf(
      await fingerprint({ roots: [path.join(root, "src")], strategy: "metadata" }),
    );
    await writeFile(file, "export const a = 1;\n");
    const restored = new Date();
    await utimes(file, restored, restored);
    const metadataAfter = hexOf(
      await fingerprint({ roots: [path.join(root, "src")], strategy: "metadata" }),
    );
    expect(metadataAfter).not.toBe(metadataBefore);
  });

  it("changes when a file is added or removed", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const withOne = hexOf(await fingerprint(SRC()));

    const added = path.join(root, "src", "b.ts");
    await writeFile(added, "export const b = 2;\n");
    const withTwo = hexOf(await fingerprint(SRC()));
    expect(withTwo).not.toBe(withOne);

    await rm(added);
    expect(hexOf(await fingerprint(SRC()))).toBe(withOne);
  });

  it("follows a symlink's target rather than its contents, and notices the link moving", async () => {
    const real = path.join(root, "real-a");
    const other = path.join(root, "real-b");
    await mkdir(real, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(path.join(real, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(other, "b.ts"), "export const b = 2;\n");

    const watched = path.join(root, "watched");
    await mkdir(watched, { recursive: true });
    const link = path.join(watched, "current");
    // A Windows directory symlink needs a privilege an ordinary test run does not have; a junction
    // does not, and it is the same shape for what this module does with it. The assertion holds
    // either way: if the platform reports the link as a link the walk records the target, and if
    // it reports it as a directory the walk descends into it — both change when the link moves.
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(real, link, linkType);
    const before = hexOf(await fingerprint({ roots: [watched] }));

    await rm(link);
    await symlink(other, link, linkType);
    expect(hexOf(await fingerprint({ roots: [watched] }))).not.toBe(before);
  });

  it("skips excluded directory names, and says which ones by default", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const before = hexOf(await fingerprint(SRC()));

    const vendored = path.join(root, "src", "node_modules");
    await mkdir(vendored, { recursive: true });
    await writeFile(path.join(vendored, "dep.js"), "module.exports = 1;\n");
    expect(hexOf(await fingerprint(SRC()))).toBe(before);
    expect(DEFAULT_EXCLUDED_DIR_NAMES.has("node_modules")).toBe(true);
    expect(DEFAULT_EXCLUDED_DIR_NAMES.has("dist")).toBe(true);
    expect(DEFAULT_EXCLUDED_DIR_NAMES.has("coverage")).toBe(true);

    // And the exclusion is a parameter, not a law: a caller who watches dependencies anyway can
    // say so, and then a change inside one is visible.
    const watchingAll = await fingerprint({
      roots: [path.join(root, "src")],
      excludedNames: new Set(),
    });
    expect(hexOf(watchingAll)).not.toBe(before);
  });

  it("degrades a file above maxInlineBytes to size+mtime, and counts it", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "big.bin"), "x".repeat(4096));
    await writeFile(path.join(root, "src", "small.ts"), "export const a = 1;\n");

    const result = await fingerprint({
      roots: [path.join(root, "src")],
      maxInlineBytes: 1024,
    });
    if (!result.ok) throw new Error("expected a fingerprint");
    expect(result.degradedFiles).toBe(1);
    expect(result.files).toBe(2);
  });
});

describe("fingerprint: failing closed", () => {
  it("refuses when there is nothing to watch", async () => {
    expect(await fingerprint({ roots: [] })).toEqual({ ok: false, reason: "no-roots" });
  });

  it("refuses when a root does not exist rather than hashing a smaller tree", async () => {
    const result = await fingerprint({ roots: [path.join(root, "nope")] });
    expect(result).toEqual({ ok: false, reason: "root-missing" });
  });

  it("refuses when the walk budget is exhausted", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      await writeFile(path.join(root, "src", `f${i}.ts`), `export const v = ${i};\n`);
    }
    const result = await fingerprint({ roots: [path.join(root, "src")], maxFiles: 3 });
    expect(result).toEqual({ ok: false, reason: "budget-exhausted" });
  });

  it("refuses when the byte budget is exhausted", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "x".repeat(2048));
    const result = await fingerprint({ roots: [path.join(root, "src")], maxTotalBytes: 512 });
    expect(result).toEqual({ ok: false, reason: "budget-exhausted" });
  });

  it("accepts a single file named as a root", async () => {
    const file = path.join(root, "tsconfig.json");
    await writeFile(file, "{}\n");
    const result = await fingerprint({ roots: [file] });
    if (!result.ok) throw new Error("expected a fingerprint");
    expect(result.files).toBe(1);
  });
});

describe("fingerprint: materials", () => {
  it("hashes a material file's content, so editing the lockfile changes the fingerprint", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const lock = path.join(root, "pnpm-lock.yaml");
    await writeFile(lock, "lockfileVersion: 1\n");

    const before = hexOf(
      await fingerprint({
        roots: [path.join(root, "src")],
        materials: [{ name: "lock", path: lock }],
      }),
    );
    await writeFile(lock, "lockfileVersion: 2\n");
    const after = hexOf(
      await fingerprint({
        roots: [path.join(root, "src")],
        materials: [{ name: "lock", path: lock }],
      }),
    );
    expect(after).not.toBe(before);
  });

  it("represents a missing material as a state, so adding it is a change", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const config = path.join(root, "tsconfig.json");
    const materials = [{ name: "tsconfig", path: config }];

    const absent = hexOf(await fingerprint({ roots: [path.join(root, "src")], materials }));
    await writeFile(config, "{}\n");
    const present = hexOf(await fingerprint({ roots: [path.join(root, "src")], materials }));
    expect(present).not.toBe(absent);
  });

  it("is order-independent, so two callers listing the same materials still share", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const one = await fingerprint({
      roots: [path.join(root, "src")],
      materials: [
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ],
    });
    const two = await fingerprint({
      roots: [path.join(root, "src")],
      materials: [
        { name: "b", value: "2" },
        { name: "a", value: "1" },
      ],
    });
    expect(hexOf(two)).toBe(hexOf(one));
  });

  it("separates materials by name, so two values cannot be swapped between them", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    const withNames = await fingerprint({
      roots: [path.join(root, "src")],
      materials: [
        { name: "node", value: "v24" },
        { name: "platform", value: "linux-x64" },
      ],
    });
    const withValues = await fingerprint({
      roots: [path.join(root, "src")],
      materials: [
        { name: "node", value: "linux-x64" },
        { name: "platform", value: "v24" },
      ],
    });
    expect(hexOf(withValues)).not.toBe(hexOf(withNames));
  });
});

describe("shareKey", () => {
  // Built per test, because `root` only exists inside one: a module-level base would capture
  // `undefined` and every key would be minted from a scope that does not exist.
  const base = (): ShareKeyInput => ({
    program: "vitest",
    argv: ["vitest", "run"],
    scope: root,
    fingerprintHex: "a".repeat(64),
  });

  it("is the documented length", () => {
    expect(shareKey(base())).toHaveLength(SHARE_KEY_HEX_LENGTH);
  });

  it("is stable for identical inputs", () => {
    expect(shareKey(base())).toBe(shareKey({ ...base() }));
  });

  it("changes when the command's arguments change", () => {
    expect(shareKey({ ...base(), argv: ["vitest", "run", "test/a.test.ts"] })).not.toBe(
      shareKey(base()),
    );
  });

  it("preserves argument order, so two different invocations cannot be equated", () => {
    // The deliberate asymmetry: missing a share costs a duplicate run, inventing one costs a
    // wrong answer, so ordering is never normalised away.
    expect(shareKey({ ...base(), argv: ["vitest", "run", "a", "b"] })).not.toBe(
      shareKey({ ...base(), argv: ["vitest", "run", "b", "a"] }),
    );
  });

  it("changes when the scope changes, so two repositories cannot collide", () => {
    const other = path.join(root, "other-repo");
    expect(shareKey({ ...base(), scope: other })).not.toBe(shareKey(base()));
  });

  it("changes when the fingerprint changes — the component that makes staleness impossible", () => {
    expect(shareKey({ ...base(), fingerprintHex: "b".repeat(64) })).not.toBe(shareKey(base()));
  });
});
