/**
 * UI copy runtime facade: provides the active dictionary `S`, dictionary setter,
 * and lazy loader. The dictionaries themselves live in strings-zh.ts and strings-en.ts
 * and are loaded on demand by main.tsx and state/locale.tsx to ensure neither
 * dictionary is statically bundled into the initial SPA entry chunk.
 */
import type { Strings } from "./strings-zh";

export type { Strings } from "./strings-zh";

/**
 * Runtime active dictionary (live binding): initialized at boot before first render,
 * and updated by setActiveStrings on language switch.
 */
export let S: Strings = null as unknown as Strings;

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
