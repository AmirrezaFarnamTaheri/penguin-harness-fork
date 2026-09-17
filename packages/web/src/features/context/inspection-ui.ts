import { useLocale } from "../../state/locale";

/** Copy and visual primitives local to the inspection pages, not the global navigation. */
export function useInspectionCopy() {
  const { locale } = useLocale();
  return (en: string, zh: string) => (locale === "zh" ? zh : en);
}

export const pageClass =
  "min-w-0 space-y-5 bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100 text-sm";
export const sectionClass = "min-w-0 border-t border-gray-200 dark:border-gray-800 pt-4 space-y-3";
export const mutedClass = "text-gray-600 dark:text-gray-400";
export const selectClass =
  "min-h-10 max-w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";
export const rowButtonClass =
  "w-full min-h-11 text-left px-3 py-3 border-b border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 focus-visible:outline-2 focus-visible:outline-brand-500";
export const selectedClass = "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300";
