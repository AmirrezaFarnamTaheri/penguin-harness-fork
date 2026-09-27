/**
 * scroll-memory.ts unit tests. The feature is "come back to a conversation and find your
 * place", so the properties worth pinning are: a reader who was at the tail gets no stored
 * position (the stream's existing stick-to-bottom is the right answer for them), a reader who
 * scrolled up gets their RAW offset back (a proportional restore would slide them down by
 * whatever arrived while they were away — the one direction they asked not to move), a
 * re-store refreshes recency so a conversation you keep using is never the one evicted, and
 * the store is bounded because its keys are server-supplied Session ids.
 */
import { describe, expect, it } from "vitest";
import {
  createScrollMemoryStore,
  SCROLL_MEMORY_CAPACITY,
  scrollMemory,
} from "../src/features/chat/scroll-memory";

describe("scroll memory", () => {
  it("returns nothing for a conversation never left", () => {
    const store = createScrollMemoryStore();
    expect(store.recall("s1")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("remembers a scrolled-up position verbatim", () => {
    const store = createScrollMemoryStore();
    store.remember("s1", 4200, false);
    expect(store.recall("s1")).toMatchObject({ top: 4200, following: false });
  });

  it("keeps the raw offset, not a proportion — content grows at the bottom", () => {
    const store = createScrollMemoryStore();
    // Reader was 3000px down in a 9000px transcript, i.e. a third of the way up.
    store.remember("s1", 3000, false);
    // 6000px arrived while they were away. The content they were reading did not move,
    // so 3000 is still 3000 — a proportional restore would have put them at 5000.
    const back = store.recall("s1");
    expect(back?.top).toBe(3000);
  });

  it("records a following reader too, so the restore can tell the two apart", () => {
    const store = createScrollMemoryStore();
    store.remember("s1", 9999, true);
    const back = store.recall("s1");
    expect(back?.following).toBe(true);
    expect(back?.top).toBe(9999);
  });

  it("stamps a monotonic sequence, so a restore can be ordered against a later store", () => {
    const store = createScrollMemoryStore();
    store.remember("s1", 10, false);
    const first = store.recall("s1")?.seq ?? 0;
    store.remember("s2", 20, false);
    const second = store.recall("s2")?.seq ?? 0;
    expect(second).toBeGreaterThan(first);
  });

  it("normalises a nonsense offset to the top rather than storing it", () => {
    const store = createScrollMemoryStore();
    store.remember("a", -5, false);
    store.remember("b", Number.NaN, false);
    store.remember("c", 0, false);
    expect(store.recall("a")?.top).toBe(0);
    expect(store.recall("b")?.top).toBe(0);
    expect(store.recall("c")?.top).toBe(0);
  });

  it("forgets one conversation on request", () => {
    const store = createScrollMemoryStore();
    store.remember("s1", 10, false);
    store.remember("s2", 20, false);
    store.forget("s1");
    expect(store.recall("s1")).toBeUndefined();
    expect(store.recall("s2")).toBeDefined();
    expect(store.size).toBe(1);
  });

  it("clears everything", () => {
    const store = createScrollMemoryStore();
    store.remember("s1", 10, false);
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("scroll memory — bounded", () => {
  it("never exceeds its capacity", () => {
    const store = createScrollMemoryStore(3);
    for (let i = 0; i < 50; i += 1) store.remember(`s${i}`, i, false);
    expect(store.size).toBe(3);
  });

  it("evicts the least recently stored, and a re-store refreshes recency", () => {
    const store = createScrollMemoryStore(3);
    store.remember("a", 1, false);
    store.remember("b", 2, false);
    store.remember("c", 3, false);
    // Touching "a" must save it even though it was stored first.
    store.remember("a", 11, false);
    store.remember("d", 4, false); // evicts "b", the now-least-recently-stored
    expect(store.recall("a")).toMatchObject({ top: 11 });
    expect(store.recall("b")).toBeUndefined();
    expect(store.recall("c")).toBeDefined();
    expect(store.recall("d")).toBeDefined();
  });

  it("a capacity of zero still holds one entry rather than none or throwing", () => {
    // A store that remembered nothing would silently disable the feature; one that grew
    // unboundedly would be the memory leak the cap exists to prevent.
    const store = createScrollMemoryStore(0);
    store.remember("s1", 1, false);
    store.remember("s2", 2, false);
    expect(store.size).toBe(1);
    expect(store.recall("s2")).toBeDefined();
  });

  it("defaults to a capacity that is a real number", () => {
    expect(SCROLL_MEMORY_CAPACITY).toBeGreaterThan(0);
    expect(scrollMemory.size).toBeLessThanOrEqual(SCROLL_MEMORY_CAPACITY);
  });
});
