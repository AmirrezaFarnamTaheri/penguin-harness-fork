/**
 * ToolCallIdAllocator / stripToolCallIdSuffix unit tests: unique ids pass through, collisions
 * get a `#n` suffix (n from 2, first free slot), markUsed seeds the taken set, and the suffix
 * strip is shape-based and idempotent.
 */
import { describe, expect, it } from "vitest";
import { ToolCallIdAllocator, stripToolCallIdSuffix } from "../src/llm/tool-call-ids.js";

describe("ToolCallIdAllocator", () => {
  it("passes a unique id through unchanged", () => {
    const a = new ToolCallIdAllocator();
    expect(a.allocate("call_abc")).toBe("call_abc");
  });

  it("disambiguates repeats with #n starting at 2", () => {
    const a = new ToolCallIdAllocator();
    expect(a.allocate("get_weather")).toBe("get_weather");
    expect(a.allocate("get_weather")).toBe("get_weather#2");
    expect(a.allocate("get_weather")).toBe("get_weather#3");
  });

  it("keeps distinct base ids independent", () => {
    const a = new ToolCallIdAllocator();
    expect(a.allocate("f")).toBe("f");
    expect(a.allocate("g")).toBe("g");
    expect(a.allocate("f")).toBe("f#2");
  });

  it("skips ids already reserved by markUsed", () => {
    const a = new ToolCallIdAllocator();
    a.markUsed("dupe");
    a.markUsed("dupe#2");
    expect(a.allocate("dupe")).toBe("dupe#3");
  });

  it("markUsed twice is harmless", () => {
    const a = new ToolCallIdAllocator();
    a.markUsed("x");
    a.markUsed("x");
    expect(a.allocate("x")).toBe("x#2");
  });
});

describe("stripToolCallIdSuffix", () => {
  it("strips a #n suffix", () => {
    expect(stripToolCallIdSuffix("get_weather#2")).toBe("get_weather");
  });

  it("returns an unsuffixed id as-is", () => {
    expect(stripToolCallIdSuffix("call_abc")).toBe("call_abc");
    expect(stripToolCallIdSuffix("toolu_123")).toBe("toolu_123");
  });

  it("is idempotent", () => {
    const once = stripToolCallIdSuffix("f#3");
    expect(stripToolCallIdSuffix(once)).toBe("f");
  });

  it("only strips a trailing #<digits>, not other hashes", () => {
    expect(stripToolCallIdSuffix("a#b")).toBe("a#b");
    expect(stripToolCallIdSuffix("a#2b")).toBe("a#2b");
  });

  it("round-trips an allocated collision id back to the provider id", () => {
    const a = new ToolCallIdAllocator();
    a.allocate("name");
    const dup = a.allocate("name");
    expect(dup).toBe("name#2");
    expect(stripToolCallIdSuffix(dup)).toBe("name");
  });

  it("leaves a provider id that legitimately ends in #2 intact when the registry is passed", () => {
    const a = new ToolCallIdAllocator();
    const allocated = a.allocate("toolu_legit#2");
    expect(allocated).toBe("toolu_legit#2");
    // Shape-based stripping would return "toolu_legit" — a different id than the one allocated.
    expect(stripToolCallIdSuffix(allocated, a)).toBe("toolu_legit#2");
  });

  it("still strips only the suffix the registry added, even around a legitimate #2", () => {
    const a = new ToolCallIdAllocator();
    expect(a.allocate("call_x#2")).toBe("call_x#2");
    // A genuine collision on that base is suffixed past the existing #2 and strips cleanly.
    expect(a.allocate("call_x#2")).toBe("call_x#2#2");
    expect(stripToolCallIdSuffix("call_x#2#2", a)).toBe("call_x#2");
  });

  it("falls back to shape-based stripping without a registry", () => {
    expect(stripToolCallIdSuffix("read_file#2")).toBe("read_file");
    expect(stripToolCallIdSuffix("call_unknown")).toBe("call_unknown");
  });
});

describe("ToolCallIdAllocator long-run behavior", () => {
  it("does not rescan from #2 on every collision in a long same-name run", () => {
    const a = new ToolCallIdAllocator();
    const ids = Array.from({ length: 400 }, () => a.allocate("same_tool"));
    expect(ids[0]).toBe("same_tool");
    // Monotonic, gap-free allocation proves each suffix slot was visited once, not rescanned from 2.
    const expected = Array.from({ length: ids.length - 1 }, (_, i) => `same_tool#${i + 2}`);
    expect(ids.slice(1)).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("releases ids once the history that owns them is compacted away", () => {
    const a = new ToolCallIdAllocator();
    a.allocate("tool");
    a.allocate("tool");
    a.markUsed("call_resumed_1");
    expect(a.size).toBe(3);

    a.rotate();
    expect(a.size).toBe(0);

    // A re-seeded survivor of the compacted context is respected again.
    a.markUsed("tool");
    expect(a.allocate("tool")).toBe("tool#2");
    expect(a.size).toBe(2);
  });

  it("forgets the suffix mapping of retired ids so it is not retained either", () => {
    const a = new ToolCallIdAllocator();
    a.allocate("gemini_fn");
    const dup = a.allocate("gemini_fn");
    expect(a.originalIdOf(dup)).toBe("gemini_fn");

    a.rotate();
    expect(a.originalIdOf(dup)).toBe(null);
  });
});
