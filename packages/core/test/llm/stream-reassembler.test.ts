import { describe, expect, it } from "vitest";
import {
  StreamReassembler,
  ReasoningContentReassembler,
  utf16IndexToByteIndex,
} from "../../src/llm/stream-reassembler.js";
import type { StreamDelta } from "../../src/llm/stream-reassembler.js";

function apply(view: string, deltas: StreamDelta[]): string {
  for (const delta of deltas) {
    expect(
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(delta.text)),
    ).toBe(delta.text);
    view = delta.type === "reset" ? delta.text : view + delta.text;
  }
  return view;
}

describe("snapshot stream reassembly", () => {
  it("extends, suppresses transient prefix deletion, and resets deep rewrites once", () => {
    const stream = new StreamReassembler(0);
    expect(stream.apply("hello 😀 world")).toEqual([{ type: "append", text: "hello 😀 world" }]);
    expect(stream.apply("hello")).toEqual([]);
    expect(stream.apply("hello 😁 again")).toEqual([
      { type: "reset", text: "hello " },
      { type: "append", text: "😁 again" },
    ]);
    expect(stream.apply("hello 😁 again!")).toEqual([{ type: "append", text: "!" }]);
    expect(stream.finalize()).toEqual([]);
  });

  it("holds 24 runes and unfinished details/quote markers until flush", () => {
    const stream = new StreamReassembler();
    expect(stream.apply("😀".repeat(25))).toEqual([{ type: "append", text: "😀" }]);
    expect(stream.finalize()).toEqual([{ type: "append", text: "😀".repeat(24) }]);
    const tags = new StreamReassembler(0);
    expect(tags.apply("before <det")).toEqual([{ type: "append", text: "before " }]);
    expect(tags.apply('before <details title="unfinished')).toEqual([]);
    expect(tags.apply('before <details title="finished">')).toEqual([
      { type: "append", text: '<details title="finished">' },
    ]);
    const quote = new StreamReassembler(0);
    expect(quote.apply("line\n>")).toEqual([{ type: "append", text: "line\n" }]);
    expect(quote.apply("line\n> quoted")).toEqual([{ type: "append", text: "> quoted" }]);
  });

  it("clamps UTF-16 offsets inside astral pairs", () => {
    expect(utf16IndexToByteIndex("a😀b", 1)).toBe(1);
    expect(utf16IndexToByteIndex("a😀b", 2)).toBe(1);
    expect(utf16IndexToByteIndex("a😀b", 3)).toBe(5);
    expect(utf16IndexToByteIndex("a😀b", 99)).toBe(6);
    expect(() => utf16IndexToByteIndex("a", -1)).toThrow(RangeError);
  });

  it("flushes reasoning before content overtakes its held tail", () => {
    const stream = new ReasoningContentReassembler();
    expect(stream.apply({ reasoning: "short reasoning", content: "" })).toEqual([]);
    const deltas = stream.apply({ reasoning: "short reasoning", content: "c".repeat(25) });
    expect(deltas).toEqual([
      { channel: "reasoning", type: "append", text: "short reasoning" },
      { channel: "content", type: "append", text: "c" },
    ]);
    expect(stream.finalize()).toEqual([
      { channel: "content", type: "append", text: "c".repeat(24) },
    ]);
  });

  it("reconstructs 500 seeded edit sequences without duplicated prefixes or invalid UTF-8", () => {
    let seed = 0x12345678;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const alphabet = ["a", "b", " ", "😀", "é", "日", "\n", "<", ">"];
    for (let sequence = 0; sequence < 500; sequence++) {
      const stream = new StreamReassembler(random(25));
      let target = "";
      let view = "";
      for (let edit = 0; edit < 30; edit++) {
        const runes = Array.from(target);
        const position = random(runes.length + 1);
        if (random(3) === 0) runes.splice(position, random(runes.length - position + 1));
        else runes.splice(position, random(2), alphabet[random(alphabet.length)]!);
        target = runes.join("");
        view = apply(view, stream.apply(target));
        expect(view).toBe(stream.view);
      }
      view = apply(view, stream.finalize());
      expect(view).toBe(target);
    }
  });
});
