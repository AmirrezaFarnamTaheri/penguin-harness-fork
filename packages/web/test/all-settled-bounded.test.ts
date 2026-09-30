import { describe, expect, it } from "vitest";
import { allSettledBounded } from "../src/lib/all-settled-bounded.js";

describe("allSettledBounded", () => {
  it("caps a 200-item batch at eight in-flight operations and preserves result order", async () => {
    const items = Array.from({ length: 200 }, (_, index) => index);
    let inFlight = 0;
    let peakInFlight = 0;

    const results = await allSettledBounded(items, 8, async (item) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });

    expect(peakInFlight).toBe(8);
    expect(inFlight).toBe(0);
    expect(results).toEqual(items.map((item) => ({ status: "fulfilled", value: item * 2 })));
  });

  it("settles every item in input order when some operations fail", async () => {
    const items = ["first", "failed", "third", "also-failed", "last"];
    const visited: string[] = [];
    const results = await allSettledBounded(items, 2, async (item) => {
      visited.push(item);
      if (item.includes("failed")) throw new Error(item);
      return item.toUpperCase();
    });

    expect(visited).toEqual(items);
    expect(results).toEqual([
      { status: "fulfilled", value: "FIRST" },
      { status: "rejected", reason: new Error("failed") },
      { status: "fulfilled", value: "THIRD" },
      { status: "rejected", reason: new Error("also-failed") },
      { status: "fulfilled", value: "LAST" },
    ]);
  });

  it("rejects invalid concurrency and returns an empty result for an empty batch", async () => {
    await expect(allSettledBounded([], 0, async () => true)).rejects.toThrow(RangeError);
    await expect(allSettledBounded([], 8, async () => true)).resolves.toEqual([]);
  });
});
