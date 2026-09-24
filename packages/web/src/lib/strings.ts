/**
 * UI copy runtime facade: provides the active dictionary `S`, dictionary setter,
 * and lazy loader. The dictionaries themselves live in strings-zh.ts and strings-en.ts
 * and are loaded on demand by main.tsx and state/locale.tsx to ensure neither
 * dictionary is statically bundled into the initial SPA entry chunk.
 */
import type { Strings } from "./strings-zh";

export type { Strings } from "./strings-zh";

/**
 * Runtime active dictionary (live binding): **`null` until `setActiveStrings` runs at
 * boot**, then re-bound on every language switch. Its type is non-null on purpose — the
 * overwhelming majority of reads are render-time, past that boot — so the type cannot see
 * the early case. Any read that can run BEFORE the first render (a module-scope value, a
 * non-React code path, an error handler firing while a dictionary is still loading) must
 * go through {@link s}, which names the missing boot step instead of dereferencing null.
 */
export let S: Strings = null as unknown as Strings;

/**
 * The active dictionary, for reads that can happen before boot finished binding one. Same
 * rule the codebase already keeps by hand ("read `S` inside functions, never at module top
 * level"), made enforceable: this throws a clear error pointing at `setActiveStrings` where
 * a bare `S.x` would fail with `Cannot read properties of null` — a TypeError the type
 * system cannot warn about, because `S` is typed non-null by design.
 */
export function s(): Strings {
  if (S === null || S === undefined) {
    throw new Error(
      "strings not loaded: setActiveStrings must run before any dictionary read (main.tsx binds it at boot, state/locale.tsx on switch)",
    );
  }
  return S;
}

export function setActiveStrings(next: Strings): void {
  S = next;
}

export function isStringsLoaded(): boolean {
  return S !== null && S !== undefined;
}

const cache: Partial<Record<"zh" | "en", Strings>> = {};

/**
 * Dynamically imports and caches the requested locale dictionary.
 */
export async function loadStrings(locale: "zh" | "en"): Promise<Strings> {
  const cached = cache[locale];
  if (cached) return cached;

  if (locale === "en") {
    const mod = await import("./strings-en");
    cache.en = mod.en;
    return mod.en;
  }

  const mod = await import("./strings-zh");
  cache.zh = mod.zh;
  return mod.zh;
}
