import { HttpError } from "../http/errors.js";
import { strFromU8 } from "fflate";

export function assertSafeZipEntryPath(name: string): void {
  const parts = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (
    !name ||
    /[\\\x00-\x1f\x7f:]/.test(name) ||
    name.startsWith("/") ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new HttpError(
      400,
      "invalid_zip_entry_path",
      "The zip contains an unsafe or ambiguous entry path.",
    );
}

/** Inspect every central-directory entry before decompression; fflate omits external attributes. */
export function assertNoZipSymlinks(archive: Uint8Array): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const invalid = () =>
    new HttpError(400, "invalid_zip_archive", "The zip directory is invalid or unsupported.");
  let end = -1;
  for (
    let offset = archive.byteLength - 22;
    offset >= Math.max(0, archive.byteLength - 65557);
    offset--
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      // Match the decompressor's last-signature selection, rejecting ambiguous comments.
      if (offset + 22 + view.getUint16(offset + 20, true) !== archive.byteLength) throw invalid();
      end = offset;
      break;
    }
  }
  if (end < 0) throw invalid();
  const entries = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  // Multi-disk and ZIP64 require a different directory format; fail closed rather than skip it.
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== entries ||
    entries === 0xffff ||
    size === 0xffffffff ||
    start === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) ||
    start + size > end
  )
    throw invalid();
  const limit = start + size;
  const names = new Set<string>();
  let offset = start;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > limit || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const attributes = view.getUint32(offset + 38, true);
    // Inspect the type bits even if the creator OS is absent or forged.
    if (((attributes >>> 16) & 0xf000) === 0xa000)
      throw new HttpError(
        400,
        "zip_symlink_entry",
        "Zip archives containing symbolic links are not accepted.",
      );
    if (view.getUint16(offset + 34, true) !== 0) throw invalid();
    const nameLength = view.getUint16(offset + 28, true);
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (next > limit) throw invalid();
    let name: string;
    try {
      name = strFromU8(
        archive.subarray(offset + 46, offset + 46 + nameLength),
        !(view.getUint16(offset + 8, true) & 0x800),
      );
    } catch {
      throw invalid();
    }
    assertSafeZipEntryPath(name);
    // Normalize the aliases used by case-insensitive and Unicode-normalizing filesystems.
    const identity = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (names.has(identity))
      throw new HttpError(
        400,
        "duplicate_zip_entry",
        "The zip contains duplicate normalized entry paths.",
      );
    names.add(identity);
    offset = next;
  }
  if (offset !== limit) throw invalid();
}
