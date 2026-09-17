import type { ReactNode } from "react";

export const fieldClass =
  "w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100";
export const panelClass =
  "min-w-0 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950";
export const mutedClass = "text-sm leading-6 text-gray-600 dark:text-gray-400";
export function WorkTool({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-w-0 overflow-y-auto bg-white p-4 text-sm leading-6 text-gray-900 dark:bg-gray-950 dark:text-gray-100 sm:p-6">
      <div className="mx-auto max-w-7xl min-w-0 space-y-6">{children}</div>
    </div>
  );
}
export function WorkHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-5 dark:border-gray-800">
      <div className="min-w-0 max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className={`mt-2 ${mutedClass}`}>{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}
export function WorkError({ error }: { error?: string | null }) {
  return error ? (
    <p
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 break-words dark:border-red-900 dark:bg-red-950 dark:text-red-300"
    >
      {error}
    </p>
  ) : null;
}
