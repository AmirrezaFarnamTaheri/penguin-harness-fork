import { describe, expect, it } from "vitest";
import { MergeQueue, pumpOpener } from "../../src/internal/merge-queue.js";
import type { OmniMessage } from "../../src/omnimessage/index.js";

function msg(n: number): OmniMessage {
  return {
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { n },
  } as unknown as OmniMessage;
}

describe("MergeQueue", () => {
  it("yields messages in push order and closes once producers drain", async () => {
    const queue = new MergeQueue();
    queue.addProducer();
    queue.push(msg(1));
    queue.push(msg(2));

    expect(await queue.next()).toMatchObject({ payload: { n: 1 } });
    expect(await queue.next()).toMatchObject({ payload: { n: 2 } });

    queue.removeProducer();
    expect(await queue.next()).toBeNull();
  });

  it("clamps a double deregister instead of hanging the consumer below zero producers", async () => {
    const queue = new MergeQueue();
    queue.addProducer();
    queue.removeProducer();

    // A deregister with no matching registration used to drive producers to -1, so
    // producers === 0 never held again and next() awaited a wakeup that never came.
    queue.removeProducer();
    expect(queue.producerUnderflows).toBe(1);

    await expect(queue.next()).resolves.toBeNull();
  });

  it("serves concurrent consumers without one clobbering the other's wakeup", async () => {
    const queue = new MergeQueue();
    queue.addProducer();

    const first = queue.next();
    const second = queue.next();

    queue.push(msg(10));
    queue.push(msg(20));
    queue.removeProducer();

    expect(await first).toMatchObject({ payload: { n: 10 } });
    expect(await second).toMatchObject({ payload: { n: 20 } });
  });

  it("resolves every waiting consumer when the queue closes", async () => {
    const queue = new MergeQueue();
    queue.addProducer();

    const waiters = [queue.next(), queue.next(), queue.next()];
    queue.removeProducer();

    for (const waiter of waiters) {
      await expect(waiter).resolves.toBeNull();
    }
  });

  it("pumps an opener's published records until it settles", async () => {
    const { queue, result } = pumpOpener(async (emit) => {
      emit(msg(1));
      emit(msg(2));
      return "done";
    });

    const drained: number[] = [];
    for (;;) {
      const next = await queue.next();
      if (next === null) break;
      drained.push((next.payload as unknown as { n: number }).n);
    }

    expect(drained).toEqual([1, 2]);
    await expect(result).resolves.toBe("done");
  });

  it("still drains to the end when the opener rejects", async () => {
    const { queue, result } = pumpOpener(async (emit) => {
      emit(msg(1));
      throw new Error("opener failed");
    });

    const drained: number[] = [];
    for (;;) {
      const next = await queue.next();
      if (next === null) break;
      drained.push((next.payload as unknown as { n: number }).n);
    }

    expect(drained).toEqual([1]);
    await expect(result).rejects.toThrow("opener failed");
  });
});
