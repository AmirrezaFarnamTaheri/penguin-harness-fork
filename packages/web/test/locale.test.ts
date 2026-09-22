/**
 * Locale switch races: the locale is switched from three places (a setLang call, the locale
 * effect, and the browser languagechange listener), and their loads do not resolve in switch
 * order. These tests pin the gate's invariant — a switch that started earlier must not apply
 * its dictionary after a later one already landed — because `S` is a module-level live
 * binding that nothing repairs: LocaleScope remounts the tree on locale, but the strings it
 * renders come from a mutable outside React, so the late dictionary just replaces it.
 */
import { describe, expect, it } from "vitest";
import { S } from "../src/lib/strings";
import type { Strings } from "../src/lib/strings-zh";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";
import { createLocaleSwitcher, resolveSystemLocale } from "../src/state/locale";

describe("resolveSystemLocale (navigator.language → UI language)", () => {
  it("zh prefix (any case or region variant) → zh", () => {
    expect(resolveSystemLocale("zh-CN")).toBe("zh");
    expect(resolveSystemLocale("ZH-TW")).toBe("zh");
  });

  it("non-Chinese or unavailable → English fallback", () => {
    expect(resolveSystemLocale("en-US")).toBe("en");
    expect(resolveSystemLocale(undefined)).toBe("en");
  });
});

describe("locale switch ordering", () => {
  it("an in-flight switch is applied when it is still the latest one", async () => {
    const applied: string[] = [];
    const { switchLocale } = createLocaleSwitcher(async (locale) => {
      applied.push(locale);
      return locale === "zh" ? zh : en;
    });
    await switchLocale("zh");
    expect(applied).toEqual(["zh"]);
    expect(S).toBe(zh);
  });

  it("a late-resolving earlier switch does not clobber the active strings", async () => {
    // zh→en→zh with the first load landing last: without a gate the stale load replaces
    // whatever won the race, and the UI shows a mixture (a live binding outside React that
    // the LocaleScope remount cannot repair).
    let resolveFirst!: (dict: Strings) => void;
    const applied: string[] = [];
    const { switchLocale } = createLocaleSwitcher(async (locale) => {
      if (locale === "en")
        return new Promise<Strings>((resolve) => {
          resolveFirst = resolve;
        });
      return locale === "zh" ? zh : en;
    });

    const p1 = switchLocale("en", () => applied.push("en"));
    await switchLocale("zh", () => applied.push("zh"));
    expect(applied).toEqual(["zh"]);
    expect(S).toBe(zh);

    // The load the user long since replaced lands now.
    resolveFirst(en);
    await p1;
    expect(S).toBe(zh);
    expect(applied).toEqual(["zh"]);
  });

  it("a superseded switch's own persist and state commit are dropped too", async () => {
    // setLang must not write the preference it replaced to localStorage after the fact.
    const applied: string[] = [];
    let resolveFirst!: (dict: Strings) => void;
    const { switchLocale } = createLocaleSwitcher(async (locale) => {
      if (locale === "en")
        return new Promise<Strings>((resolve) => {
          resolveFirst = resolve;
        });
      return locale === "zh" ? zh : en;
    });
    const p1 = switchLocale("en", () => applied.push("en"));
    const p2 = switchLocale("zh", () => applied.push("zh"));
    await p2;
    resolveFirst(en);
    await p1;
    expect(applied).toEqual(["zh"]);
  });

  it("a supersede mark closes every in-flight switch (the locale effect tears the gate down)", async () => {
    // The effect's cleanup supersedes what it started, so an unmount while a load is in
    // flight does not rebind S on a tree that no longer exists.
    let resolveLoad!: (dict: Strings) => void;
    const { switchLocale, supersede } = createLocaleSwitcher(
      () =>
        new Promise<Strings>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const before = S;
    const p = switchLocale("zh");
    supersede();
    resolveLoad(zh);
    await p;
    expect(S).toBe(before);
  });

  it("still applies the latest of many interleaved switches", async () => {
    // Loads land in the opposite order they were started.
    const pending: Array<(d: Strings) => void> = [];
    const { switchLocale } = createLocaleSwitcher(
      () =>
        new Promise<Strings>((resolve) => {
          pending.push(resolve);
        }),
    );
    const promises = [
      switchLocale("en"),
      switchLocale("zh"),
      switchLocale("en"),
      switchLocale("zh"),
    ];
    for (let i = pending.length - 1; i >= 0; i--) pending[i]!(zh);
    await Promise.all(promises);
    expect(S).toBe(zh);
  });
});
