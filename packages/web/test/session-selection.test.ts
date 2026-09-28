/**
 * session-selection.ts unit tests: the conversation list's multi-selection. The invariant
 * under test is that a marked row is ALWAYS a row the list is currently showing — a search
 * query, a collapsed group, a Project switch or a paged folder must not leave a marked id
 * behind, because a batch action driven from this state would then operate on conversations
 * the user cannot see or count. Everything else is the interaction contract: the anchor is
 * a position (untoggling a row leaves it), Shift-click replaces with the range, a Shift-click
 * with no anchor selects one row rather than guessing, an id outside the visible list is
 * ignored, and a reduction that changes nothing returns the input reference so the list
 * does not re-render for a no-op.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  pruneSelection,
  reduceSelection,
  selectedInOrder,
} from "../src/lib/session-selection";
import type { SelectionAction, SelectionState } from "../src/lib/session-selection";

const LIST = ["a", "b", "c", "d", "e"] as const;

/** Fold a sequence of actions against one fixed visible list. */
function run(actions: SelectionAction[], visible: readonly string[] = LIST): SelectionState {
  return actions.reduce<SelectionState>(
    (state, action) => reduceSelection(state, action, visible),
    EMPTY_SELECTION,
  );
}

const ids = (state: SelectionState): string[] => [...state.selected].sort();

describe("reduceSelection — marking", () => {
  it("toggles a row on and off, and the anchor stays on the row last touched", () => {
    const on = run([{ kind: "toggle", id: "c" }]);
    expect(ids(on)).toEqual(["c"]);
    expect(on.anchor).toBe("c");

    const off = reduceSelection(on, { kind: "toggle", id: "c" }, LIST);
    expect(ids(off)).toEqual([]);
    // The anchor is a position, not a selection: untoggling the anchor row does not lose it.
    expect(off.anchor).toBe("c");
  });

  it("accumulates scattered marks and never mutates the input set", () => {
    const first = run([{ kind: "toggle", id: "a" }]);
    const second = reduceSelection(first, { kind: "toggle", id: "e" }, LIST);
    expect(ids(second)).toEqual(["a", "e"]);
    expect(ids(first)).toEqual(["a"]);
  });

  it("only() replaces the whole selection", () => {
    const state = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "b" },
      { kind: "only", id: "d" },
    ]);
    expect(ids(state)).toEqual(["d"]);
  });

  it("all() marks every visible row and is idempotent", () => {
    const all = run([{ kind: "all" }]);
    expect(ids(all)).toEqual(["a", "b", "c", "d", "e"]);
    expect(reduceSelection(all, { kind: "all" }, LIST)).toBe(all);
  });

  it("all() follows the visible list, so a filtered query marks only its matches", () => {
    const filtered = ["b", "d"];
    const state = reduceSelection(EMPTY_SELECTION, { kind: "all" }, filtered);
    expect(ids(state)).toEqual(["b", "d"]);
  });

  it("clear() empties the selection and the anchor", () => {
    const state = run([{ kind: "toggle", id: "b" }, { kind: "clear" }]);
    expect(state.selected.size).toBe(0);
    expect(state.anchor).toBeNull();
  });

  it("ignores an id that is not in the visible list", () => {
    const state = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "zz" },
    ]);
    expect(ids(state)).toEqual(["a"]);
    expect(state.anchor).toBe("a");
  });
});

describe("reduceSelection — shift-click ranges", () => {
  it("selects the span from the anchor to the clicked row, forwards and backwards", () => {
    const forward = run([
      { kind: "toggle", id: "b" },
      { kind: "range", id: "d" },
    ]);
    expect(ids(forward)).toEqual(["b", "c", "d"]);

    const backward = run([
      { kind: "toggle", id: "d" },
      { kind: "range", id: "b" },
    ]);
    expect(ids(backward)).toEqual(["b", "c", "d"]);
  });

  it("replaces rather than accumulates, so the result does not depend on earlier marks", () => {
    const withHistory = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "e" },
      { kind: "range", id: "b" },
    ]);
    // Anchor is e, so the span is b…e. "a" was marked a moment ago and is not in the span,
    // so it is no longer marked: the result is a function of the two rows in the range
    // action and of nothing before them.
    expect(ids(withHistory)).toEqual(["b", "c", "d", "e"]);

    // Same shift-click, no earlier marks: the same answer.
    const withoutHistory = run([
      { kind: "toggle", id: "e" },
      { kind: "range", id: "b" },
    ]);
    expect(ids(withoutHistory)).toEqual(ids(withHistory));
  });

  it("selects a single row when there is no anchor to extend from", () => {
    const state = run([{ kind: "range", id: "c" }]);
    expect(ids(state)).toEqual(["c"]);
    expect(state.anchor).toBe("c");
  });

  it("keeps working from a row that is no longer marked", () => {
    // click a, cmd-click a again (anchor stays on a, nothing marked), shift-click c
    const state = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "a" },
      { kind: "range", id: "c" },
    ]);
    expect(ids(state)).toEqual(["a", "b", "c"]);
  });

  it("follows the visible order, not the display-independent id order", () => {
    const reordered = ["e", "d", "c", "b", "a"];
    const state = run(
      [
        { kind: "toggle", id: "e" },
        { kind: "range", id: "c" },
      ],
      reordered,
    );
    expect(selectedInOrder(state, reordered)).toEqual(["e", "d", "c"]);
  });
});

describe("reduceSelection — the visibility invariant", () => {
  it("drops marked rows a search query filtered out", () => {
    const marked = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "c" },
    ]);
    // The list now shows only c: a is no longer reachable, so it cannot stay marked.
    const afterSearch = reduceSelection(marked, { kind: "toggle", id: "c" }, ["c"]);
    expect(ids(afterSearch)).toEqual([]);
  });

  it("drops the anchor when its row left the list, and a range click then selects one row", () => {
    const marked = run([
      { kind: "toggle", id: "a" },
      { kind: "range", id: "c" },
    ]);
    expect(marked.anchor).toBe("c");
    // `all` re-derives the selection from the visible list without touching the anchor, so
    // this is where the prune is observable: c is gone, and with it the anchor.
    const afterCollapse = reduceSelection(marked, { kind: "all" }, ["d", "e"]);
    expect(afterCollapse.anchor).toBeNull();
    const rangeClick = reduceSelection(afterCollapse, { kind: "range", id: "e" }, ["d", "e"]);
    // Conservative: with no anchor, one row — never a guessed range over a batch action.
    expect(ids(rangeClick)).toEqual(["e"]);
  });

  it("empties the selection when the list is empty (a Project with no conversations)", () => {
    const marked = run([{ kind: "toggle", id: "a" }]);
    const afterProjectSwitch = reduceSelection(marked, { kind: "all" }, []);
    expect(afterProjectSwitch.selected.size).toBe(0);
    expect(afterProjectSwitch.anchor).toBeNull();
  });

  it("keeps a still-visible anchor and still-visible marks across a prune", () => {
    const marked = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "b" },
      { kind: "toggle", id: "c" },
    ]);
    expect(marked.anchor).toBe("c");
    const narrowed = reduceSelection(marked, { kind: "all" }, ["b", "c"]);
    // a is gone, so it cannot stay marked — and c is still on screen, so it is still the
    // anchor a Shift-click extends from.
    expect(ids(narrowed)).toEqual(["b", "c"]);
    expect(narrowed.anchor).toBe("c");
  });
});

describe("reduceSelection — identity", () => {
  it("returns the input state when an action changes nothing", () => {
    const marked = run([{ kind: "toggle", id: "b" }]);
    // Re-marking an already marked row through `all` on an already-full selection.
    const all = reduceSelection(marked, { kind: "all" }, ["b"]);
    expect(reduceSelection(all, { kind: "all" }, ["b"])).toBe(all);
    expect(reduceSelection(marked, { kind: "only", id: "b" }, LIST)).toBe(marked);
    expect(reduceSelection(EMPTY_SELECTION, { kind: "clear" }, LIST)).toBe(EMPTY_SELECTION);
  });

  it("returns a fresh state when a prune actually removed something", () => {
    const marked = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "b" },
    ]);
    const pruned = reduceSelection(marked, { kind: "all" }, ["a"]);
    expect(pruned).not.toBe(marked);
    expect(ids(pruned)).toEqual(["a"]);
  });
});

describe("pruneSelection", () => {
  it("drops marked rows that left the screen and keeps the rest", () => {
    const state = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "c" },
    ]);
    const pruned = pruneSelection(state, ["a", "b"]);
    expect(ids(pruned)).toEqual(["a"]);
  });

  it("never adds a row, even one that is on screen and unmarked", () => {
    const state = run([{ kind: "toggle", id: "a" }]);
    // The whole list is visible and two of its rows are unmarked; a prune that added them
    // would silently widen a batch the user never drew.
    expect(ids(pruneSelection(state, LIST))).toEqual(["a"]);
  });

  it("drops an anchor that left the screen, and keeps one that stayed", () => {
    const gone = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "c" },
    ]);
    expect(pruneSelection(gone, ["a"]).anchor).toBeNull();
    expect(pruneSelection(gone, ["a", "c"]).anchor).toBe("c");
  });

  it("returns the input state by reference when nothing was dropped", () => {
    const state = run([
      { kind: "toggle", id: "a" },
      { kind: "toggle", id: "b" },
    ]);
    expect(pruneSelection(state, LIST)).toBe(state);
    expect(pruneSelection(EMPTY_SELECTION, LIST)).toBe(EMPTY_SELECTION);
  });

  it("empties the selection when the list empties under it", () => {
    const state = run([{ kind: "toggle", id: "a" }]);
    const emptied = pruneSelection(state, []);
    expect(emptied.selected.size).toBe(0);
    expect(emptied.anchor).toBeNull();
  });
});

describe("selectedInOrder", () => {
  it("returns the marked ids in display order, not insertion order", () => {
    const state = run([
      { kind: "toggle", id: "e" },
      { kind: "toggle", id: "b" },
    ]);
    expect(selectedInOrder(state, LIST)).toEqual(["b", "e"]);
  });

  it("skips an id that is marked but no longer visible", () => {
    const state = run([
      { kind: "toggle", id: "zz" },
      { kind: "toggle", id: "b" },
    ]);
    expect(selectedInOrder(state, LIST)).toEqual(["b"]);
  });

  it("is empty for an empty selection", () => {
    expect(selectedInOrder(EMPTY_SELECTION, LIST)).toEqual([]);
  });
});
