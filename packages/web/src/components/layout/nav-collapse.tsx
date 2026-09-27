/**
 * The whole-nav collapse, shared by both page navs — company mode's flat list
 * (sidebar.tsx) and development mode's ProductNavigation. It was written twice, once
 * per call site, and the two copies had already drifted in their comments while the
 * markup stayed identical; the duplication cost a fix to a measured bug twice over
 * (every nav group expanded pushed the Session list below the fold). One component, one
 * place the `max-md:min-h-11` touch-target floor and the accessible name live.
 *
 * `collapsed` / `onToggle` are the sidebar's own state and store write: one preference,
 * one stored key, passed in rather than read here, because a second reader would hold a
 * second copy and drift from the sidebar's the moment either side remounts.
 */
import type { ReactNode } from "react";
import { S } from "../../lib/strings";
import { ChevronDown } from "../ui/icons";

export function NavGroupCollapse({
  collapsed,
  onToggle,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** The nav entries themselves; this component owns the sliding wrapper and the toggle. */
  children: ReactNode;
}) {
  return (
    <>
      {/* The SLIDE: grid-template-rows tweens between 0fr and 1fr with the inner
          overflow-hidden clipping the entries — the moving clip edge reveals/hides them
          while the toggle button and the Session list below glide up/down with it; a
          subtle opacity fade rides along, both 200ms, moving as one with the chevron flip
          below. The rows stay mounted for the tween but go inert while collapsed
          (zero-height rows must not stay Tab-focusable or clickable). Transitions fire
          only on state CHANGES, so a mount restoring a persisted collapsed state renders
          collapsed instantly — only user toggles animate; reduced motion is covered by
          the global prefers-reduced-motion override in styles.css. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden" inert={collapsed}>
          <div
            className={`space-y-0.5 transition-opacity duration-200 ${
              collapsed ? "opacity-0" : "opacity-100"
            }`}
          >
            {children}
          </div>
        </div>
      </div>
      {/* Collapse toggle of the page-nav group (Agents → Benchmark): a slim (h-4)
          nav-row-wide button directly under the group's last entry — a centered chevron
          pointing UP while expanded (click to collapse) and DOWN while collapsed (the
          button stays as the only way back, right under the new-chat boundary once the
          entries are hidden). The soft resting band is deliberate — the sidebar's one
          exception to flat-at-rest: it makes the strip read as the seam between the page
          nav above and the Session list below (the ruled separator it replaces was
          rejected as a line under the button); hover deepens it a step further so it
          stays clearly interactive. Icon-only, so tooltip + aria carry the name —
          and it names the WHOLE nav ("Collapse all sections"), not GroupHeader's
          "Collapse", because this is a different action on a different target and
          two controls sharing one accessible name is a defect in itself.
          `max-md:min-h-11` is the touch
          target the nav rows keep on a phone — a 16px strip is a fine mouse target and a
          poor one under a thumb. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? S.nav.expandAllGroups : S.nav.collapseAllGroups}
        title={collapsed ? S.nav.expandAllGroups : S.nav.collapseAllGroups}
        className="flex h-4 max-md:min-h-11 w-full items-center justify-center rounded-md bg-gray-200/70 text-gray-400 transition-colors duration-150 hover:bg-gray-300/60 hover:text-gray-700 dark:bg-gray-800/70 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
      >
        <ChevronDown
          size={12}
          className={`transition-transform duration-200 ${collapsed ? "" : "rotate-180"}`}
        />
      </button>
    </>
  );
}
