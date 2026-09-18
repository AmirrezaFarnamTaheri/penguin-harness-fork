import { describe, expect, it } from "vitest";

import {
  MOUSE_BUTTON_BITMASK,
  MOUSE_EVENT_SEQUENCE,
  type MouseButton,
  charToKeyInfo,
  keyTextFor,
  namedKeyInfo,
  periodIsNotVkDelete,
  punctuationKeyInfo,
  splitTypableSegments,
} from "../../src/browser/us-keyboard-layout.js";

describe("us keyboard layout", () => {
  describe("charToKeyInfo", () => {
    it("maps letters to VK codes equal to the uppercase ASCII value", () => {
      expect(charToKeyInfo("a")).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      expect(charToKeyInfo("Z")).toEqual({ key: "Z", code: "KeyZ", windowsVirtualKeyCode: 90 });
    });

    it("maps digits to the DigitN code", () => {
      expect(charToKeyInfo("0")).toEqual({ key: "0", code: "Digit0", windowsVirtualKeyCode: 48 });
      expect(charToKeyInfo("9")).toEqual({ key: "9", code: "Digit9", windowsVirtualKeyCode: 57 });
    });

    it("maps control characters to their named keys", () => {
      expect(charToKeyInfo("\n")).toEqual({
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      expect(charToKeyInfo("\r")).toEqual({
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      expect(charToKeyInfo("\t")).toEqual({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      expect(charToKeyInfo(" ")).toEqual({ key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    });

    it("maps the full US punctuation set to VK_OEM_* codes", () => {
      // Verbatim from the donor's regression table, which is itself cross-checked against
      // Playwright's USKeyboardLayout.
      const cases: ReadonlyArray<[string, string, number]> = [
        [".", "Period", 190],
        [",", "Comma", 188],
        ["/", "Slash", 191],
        [";", "Semicolon", 186],
        ["'", "Quote", 222],
        ["[", "BracketLeft", 219],
        ["]", "BracketRight", 221],
        ["\\", "Backslash", 220],
        ["`", "Backquote", 192],
        ["-", "Minus", 189],
        ["=", "Equal", 187],
        [">", "Period", 190],
        ["<", "Comma", 188],
        ["?", "Slash", 191],
        [":", "Semicolon", 186],
        ['"', "Quote", 222],
        ["{", "BracketLeft", 219],
        ["}", "BracketRight", 221],
        ["|", "Backslash", 220],
        ["~", "Backquote", 192],
        ["_", "Minus", 189],
        ["+", "Equal", 187],
      ];
      for (const [character, code, vk] of cases) {
        expect(charToKeyInfo(character)).toEqual({
          key: character,
          code,
          windowsVirtualKeyCode: vk,
        });
      }
    });

    it("returns a zero VK code for characters outside the US layout", () => {
      for (const character of ["@", "#", "$", "%", "^", "&", "*", "(", ")", "€", "£", "你"]) {
        expect(charToKeyInfo(character)).toEqual({
          key: character,
          code: "",
          windowsVirtualKeyCode: 0,
        });
      }
    });
  });

  describe("punctuationKeyInfo", () => {
    it("shares a physical key between a symbol and its shifted variant", () => {
      expect(punctuationKeyInfo(";")[0]).toBe(punctuationKeyInfo(":")[0]);
      expect(punctuationKeyInfo("-")[0]).toBe(punctuationKeyInfo("_")[0]);
    });
  });

  describe("periodIsNotVkDelete", () => {
    it("holds: period must never collide with VK_DELETE (46)", () => {
      expect(periodIsNotVkDelete()).toBe(true);
      expect(punctuationKeyInfo(".")[1]).toBe(190);
      expect(punctuationKeyInfo(".")[1]).not.toBe(46);
    });
  });

  describe("keyTextFor", () => {
    it("supplies the text CDP needs for the default action", () => {
      expect(keyTextFor("Enter")).toBe("\r");
      expect(keyTextFor("Tab")).toBe("\t");
      expect(keyTextFor(" ")).toBe(" ");
      expect(keyTextFor("a")).toBe("a");
      expect(keyTextFor("Z")).toBe("Z");
    });

    it("returns undefined for non-printable named keys", () => {
      expect(keyTextFor("Escape")).toBeUndefined();
      expect(keyTextFor("ArrowUp")).toBeUndefined();
      expect(keyTextFor("Backspace")).toBeUndefined();
      expect(keyTextFor("Delete")).toBeUndefined();
    });
  });

  describe("namedKeyInfo", () => {
    it("maps navigation keys", () => {
      expect(namedKeyInfo("ArrowUp")).toEqual({
        key: "ArrowUp",
        code: "ArrowUp",
        windowsVirtualKeyCode: 38,
      });
      expect(namedKeyInfo("ArrowDown")).toEqual({
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
      });
      expect(namedKeyInfo("ArrowLeft")).toEqual({
        key: "ArrowLeft",
        code: "ArrowLeft",
        windowsVirtualKeyCode: 37,
      });
      expect(namedKeyInfo("ArrowRight")).toEqual({
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
      });
      expect(namedKeyInfo("Escape")).toEqual({
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      expect(namedKeyInfo("Backspace")).toEqual({
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      expect(namedKeyInfo("Delete")).toEqual({
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
      expect(namedKeyInfo("Home")).toEqual({
        key: "Home",
        code: "Home",
        windowsVirtualKeyCode: 36,
      });
      expect(namedKeyInfo("End")).toEqual({ key: "End", code: "End", windowsVirtualKeyCode: 35 });
      expect(namedKeyInfo("PageUp")).toEqual({
        key: "PageUp",
        code: "PageUp",
        windowsVirtualKeyCode: 33,
      });
      expect(namedKeyInfo("PageDown")).toEqual({
        key: "PageDown",
        code: "PageDown",
        windowsVirtualKeyCode: 34,
      });
    });

    it("accepts common aliases", () => {
      expect(namedKeyInfo("esc")).toEqual(namedKeyInfo("Escape"));
      expect(namedKeyInfo("up")).toEqual(namedKeyInfo("ArrowUp"));
      expect(namedKeyInfo("return")).toEqual(namedKeyInfo("Enter"));
      expect(namedKeyInfo("space")).toEqual(namedKeyInfo(" "));
    });

    it("delegates single characters to charToKeyInfo", () => {
      expect(namedKeyInfo("q")).toEqual(charToKeyInfo("q"));
    });
  });

  describe("splitTypableSegments", () => {
    it("keeps US-layout characters as key events", () => {
      const segments = splitTypableSegments("hello");
      expect(segments).toEqual([
        { type: "key", value: "h" },
        { type: "key", value: "e" },
        { type: "key", value: "l" },
        { type: "key", value: "l" },
        { type: "key", value: "o" },
      ]);
    });

    it("collects non-US characters into an insertText segment", () => {
      const segments = splitTypableSegments("café");
      expect(segments).toContainEqual({ type: "key", value: "c" });
      expect(segments).toContainEqual({ type: "key", value: "a" });
      expect(segments).toContainEqual({ type: "key", value: "f" });
      expect(segments).toContainEqual({ type: "insert", value: "é" });
    });

    it("handles a string with no typable US characters", () => {
      expect(splitTypableSegments("你好")).toEqual([{ type: "insert", value: "你好" }]);
    });

    it("handles the empty string", () => {
      expect(splitTypableSegments("")).toEqual([]);
    });

    it("routes control characters as key events", () => {
      expect(splitTypableSegments("a\nb")).toEqual([
        { type: "key", value: "a" },
        { type: "key", value: "\n" },
        { type: "key", value: "b" },
      ]);
    });
  });

  describe("mouse button bitmask", () => {
    it("matches the CDP buttons bitfield", () => {
      expect(MOUSE_BUTTON_BITMASK.left).toBe(1);
      expect(MOUSE_BUTTON_BITMASK.right).toBe(2);
      expect(MOUSE_BUTTON_BITMASK.middle).toBe(4);
      expect(MOUSE_BUTTON_BITMASK.back).toBe(8);
      expect(MOUSE_BUTTON_BITMASK.forward).toBe(16);
    });

    it("exposes the click dispatch order", () => {
      expect(MOUSE_EVENT_SEQUENCE).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    });

    it("types every key of the bitmask union", () => {
      const button: MouseButton = "middle";
      expect(MOUSE_BUTTON_BITMASK[button]).toBe(4);
    });
  });
});
