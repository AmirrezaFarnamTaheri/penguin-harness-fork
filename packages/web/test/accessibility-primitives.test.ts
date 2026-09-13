import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextEnabledOptionIndex } from "../src/components/ui/select";

function source(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/components/ui/${name}.tsx`, import.meta.url)),
    "utf8",
  );
}

describe("custom listbox keyboard navigation", () => {
  it("wraps and skips disabled options in both directions", () => {
    const enabled = [true, false, true];
    expect(nextEnabledOptionIndex(enabled, 0, 1)).toBe(2);
    expect(nextEnabledOptionIndex(enabled, 2, 1)).toBe(0);
    expect(nextEnabledOptionIndex(enabled, 0, -1)).toBe(2);
    expect(nextEnabledOptionIndex([false, false], 0, 1)).toBe(-1);
  });

  it.each(["select", "option-menu"])("wires expected keys and focus for %s", (name) => {
    const text = source(name);
    expect(text).toContain('case "ArrowDown"');
    expect(text).toContain('case "ArrowUp"');
    expect(text).toContain('case "Home"');
    expect(text).toContain('case "End"');
    expect(text).toContain('case "Escape"');
    expect(text).toContain("optionRefs.current");
    expect(text).toContain("tabIndex={i === activeIndex ? 0 : -1}");
    expect(text).toContain("aria-controls={open ? listboxId : undefined}");
    expect(text).toContain("id={listboxId}");
  });
});

describe("Sheet modal focus", () => {
  const text = source("sheet");

  it("moves focus inside, traps Tab, and keeps the panel focusable", () => {
    expect(text).toContain("FOCUSABLE_SELECTOR");
    expect(text).toContain("nextFocusIndex(");
    expect(text).toContain("onKeyDown={onPanelKeyDown}");
    expect(text).toContain("tabIndex={-1}");
    expect(text).toContain("panel.focus()");
  });
});

describe("toast announcements", () => {
  const text = source("toast");

  it("announces errors assertively and other outcomes politely", () => {
    expect(text).toContain('role={t.kind === "error" ? "alert" : "status"}');
    expect(text).toContain('aria-live={t.kind === "error" ? "assertive" : "polite"}');
    expect(text).toContain('aria-atomic="true"');
  });
});
