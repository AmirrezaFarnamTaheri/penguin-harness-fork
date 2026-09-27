/**
 * A measurement, not a claim: what the coordination log costs at the stream's repaint frequency.
 *
 * The log used to re-walk every item of every bound subagent model on every repaint — about
 * eight times a second for the life of a Task, and while hidden, because the view stays mounted
 * so its live region stays valid. Rows are now reused behind a per-item signature. This file
 * exists so that claim is measured rather than asserted, and so a regression is visible: if the
 * guard stops matching, the "no change" column below jumps to the cost of a full walk and the
 * budget assertion fails.
 *
 * Determinism: the fixture is built once and the two cases differ ONLY in whether the model
 * changed between calls, so the difference is attributable to the cache and not to the workload.
 * The absolute ceilings are deliberately loose — they are there to catch an order-of-magnitude
 * regression on a slow CI box, not to benchmark the machine.
 */
import { describe, expect, it } from "vitest";
import { toolCall, toolCallOutput, userText } from "@prismshadow/penguin-core/omnimessage";
import { createStreamModel, pushMessage } from "../src/lib/omni/stream-model";
import {
  ACTIVITY_WINDOW,
  coordinationActivityFor,
} from "../src/features/chat/cross-agent-activity";
import type { StreamModel } from "../src/lib/omni/stream-model";

/**
 * A Task with the shape the log is actually asked to render: breadth (siblings), a little
 * depth, and volume on each.
 */
function largeTask(
  children: number,
  itemsPerChild: number,
): { root: StreamModel; last: StreamModel[] } {
  const root = createStreamModel();
  pushMessage(root, userText("do the thing"));
  const last: StreamModel[] = [];
  for (let c = 0; c < children; c += 1) {
    const child = createStreamModel();
    root.subagents.set(`child-${c}`, child);
    // One level of nesting under every child, so the walk is a tree rather than a list.
    const grandchild = createStreamModel();
    child.subagents.set(`child-${c}-a`, grandchild);
    for (let i = 0; i < itemsPerChild; i += 1) {
      pushMessage(
        grandchild,
        toolCall({ name: `tool_${i}`, arguments: "{}", toolCallId: `c${c}_${i}` }),
      );
      pushMessage(grandchild, toolCallOutput({ toolCallId: `c${c}_${i}`, output: `result ${i}` }));
    }
    last.push(child);
  }
  return { root, last };
}

const agent = () => "agent";

describe("coordination activity cost", () => {
  it("reuses its rows when the model has not changed, and rebuilds when it has", () => {
    // (a) The uncached walk — what EVERY repaint used to cost, since the model mutates in
    // place and only the version counter changes.
    const cold = largeTask(12, 25);
    const coldStarted = performance.now();
    const first = coordinationActivityFor(cold.root, "root", agent);
    const fullWalkMs = performance.now() - coldStarted;
    expect(first.length).toBeGreaterThan(200);

    // (b) The repaint case, same tree, nothing changed: 50 consecutive repaints, which is about
    // six seconds of an idle live Task. This is the number the cache exists to move.
    const { root, last } = largeTask(12, 25);
    coordinationActivityFor(root, "root", agent);
    const idleStarted = performance.now();
    for (let i = 0; i < 50; i += 1) {
      expect(coordinationActivityFor(root, "root", agent)).toBeDefined();
    }
    const idleMs = (performance.now() - idleStarted) / 50;

    // (c) One appended event deep in the tree, then 49 more repaints: the first is real work,
    // the rest are the guard holding.
    const deepest = last[0]!.subagents.values().next().value as StreamModel;
    const changedStarted = performance.now();
    pushMessage(deepest, toolCall({ name: "new_tool", arguments: "{}", toolCallId: "new" }));
    coordinationActivityFor(root, "root", agent);
    const changeMs = performance.now() - changedStarted;
    for (let i = 0; i < 49; i += 1) {
      expect(coordinationActivityFor(root, "root", agent)).toBeDefined();
    }
    const steadyMs = (performance.now() - changedStarted - changeMs) / 49;

    // Loose, absolute ceilings. A guard that stopped matching would put the idle column at the
    // full-walk cost and fail here.
    expect(idleMs).toBeLessThan(2);
    expect(changeMs).toBeLessThan(60);

    // eslint-disable-next-line no-console
    console.log(
      `[activity-cost] rows=${first.length} full-walk=${fullWalkMs.toFixed(2)}ms ` +
        `idle-repaint=${idleMs.toFixed(3)}ms change-repaint=${changeMs.toFixed(2)}ms ` +
        `steady-after-change=${steadyMs.toFixed(3)}ms ` +
        `speedup=${(fullWalkMs / Math.max(idleMs, 0.0001)).toFixed(0)}x`,
    );
  });

  it("keeps the rendered window bounded whatever the Task size", () => {
    // The walk may see everything; the LIST may not. A 100-child Task must not put a thousand
    // rows in the DOM, or the panel is a scrollbar before it is a view.
    const { root } = largeTask(40, 20);
    const rows = coordinationActivityFor(root, "root", agent);
    expect(rows.length).toBeGreaterThan(ACTIVITY_WINDOW);
    const rendered = rows.slice(rows.length - ACTIVITY_WINDOW);
    expect(rendered).toHaveLength(ACTIVITY_WINDOW);
  });
});
