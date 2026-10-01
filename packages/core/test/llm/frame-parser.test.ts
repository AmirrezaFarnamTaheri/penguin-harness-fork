import { describe, expect, it } from "vitest";
import { LengthPrefixedFrameParser } from "../../src/llm/frame-parser.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("LengthPrefixedFrameParser", () => {
  it("fails closed for oversized frames, even when their next marker arrives in the same chunk", () => {
    const parser = new LengthPrefixedFrameParser(32);
    expect(() => parser.write(bytes(`1\n${JSON.stringify("x".repeat(64))}\n2\n[]`))).toThrow(
      RangeError,
    );
    expect(parser.state).toBe("failed");
    expect(() => parser.write(bytes("1\n[]"))).toThrow("closed");
    expect(() => parser.finish()).toThrow("closed");
  });

  it("latches invalid UTF-8 and EOF decoder errors", () => {
    const invalid = new LengthPrefixedFrameParser();
    expect(() => invalid.write(Uint8Array.of(0xff))).toThrow();
    expect(invalid.state).toBe("failed");
    const partial = new LengthPrefixedFrameParser();
    partial.write(Uint8Array.of(0xf0, 0x9f));
    expect(() => partial.finish()).toThrow();
    expect(partial.state).toBe("failed");
    const marker = new LengthPrefixedFrameParser();
    marker.write(bytes("123"));
    expect(marker.finish()).toEqual([]);
    expect(marker.state).toBe("finished");
  });

  it("preserves frames through every cross-chunk boundary", () => {
    const wire = bytes('12\n{"a":1}\n9\n[1,2]\n');
    for (let split = 0; split <= wire.length; split++) {
      const parser = new LengthPrefixedFrameParser();
      expect([
        ...parser.write(wire.slice(0, split)),
        ...parser.write(wire.slice(split)),
        ...parser.finish(),
      ]).toEqual(['{"a":1}', "[1,2]"]);
    }
  });

  it("decodes astral characters split into single bytes", () => {
    const parser = new LengthPrefixedFrameParser();
    const frames: string[] = [];
    for (const byte of bytes('10\n["😀"]\n')) frames.push(...parser.write(Uint8Array.of(byte)));
    expect([...frames, ...parser.finish()]).toEqual(['["😀"]']);
  });

  it("resynchronizes after junk and a malformed frame before EOF", () => {
    const parser = new LengthPrefixedFrameParser();
    expect(parser.write(bytes('junk\n7\n{bad\n5\n{"ok":true}\n4\n{"tail":true}'))).toEqual([
      '{"ok":true}',
    ]);
    expect(parser.finish()).toEqual(['{"tail":true}']);
  });

  it("flushes complete EOF payloads and discards truncated JSON", () => {
    const complete = new LengthPrefixedFrameParser();
    complete.write(bytes('2\n{"done":true}'));
    expect(complete.finish()).toEqual(['{"done":true}']);
    const incomplete = new LengthPrefixedFrameParser();
    incomplete.write(bytes('2\n{"done":'));
    expect(incomplete.finish()).toEqual([]);
  });

  it("uses structure rather than the advertised marker length", () => {
    const parser = new LengthPrefixedFrameParser();
    expect([
      ...parser.write(bytes('999999\n[\n42\n]\n1\n{"x":"long value"}')),
      ...parser.finish(),
    ]).toEqual(["[\n42\n]", '{"x":"long value"}']);
  });
});
