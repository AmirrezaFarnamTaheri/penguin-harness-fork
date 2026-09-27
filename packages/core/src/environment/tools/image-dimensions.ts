/**
 * Declared image dimensions, read from the container header.
 *
 * The byte cap is not a memory cap. A 5 MB PNG is a perfectly ordinary file that can declare
 * 30000 x 30000 — a solid-colour image compresses to almost nothing — and decoding that costs
 * 30000 * 30000 * 4 bytes ≈ 3.6 GB of RGBA before anything looks at a pixel. Every image this
 * project accepts goes on to a provider or a browser, and the decode happens there; all we can
 * do is refuse to hand one over, which means reading the declared size without decoding.
 *
 * So: parse the header each format already carries. This is not a decoder and deliberately not a
 * general image library — it reads the fixed-offset fields the four supported container formats
 * specify, and returns null whenever it cannot, so an unreadable header is "unknown" rather
 * than a guess. Callers decide what unknown means; here it means the byte cap still applies.
 *
 * The parsers are strict about length: every one returns null rather than reading past the end,
 * because a truncated header is exactly the shape an adversarial file has.
 */

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Longest prefix any probe needs, so callers can sniff once and slice once. */
export const IMAGE_HEADER_BYTES = 64 * 1024;

function u16be(buf: Buffer, at: number): number | null {
  return at + 2 <= buf.length ? buf.readUInt16BE(at) : null;
}
function u16le(buf: Buffer, at: number): number | null {
  return at + 2 <= buf.length ? buf.readUInt16LE(at) : null;
}
function u32be(buf: Buffer, at: number): number | null {
  return at + 4 <= buf.length ? buf.readUInt32BE(at) : null;
}
function u24le(buf: Buffer, at: number): number | null {
  if (at + 3 > buf.length) return null;
  return buf[at]! | (buf[at + 1]! << 8) | (buf[at + 2]! << 16);
}

/** Both fields positive, or null — the shape every probe returns. */
function dimensions(width: number | null, height: number | null): ImageDimensions | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** PNG: the IHDR chunk is mandatory, first, and carries both dimensions as big-endian u32. */
function pngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf[4] !== 0x0d || buf[5] !== 0x0a) return null;
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return dimensions(u32be(buf, 16), u32be(buf, 20));
}

/** GIF: the logical screen descriptor is at a fixed offset, little-endian u16, in both versions. */
function gifDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const version = buf.subarray(0, 6).toString("latin1");
  if (version !== "GIF87a" && version !== "GIF89a") return null;
  return dimensions(u16le(buf, 6), u16le(buf, 8));
}

/**
 * JPEG: dimensions live in a Start-Of-Frame marker, not at a fixed offset, so the segments are
 * walked. The marker set that matters is SOF0-SOF15 minus the four that are NOT frame headers
 * (DHT=C4, JPG=C8, DAC=CC) — reading a length from one of those as if it were a frame header is
 * how a naive walker lands on garbage.
 */
function jpegDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) {
      at += 1; // Resynchronise: a stray fill byte between segments is legal.
      continue;
    }
    const marker = buf[at + 1]!;
    // Standalone markers carry no length: SOI, EOI, TEM, and RSTn.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      at += 2;
      continue;
    }
    const length = u16be(buf, at + 2);
    if (length === null || length < 2) return null;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // A frame header is: precision(1) height(2) width(2) — after the marker's own length.
      // JPEG stores HEIGHT before width in the frame header — the reverse of the order the
      // fields are read, which is exactly the kind of swap a header parser gets wrong.
      return dimensions(u16be(buf, at + 7), u16be(buf, at + 5));
    }
    at += 2 + length;
  }
  return null;
}

/** WebP: one container, three payload encodings, each declaring its size differently. */
function webpDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (buf.subarray(8, 12).toString("latin1") !== "WEBP") return null;
  const chunk = buf.subarray(12, 16).toString("latin1");
  // VP8X: the extended format, 24-bit little-endian dimensions stored one less than the real.
  if (chunk === "VP8X") {
    const width = u24le(buf, 24);
    const height = u24le(buf, 27);
    // VP8X stores each dimension minus one, in 24-bit little-endian.
    return width === null || height === null ? null : { width: width + 1, height: height + 1 };
  }
  // VP8L: lossless, 14-bit width-1 and height-1 packed little-endian after the 0x2f signature.
  if (chunk === "VP8L") {
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  // VP8: lossy. The frame header is preceded by a 3-byte start code (9d 01 2a) and two tag bytes.
  if (chunk === "VP8 ") {
    if (buf.length < 30) return null;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = u16le(buf, 26);
    const height = u16le(buf, 28);
    // The low 14 bits carry the size; the top 2 are the scale.
    return dimensions(
      width === null ? null : width & 0x3fff,
      height === null ? null : height & 0x3fff,
    );
  }
  return null;
}

/**
 * The declared size of a supported image, or null when the format is unrecognized, the header
 * is truncated, or the fields are not positive. Callers must treat null as "unknown", never as
 * "small".
 */
export function imageDimensions(bytes: Buffer): ImageDimensions | null {
  return (
    pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes)
  );
}

/** Total pixels: the figure that actually predicts decode cost, and not the byte count. */
export function pixelCount(dimensions: ImageDimensions): number {
  return dimensions.width * dimensions.height;
}
