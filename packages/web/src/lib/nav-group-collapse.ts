/**
 * Product navigation manifest, route matching, and independent tool disclosure preferences.
 * Three primary pages stay visible; Build, Review, and Models groups start closed.
 * The legacy all-or-nothing collapse helpers below remain for company-mode navigation.
 * Storage is injectable so blocked site data and preference restoration are testable.
 */

/**
 * Page entries of the collapsible nav group, in rendered order. Each key names its
 * route (`/<key>`), its S.nav label, and its NAV_ICONS glyph — the sidebar derives
 * its nav rows from this manifest, so the covered range is pinned here (and in the
 * unit tests) rather than duplicated. Some entries are admin-only (see below), so the
 * sidebar renders navKeysFor(user.isAdmin), not the raw manifest. Traces is deliberately
 * NOT absent any more: it used to be reachable only through the chat toolbar's panel
 * switcher, and a row for it now exists — so this sentence was describing a state the
 * manifest moved past, and a reader checking "where is Traces" would have been sent to
 * look inside the chat pane for a nav entry that is right here.
 */
export const NAV_GROUP_KEYS = [
  "cockpit",
  "topology",
  "guardian",
  "consensus",
  "contextBreakdown",
  "memory",
  "keyFleet",
  "flamegraph",
  "snapshots",
  "agents",
  "kanban",
  "pipelines",
  "wiki",
  "skills",
  "plugins",
  "models",
  "gateway",
  "machines",
  "usage",
  "benchmark",
] as const;
/** A nav entry's key. Module-local: every function that names one also takes the manifest's
 *  own union, and nothing outside this file ever spells the type. */
type NavGroupKey = (typeof NAV_GROUP_KEYS)[number];

/**
 * Entries the server refuses to a non-admin, so the sidebar does not offer them. Machines
 * installs software on another machine over ssh with the SERVER account's keys, which
 * `/api/machines` gates on `isAdmin` — a row that always answers 403 is worse than no row.
 * On a personal or desktop server the only account IS the admin, so nothing is hidden there.
 */
const ADMIN_ONLY_NAV_KEYS: ReadonlySet<NavGroupKey> = new Set<NavGroupKey>(["machines"]);

/**
 * Entries built but not yet offered. They keep their place in the manifest — the page and its
 * unit tests still exist — and are simply not put in front of anyone, so releasing one is
 * deleting its name from this set rather than restoring code.
 *
 * **This comment used to claim the route and the server routes "all still exist and are
 * reachable from a test". Neither is true:** `router.tsx` has no `/machines`, so the catch-all
 * sends it to `/chat`, and nothing imports `MachinesPage`. Only the page and its tests are
 * real. The claim was not harmless — "there is a route" is exactly what a reader checks before
 * deciding a nav key is merely hidden rather than unwired, and here it sent them the wrong way.
 * The fix is the same in both cases: say what exists, not what you wish existed.
 *
 * `machines` installs this build onto another host over ssh with the server account's keys.
 * That is a capability worth shipping deliberately rather than as a row that happens to appear,
 * so it waits for a release that means to introduce it.
 */
const UNRELEASED_NAV_KEYS: ReadonlySet<NavGroupKey> = new Set<NavGroupKey>(["machines"]);

/** Everyday destinations stay visible; tools are grouped by the job they help with. */
export const PRIMARY_NAV_KEYS = ["cockpit", "agents", "kanban"] as const;
export const NAV_TOOL_GROUPS = [
  { key: "build", keys: ["pipelines", "skills", "plugins", "memory", "wiki", "topology"] },
  {
    key: "inspect",
    keys: ["guardian", "consensus", "contextBreakdown", "flamegraph", "snapshots", "benchmark"],
  },
  { key: "manage", keys: ["models", "keyFleet", "gateway", "usage", "machines"] },
] as const satisfies readonly { key: string; keys: readonly NavGroupKey[] }[];
export type NavToolGroupKey = (typeof NAV_TOOL_GROUPS)[number]["key"];

/** Preserve special routes rather than deriving a different URL from a display label. */
export function navPathFor(key: NavGroupKey): string {
  if (key === "contextBreakdown") return "/context-breakdown";
  if (key === "keyFleet") return "/models/keys";
  if (key === "flamegraph") return "/traces/flamegraph";
  return `/${key}`;
}

/** Longest segment match: API keys must not also mark Models as the current page. */
export function currentNavKey(pathname: string, isAdmin = true): NavGroupKey | null {
  const path = pathname === "/contextBreakdown" ? "/context-breakdown" : pathname;
  return (
    navKeysFor(isAdmin)
      .filter((key) => path === navPathFor(key) || path.startsWith(`${navPathFor(key)}/`))
      .sort((a, b) => navPathFor(b).length - navPathFor(a).length)[0] ?? null
  );
}

/** New preferences intentionally do not inherit the old all-or-nothing nav expansion. */
export const NAV_TOOLS_STORAGE_PREFIX = "penguin.sidebarTools.";
export function initialToolGroupExpanded(
  group: NavToolGroupKey,
  storage?: NavCollapseStorage,
): boolean {
  try {
    return (storage ?? localStorage).getItem(`${NAV_TOOLS_STORAGE_PREFIX}${group}`) === "expanded";
  } catch {
    return false;
  }
}
export function storeToolGroupExpanded(
  group: NavToolGroupKey,
  expanded: boolean,
  storage?: NavCollapseStorage,
): void {
  try {
    (storage ?? localStorage).setItem(
      `${NAV_TOOLS_STORAGE_PREFIX}${group}`,
      expanded ? "expanded" : "collapsed",
    );
  } catch {
    /* Best effort when site storage is blocked. */
  }
}

/** The manifest as this user sees it. */
export function navKeysFor(isAdmin: boolean): readonly NavGroupKey[] {
  const offered = NAV_GROUP_KEYS.filter((key) => !UNRELEASED_NAV_KEYS.has(key));
  return isAdmin ? offered : offered.filter((key) => !ADMIN_ONLY_NAV_KEYS.has(key));
}

/** Minimal storage interface (the subset of localStorage used here); tests inject an in-memory implementation. */
export interface NavCollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The single global key (`penguin.…` naming convention); holds "collapsed" / "expanded". */
export const NAV_GROUP_COLLAPSED_KEY = "penguin.sidebarNavGroupCollapsed";

/**
 * Reads the persisted choice; only an explicit "collapsed" collapses — anything else
 * (absent / unrecognized / throwing storage) is the expanded default. `localStorage` is
 * resolved INSIDE the try, never as a default parameter: merely touching it throws a
 * SecurityError when site data is blocked (or in a partitioned iframe), and this runs
 * from a useState initializer — an escaping throw would take the sidebar's first render
 * down.
 */
export function initialNavGroupCollapsed(storage?: NavCollapseStorage): boolean {
  try {
    return (storage ?? localStorage).getItem(NAV_GROUP_COLLAPSED_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Writes the choice on every toggle (best-effort: quota limits / private browsing fail silently). */
export function storeNavGroupCollapsed(collapsed: boolean, storage?: NavCollapseStorage): void {
  try {
    (storage ?? localStorage).setItem(
      NAV_GROUP_COLLAPSED_KEY,
      collapsed ? "collapsed" : "expanded",
    );
  } catch {
    /* best-effort persistence (quota limits / private browsing) */
  }
}
