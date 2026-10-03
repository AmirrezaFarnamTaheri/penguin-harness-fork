import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { assertNoZipSymlinks } from "../src/services/zip-entry-types.js";
import { unzipBounded } from "../src/services/skill-import-limits.js";

describe("ZIP entry type boundary", () => {
  it.each([
    "../outside",
    "dir/../outside",
    "dir/./file",
    "file.",
    "dir/file:stream",
    "NUL.txt",
    "dir\\file",
    "/outside",
  ])("refuses unsafe path %s before extraction", (entry) => {
    const archive = zipSync({ [entry]: strToU8("bytes") });
    expect(() => unzipBounded(archive)).toThrow("unsafe or ambiguous");
  });

  it("refuses case and Unicode normalization collisions before extraction", () => {
    for (const names of [
      ["File", "file"],
      ["café", "cafe\u0301"],
    ]) {
      const archive = zipSync(Object.fromEntries(names.map((name) => [name, strToU8("bytes")])));
      expect(() => unzipBounded(archive)).toThrow("duplicate normalized");
    }
  });
  it.each([0, 3, 19])("rejects a symlink before extraction regardless of creator OS %i", (os) => {
    const archive = zipSync({
      "SKILL.md": strToU8("---\nname: fixture\n---\nContent"),
      reference: [strToU8("destination"), { os, attrs: (0o120777 << 16) >>> 0 }],
    });
    expect(() => unzipBounded(archive)).toThrow("symbolic links");
    expect(() => assertNoZipSymlinks(archive)).toThrow("symbolic links");
  });

  it("checks symlinks even when their name resembles a directory", () => {
    const archive = zipSync({
      "reference/": [strToU8("destination"), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
    });
    expect(() => unzipBounded(archive)).toThrow("symbolic links");
  });

  it("accepts normal Unix files and directories and offset byte views", () => {
    const archive = zipSync({
      "folder/": [new Uint8Array(), { os: 3, attrs: (0o40755 << 16) >>> 0 }],
      "folder/content": [strToU8("bytes"), { os: 3, attrs: (0o100644 << 16) >>> 0 }],
    });
    const backing = new Uint8Array(archive.length + 8);
    backing.set(archive, 4);
    expect(unzipBounded(backing.subarray(4, backing.length - 4))["folder/content"]).toEqual(
      strToU8("bytes"),
    );
  });

  it("fails closed for a malformed directory before inflation", () => {
    const archive = zipSync({ content: strToU8("bytes") });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const end = archive.length - 22;
    view.setUint32(end + 16, archive.length, true);
    expect(() => unzipBounded(archive)).toThrow("invalid or unsupported");
  });
});
