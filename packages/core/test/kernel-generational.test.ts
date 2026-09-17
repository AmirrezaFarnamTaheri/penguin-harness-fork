/**
 * T29: pin the real HMR fence, not a second config-reload mechanism.
 * Code generations may share an iface version; `v` versions parked data only.
 * The platform stops active work on dispose and exposes its asynchronous tail as
 * drained(). The kernel must not boot the successor until that tail settles.
 */
import { describe, expect, it } from "vitest";
import { boot, defineIface, initialDoc, schema, type, upgrade } from "../src/kernel/index.js";
import type { Impl, Park, Resources } from "../src/kernel/index.js";

type Context = { prompt: string };
interface TurnApi extends Park {
  prompt(): string;
  drained(): Promise<void> | undefined;
}

const resources: Resources = {
  register: () => () => {},
  claim: () => undefined,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function turnIface(version = 1, migrate = false) {
  return defineIface<TurnApi, Context>({
    name: "Turn",
    version,
    context: schema(type({ prompt: "string" })),
    methods: ["park", "prompt", "drained"],
    migrations: migrate ? { 1: () => ({ prompt: "v2" }) } : {},
  });
}

function generation(
  prompt: string,
  events: string[],
  tail?: Promise<void>,
): Impl<TurnApi, Context> {
  return {
    create(ctx, context) {
      events.push(`boot:${prompt}`);
      let draining: Promise<void> | undefined;
      ctx.effect(() => {
        events.push(`dispose:${prompt}`);
        draining = tail;
      });
      return {
        park: () => ({ ...context }),
        prompt: () => prompt,
        drained: () => draining,
      };
    },
  };
}

describe("kernel generational fencing", () => {
  it.each([false, true])(
    "fences pending old work before successor boot (migration=%s)",
    async (migrate) => {
      const events: string[] = [];
      const tail = deferred();
      const oldIface = turnIface();
      const old = await boot(
        generation("v1", events, tail.promise),
        oldIface,
        initialDoc(oldIface, { prompt: "v1" }),
        resources,
      );
      // A callback already executing in the old generation retains its closures.
      const activeTurn = tail.promise.then(() => {
        events.push(`finish:${old.api.prompt()}`);
        return old.api.prompt();
      });
      const nextIface = turnIface(migrate ? 2 : 1, migrate);
      const swapping = upgrade({
        current: old,
        impl: generation("v2", events),
        iface: nextIface,
        resources,
      });
      try {
        // Let a mistakenly non-awaited drain reach create(); no timing/sleep dependency.
        await Promise.resolve();
        expect(events).toEqual(["boot:v1", "dispose:v1"]);
        expect(old.api.prompt()).toBe("v1");
        expect(old.park().self).toEqual({ prompt: "v1" });
      } finally {
        tail.resolve();
      }
      expect(await activeTurn).toBe("v1");
      const result = await swapping;
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error(`Unexpected swap: ${result.status}`);
      try {
        expect(events).toEqual(["boot:v1", "dispose:v1", "finish:v1", "boot:v2"]);
        expect(result.mode).toBe(migrate ? "migrated" : "silent");
        expect(result.instance.api.prompt()).toBe("v2");
        expect(result.instance.park()).toEqual({
          v: migrate ? 2 : 1,
          self: { prompt: migrate ? "v2" : "v1" },
          children: {},
        });
      } finally {
        result.instance.dispose();
      }
    },
  );

  it("blocks an incompatible data version without disposing the active generation", async () => {
    const events: string[] = [];
    const iface = turnIface();
    const old = await boot(
      generation("v1", events),
      iface,
      initialDoc(iface, { prompt: "v1" }),
      resources,
    );
    try {
      const result = await upgrade({
        current: old,
        impl: generation("v2", events),
        iface: turnIface(2),
        resources,
      });
      expect(result).toMatchObject({
        status: "blocked",
        missing: ["$.v: no migration path from v1 to v2"],
        doc: { v: 1, self: { prompt: "v1" }, children: {} },
      });
      expect(events).toEqual(["boot:v1"]);
      expect(old.api.prompt()).toBe("v1");
    } finally {
      old.dispose();
    }
  });

  it("never boots a successor after a rejected drain and returns recoverable state", async () => {
    const events: string[] = [];
    const tail = deferred();
    const iface = turnIface();
    const impl = generation("v1", events, tail.promise);
    const old = await boot(impl, iface, initialDoc(iface, { prompt: "v1" }), resources);
    const swapping = upgrade({ current: old, impl: generation("v2", events), iface, resources });
    const error = new Error("old generation failed to drain");
    tail.reject(error);
    const result = await swapping;
    expect(result).toEqual({
      status: "failed",
      error,
      doc: { v: 1, self: { prompt: "v1" }, children: {} },
    });
    expect(events).toEqual(["boot:v1", "dispose:v1"]);
    if (result.status !== "failed") throw new Error(`Unexpected swap: ${result.status}`);
    const recovered = await boot(generation("v1", events), iface, result.doc, resources);
    try {
      expect(recovered.api.prompt()).toBe("v1");
      expect(recovered.park()).toEqual(result.doc);
    } finally {
      recovered.dispose();
    }
  });
});
