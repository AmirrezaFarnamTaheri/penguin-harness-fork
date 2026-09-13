/**
 * Dropdown select component: **custom-drawn** (not the native browser select),
 * keeping the same API — parses `<option>` children and follows the
 * `value` / `onChange(e.target.value)` convention. The menu is rendered via
 * portal to body (fixed positioning from the shared usePortalPanel hook), so it
 * is never clipped by a Modal or scroll container; it closes on outside click,
 * Esc, a scroll that moves the trigger, or resize. Styling matches Input.
 */
import { Children, isValidElement, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode, SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { errorClass, sizeClass, sizeTextClass } from "./input";
import type { ControlSize } from "./input";
import { Field, controlBase, menuRowClass } from "./field";
import { CheckIcon, ChevronDown } from "./icons";
import { usePortalPanel } from "./use-portal-panel";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: string;
  hint?: string;
  /** Field-value error: red border + message below, exactly like Input. */
  error?: string;
  /** Same size tier as Input: sm is for filter bars, keeps the toolbar from growing taller. */
  size?: ControlSize;
}

interface Opt {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

/** Parses the option list out of `<option>` children. */
function parseOptions(children: ReactNode): Opt[] {
  const out: Opt[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || child.type !== "option") return;
    const p = child.props as { value?: string | number; children?: ReactNode; disabled?: boolean };
    out.push({
      value: p.value !== undefined ? String(p.value) : "",
      label: p.children ?? "",
      ...(p.disabled ? { disabled: true } : {}),
    });
  });
  return out;
}

const CONTROL_CLASS = `flex w-full items-center gap-2 text-left ${controlBase} disabled:cursor-not-allowed disabled:opacity-60`;

/** Move through a circular option list while skipping disabled rows. */
export function nextEnabledOptionIndex(
  enabled: readonly boolean[],
  from: number,
  direction: 1 | -1,
): number {
  for (let step = 1; step <= enabled.length; step += 1) {
    const index = (from + direction * step + enabled.length) % enabled.length;
    if (enabled[index]) return index;
  }
  return -1;
}

export function Select({
  label,
  hint,
  error,
  required,
  size = "sm",
  className,
  children,
  value,
  onChange,
  disabled,
  // Forwarded like a native select would: a control with no visible `label` (one sitting in
  // an already-labelled settings row, say) still has to name itself to a screen reader, and
  // the selected option's text says what is chosen, not what is being chosen.
  "aria-label": ariaLabel,
}: SelectProps) {
  const options = parseOptions(children);
  const current = String(value ?? "");
  const selected = options.find((o) => o.value === current);
  const errorId = useId();
  const listboxId = useId();

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { triggerRef, panelRef, position } = usePortalPanel({
    open,
    onClose: () => setOpen(false),
    // Row height is roughly 36px (px-3 py-1.5 + text) — only used to decide up vs down.
    estimatedHeight: options.length * 36 + 8,
  });

  const enabled = options.map((option) => !option.disabled);
  const selectedIndex = options.findIndex((option) => option.value === current && !option.disabled);
  const firstEnabled = enabled.indexOf(true);
  const lastEnabled = enabled.lastIndexOf(true);

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

  const pick = (v: string) => {
    setOpen(false);
    // Synthesize a minimal event object, following the caller's onChange(e.target.value) convention.
    onChange?.({ target: { value: v } } as unknown as ChangeEvent<HTMLSelectElement>);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openAt(
      selectedIndex >= 0 ? selectedIndex : event.key === "ArrowDown" ? firstEnabled : lastEnabled,
    );
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
        next = firstEnabled;
        break;
      case "End":
        next = lastEnabled;
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
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onClick={() =>
          open ? setOpen(false) : openAt(selectedIndex >= 0 ? selectedIndex : firstEnabled)
        }
        onKeyDown={onTriggerKeyDown}
        className={`${CONTROL_CLASS} ${sizeClass[size]} ${error ? errorClass : ""} ${className ?? ""}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected?.label ?? options[0]?.label ?? ""}
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
            className="anim-pop fixed z-[60] max-h-60 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
            style={{
              left: position.left,
              width: position.triggerWidth,
              top: position.topPx,
              bottom: position.bottomPx,
            }}
          >
            {options.map((o, i) => (
              <button
                ref={(node) => {
                  optionRefs.current[i] = node;
                }}
                key={`${o.value}-${i}`}
                type="button"
                role="option"
                aria-selected={o.value === current}
                disabled={o.disabled}
                tabIndex={i === activeIndex ? 0 : -1}
                onClick={() => pick(o.value)}
                onKeyDown={(event) => onOptionKeyDown(event, i)}
                // Menu-row text takes the control's own tier, so the dropdown reads exactly
                // like an Input of that tier.
                className={`flex items-center ${menuRowClass} ${sizeTextClass[size]} disabled:opacity-50 ${
                  o.value === current
                    ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === current && <CheckIcon className="text-gray-500 dark:text-gray-400" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );

  return (
    <Field label={label} hint={hint} error={error} errorId={errorId} required={required}>
      {control}
    </Field>
  );
}
