/**
 * Option menu (controlled): the trigger button shows a compact current value, and
 * clicking it expands a panel where each row has a title + description text + a
 * selected-state checkmark. Replaces select controls that show only an abbreviation
 * and rely on the native `title` hover tooltip for details (tooltips are poorly
 * discoverable — users have no idea they should hover before they've clicked once).
 *
 * The trigger button shares the sizeClass size tier with Input/Select, and the panel
 * row styling matches the Select menu (py-1.5, bold selected row + SVG checkmark),
 * keeping visuals consistent when mixed with existing form controls.
 *
 * The panel is mounted via createPortal to document.body and positioned with
 * `position: fixed` against viewport coordinates — it does not reuse the Dropdown
 * primitive's in-place absolute positioning. Reason: a Dropdown panel is a DOM
 * descendant of its trigger button, so if an ancestor in the chain has a container
 * like overflow-x-auto (e.g. this component used inside a tool table), the CSS spec
 * says that when one axis has non-visible overflow and the other is visible, the
 * visible axis gets forced to `auto` — making that ancestor clip vertically
 * overflowing descendants, and absolute positioning is not exempt. A portaled node
 * is outside that ancestor's DOM subtree, so it is fundamentally unaffected by its
 * overflow, without having to audit every call site's ancestor chain.
 * Positioning and close behavior live in use-portal-panel.ts.
 *
 * The panel uses z-[60] (above the modal overlay's z-50): a portaled node sits in
 * the root stacking context, and this component may also be used inside a Modal
 * form, where z-40 would get covered by the overlay.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { errorClass, sizeClass, sizeTextClass } from "./input";
import type { ControlSize } from "./input";
import { Field, controlBase, menuRowClass } from "./field";
import { CheckIcon, ChevronDown } from "./icons";
import { usePortalPanel } from "./use-portal-panel";
import { nextEnabledOptionIndex } from "./select";

export interface OptionMenuChoice<T extends string> {
  value: T;
  /** Compact text on the trigger button (e.g. "rw"). */
  triggerLabel: string;
  /** Panel row title (e.g. "Read & write"). */
  label: string;
  /** Panel row description text explaining when this option actually takes effect. */
  description: string;
}

const PANEL_WIDTH = 288; // w-72

/**
 * Descriptions keep one step below the row title at every tier, so the title/description
 * hierarchy survives the sm tier's text-xs titles. The sm value is the one `text-[Npx]` the
 * control family allows: there is no rung below text-xs to step down to. It is a fixed px and
 * so does not scale with the user's font-size setting — do not copy the shape elsewhere.
 */
export const rowDescClass: Record<ControlSize, string> = { base: "text-xs", sm: "text-[11px]" };

export function OptionMenu<T extends string>({
  options,
  value,
  onChange,
  placeholder,
  mono,
  label,
  error,
  required,
  fullWidth,
  size = "sm",
  "aria-label": ariaLabel,
}: {
  options: ReadonlyArray<OptionMenuChoice<T>>;
  /** null/undefined means unset/default: the trigger shows the placeholder and no panel row is selected. */
  value: T | null | undefined;
  onChange: (value: T) => void;
  /** Placeholder text on the trigger when value is empty. */
  placeholder?: string;
  /** Use a monospace font for the trigger text. */
  mono?: boolean;
  /** Field title above the control (same typography as Input); omit to render a bare trigger button (e.g. for table cell usage). */
  label?: string;
  /** Field-value error: red border + message below, exactly like Input. */
  error?: string;
  /** Renders a red "*" after the label. An optional field passes nothing — no counterpart mark, and no "optional" in the label. */
  required?: boolean;
  /** Stretch the trigger button to fill the container width, as a replacement for native Select in dense form areas. */
  fullWidth?: boolean;
  /** Same size tier as Input/Select (sizeClass), for pixel-perfect alignment when mixed together. */
  size?: ControlSize;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { triggerRef, panelRef, position } = usePortalPanel({
    open,
    onClose: () => setOpen(false),
    // Row height is roughly 48px (title + description two lines + py-1.5) + panel top/bottom padding.
    estimatedHeight: options.length * 48 + 16,
    panelWidth: PANEL_WIDTH,
  });
  const current = value != null ? options.find((o) => o.value === value) : undefined;
  const errorId = useId();
  const listboxId = useId();
  const enabled = options.map(() => true);
  const selectedIndex = options.findIndex((option) => option.value === value);

  const openAt = (index: number) => {
    if (index < 0 || index >= options.length) return;
    setActiveIndex(index);
    setOpen(true);
  };

  useEffect(() => {
    if (open && position && activeIndex >= 0) optionRefs.current[activeIndex]?.focus();
  }, [open, position, activeIndex]);

  useEffect(() => {
    if (!open && activeIndex >= 0 && document.activeElement === document.body)
      triggerRef.current?.focus();
  }, [open, activeIndex, triggerRef]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openAt(selectedIndex >= 0 ? selectedIndex : event.key === "ArrowDown" ? 0 : options.length - 1);
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    switch (event.key) {
      case "Tab":
        setOpen(false);
        triggerRef.current?.focus();
        return;
      case "ArrowDown":
        next = nextEnabledOptionIndex(enabled, index, 1);
        break;
      case "ArrowUp":
        next = nextEnabledOptionIndex(enabled, index, -1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = options.length - 1;
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (next >= 0) setActiveIndex(next);
  };

  const control = (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex >= 0 ? selectedIndex : 0))}
        onKeyDown={onTriggerKeyDown}
        className={
          `flex items-center gap-2 ${controlBase} ${sizeClass[size]} ${error ? errorClass : ""}` +
          (fullWidth ? " w-full justify-between" : "")
        }
      >
        <span className={`min-w-0 truncate ${mono ? "font-mono" : ""}`}>
          {current?.triggerLabel ?? placeholder ?? "—"}
        </span>
        <ChevronDown className="text-gray-400" />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            style={{
              position: "fixed",
              top: position.topPx,
              bottom: position.bottomPx,
              left: position.left,
              minWidth: position.triggerWidth,
            }}
            className="anim-pop z-[60] max-h-[70vh] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
          >
            {options.map((opt, i) => (
              <button
                ref={(node) => {
                  optionRefs.current[i] = node;
                }}
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                tabIndex={i === activeIndex ? 0 : -1}
                onKeyDown={(event) => onOptionKeyDown(event, i)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`block ${menuRowClass} hover:bg-gray-100 dark:hover:bg-gray-800 ${
                  opt.value === value ? "bg-gray-100 dark:bg-gray-800" : ""
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  {/* Row title takes the control's own tier, so the menu reads exactly like
                      an Input of that tier. */}
                  <span
                    className={`${sizeTextClass[size]} ${
                      opt.value === value
                        ? "font-medium text-gray-900 dark:text-gray-100"
                        : "text-gray-700 dark:text-gray-300"
                    }`}
                  >
                    {opt.label}
                  </span>
                  {opt.value === value && (
                    <CheckIcon className="text-gray-500 dark:text-gray-400" />
                  )}
                </span>
                <span
                  className={`mt-0.5 block ${rowDescClass[size]} text-gray-500 dark:text-gray-400`}
                >
                  {opt.description}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
  return (
    <Field label={label} error={error} errorId={errorId} required={required}>
      {control}
    </Field>
  );
}
