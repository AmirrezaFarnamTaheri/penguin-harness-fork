import { describe, expect, it } from "vitest";
import { BoundedStreamCapture } from "../../src/trace/bounded-capture.js";

describe("BoundedStreamCapture", () => {
  it("keeps both ends of a 1MB stream byte-exact", () => {
    const headBytes = 262_144;
    const tailBytes = 262_144;
    const stream = Buffer.alloc(1_048_576);
    for (let index = 0; index < stream.length; index += 1) stream[index] = 33 + (index % 94);
    const head = stream.subarray(0, headBytes);
    const middle = stream.subarray(headBytes, stream.length - tailBytes);
    const tail = stream.subarray(stream.length - tailBytes);
    const capture = new BoundedStreamCapture();

    for (let offset = 0; offset < stream.length; offset += 16_381) {
      capture.write(stream.subarray(offset, offset + 16_381));
    }

    const marker = Buffer.from(`\n…[omitted ${middle.length} bytes]…\n`);
    expect(capture.render()).toBe(Buffer.concat([head, marker, tail]).toString("utf8"));
  });

  it("states the exact number of omitted bytes at the seam", () => {
    const capture = new BoundedStreamCapture(4, 4);
    capture.write(Buffer.from("abcdefghij"));

    expect(capture.render()).toBe("abcd\n…[omitted 2 bytes]…\nghij");
  });

  it("passes small streams through without a marker", () => {
    const capture = new BoundedStreamCapture();
    capture.write(Buffer.from("small stream"));

    expect(capture.render()).toBe("small stream");
  });

  it("preserves streams that fit across the combined head and tail capacities", () => {
    const capture = new BoundedStreamCapture(4, 4);
    capture.write(Buffer.from("abcdef"));

    expect(capture.render()).toBe("abcdef");
  });
});
