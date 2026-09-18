import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AsyncJobRegistry, JobRegistryError } from "../../src/sandbox/async-pipeline.js";

describe("async-pipeline", () => {
  describe("scheduled jobs", () => {
    // The registry uses real setTimeout handles, so the scheduling tests drive a
    // virtual clock: advancing it is what makes a pending job fire (or not).
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe("setTimeout", () => {
      it("fires once after the delay and records a completed outcome with the result", () => {
        const registry = new AsyncJobRegistry();
        const fn = vi.fn(() => "done");

        const id = registry.setTimeout(fn, 100);
        const pending = registry.records().find((record) => record.id === id);
        expect(pending?.outcome).toBeUndefined();
        expect(pending?.firedAt).toBeUndefined();

        vi.advanceTimersByTime(100);

        expect(fn).toHaveBeenCalledTimes(1);
        const record = registry.records().find((r) => r.id === id);
        expect(record?.outcome).toBe("completed");
        expect(record?.result).toBe("done");
        expect(record?.firedAt).toBeGreaterThanOrEqual(record!.scheduledAt);
        expect(record?.finishedAt).toBeGreaterThanOrEqual(record!.firedAt!);
      });

      it("does not fire before the delay has elapsed", () => {
        const registry = new AsyncJobRegistry();
        const fn = vi.fn();

        registry.setTimeout(fn, 100);
        vi.advanceTimersByTime(99);

        expect(fn).not.toHaveBeenCalled();
      });
    });

    describe("setInterval", () => {
      it("fires once per interval tick and keeps the series going", () => {
        const registry = new AsyncJobRegistry();
        const calls: number[] = [];
        let tick = 0;

        const id = registry.setInterval(() => {
          tick += 1;
          calls.push(tick);
          return tick;
        }, 50);

        vi.advanceTimersByTime(50);
        vi.advanceTimersByTime(50);
        vi.advanceTimersByTime(50);

        expect(calls).toEqual([1, 2, 3]);
        // A repeating job stays live between ticks: no outcome until something ends it.
        const record = registry.records().find((r) => r.id === id);
        expect(record?.outcome).toBeUndefined();
        expect(record?.firedAt).toBeTypeOf("number");
      });

      it("stops the series when an iteration throws and records the failure", () => {
        const registry = new AsyncJobRegistry();
        const calls: number[] = [];
        let tick = 0;

        const id = registry.setInterval(() => {
          tick += 1;
          calls.push(tick);
          if (tick === 2) throw new Error("boom");
          return tick;
        }, 50);

        vi.advanceTimersByTime(50);
        vi.advanceTimersByTime(50);
        // Plenty of virtual time elapses; the failed job must not re-arm itself.
        vi.advanceTimersByTime(5_000);

        expect(calls).toEqual([1, 2]);
        const record = registry.records().find((r) => r.id === id);
        expect(record?.outcome).toBe("failed");
        expect(String(record?.error)).toMatch(/boom/);
      });
    });

    describe("killJob", () => {
      it("cancels a pending one-shot so it never fires", () => {
        const registry = new AsyncJobRegistry();
        const fn = vi.fn();

        const id = registry.setTimeout(fn, 100);
        expect(registry.killJob(id)).toBe(true);
        vi.advanceTimersByTime(10_000);

        expect(fn).not.toHaveBeenCalled();
        const record = registry.records().find((r) => r.id === id);
        expect(record?.outcome).toBe("killed");
        expect(record?.firedAt).toBeUndefined();
      });

      it("cancels a repeating job so no further iterations fire", () => {
        const registry = new AsyncJobRegistry();
        const calls: number[] = [];
        let tick = 0;

        const id = registry.setInterval(() => {
          tick += 1;
          calls.push(tick);
        }, 50);

        vi.advanceTimersByTime(150);
        const killedAt = calls.length;
        expect(killedAt).toBe(3);

        expect(registry.killJob(id)).toBe(true);
        vi.advanceTimersByTime(5_000);

        expect(calls).toHaveLength(killedAt);
        const record = registry.records().find((r) => r.id === id);
        expect(record?.outcome).toBe("killed");
      });

      it("returns false for an id the registry does not know", () => {
        const registry = new AsyncJobRegistry();
        registry.setTimeout(() => {}, 100);

        expect(registry.killJob("job-does-not-exist")).toBe(false);
      });
    });

    describe("registry limits", () => {
      it("refuses a delay that would outlive the configured maximum", () => {
        const registry = new AsyncJobRegistry({ maxDelayMs: 1_000 });
        expect(() => registry.setTimeout(() => {}, 1_001)).toThrow(JobRegistryError);
      });

      it("refuses new jobs once the cap is reached", () => {
        const registry = new AsyncJobRegistry({ maxJobs: 2 });
        registry.setTimeout(() => {}, 1_000);
        registry.setTimeout(() => {}, 1_000);

        expect(() => registry.setTimeout(() => {}, 1_000)).toThrow(/registry is full/);
      });

      it("drains pending jobs without running them and refuses new ones", () => {
        const registry = new AsyncJobRegistry();
        const fn = vi.fn();

        const id = registry.setTimeout(fn, 100);
        expect(registry.shutdownRegistry()).toBe(1);
        vi.advanceTimersByTime(10_000);

        expect(fn).not.toHaveBeenCalled();
        const record = registry.records().find((r) => r.id === id);
        expect(record?.outcome).toBe("drained");
        expect(() => registry.setTimeout(() => {}, 10)).toThrow(/shut down/);
      });
    });
  });

  describe("async", () => {
    it("invokes only the success continuation, with the result", async () => {
      const registry = new AsyncJobRegistry();
      const onSuccess = vi.fn();
      const onError = vi.fn();

      const id = await registry.async(async () => "ok", onSuccess, onError);

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith("ok");
      expect(onError).not.toHaveBeenCalled();

      const record = registry.records().find((r) => r.id === id);
      expect(record?.outcome).toBe("completed");
      expect(record?.result).toBe("ok");
    });

    it("invokes only the error continuation, with the reason", async () => {
      const registry = new AsyncJobRegistry();
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const boom = new Error("boom");

      const id = await registry.async(
        async () => {
          throw boom;
        },
        onSuccess,
        onError,
      );

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(boom);
      expect(onSuccess).not.toHaveBeenCalled();

      const record = registry.records().find((r) => r.id === id);
      expect(record?.outcome).toBe("failed");
      expect(record?.error).toBe(boom);
    });
  });

  describe("parallel", () => {
    it("fans the main result out to every member and runs final only once all have settled", async () => {
      const registry = new AsyncJobRegistry();
      const settled: string[] = [];
      const inputs: string[] = [];
      let finalRuns = 0;

      const id = await registry.parallel(
        async () => "payload",
        [
          async (input) => {
            inputs.push(input);
            await Promise.resolve();
            settled.push("member-a");
            return "A";
          },
          async (input) => {
            inputs.push(input);
            await Promise.resolve();
            await Promise.resolve();
            settled.push("member-b");
            return "B";
          },
        ],
        async (successes, failure) => {
          // The contract: final starts only once every member has settled.
          expect(settled).toEqual(["member-a", "member-b"]);
          finalRuns += 1;
          expect(failure).toBeUndefined();
          expect(successes).toEqual(["A", "B"]);
          return "finalized";
        },
      );

      // Every member received the main function's output, exactly once each.
      expect(inputs).toEqual(["payload", "payload"]);
      expect(finalRuns).toBe(1);
      expect(settled).toEqual(["member-a", "member-b"]);

      const record = registry.records().find((r) => r.id === id);
      expect(record?.outcome).toBe("completed");
      expect(record?.result).toEqual(["A", "B"]);
    });

    it("reports a failing member to final with empty successes and still waits for the others", async () => {
      const registry = new AsyncJobRegistry();
      const events: string[] = [];

      const id = await registry.parallel(
        async () => "in",
        [
          async () => {
            await Promise.resolve();
            events.push("member-a-failed");
            throw new Error("a-boom");
          },
          async () => {
            await Promise.resolve();
            await Promise.resolve();
            events.push("member-b-done");
            return "B";
          },
        ],
        async (successes, failure) => {
          events.push("final");
          expect(successes).toEqual([]);
          expect(failure).toBeInstanceOf(Error);
          expect(String(failure)).toMatch(/a-boom/);
          return "finalized";
        },
      );

      // The surviving member was still awaited to completion before final ran.
      expect(events).toEqual(["member-a-failed", "member-b-done", "final"]);

      const record = registry.records().find((r) => r.id === id);
      expect(record?.outcome).toBe("failed");
      expect(String(record?.error)).toMatch(/a-boom/);
    });

    it("reports a failing main function to final without running the members", async () => {
      const registry = new AsyncJobRegistry();
      const members = [vi.fn(async () => "never")];
      let finalRuns = 0;

      const id = await registry.parallel(
        async () => {
          throw new Error("main-boom");
        },
        members,
        async (successes, failure) => {
          finalRuns += 1;
          expect(successes).toEqual([]);
          expect(String(failure)).toMatch(/main-boom/);
          return "finalized";
        },
      );

      expect(finalRuns).toBe(1);
      expect(members[0]).not.toHaveBeenCalled();

      const record = registry.records().find((r) => r.id === id);
      expect(record?.outcome).toBe("failed");
      expect(String(record?.error)).toMatch(/main-boom/);
    });
  });
});
