/**
 * Popup frame shared by the composer's two `/` switch pickers (`/model`, `/agent`), extracted
 * from chat-input.tsx (a mechanical move — the panel and its upward placement are unchanged).
 */
import type { ReactNode, RefObject } from "react";

/**
 * Popup frame shared by the two `/` switch pickers (`/model`, `/agent`): the upward-opening
 * panel and its title bar. It opens upward from the composer and is height-capped to the room
 * actually measured above it (see upwardMaxH), so it can never render off-screen; the panel has
 * no trigger button of its own, so dismissal (click-outside / Escape) is handled by the host.
 */
export function SwitchPickerPanel({
  panelRef,
  maxHeight,
  title,
  children,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  maxHeight: number | undefined;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={panelRef}
      style={{ maxHeight }}
      className="anim-pop absolute bottom-full left-0 z-40 mb-1.5 flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="border-b border-gray-100 px-3 pb-1.5 pt-0.5 text-xs font-semibold text-gray-500 dark:border-gray-800 dark:text-gray-400">
        {title}
      </div>
      {children}
    </div>
  );
}
