/**
 * US keyboard layout mapping for CDP `Input.dispatchKeyEvent`.
 *
 * Ports the donor's `char_to_key_info` / `punctuation_key_info` / `named_key_info` tables
 * verbatim. Those exist because the Windows virtual-key codes for punctuation are NOT the ASCII
 * values — the donor's original code sent `.` as VK 46, which is VK_DELETE, so the period was
 * silently swallowed by the renderer. The fix is this table, and the regression test that came
 * with it (period must never be VK 46) is preserved below as a documented invariant.
 *
 * CDP `Input.dispatchKeyEvent` needs three coordinated values for a keyDown to trigger the
 * browser's default action:
 *   - `key`: the KeyboardEvent.key (the character produced, or the named key)
 *   - `code`: the KeyboardEvent.code (the PHYSICAL key, layout-independent)
 *   - `windowsVirtualKeyCode`: the Windows VK code, which Chrome maps to the platform key
 * plus `text` (see `keyTextFor`) for the default action to actually insert a character.
 */

export interface KeyInfo {
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.code` — the physical key. Empty when the layout cannot produce the char. */
  code: string;
  /** Windows virtual-key code; 0 when unmapped (caller falls back to `Input.insertText`). */
  windowsVirtualKeyCode: number;
}

/**
 * A char → (key, code, VK) triple. Assumptions: US keyboard layout, and that for letters the
 * Windows VK code equals the UPPERCASE ASCII value (VK_A == 65 == 'A'.charCodeAt(0)).
 */
export function charToKeyInfo(ch: string): KeyInfo {
  switch (ch) {
    case "\n":
    case "\r":
      return { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
    case "\t":
      return { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
    case " ":
      return { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
    default: {
      const key = ch;
      if (/[A-Za-z]/.test(ch)) {
        const upper = ch.toUpperCase();
        return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
      }
      if (/[0-9]/.test(ch)) {
        return { key, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0) };
      }
      const [code, vk] = punctuationKeyInfo(ch);
      return { key, code, windowsVirtualKeyCode: vk };
    }
  }
}

/**
 * Punctuation → (code, VK) for a US layout. Shifted variants (':' vs ';') share a physical key
 * and therefore share a code, differing only in the reported `key`.
 */
export function punctuationKeyInfo(ch: string): [string, number] {
  switch (ch) {
    // VK_OEM_1 (0xBA = 186) — ";:" key
    case ";":
    case ":":
      return ["Semicolon", 186];
    // VK_OEM_PLUS (0xBB = 187) — "=+" key
    case "=":
    case "+":
      return ["Equal", 187];
    // VK_OEM_COMMA (0xBC = 188) — ",<" key
    case ",":
    case "<":
      return ["Comma", 188];
    // VK_OEM_MINUS (0xBD = 189) — "-_" key
    case "-":
    case "_":
      return ["Minus", 189];
    // VK_OEM_PERIOD (0xBE = 190) — ".>" key. NOT VK 46 (VK_DELETE) — see the invariant below.
    case ".":
    case ">":
      return ["Period", 190];
    // VK_OEM_2 (0xBF = 191) — "/?" key
    case "/":
    case "?":
      return ["Slash", 191];
    // VK_OEM_3 (0xC0 = 192) — "`~" key
    case "`":
    case "~":
      return ["Backquote", 192];
    // VK_OEM_4 (0xDB = 219) — "[{" key
    case "[":
    case "{":
      return ["BracketLeft", 219];
    // VK_OEM_5 (0xDC = 220) — "\|" key
    case "\\":
    case "|":
      return ["Backslash", 220];
    // VK_OEM_6 (0xDD = 221) — "]}" key
    case "]":
    case "}":
      return ["BracketRight", 221];
    // VK_OEM_7 (0xDE = 222) — "'"" key
    case "'":
    case '"':
      return ["Quote", 222];
    default:
      return ["", 0];
  }
}

/**
 * The `text` value CDP needs on the keyDown event for the browser to perform the key's default
 * action: Enter needs "\r" to submit a form and Tab needs "\t" to move focus — the `key` name
 * alone does nothing. Non-printable / navigation keys return undefined.
 */
export function keyTextFor(keyName: string): string | undefined {
  switch (keyName) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case " ":
      return " ";
    default:
      return keyName.length === 1 ? keyName : undefined;
  }
}

/** Named (non-printable) keys → (key, code, VK). Accepts common aliases like "esc"/"up". */
export function namedKeyInfo(key: string): KeyInfo {
  switch (key.toLowerCase()) {
    case "enter":
    case "return":
      return { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
    case "tab":
      return { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
    case "escape":
    case "esc":
      return { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
    case "backspace":
      return { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
    case "delete":
      return { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 };
    case "arrowup":
    case "up":
      return { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 };
    case "arrowdown":
    case "down":
      return { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 };
    case "arrowleft":
    case "left":
      return { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 };
    case "arrowright":
    case "right":
      return { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 };
    case "home":
      return { key: "Home", code: "Home", windowsVirtualKeyCode: 36 };
    case "end":
      return { key: "End", code: "End", windowsVirtualKeyCode: 35 };
    case "pageup":
      return { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 };
    case "pagedown":
      return { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 };
    case "space":
    case " ":
      return { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
    default:
      return key.length === 1 ? charToKeyInfo(key) : { key, code: key, windowsVirtualKeyCode: 0 };
  }
}

/**
 * Splits text into the segments a typist must dispatch as key events versus the ones that must go
 * through `Input.insertText`. Chars outside the US layout (é, €, CJK) have no VK code; the donor
 * falls back to insertText for them so a non-US character does not stall typing.
 */
export function splitTypableSegments(
  text: string,
): Array<{ type: "key"; value: string } | { type: "insert"; value: string }> {
  const segments: Array<{ type: "key"; value: string } | { type: "insert"; value: string }> = [];
  let buffer = "";
  const flushInsert = (): void => {
    if (buffer.length > 0) {
      segments.push({ type: "insert", value: buffer });
      buffer = "";
    }
  };
  for (const ch of text) {
    const info = charToKeyInfo(ch);
    if (info.code === "" || info.windowsVirtualKeyCode === 0) {
      buffer += ch;
    } else {
      flushInsert();
      segments.push({ type: "key", value: ch });
    }
  }
  flushInsert();
  return segments;
}

/**
 * Mouse button bitmask for CDP `Input.dispatchMouseEvent`. `buttons` is a bitfield of the
 * currently-held buttons, so a right press reports 2 and its release reports 0.
 */
export const MOUSE_BUTTON_BITMASK = {
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
} as const;

export type MouseButton = keyof typeof MOUSE_BUTTON_BITMASK;

/** Mouse event types in the dispatch order a click requires. */
export const MOUSE_EVENT_SEQUENCE = ["mouseMoved", "mousePressed", "mouseReleased"] as const;

/**
 * The donor's central correctness fix, kept as a function so a test can assert it: a period must
 * never map to VK 46, because 46 is VK_DELETE and the character would be dropped.
 */
export function periodIsNotVkDelete(): boolean {
  return punctuationKeyInfo(".")[1] !== 46;
}
