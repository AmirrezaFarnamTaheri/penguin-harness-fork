/**
 * DOM interaction classification rules.
 *
 * Ports the rule engine of the donor's in-page DOM tree builder. That file runs inside the page
 * against live DOM objects; the rules themselves — which tags, roles, cursors, ARIA attributes
 * and overflow states count as interactive — are pure data and are reproduced here so they can be
 * exercised server-side over a serialized node, or used to generate the in-page script.
 *
 * Design decisions preserved from the donor, because each is load-bearing for detection quality:
 *  - Cursor style is the strongest single signal (`pointer` alone resolves most interactive
 *    elements), so it is checked first and short-circuits to true.
 *  - Disabled/readonly/inert form controls are NOT interactive, and `not-allowed` / `wait`
 *    cursors override an otherwise-interactive tag.
 *  - An interactive element nested inside a highlighted one is only a separate target when it is
 *    a *distinct* interaction (a `<span>` inside a `<button>` usually triggers the same handler;
 *    a `<select>` inside a menu does not). See `isElementDistinctInteraction`.
 *  - Scrollable containers are always interactive and always distinct, because an agent needs
 *    their index to scroll them.
 *  - `viewportExpansion === -1` means "consider everything visible" (whole-page harvest).
 *
 * The donor also probes `getEventListeners` / `getEventListenersForNode`, which only exist in the
 * DevTools console context and are undefined under `page.evaluate`. That probing is kept here as
 * the `hasEventListeners` hook so an in-page caller can supply it if it has the API, but the
 * fallback path (inline `on*` attributes) is what actually runs in a page.
 */

export interface DomNodeDescriptor {
  tagName: string;
  attributes: Record<string, string>;
  className?: string;
  role?: string;
  isContentEditable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  inert?: boolean;
  /** Computed style fields the rules read. Missing ⇒ treated as unset. */
  style?: {
    cursor?: string;
    display?: string;
    visibility?: string;
    overflowX?: string;
    overflowY?: string;
    scrollbarWidth?: string;
    scrollbarGutter?: string;
    position?: string;
  };
  /** Layout metrics; a node with zero area is not visible. */
  offsetWidth?: number;
  offsetHeight?: number;
  /** Scroll metrics, present when the node was tested for scrollability. */
  scroll?: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    scrollTop: number;
    scrollLeft: number;
  };
  /** Optional: the caller's event-listener probe (available only in a DevTools context). */
  hasEventListeners?: (descriptor: DomNodeDescriptor) => boolean;
}

/** Containers that are always walked even when they have no interactive descendants. */
export const ALWAYS_ACCEPT_TAGS = new Set([
  "body",
  "div",
  "main",
  "article",
  "section",
  "nav",
  "header",
  "footer",
]);

/** Leaf elements whose subtree is pruned: they carry no agent-useful structure. */
export const LEAF_ELEMENT_DENYLIST = new Set([
  "svg",
  "script",
  "style",
  "link",
  "meta",
  "noscript",
  "template",
]);

/** Tags that are interactive by construction. */
export const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "details",
  "summary",
  "label",
  "option",
  "optgroup",
  "fieldset",
  "legend",
]);

/** ARIA roles implying interactivity. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "menu",
  "menubar",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "radio",
  "checkbox",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "combobox",
  "searchbox",
  "textbox",
  "listbox",
  "option",
  "scrollbar",
]);

/** Cursor styles that indicate the element responds to input. */
export const INTERACTIVE_CURSORS = new Set([
  "pointer",
  "move",
  "text",
  "grab",
  "grabbing",
  "cell",
  "copy",
  "alias",
  "all-scroll",
  "col-resize",
  "context-menu",
  "crosshair",
  "e-resize",
  "ew-resize",
  "help",
  "n-resize",
  "ne-resize",
  "nesw-resize",
  "ns-resize",
  "nw-resize",
  "nwse-resize",
  "row-resize",
  "s-resize",
  "se-resize",
  "sw-resize",
  "vertical-text",
  "w-resize",
  "zoom-in",
  "zoom-out",
]);

/** Cursor styles that suppress an otherwise-interactive tag. */
export const NON_INTERACTIVE_CURSORS = new Set([
  "not-allowed",
  "no-drop",
  "wait",
  "progress",
  "initial",
  "inherit",
]);

/** `disabled`-like attributes checked on the element. */
export const EXPLICIT_DISABLE_TAGS = new Set(["disabled", "readonly"]);

/** ARIA attributes whose presence implies the element manages its own interaction state. */
export const INTERACTIVE_ARIA_ATTRS: readonly string[] = [
  "aria-expanded",
  "aria-checked",
  "aria-selected",
  "aria-pressed",
  "aria-haspopup",
  "aria-controls",
  "aria-activedescendant",
  "aria-current",
];

/** Tags that are always a distinct interaction from their parent. */
export const DISTINCT_INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "details",
  "label",
  "option",
  "li",
]);

/** Roles that are always a distinct interaction from their parent. */
export const DISTINCT_INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "radio",
  "checkbox",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "combobox",
  "searchbox",
  "textbox",
  "listbox",
  "listitem",
  "treeitem",
  "row",
  "option",
  "scrollbar",
]);

/** Test/automation attributes that mark an element as a first-class target. */
export const TEST_ID_ATTRIBUTES = new Set(["data-testid", "data-cy", "data-test"]);

/** Class-name tokens that heuristically signal a clickable wrapper. */
export const HEURISTIC_INTERACTIVE_CLASS_REGEX = /\b(btn|clickable|menu|item|entry|link)\b/i;

/** Sub-pixel scroll distances below this many pixels are treated as not scrollable. */
export const SCROLLABLE_THRESHOLD_PX = 4;

/** Selectors for containers whose descendants may be independently interactive. */
export const INTERACTIVE_CONTAINER_SELECTOR =
  "button,a,[role='button'],.menu,.dropdown,.list,.toolbar";

/** Nodes flagged with this attribute are pruned along with their subtree. */
export const IGNORE_ATTRIBUTES = new Set(["data-browser-use-ignore", "data-page-agent-ignore"]);

/** True when a node should be walked at all. */
export function isElementAccepted(descriptor: DomNodeDescriptor): boolean {
  const tagName = descriptor.tagName.toLowerCase();
  if (ALWAYS_ACCEPT_TAGS.has(tagName)) return true;
  return !LEAF_ELEMENT_DENYLIST.has(tagName);
}

/** True when the node occupies area and is not display:none / visibility:hidden. */
export function isElementVisible(descriptor: DomNodeDescriptor): boolean {
  if ((descriptor.offsetWidth ?? 0) <= 0 && (descriptor.offsetHeight ?? 0) <= 0) return false;
  const style = descriptor.style;
  if (!style) return true;
  return style.visibility !== "hidden" && style.display !== "none";
}

/** The donor's scrollability test, verbatim in logic. */
export function computeScrollData(
  descriptor: DomNodeDescriptor,
): { top: number; right: number; bottom: number; left: number } | null {
  const style = descriptor.style;
  const scroll = descriptor.scroll;
  if (!style || !scroll) return null;
  if (style.display === "inline" || style.display === "inline-block") return null;

  const scrollableX = style.overflowX === "auto" || style.overflowX === "scroll";
  const scrollableY = style.overflowY === "auto" || style.overflowY === "scroll";
  // scrollbar-width/scrollbar-gutter only appear on elements designed to scroll; they signal
  // scroll intent even when overflow is hidden (e.g. overflow:auto on :hover).
  const hasScrollbarSignal =
    (!!style.scrollbarWidth && style.scrollbarWidth !== "auto") ||
    (!!style.scrollbarGutter && style.scrollbarGutter !== "auto");

  if (!scrollableX && !scrollableY && !hasScrollbarSignal) return null;

  const overflowWidth = scroll.scrollWidth - scroll.clientWidth;
  const overflowHeight = scroll.scrollHeight - scroll.clientHeight;
  if (overflowWidth < SCROLLABLE_THRESHOLD_PX && overflowHeight < SCROLLABLE_THRESHOLD_PX) {
    return null;
  }
  if (!scrollableY && !hasScrollbarSignal && overflowWidth < SCROLLABLE_THRESHOLD_PX) return null;
  if (!scrollableX && !hasScrollbarSignal && overflowHeight < SCROLLABLE_THRESHOLD_PX) return null;

  return {
    top: scroll.scrollTop,
    left: scroll.scrollLeft,
    right: overflowWidth - scroll.scrollLeft,
    bottom: overflowHeight - scroll.scrollTop,
  };
}

/** Fast-path pre-check used to decide whether to harvest attributes at all. */
export function isInteractiveCandidate(descriptor: DomNodeDescriptor): boolean {
  const tagName = descriptor.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tagName)) return true;
  return (
    "onclick" in descriptor.attributes ||
    "role" in descriptor.attributes ||
    "tabindex" in descriptor.attributes ||
    hasInteractiveAria(descriptor) ||
    "data-action" in descriptor.attributes ||
    descriptor.attributes["contenteditable"] === "true"
  );
}

/** True when any ARIA state attribute is present. */
export function hasInteractiveAria(descriptor: DomNodeDescriptor): boolean {
  return INTERACTIVE_ARIA_ATTRS.some((attr) => attr in descriptor.attributes);
}

/**
 * The donor's headline rule: a cursor style implying interactivity wins immediately, before the
 * tag/role tables are consulted. Returns false for disabled controls even with a good tag.
 */
export function isInteractiveElement(descriptor: DomNodeDescriptor): boolean {
  const tagName = descriptor.tagName.toLowerCase();
  const style = descriptor.style;
  const cursor = style?.cursor;

  if (cursor && INTERACTIVE_CURSORS.has(cursor)) return true;

  if (INTERACTIVE_TAGS.has(tagName)) {
    if (cursor && NON_INTERACTIVE_CURSORS.has(cursor)) return false;
    if (EXPLICIT_DISABLE_TAGS.has("disabled") && isExplicitlyDisabled(descriptor)) return false;
    if (descriptor.disabled === true) return false;
    if (descriptor.readOnly === true) return false;
    if (descriptor.inert === true) return false;
    return true;
  }

  const role = descriptor.role ?? descriptor.attributes["role"];
  if (descriptor.isContentEditable || descriptor.attributes["contenteditable"] === "true") {
    return true;
  }

  // Bootstrap-style dropdown affordances.
  if (
    (descriptor.className &&
      containsAnyClass(descriptor.className, ["button", "dropdown-toggle"])) ||
    "data-index" in descriptor.attributes ||
    descriptor.attributes["data-toggle"] === "dropdown" ||
    descriptor.attributes["aria-haspopup"] === "true"
  ) {
    return true;
  }

  if (role !== undefined && INTERACTIVE_ROLES.has(role)) return true;

  if (descriptor.hasEventListeners?.(descriptor) === true) return true;

  // Inline handler fallback — the only event-listener signal available inside page.evaluate.
  if (
    "onclick" in descriptor.attributes ||
    "onmousedown" in descriptor.attributes ||
    "onmouseup" in descriptor.attributes ||
    "ondblclick" in descriptor.attributes
  ) {
    return true;
  }

  // Scrollable containers are interactive targets in their own right.
  return computeScrollData(descriptor) !== null;
}

function isExplicitlyDisabled(descriptor: DomNodeDescriptor): boolean {
  for (const attr of EXPLICIT_DISABLE_TAGS) {
    const value = descriptor.attributes[attr];
    if (value === "true" || value === "") return true;
  }
  return false;
}

function containsAnyClass(className: string, tokens: readonly string[]): boolean {
  const classes = className.split(/\s+/);
  return tokens.some((token) => classes.includes(token));
}

/**
 * Heuristic interactivity for deeply-nested actionable elements (a menu item inside a button)
 * that the strict checks miss. Requires visible children and a known interactive container.
 */
export function isHeuristicallyInteractive(
  descriptor: DomNodeDescriptor,
  hasVisibleChildren: boolean,
  isInKnownContainer: boolean,
  isParentBody: boolean,
): boolean {
  if (!isElementVisible(descriptor)) return false;
  const hasInteractiveAttributes =
    "role" in descriptor.attributes ||
    "tabindex" in descriptor.attributes ||
    "onclick" in descriptor.attributes;
  const hasInteractiveClass = HEURISTIC_INTERACTIVE_CLASS_REGEX.test(descriptor.className ?? "");
  return (
    (isInteractiveElement(descriptor) || hasInteractiveAttributes || hasInteractiveClass) &&
    hasVisibleChildren &&
    isInKnownContainer &&
    !isParentBody
  );
}

/**
 * True when an interactive element nested in a highlighted parent is a SEPARATE target. The donor
 * defaults to false (assume it triggers the parent's handler) and only promotes on a positive
 * signal here.
 */
export function isElementDistinctInteraction(descriptor: DomNodeDescriptor): boolean {
  const tagName = descriptor.tagName.toLowerCase();
  if (tagName === "iframe") return true;
  if (DISTINCT_INTERACTIVE_TAGS.has(tagName)) return true;
  const role = descriptor.role ?? descriptor.attributes["role"];
  if (role !== undefined && DISTINCT_INTERACTIVE_ROLES.has(role)) return true;
  if (descriptor.isContentEditable || descriptor.attributes["contenteditable"] === "true") {
    return true;
  }
  for (const attr of TEST_ID_ATTRIBUTES) {
    if (attr in descriptor.attributes) return true;
  }
  if ("onclick" in descriptor.attributes) return true;
  if (hasInteractiveAria(descriptor)) return true;
  if (
    "onmousedown" in descriptor.attributes ||
    "onmouseup" in descriptor.attributes ||
    "onkeydown" in descriptor.attributes ||
    "onkeyup" in descriptor.attributes ||
    "onsubmit" in descriptor.attributes ||
    "onchange" in descriptor.attributes ||
    "oninput" in descriptor.attributes
  ) {
    return true;
  }
  // Scrollable containers are always distinct — an agent needs their index to scroll them.
  return computeScrollData(descriptor) !== null;
}
