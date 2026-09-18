/**
 * DomTreeInspector — the agent's map of a page, as the cluster snapshotted it.
 *
 * The cluster prunes the tree to what the agent can act on before it ever reaches the cockpit,
 * so this renders the whole thing with no virtualization and a depth cap as the only backstop
 * against a page the pruning missed. Nodes are collapsible because an expanded snapshot of a
 * real nav is a wall of unreadable divs; the first two levels open by default, and any key the
 * operator has touched is remembered across snapshots so a refresh never undoes their pruning.
 *
 * Selection is index-based: the cluster assigns the index an agent would reference the element
 * by, so clicking a row hands the parent that index for the next query instead of a selector
 * this widget would have to guess at.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DomSnapshot, DomTreeNode } from "@prismshadow/penguin-core/browser";

export interface DomTreeInspectorProps {
  snapshot: DomSnapshot | null;
  /** Index of the node to highlight; undefined highlights nothing. */
  selectedIndex?: number;
  /** Called with the node's key and its cluster-assigned index, when it has one. */
  onSelect?: (key: string, index?: number) => void;
  className?: string;
}

/** Past this depth a pathological page is truncated rather than walked. */
const MAX_DEPTH = 32;
/** How much each nesting level indents, in pixels. */
const INDENT_PX = 12;
/** Visible characters of a node's own text before it is ellipsized. */
const TEXT_LIMIT = 48;

export function DomTreeInspector({
  snapshot,
  selectedIndex,
  onSelect,
  className,
}: DomTreeInspectorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Keys the operator has expanded or collapsed by hand; defaults never override these.
  const toggledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!snapshot) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const seedDefaults = (node: DomTreeNode, depth: number): void => {
        if (depth >= 2) return;
        if (!toggledRef.current.has(node.key)) next.add(node.key);
        node.children.forEach((child: DomTreeNode) => seedDefaults(child, depth + 1));
      };
      seedDefaults(snapshot.root, 0);
      return next;
    });
  }, [snapshot]);

  const toggle = useCallback((key: string) => {
    toggledRef.current.add(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (node: DomTreeNode) => {
      onSelect?.(node.key, node.index);
    },
    [onSelect],
  );

  const nodeCount = useMemo(() => {
    if (!snapshot) return 0;
    let count = 0;
    const walk = (node: DomTreeNode): void => {
      count += 1;
      node.children.forEach(walk);
    };
    walk(snapshot.root);
    return count;
  }, [snapshot]);

  const renderNode = (node: DomTreeNode, depth: number): React.ReactNode => {
    if (depth > MAX_DEPTH) return null;
    const isOpen = expanded.has(node.key);
    const hasChildren = node.children.length > 0;
    const isSelected = node.index !== undefined && node.index === selectedIndex;
    const text =
      node.text.length > TEXT_LIMIT ? `${node.text.slice(0, TEXT_LIMIT).trimEnd()}…` : node.text;
    const showRole = node.role.length > 0 && node.role !== node.tag;

    return (
      <div key={node.key}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => handleSelect(node)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleSelect(node);
            }
          }}
          style={{ paddingLeft: depth * INDENT_PX }}
          className={`flex items-center gap-1.5 py-1 pr-2 rounded-md cursor-pointer select-none border border-transparent ${
            isSelected
              ? "bg-blue-50 border-blue-200 dark:bg-blue-950/40 dark:border-blue-900"
              : "hover:bg-gray-50 dark:hover:bg-gray-800/50"
          }`}
          title={node.text}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggle(node.key);
              }}
              className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              aria-label={isOpen ? "Collapse node" : "Expand node"}
              aria-expanded={isOpen}
            >
              {isOpen ? "▾" : "▸"}
            </button>
          ) : (
            <span className="shrink-0 w-4" />
          )}
          <span className="shrink-0 font-mono text-[11px] font-semibold text-blue-600 dark:text-blue-400">
            {node.tag}
          </span>
          {showRole && (
            <span className="shrink-0 font-mono text-[10px] text-gray-500 dark:text-gray-400">
              {node.role}
            </span>
          )}
          {text && (
            <span className="truncate text-[11px] text-gray-600 dark:text-gray-300">{text}</span>
          )}
          {node.index !== undefined && (
            <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded font-mono text-[10px] bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {node.index}
            </span>
          )}
        </div>
        {isOpen &&
          hasChildren &&
          node.children.map((child: DomTreeNode) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div
      className={`rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 text-xs shadow-xs space-y-3 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">DOM Tree</h3>
        {snapshot ? (
          <>
            <span className="text-gray-400 font-mono text-[10px]">{nodeCount} nodes</span>
            <span className="text-gray-400 font-mono text-[10px]">
              {snapshot.viewport.width}×{snapshot.viewport.height}
            </span>
            <span className="text-gray-400 font-mono text-[10px]">
              scroll {Math.round(snapshot.scrollX)},{Math.round(snapshot.scrollY)}
            </span>
            <span className="ml-auto truncate text-gray-400 font-mono text-[10px]">
              {snapshot.targetId}
            </span>
          </>
        ) : (
          <span className="text-gray-400 font-mono text-[10px]">no snapshot</span>
        )}
      </div>

      {snapshot ? (
        <div className="max-h-96 overflow-y-auto -mx-1 px-1">{renderNode(snapshot.root, 0)}</div>
      ) : (
        <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-gray-300 px-4 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
          No DOM snapshot yet — the session has not captured the page.
        </div>
      )}
    </div>
  );
}
