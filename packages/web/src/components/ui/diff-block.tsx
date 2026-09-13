import React, { useState } from "react";
import { Button } from "./button.js";

export interface DiffChange {
  old?: string;
  new?: string;
}

export interface DiffBlockProps {
  filePath?: string;
  changes?: DiffChange[];
  diffString?: string;
  collapsedLines?: number;
  actions?: React.ReactNode;
  className?: string;
}

interface ParsedDiffLine {
  type: "add" | "remove" | "context";
  content: string;
}

export function DiffBlock({
  filePath,
  changes,
  diffString,
  collapsedLines = 8,
  actions,
  className = "",
}: DiffBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Parse lines from either changes array or unified diff string
  const lines: ParsedDiffLine[] = React.useMemo(() => {
    const res: ParsedDiffLine[] = [];

    if (diffString) {
      for (const line of diffString.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          res.push({ type: "add", content: line.slice(1) });
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          res.push({ type: "remove", content: line.slice(1) });
        } else if (
          !line.startsWith("@@") &&
          !line.startsWith("diff ") &&
          !line.startsWith("index ")
        ) {
          res.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line });
        }
      }
      return res;
    }

    if (changes) {
      for (const c of changes) {
        if (c.old !== undefined) {
          for (const l of c.old.split("\n")) {
            res.push({ type: "remove", content: l });
          }
        }
        if (c.new !== undefined) {
          for (const l of c.new.split("\n")) {
            res.push({ type: "add", content: l });
          }
        }
      }
    }

    return res;
  }, [changes, diffString]);

  const shouldCollapse = lines.length > collapsedLines;
  const visibleLines = shouldCollapse && !isExpanded ? lines.slice(0, collapsedLines) : lines;

  const handleCopy = () => {
    const raw = lines
      .map((l) =>
        l.type === "add"
          ? `+ ${l.content}`
          : l.type === "remove"
            ? `- ${l.content}`
            : `  ${l.content}`,
      )
      .join("\n");
    navigator.clipboard.writeText(raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`rounded-lg border border-gray-200 bg-gray-50 text-xs font-mono dark:border-gray-800 dark:bg-gray-900/80 overflow-hidden shadow-xs ${className}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 bg-gray-100/70 dark:border-gray-800 dark:bg-gray-800/60 font-sans">
        <div className="flex items-center gap-2 font-medium text-gray-700 dark:text-gray-300">
          <svg
            className="w-3.5 h-3.5 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span className="truncate max-w-xs">{filePath ?? "Diff View"}</span>
          <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">
            {lines.filter((l) => l.type === "add").length}+ /{" "}
            {lines.filter((l) => l.type === "remove").length}-
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {actions}
          <Button size="sm" variant="ghost" onClick={handleCopy} title="Copy diff">
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>

      {/* Code diff lines */}
      <div className="p-2 overflow-x-auto space-y-0.5 select-text">
        {visibleLines.map((line, idx) => {
          if (line.type === "add") {
            return (
              <div
                key={idx}
                className="flex items-start gap-2 px-2 py-0.5 rounded-sm bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border-l-2 border-emerald-500"
              >
                <span className="select-none font-bold text-emerald-600 dark:text-emerald-400 shrink-0">
                  +
                </span>
                <pre className="whitespace-pre-wrap break-all font-mono">{line.content}</pre>
              </div>
            );
          }
          if (line.type === "remove") {
            return (
              <div
                key={idx}
                className="flex items-start gap-2 px-2 py-0.5 rounded-sm bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300 border-l-2 border-rose-500 line-through opacity-80"
              >
                <span className="select-none font-bold text-rose-600 dark:text-rose-400 shrink-0">
                  -
                </span>
                <pre className="whitespace-pre-wrap break-all font-mono">{line.content}</pre>
              </div>
            );
          }
          return (
            <div
              key={idx}
              className="flex items-start gap-2 px-2 py-0.5 text-gray-600 dark:text-gray-400 border-l-2 border-transparent"
            >
              <span className="select-none text-gray-400 shrink-0"> </span>
              <pre className="whitespace-pre-wrap break-all font-mono">{line.content}</pre>
            </div>
          );
        })}
      </div>

      {/* Expand/Collapse Toggle */}
      {shouldCollapse && (
        <div className="border-t border-gray-200 bg-gray-100/50 dark:border-gray-800 dark:bg-gray-900/50 px-3 py-1 text-center">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs font-sans text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 font-medium cursor-pointer"
          >
            {isExpanded ? "Collapse diff" : `Show ${lines.length - collapsedLines} more lines...`}
          </button>
        </div>
      )}
    </div>
  );
}
