import { describe, expect, it } from "vitest";

import {
  type RecallEvent,
  type RecallQueryOptions,
  RecallStore,
  recallScore,
} from "../../src/memory/recall-store.js";

const HOUR_MS = 60 * 60 * 1000;

describe("recall-store", () => {
  describe("recallScore", () => {
    it("is zero for no query terms and for no match", () => {
      const event: RecallEvent = {
        id: "e",
        category: "user",
        type: "message",
        data: "redis cache config",
        severity: "info",
        createdAt: 0,
        tokens: 3,
      };
      expect(recallScore(event, [], 0, HOUR_MS)).toBe(0);
      expect(recallScore(event, ["nope"], 0, HOUR_MS)).toBe(0);
    });

    it("scores term frequency against document length", () => {
      const event: RecallEvent = {
        id: "e",
        category: "user",
        type: "message",
        data: "redis cache",
        severity: "info",
        createdAt: 0,
        tokens: 2,
      };
      // Topical is 1 occurrence / 11 chars, with no decay at time zero.
      expect(recallScore(event, ["redis"], 0, HOUR_MS)).toBeCloseTo(1 / 11, 10);
    });

    it("halves the score every half-life", () => {
      const make = (createdAt: number): RecallEvent => ({
        id: `e-${createdAt}`,
        category: "user",
        type: "message",
        data: "redis cache",
        severity: "info",
        createdAt,
        tokens: 2,
      });
      const base = recallScore(make(0), ["redis"], 0, HOUR_MS);
      const oneHalfLife = recallScore(make(0), ["redis"], HOUR_MS, HOUR_MS);
      const twoHalfLives = recallScore(make(0), ["redis"], 2 * HOUR_MS, HOUR_MS);
      expect(oneHalfLife).toBeCloseTo(base / 2, 10);
      expect(twoHalfLives).toBeCloseTo(base / 4, 10);
    });

    it("prefers a newer event over an older one on the same topic", () => {
      const make = (createdAt: number): RecallEvent => ({
        id: `e-${createdAt}`,
        category: "user",
        type: "message",
        data: "redis cache",
        severity: "info",
        createdAt,
        tokens: 2,
      });
      const old = recallScore(make(0), ["redis"], 10 * HOUR_MS, HOUR_MS);
      const recent = recallScore(make(9 * HOUR_MS), ["redis"], 10 * HOUR_MS, HOUR_MS);
      expect(recent).toBeGreaterThan(old);
    });
  });

  describe("construction and defaults", () => {
    it("ships the documented default retention", () => {
      const store = new RecallStore();
      expect(store.halfLifeMs).toBe(HOUR_MS);
    });

    it("accepts an explicit half-life and retention", () => {
      const store = new RecallStore({
        maxEvents: 3,
        maxTokens: 100,
        maxAgeMs: 1_000,
        halfLifeMs: 30 * 60 * 1000,
      });
      expect(store.halfLifeMs).toBe(30 * 60 * 1000);
      expect(store.size()).toBe(0);
    });
  });

  describe("record", () => {
    it("stores an event with a computed token cost", async () => {
      const store = new RecallStore();
      const event = await store.record("e1", "user", "message", "abcdefghij");
      expect(store.size()).toBe(1);
      expect(event.tokens).toBe(Math.ceil(10 / 4));
      expect(event.severity).toBe("info");
      expect(store.tokens()).toBe(event.tokens);
    });

    it("defaults severity to info and accepts an explicit one", async () => {
      const store = new RecallStore();
      const info = await store.record("e1", "user", "message", "a");
      const error = await store.record("e2", "tool", "failure", "a", "error");
      expect(info.severity).toBe("info");
      expect(error.severity).toBe("error");
    });

    it("overwrites a duplicate id", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "first");
      await store.record("e1", "user", "message", "second");
      expect(store.size()).toBe(1);
      const found = await store.query("", {}, 0);
      expect(found[0]?.data).toBe("second");
    });
  });

  describe("delete and clear", () => {
    it("removes one event and reports whether it existed", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "a");
      expect(await store.delete("e1")).toBe(true);
      expect(await store.delete("e1")).toBe(false);
      expect(store.size()).toBe(0);
    });

    it("clears the whole tier", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "a");
      await store.record("e2", "user", "message", "b");
      await store.clear();
      expect(store.size()).toBe(0);
      expect(store.tokens()).toBe(0);
    });
  });

  describe("query", () => {
    it("returns the most recent events for an empty query, newest first", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "one", "info", 100);
      await store.record("e2", "user", "message", "two", "info", 300);
      await store.record("e3", "user", "message", "three", "info", 200);

      const empty = await store.query("", { topK: 2 }, 0);
      expect(empty.map((event) => event.id)).toEqual(["e2", "e3"]);
      expect(empty.every((event) => event.score === 1)).toBe(true);
    });

    it("scores by topical relevance and breaks ties by recency", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "redis is great", "info", 100);
      await store.record("e2", "user", "message", "redis redis redis", "info", 200);

      const scored = await store.query("redis", {}, 200);
      expect(scored.map((event) => event.id)).toEqual(["e2", "e1"]);
      expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
    });

    it("drops events that do not match the terms", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "redis cache", "info", 0);
      await store.record("e2", "user", "message", "postgres index", "info", 0);

      const scored = await store.query("redis", {}, 0);
      expect(scored.map((event) => event.id)).toEqual(["e1"]);
    });

    it("truncates to topK", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "redis one", "info", 0);
      await store.record("e2", "user", "message", "redis two", "info", 0);
      await store.record("e3", "user", "message", "redis three", "info", 0);

      expect((await store.query("redis", { topK: 2 }, 0)).map((event) => event.id)).toHaveLength(2);
    });

    it("filters by category and type", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "redis", "info", 0);
      await store.record("e2", "tool", "invoke", "redis", "info", 0);
      await store.record("e3", "user", "summary", "redis", "info", 0);

      const opts: RecallQueryOptions = { category: "user" };
      expect((await store.query("redis", opts, 0)).map((event) => event.id)).toEqual(["e1", "e3"]);
      opts.category = undefined;
      opts.type = "invoke";
      expect((await store.query("redis", opts, 0)).map((event) => event.id)).toEqual(["e2"]);
    });

    it("filters by the since/until window", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "redis", "info", 100);
      await store.record("e2", "user", "message", "redis", "info", 200);
      await store.record("e3", "user", "message", "redis", "info", 300);

      expect(
        (await store.query("redis", { since: 150, until: 250 }, 0)).map((event) => event.id),
      ).toEqual(["e2"]);
    });

    it("filters by minimum severity", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "redis", "info", 0);
      await store.record("e2", "user", "message", "redis", "warning", 0);
      await store.record("e3", "user", "message", "redis", "error", 0);

      expect(
        (await store.query("redis", { minSeverity: "warning" }, 0)).map((event) => event.id),
      ).toEqual(["e2", "e3"]);
    });

    it("ignores query terms shorter than two characters", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "a b cd", "info", 0);
      // Only "cd" is a usable term, so a single-letter query degrades to recency.
      expect((await store.query("a", {}, 0)).map((event) => event.id)).toEqual(["e1"]);
      expect((await store.query("cd", {}, 0)).map((event) => event.id)).toEqual(["e1"]);
    });
  });

  describe("recent", () => {
    it("returns the last N events oldest-first for context reconstruction", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "one", "info", 100);
      await store.record("e2", "user", "message", "two", "info", 300);
      await store.record("e3", "user", "message", "three", "info", 200);

      const recent = await store.recent(2);
      expect(recent.map((event) => event.id)).toEqual(["e3", "e2"]);
    });

    it("returns everything when fewer than N are retained", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "one", "info", 100);
      expect((await store.recent(10)).map((event) => event.id)).toEqual(["e1"]);
    });
  });

  describe("evict", () => {
    it("drops events past the age horizon first", async () => {
      const store = new RecallStore({ maxAgeMs: 1_000 });
      await store.record("e1", "user", "message", "old", "info", 0);
      await store.record("e2", "user", "message", "new", "info", 2_000);
      expect(store.size()).toBe(1);
      expect((await store.query("", {}, 2_000))[0]?.id).toBe("e2");
    });

    it("drops the oldest events past the capacity", async () => {
      const store = new RecallStore({ maxEvents: 2 });
      await store.record("e1", "user", "message", "one", "info", 100);
      await store.record("e2", "user", "message", "two", "info", 200);
      await store.record("e3", "user", "message", "three", "info", 300);
      expect(store.size()).toBe(2);
      expect((await store.query("", {}, 300)).map((event) => event.id)).toEqual(["e3", "e2"]);
    });

    it("enforces the token budget as a hard guarantee", async () => {
      const store = new RecallStore({ maxTokens: 10 });
      for (let i = 0; i < 4; i++) {
        await store.record(`e${i}`, "user", "message", "abcdefghij", "info", i * 100);
      }
      expect(store.size()).toBe(3);
      expect(store.tokens()).toBeLessThanOrEqual(10);
    });

    it("keeps evicting when one insert requires a purge larger than the tier", async () => {
      // The tier is already at its 10-token cap when an event arrives that costs
      // three times the cap, so getting back under it means deleting every
      // event. A guard measured against the shrinking event count stops about
      // halfway and leaves the window over its hard limit.
      const store = new RecallStore({ maxEvents: 1_000, maxTokens: 10 });
      await store.record("e1", "user", "message", "abcdefghij", "info", 100);
      await store.record("e2", "user", "message", "abcdefghij", "info", 200);
      await store.record("e3", "user", "message", "abcdefghij", "info", 300);
      await store.record("big", "user", "message", "x".repeat(120), "info", 400);
      expect(store.tokens()).toBeLessThanOrEqual(10);
      expect(store.size()).toBe(0);
    });

    it("reports how many events it removed", async () => {
      const store = new RecallStore({ maxEvents: 1 });
      await store.record("e1", "user", "message", "one", "info", 100);
      await store.record("e2", "user", "message", "two", "info", 200);
      expect(await store.evict(200)).toBeGreaterThanOrEqual(0);
      // A second eviction on a compliant tier removes nothing.
      expect(await store.evict(200)).toBe(0);
    });

    it("never evicts a compliant tier", async () => {
      const store = new RecallStore();
      await store.record("e1", "user", "message", "one", "info", 100);
      expect(await store.evict(100)).toBe(0);
      expect(store.size()).toBe(1);
    });
  });
});
