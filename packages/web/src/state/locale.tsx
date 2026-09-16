/**
 * Language context: zh / en / system (tracks navigator.language, listens for languagechange).
 * On switch, dynamically loads the target dictionary via loadStrings, calls setActiveStrings,
 * and remounts the whole tree keyed on locale so every `S.x` read immediately reflects the
 * new language; the preference persists to localStorage.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { loadStrings, setActiveStrings } from "../lib/strings";

export type LangPref = "zh" | "en" | "system";
export type Locale = "zh" | "en";

const STORAGE_KEY = "penguin.lang";

interface LocaleContextValue {
  lang: LangPref;
  locale: Locale;
  setLang: (lang: LangPref) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Device language → UI language (default when no stored preference exists; also applies on the
 * login page): a language tag starting with zh (zh-CN/zh-TW…) → zh; anything else or
 * unavailable → falls back to en. Exported as a pure function for unit tests (test/locale.test.ts).
 */
export function resolveSystemLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function systemLocale(): Locale {
  return resolveSystemLocale(navigator.language);
}

function resolve(lang: LangPref): Locale {
  return lang === "system" ? systemLocale() : lang;
}

function initialLang(): LangPref {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "zh" || stored === "en" || stored === "system") return stored;
  return "system";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LangPref>(initialLang);
  // Re-resolution signal for browser language changes while in system mode.
  const [, setSysTick] = useState(0);

  const locale = resolve(lang);

  // In case the target dictionary has not loaded yet (e.g. initial mount in tests or fast switch),
  // load it and set active strings.
  useEffect(() => {
    void loadStrings(locale).then((dict) => {
      setActiveStrings(dict);
    });
  }, [locale]);

  useEffect(() => {
    if (lang !== "system") return;
    const onChange = () => {
      const targetLocale = systemLocale();
      void loadStrings(targetLocale).then((dict) => {
        setActiveStrings(dict);
        setSysTick((t) => t + 1);
      });
    };
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, [lang]);

  const setLang = useCallback((next: LangPref) => {
    const targetLocale = resolve(next);
    void loadStrings(targetLocale).then((dict) => {
      setActiveStrings(dict);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage error ignored
      }
      setLangState(next);
    });
  }, []);

  return (
    <LocaleContext.Provider value={{ lang, locale, setLang }}>{children}</LocaleContext.Provider>
  );
}

/**
 * Language scope: a remount boundary keyed on locale. Placed **inside** AuthProvider —
 * switching language only rebuilds the UI tree, not the auth state (otherwise user=undefined
 * would cause a full-screen flash).
 */
export function LocaleScope({ children }: { children: ReactNode }) {
  const { locale } = useLocale();
  return (
    <div key={locale} className="contents">
      {children}
    </div>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within a LocaleProvider");
  return ctx;
}
