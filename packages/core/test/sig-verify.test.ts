import { expect, it } from "vitest";
import { checkTree, parseManifest } from "../src/kernel/index.js";
import type { IfaceTable } from "../src/kernel/index.js";

it("rejects a serialized provider returning string where the consumer requires boolean", () => {
  const table: IfaceTable = {
    ifaces: {
      "provider#Runner": {
        name: "Runner",
        methods: { run: { params: [{ data: "string" }], returns: { data: "string" } } },
        slots: {},
      },
      "consumer#Runner": {
        name: "Runner",
        methods: { run: { params: [{ data: "string" }], returns: { data: "boolean" } } },
        slots: {},
      },
    },
    types: {},
  };
  const transported: IfaceTable = JSON.parse(JSON.stringify(table));
  const empty = { requires: {}, provides: {}, contributes: {}, children: [] };
  const root = {
    manifest: parseManifest({ ...empty, name: "root", children: ["provider", "consumer"] }),
    children: [
      {
        manifest: parseManifest({ ...empty, name: "provider", provides: { runner: "Runner" } }),
        children: [],
      },
      {
        manifest: parseManifest({
          ...empty,
          name: "consumer",
          requires: { runner: { from: "provider", iface: "Runner" } },
        }),
        children: [],
      },
    ],
  };
  expect(checkTree(root, transported).problems).toEqual([
    {
      path: "/root/consumer",
      kind: "mismatch",
      alias: "runner",
      from: "provider",
      method: "run",
      why: "returns string, caller expects boolean",
    },
  ]);
});
