/**
 * Code Toolbar & Block Actions Header.
 *
 * Sits at the top of rendered code blocks: language chip, line count, wrap toggle,
 * copy affordance, and live preview toggle for HTML/SVG/Mermaid artifacts.
 *
 * Synthesized from cherry-studio CodeToolbar and open-pencil code inspector.
 */
import { useState } from "react";
import { CopyButton } from "./copy-button";

export interface CodeToolbarProps {
  language: string;
  code: string;
  filename?: string;
  onToggleWrap?: (wrapped: boolean) => void;
  onPreview?: () => void;
  previewable?: boolean;
}

export function CodeToolbar({
  language,
  code,
  filename,
  onToggleWrap,
  onPreview,
  previewable,
}: CodeToolbarProps) {
  const [isWrapped, setIsWrapped] = useState(false);

  const lineCount = code.split(/\r?\n/).length;
  const isPreviewSupported =
    previewable ?? ["html", "htm", "svg", "mermaid"].includes(language.toLowerCase());

  const handleWrapToggle = () => {
    const next = !isWrapped;
    setIsWrapped(next);
    onToggleWrap?.(next);
  };

  return (
    <div className="flex items-center justify-between border-b border-gray-200 bg-gray-100/70 px-3 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-400">
      {/* Left: filename / language + line count */}
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium text-gray-800 dark:text-gray-200">
          {filename || language || "text"}
        </span>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1.5">
        {isPreviewSupported && onPreview && (
          <button
            type="button"
            onClick={onPreview}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            title="Preview artifact"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            Preview
          </button>
        )}

        {onToggleWrap && (
          <button
            type="button"
            onClick={handleWrapToggle}
            className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
              isWrapped
                ? "bg-gray-200 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
                : "text-gray-500 hover:bg-gray-200/60 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-gray-200"
            }`}
            title={isWrapped ? "Unwrap lines" : "Wrap lines"}
          >
            Wrap
          </button>
        )}

        <CopyButton label="Copy code" text={code} />
      </div>
    </div>
  );
}
