/**
 * The active dictionary binding is `null` until `setActiveStrings` runs at boot, but `S`
 * is typed non-null (the reads are render-time). `s()` is the read path for anything that
 * can run before that boot finishes, so it names the missing step instead of letting a
 * null dereference surface as a TypeError no caller can diagnose.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isStringsLoaded, s, S, setActiveStrings } from "../src/lib/strings";
import type { Strings } from "../src/lib/strings-zh";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";

describe("dictionary binding", () => {
  afterEach(() => setActiveStrings(zh));

  it("reports a bound dictionary and reads it", () => {
    setActiveStrings(en);
    expect(isStringsLoaded()).toBe(true);
    expect(s()).toBe(en);
    expect(typeof S.common.save).toBe("string");
  });

  it("s() names the missing boot step when no dictionary is bound", () => {
    // The binding starts null at import time; a bare `S.x` here would be a TypeError the
    // type system cannot see (S is typed non-null by design).
    const bound: Strings = S;
    setActiveStrings(null as unknown as Strings);
    try {
      expect(isStringsLoaded()).toBe(false);
      expect(() => s()).toThrow(/strings not loaded/);
      expect(() => s()).toThrow(/setActiveStrings/);
    } finally {
      setActiveStrings(bound);
    }
  });
});
