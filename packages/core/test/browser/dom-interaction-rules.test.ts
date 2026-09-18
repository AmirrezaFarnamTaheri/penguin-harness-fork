import { describe, expect, it } from "vitest";

import {
  type DomNodeDescriptor,
  INTERACTIVE_ARIA_ATTRS,
  SCROLLABLE_THRESHOLD_PX,
  computeScrollData,
  isElementAccepted,
  isElementDistinctInteraction,
  isElementVisible,
  isHeuristicallyInteractive,
  isInteractiveCandidate,
  isInteractiveElement,
} from "../../src/browser/dom-interaction-rules.js";

function descriptor(overrides: Partial<DomNodeDescriptor> = {}): DomNodeDescriptor {
  return {
    tagName: "div",
    attributes: {},
    offsetWidth: 100,
    offsetHeight: 40,
    ...overrides,
  };
}

describe("dom interaction rules", () => {
  describe("isElementAccepted", () => {
    it("always accepts structural containers", () => {
      for (const tag of ["body", "div", "main", "article", "section", "nav", "header", "footer"]) {
        expect(isElementAccepted(descriptor({ tagName: tag }))).toBe(true);
      }
    });

    it("prunes script/style/svg leaves", () => {
      for (const tag of ["svg", "script", "style", "link", "meta", "noscript", "template"]) {
        expect(isElementAccepted(descriptor({ tagName: tag }))).toBe(false);
      }
    });

    it("accepts ordinary elements", () => {
      expect(isElementAccepted(descriptor({ tagName: "span" }))).toBe(true);
    });
  });

  describe("isElementVisible", () => {
    it("rejects zero-area elements", () => {
      expect(isElementVisible(descriptor({ offsetWidth: 0, offsetHeight: 0 }))).toBe(false);
    });

    it("rejects display:none and visibility:hidden", () => {
      expect(isElementVisible(descriptor({ style: { display: "none" } }))).toBe(false);
      expect(isElementVisible(descriptor({ style: { visibility: "hidden" } }))).toBe(false);
    });

    it("accepts an unstyled element with area", () => {
      expect(isElementVisible(descriptor())).toBe(true);
    });
  });

  describe("isInteractiveElement", () => {
    it("short-circuits to true on an interactive cursor", () => {
      expect(isInteractiveElement(descriptor({ style: { cursor: "pointer" } }))).toBe(true);
      expect(isInteractiveElement(descriptor({ style: { cursor: "zoom-in" } }))).toBe(true);
    });

    it("rejects a disabled form control even with a good tag", () => {
      expect(isInteractiveElement(descriptor({ tagName: "button", disabled: true }))).toBe(false);
      expect(isInteractiveElement(descriptor({ tagName: "input", readOnly: true }))).toBe(false);
      expect(isInteractiveElement(descriptor({ tagName: "input", inert: true }))).toBe(false);
      expect(
        isInteractiveElement(descriptor({ tagName: "button", style: { cursor: "not-allowed" } })),
      ).toBe(false);
    });

    it("accepts a plain enabled button", () => {
      expect(isInteractiveElement(descriptor({ tagName: "button" }))).toBe(true);
    });

    it("accepts contenteditable", () => {
      expect(isInteractiveElement(descriptor({ isContentEditable: true }))).toBe(true);
    });

    it("accepts interactive roles", () => {
      expect(isInteractiveElement(descriptor({ role: "button" }))).toBe(true);
      expect(isInteractiveElement(descriptor({ role: "checkbox" }))).toBe(true);
      expect(isInteractiveElement(descriptor({ role: "main" }))).toBe(false);
    });

    it("accepts bootstrap-style dropdown affordances", () => {
      expect(
        isInteractiveElement(descriptor({ className: "btn btn-primary dropdown-toggle" })),
      ).toBe(true);
      expect(isInteractiveElement(descriptor({ attributes: { "data-toggle": "dropdown" } }))).toBe(
        true,
      );
      expect(isInteractiveElement(descriptor({ attributes: { "aria-haspopup": "true" } }))).toBe(
        true,
      );
    });

    it("accepts inline event handlers", () => {
      expect(isInteractiveElement(descriptor({ attributes: { onclick: "doThing()" } }))).toBe(true);
      expect(isInteractiveElement(descriptor({ attributes: { onmousedown: "x" } }))).toBe(true);
    });

    it("accepts a scrollable container", () => {
      const scrollable = descriptor({
        style: { overflowY: "auto", display: "block" },
        scroll: {
          scrollWidth: 100,
          scrollHeight: 1000,
          clientWidth: 100,
          clientHeight: 400,
          scrollTop: 0,
          scrollLeft: 0,
        },
      });
      expect(isInteractiveElement(scrollable)).toBe(true);
    });

    it("uses the supplied event-listener probe when present", () => {
      const probe = descriptor({ hasEventListeners: () => true });
      expect(isInteractiveElement(probe)).toBe(true);
      const negative = descriptor({
        tagName: "span",
        hasEventListeners: () => false,
      });
      expect(isInteractiveElement(negative)).toBe(false);
    });
  });

  describe("isInteractiveCandidate", () => {
    it("fast-paths interactive tags", () => {
      expect(isInteractiveCandidate(descriptor({ tagName: "a" }))).toBe(true);
    });

    it("fast-paths on role/tabindex/aria presence", () => {
      expect(isInteractiveCandidate(descriptor({ attributes: { role: "button" } }))).toBe(true);
      expect(isInteractiveCandidate(descriptor({ attributes: { tabindex: "0" } }))).toBe(true);
      expect(isInteractiveCandidate(descriptor({ attributes: { "aria-expanded": "true" } }))).toBe(
        true,
      );
    });

    it("is false for a bare container", () => {
      expect(isInteractiveCandidate(descriptor({ tagName: "div" }))).toBe(false);
    });
  });

  describe("computeScrollData", () => {
    const scroll = {
      scrollWidth: 100,
      scrollHeight: 1000,
      clientWidth: 100,
      clientHeight: 400,
      scrollTop: 10,
      scrollLeft: 0,
    };

    it("returns null for inline elements", () => {
      expect(
        computeScrollData(descriptor({ style: { display: "inline", overflowY: "auto" }, scroll })),
      ).toBeNull();
    });

    it("returns null when nothing scrolls and no scrollbar signal is present", () => {
      expect(
        computeScrollData(
          descriptor({ style: { overflowX: "hidden", overflowY: "hidden" }, scroll }),
        ),
      ).toBeNull();
    });

    it("returns null for sub-threshold overflow", () => {
      const tiny = { ...scroll, scrollHeight: 402 };
      expect(
        computeScrollData(descriptor({ style: { overflowY: "auto" }, scroll: tiny })),
      ).toBeNull();
    });

    it("reports remaining scroll distances", () => {
      const data = computeScrollData(descriptor({ style: { overflowY: "auto" }, scroll }));
      expect(data).toEqual({ top: 10, left: 0, right: 0, bottom: 590 });
    });

    it("honours scrollbar-width/scrollbar-gutter as a scroll signal even with overflow hidden", () => {
      const data = computeScrollData(
        descriptor({
          style: { overflowX: "hidden", overflowY: "hidden", scrollbarWidth: "thin" },
          scroll,
        }),
      );
      expect(data).not.toBeNull();
    });

    it("exposes the sub-pixel threshold the donor uses", () => {
      expect(SCROLLABLE_THRESHOLD_PX).toBe(4);
    });
  });

  describe("isElementDistinctInteraction", () => {
    it("treats iframes as always distinct", () => {
      expect(isElementDistinctInteraction(descriptor({ tagName: "iframe" }))).toBe(true);
    });

    it("promotes distinct tags and roles", () => {
      expect(isElementDistinctInteraction(descriptor({ tagName: "select" }))).toBe(true);
      expect(isElementDistinctInteraction(descriptor({ role: "menuitem" }))).toBe(true);
    });

    it("promotes test-id attributes", () => {
      expect(
        isElementDistinctInteraction(descriptor({ attributes: { "data-testid": "submit" } })),
      ).toBe(true);
    });

    it("promotes scrollable containers", () => {
      const scrollable = descriptor({
        style: { overflowY: "auto", display: "block" },
        scroll: {
          scrollWidth: 100,
          scrollHeight: 1000,
          clientWidth: 100,
          clientHeight: 400,
          scrollTop: 0,
          scrollLeft: 0,
        },
      });
      expect(isElementDistinctInteraction(scrollable)).toBe(true);
    });

    it("defaults a plain nested span to non-distinct", () => {
      expect(isElementDistinctInteraction(descriptor({ tagName: "span" }))).toBe(false);
    });

    it("promotes ARIA state attributes", () => {
      expect(INTERACTIVE_ARIA_ATTRS).toContain("aria-expanded");
      expect(
        isElementDistinctInteraction(descriptor({ attributes: { "aria-pressed": "true" } })),
      ).toBe(true);
    });
  });

  describe("isHeuristicallyInteractive", () => {
    it("requires visible children inside a known container", () => {
      const base = descriptor({
        tagName: "span",
        className: "menu-item",
        attributes: { onclick: "x" },
      });
      expect(isHeuristicallyInteractive(base, true, true, false)).toBe(true);
      expect(isHeuristicallyInteractive(base, false, true, false)).toBe(false);
      expect(isHeuristicallyInteractive(base, true, false, false)).toBe(false);
      expect(isHeuristicallyInteractive(base, true, true, true)).toBe(false);
    });

    it("rejects invisible elements", () => {
      expect(
        isHeuristicallyInteractive(
          descriptor({ className: "btn", offsetWidth: 0, offsetHeight: 0 }),
          true,
          true,
          false,
        ),
      ).toBe(false);
    });
  });
});
