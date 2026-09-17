import { useId, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  NAV_TOOL_GROUPS,
  PRIMARY_NAV_KEYS,
  currentNavKey,
  initialToolGroupExpanded,
  storeToolGroupExpanded,
} from "../../lib/nav-group-collapse";
import type { NavToolGroupKey } from "../../lib/nav-group-collapse";
import { S } from "../../lib/strings";
import { ChevronDown } from "../ui/icons";
import { Icon } from "../ui/group-list";
import { UpdateDot } from "../ui/update-dot";

export interface ProductNavItem {
  key: string;
  to: string | null;
  label: string;
  icon: string;
  note: string | null;
}

const rowClass =
  "relative flex min-h-9 w-full items-center gap-2 rounded-md py-1.5 pl-2.5 pr-6 text-sm transition-colors duration-150 max-md:min-h-11";
const idleClass =
  "text-gray-600 hover:bg-gray-200/50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/70 dark:hover:text-gray-200";

/** Three everyday links, then named tool groups. A closed group still shows its current page. */
export function ProductNavigation({
  items,
  onNavigate,
}: {
  items: readonly ProductNavItem[];
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const active = currentNavKey(pathname);
  const id = useId();
  const [expanded, setExpanded] = useState<Record<NavToolGroupKey, boolean>>(() => ({
    build: initialToolGroupExpanded("build"),
    inspect: initialToolGroupExpanded("inspect"),
    manage: initialToolGroupExpanded("manage"),
  }));
  const toggle = (key: NavToolGroupKey) => {
    const next = !expanded[key];
    storeToolGroupExpanded(key, next);
    setExpanded({ ...expanded, [key]: next });
  };
  const row = (item: ProductNavItem) =>
    item.to === null ? null : (
      <Link
        key={item.key}
        to={item.to}
        onClick={() => onNavigate?.()}
        aria-current={active === item.key ? "page" : undefined}
        title={item.note ?? undefined}
        aria-label={item.note ? `${item.label} · ${item.note}` : undefined}
        className={`${rowClass} ${active === item.key ? "bg-gray-200/70 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100" : idleClass}`}
      >
        <span className="shrink-0 text-gray-500 dark:text-gray-400">
          <Icon d={item.icon} />
        </span>
        <span className="min-w-0 flex-1">{item.label}</span>
        {item.note !== null && (
          <UpdateDot size="inline" position="right-2.5 top-1/2 -translate-y-1/2" />
        )}
      </Link>
    );
  return (
    <nav aria-label={S.nav.navigation} className="space-y-0.5">
      {PRIMARY_NAV_KEYS.map((key) => {
        const item = items.find((item) => item.key === key);
        return item ? row(item) : null;
      })}
      <div className="pt-2">
        {NAV_TOOL_GROUPS.map((group) => {
          const groupItems = group.keys.flatMap((key) => {
            const item = items.find((item) => item.key === key);
            return item ? [item] : [];
          });
          if (!groupItems.length) return null;
          const open = expanded[group.key];
          const notes = groupItems
            .filter((item) => item.note !== null)
            .map((item) => `${item.label}: ${item.note}`)
            .join("; ");
          const label = S.nav.toolGroups[group.key];
          return (
            <div key={group.key} className="space-y-0.5">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`${id}-${group.key}`}
                aria-label={notes ? `${label} · ${notes}` : undefined}
                title={notes || undefined}
                onClick={() => toggle(group.key)}
                className={`${rowClass} ${idleClass}`}
              >
                <ChevronDown
                  size={16}
                  className={`shrink-0 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
                />
                <span className="min-w-0 flex-1 text-left">{label}</span>
                {notes && !open && (
                  <UpdateDot size="inline" position="right-2.5 top-1/2 -translate-y-1/2" />
                )}
              </button>
              <div id={`${id}-${group.key}`} className="space-y-0.5 pl-3">
                {/* No zero-height focusable links: closed groups render only the active destination. */}
                {groupItems.filter((item) => open || item.key === active).map(row)}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
