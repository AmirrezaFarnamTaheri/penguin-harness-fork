import { describe, it, expect } from "vitest";
import { imageDimensions, pixelCount } from "../src/environment/tools/image-dimensions.js";
import { checkImagePixelCount, MAX_IMAGE_PIXELS } from "../src/environment/tools/image-source.js";

/** PNG signature + IHDR carrying the two big-endian u32 dimensions. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** GIF87a/89a + the logical screen descriptor's two little-endian u16. */
function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** JPEG with one APP0 segment before the SOF0 frame header that carries the dimensions. */
function jpeg(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), // APP0, length 4
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), // SOF0, length 17, 8-bit precision
    (() => {
      const dims = Buffer.alloc(4);
      dims.writeUInt16BE(height, 0);
      dims.writeUInt16BE(width, 2);
      return dims;
    })(),
  ]);
}

/** RIFF/WEBP carrying a VP8X extended-format chunk (24-bit dimensions, stored one less). */
function webpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8X", 12, "latin1");
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

describe("image dimensions", () => {
  it("reads the declared size of each supported container format", () => {
    expect(imageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(imageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(jpeg(800, 600))).toEqual({ width: 800, height: 600 });
    const repeatedFill = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      jpeg(800, 600).subarray(8),
    ]);
    expect(imageDimensions(repeatedFill)).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(webpVp8x(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(pixelCount({ width: 1920, height: 1080 })).toBe(1920 * 1080);
  });

  it("returns null rather than reading past a truncated header", () => {
    // Truncation is the shape an adversarial file has; a parser that guesses here is the bug.
    expect(imageDimensions(png(100, 100).subarray(0, 20))).toBeNull();
    expect(imageDimensions(gif(100, 100).subarray(0, 8))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
    expect(imageDimensions(Buffer.alloc(4))).toBeNull();
  });

  it("returns null for bytes that are not an image at all", () => {
    expect(imageDimensions(Buffer.from("not an image, just prose"))).toBeNull();
    expect(imageDimensions(Buffer.from('{\\"json\\": true}'))).toBeNull();
  });

  it("treats a zero or absent dimension as unknown, not as a small image", () => {
    expect(imageDimensions(gif(0, 100))).toBeNull();
    expect(imageDimensions(png(0, 0))).toBeNull();
  });

  it("does not mistake a JPEG non-frame marker for a frame header", () => {
    // DHT (C4) is a length-bearing marker that is NOT a start-of-frame; a walker that reads it as
    // one lands on the entropy table's bytes as a bogus 16-bit size.
    const bogus = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x11, 0x22]), // DHT, length 4
      // SOF0: precision 8, then HEIGHT 300, then WIDTH 1104 — JPEG's order, not the natural one.
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x04, 0x50]),
    ]);
    expect(imageDimensions(bogus)).toEqual({ width: 1104, height: 300 });
  });
});

describe("decode-bomb guard", () => {
  it("refuses a small file that declares an enormous image", () => {
    // The whole point: bytes say "fine", the header says 30000 x 30000, which is ~3.6 GB of RGBA.
    const bomb = png(30000, 30000);
    expect(bomb.length).toBeLessThan(1000);
    const message = checkImagePixelCount(bomb);
    expect(message).not.toBeNull();
    expect(message).toContain("30000 x 30000");
    expect(message).toContain("megapixel");
    expect(pixelCount({ width: 30000, height: 30000 })).toBeGreaterThan(MAX_IMAGE_PIXELS);
  });

  it("passes an ordinary photograph-sized image", () => {
    expect(checkImagePixelCount(png(1920, 1080))).toBeNull();
    expect(checkImagePixelCount(jpeg(4032, 3024))).toBeNull();
    expect(checkImagePixelCount(gif(800, 600))).toBeNull();
  });

  it("leaves the decision open for an unreadable header rather than guessing", () => {
    // Unknown is not small, but it is also not proof of a bomb: the byte cap already applies.
    expect(checkImagePixelCount(Buffer.from("not an image"))).toBeNull();
    expect(checkImagePixelCount(Buffer.from("not a png"), "image/png")).toContain(
      "dimensions could not be verified",
    );
    expect(checkImagePixelCount(Buffer.from("not a png"), "IMAGE/PNG; charset=binary")).toContain(
      "dimensions could not be verified",
    );
  });
});
