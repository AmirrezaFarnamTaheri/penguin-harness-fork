/**
 * Multi-selection for the sidebar's conversation list (pure decisions, unit tested).
 *
 * The list is a scroller over data that keeps moving under it: a search query filters it, a
 * group collapses, a folder pages, the Project changes. A selection is therefore never a
 * bare set of ids — it is a set of ids **plus** the row a Shift-click extends from, and
 * both are only ever meaningful against the rows the user can currently see.
 *
 * The one invariant, enforced at the top of every reduction rather than in each call site:
 * the result is intersected with the visible id list. Without it a Project switch, a typed
 * query or a collapsed group leaves ids in the set that no longer render — and a batch
 * action is then operating on conversations the user cannot see, cannot count, and cannot
 * check. That is a privileged action on a subject the operator cannot name, which is the
 * shape of a confused-deputy bug rather than a cosmetic bug. Pruning inside the reducer
 * makes it impossible to forget: there is no code path that grows the set without passing
 * the visible list in.
 *
 * The anchor is a POSITION, not a selection: untoggling a row leaves the anchor there, so
 * Shift-click still extends from the row you last touched. A row that has left the list
 * drops the anchor, and a Shift-click with no anchor selects only the row clicked rather
 * than guessing a range — on a selection that can drive a bulk action, "less than the user
 * pointed at" is the correct failure.
 *
 * Shift-click REPLACES the selection with the range (Finder / VS Code / Gmail convention).
 * It is the only convention where "the thing I Shift-clicked is the only thing that
 * changed" stays true; the alternative (add the range to what is already selected) makes
 * the count after a Shift-click depend on history the user cannot see.
 *
 * Every reduction returns the INPUT state by reference when nothing changed, so a React
 * state setter on this value skips the re-render of a list that can hold hundreds of rows
 * (pinned-sessions.ts convention).
 */

/** A conversation-list selection: which rows are marked, and which one a Shift-click extends from. */
export interface SelectionState {
  readonly selected: ReadonlySet<string>;
  /** Row id a Shift-click extends from; null when unset, or when the anchor has left the visible list. */
  readonly anchor: string | null;
}

/** Nothing selected, no anchor — the state every list starts from. */
export const EMPTY_SELECTION: SelectionState = { selected: new Set<string>(), anchor: null };

/** What a pointer or key did to the selection. */
export type SelectionAction =
  /** Click / Cmd-click: mark the row, or unmark it if it was marked. */
  | { readonly kind: "toggle"; readonly id: string }
  /** Cmd-click on the only marked row, or "select this and nothing else". */
  | { readonly kind: "only"; readonly id: string }
  /** Shift-click: mark every row between the anchor and this one, replacing what was marked. */
  | { readonly kind: "range"; readonly id: string }
  /** "Select all": every row currently rendered. */
  | { readonly kind: "all" }
  /** Esc / "Cancel" / any completed batch action. */
  | { readonly kind: "clear" };

/** The rows the list can show, in display order. Range arithmetic reads this order, so it is the order the user sees. */
export type VisibleIds = readonly string[];

/**
 * The invariant: intersect the carried selection with what is visible, and drop an anchor
 * that is no longer on screen. Element-wise equality returns the input reference so a
 * no-op reduction costs the caller nothing.
 */
function prune(state: SelectionState, visible: VisibleIds): SelectionState {
  const visibleSet = new Set(visible);
  let changed = false;
  const selected = new Set<string>();
  for (const id of state.selected) {
    if (visibleSet.has(id)) selected.add(id);
    else changed = true;
  }
  const anchor = state.anchor !== null && visibleSet.has(state.anchor) ? state.anchor : null;
  if (anchor !== state.anchor) changed = true;
  if (!changed) return state;
  return { selected, anchor };
}

/**
 * Drop every marked row that is no longer on screen, and an anchor that has left with them.
 * Never ADDS a row.
 *
 * This is the half of the invariant that has to run on its own: `reduceSelection` applies an
 * action, and a list that changed under the user — a search query typed, a group collapsed,
 * the Project switched — produces no action. The sidebar runs this after every commit so
 * the COUNT in the batch bar keeps describing rows the user can still see; the batch actions
 * re-intersect at the moment they run regardless, so nothing here is load-bearing for safety.
 *
 * Returns the INPUT state by reference when nothing was dropped.
 */
export function pruneSelection(state: SelectionState, visible: VisibleIds): SelectionState {
  return prune(state, visible);
}

/**
 * Apply one action to the selection, given the rows the list currently shows.
 *
 * An id that is not in `visible` is ignored rather than added: the only way to reach a row
 * is to be looking at it. That is what makes the batch actions safe to drive from this
 * state alone — every marked row in it is a row the user can see and count.
 */
export function reduceSelection(
  state: SelectionState,
  action: SelectionAction,
  visible: VisibleIds,
): SelectionState {
  const base = prune(state, visible);
  const visibleSet = new Set(visible);
  switch (action.kind) {
    case "clear":
      return base.selected.size === 0 && base.anchor === null ? base : EMPTY_SELECTION;
    case "all": {
      if (base.selected.size === visible.length && visible.every((id) => base.selected.has(id))) {
        return base;
      }
      return { selected: new Set(visible), anchor: base.anchor };
    }
    case "only": {
      if (!visibleSet.has(action.id)) return base;
      if (base.selected.size === 1 && base.selected.has(action.id) && base.anchor === action.id) {
        return base;
      }
      return { selected: new Set([action.id]), anchor: action.id };
    }
    case "toggle": {
      if (!visibleSet.has(action.id)) return base;
      const next = new Set(base.selected);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return { selected: next, anchor: action.id };
    }
    case "range": {
      if (!visibleSet.has(action.id)) return base;
      if (base.anchor === null)
        return reduceSelection(base, { kind: "only", id: action.id }, visible);
      const from = visible.indexOf(base.anchor);
      const to = visible.indexOf(action.id);
      // Both ids were just proven present in the visible set, so neither index is -1; the
      // guard is here so a future VisibleIds with duplicates cannot produce a NaN range.
      if (from < 0 || to < 0)
        return reduceSelection(base, { kind: "only", id: action.id }, visible);
      // From EMPTY, not from the carried selection: Shift-click replaces, so what stays
      // marked is a function of the two rows involved and nothing else.
      const next = new Set<string>();
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i += 1) next.add(visible[i]!);
      return { selected: next, anchor: action.id };
    }
  }
}

/**
 * Marking count plus the ids themselves, in display order — the shape a batch action
 * consumes. Ordered so an error message, a confirmation and a log line all name the same
 * conversations in the same order the user saw them, rather than in Set insertion order.
 */
export function selectedInOrder(state: SelectionState, visible: VisibleIds): readonly string[] {
  return visible.filter((id) => state.selected.has(id));
}
