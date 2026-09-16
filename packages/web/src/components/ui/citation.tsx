import React from "react";

export interface CitationProps {
  index?: number;
  title: string;
  source?: string;
  url?: string;
  snippet?: string;
  compact?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  className?: string;
}

export function Citation({
  index,
  title,
  source,
  url,
  snippet,
  compact = false,
  onOpen,
  onClose,
  className = "",
}: CitationProps) {
  if (compact) {
    if (url && !onOpen) {
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={snippet ?? title}
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-gray-300 bg-gray-50 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors cursor-pointer ${className}`}
        >
          {index !== undefined && (
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white shrink-0">
              {index}
            </span>
          )}
          <span className="truncate max-w-[140px] font-medium">{title}</span>
        </a>
      );
    }
    return (
      <button
        type="button"
        onClick={onOpen}
        title={snippet ?? title}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-gray-300 bg-gray-50 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors cursor-pointer ${className}`}
      >
        {index !== undefined && (
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white shrink-0">
            {index}
          </span>
        )}
        <span className="truncate max-w-[140px] font-medium">{title}</span>
      </button>
    );
  }

  return (
    <div
      className={`group relative flex flex-col justify-between rounded-lg border border-gray-200 bg-white p-2.5 text-xs shadow-xs transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900/90 ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 overflow-hidden">
          {index !== undefined && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white shrink-0">
              {index}
            </span>
          )}
          <div className="truncate font-semibold text-gray-800 dark:text-gray-200">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline flex items-center gap-1 text-blue-600 dark:text-blue-400"
              >
                <span className="truncate">{title}</span>
                <svg
                  className="w-3 h-3 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            ) : (
              <button
                type="button"
                onClick={onOpen}
                className="hover:underline text-left truncate cursor-pointer"
              >
                {title}
              </button>
            )}
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-0.5 rounded cursor-pointer"
            title="Dismiss source"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {source && (
        <div className="mt-1 truncate text-[11px] text-gray-500 dark:text-gray-400">
          Source: {source}
        </div>
      )}

      {snippet && (
        <p className="mt-1.5 text-gray-600 dark:text-gray-300 line-clamp-2 italic leading-relaxed">
          &ldquo;{snippet}&rdquo;
        </p>
      )}
    </div>
  );
}
