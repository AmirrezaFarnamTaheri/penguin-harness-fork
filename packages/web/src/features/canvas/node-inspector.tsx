/**
 * Agent node property inspector (Track 5, Tier 3).
 *
 * Property panel for the currently selected canvas node: position, size, shape,
 * and fill/stroke colours. Colour fields validate through the core colour
 * module and show a WCAG-aware contrast hint, so the panel can never accept a
 * colour string the renderer would reject. Presentational only — every edit
 * leaves as a patch callback; the parent owns the node.
 */
import {
  contrastRatio,
  hexToRgb,
  isValidColorString,
  wcagLevels,
} from "../../../../core/src/canvas/color-space.js";
import type { CanvasNodeShape } from "./vector-canvas.js";

export interface InspectorNode {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly shape?: CanvasNodeShape;
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly layer?: number;
}

/** The fields the inspector can edit. */
export type InspectorPatch = Partial<{
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: CanvasNodeShape;
  fill: string;
  stroke: string;
  strokeWidth: number;
}>;

export interface NodeInspectorProps {
  readonly node: InspectorNode | null;
  readonly onChange?: (patch: InspectorPatch) => void;
  readonly className?: string;
}

const SHAPES: ReadonlyArray<CanvasNodeShape> = ["rect", "rounded", "ellipse"];

export function NodeInspector({ node, onChange, className = "" }: NodeInspectorProps) {
  if (!node) {
    return (
      <div
        className={`flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-gray-400 dark:text-gray-500 ${className}`}
      >
        <svg
          className="h-8 w-8"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15 15l-2 5L9 9l11 4-5 2zM15 15l5 5M15 15l-5-5"
          />
        </svg>
        <p>Select a node on the canvas to inspect its properties.</p>
      </div>
    );
  }

  const numberField = (
    field: "x" | "y" | "width" | "height" | "strokeWidth",
    label: string,
    step = 1,
  ) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <input
        type="number"
        step={step}
        value={node[field]}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) onChange?.({ [field]: value } as InspectorPatch);
        }}
        className="rounded-md border border-gray-200 bg-white px-2 py-1 font-mono tabular-nums text-gray-800 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
      />
    </label>
  );

  const colorField = (field: "fill" | "stroke", label: string) => {
    const value = node[field];
    const valid = isValidColorString(value);
    return (
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-gray-500 dark:text-gray-400">{label}</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={value}
            aria-label={`${label} colour picker`}
            onChange={(event) => onChange?.({ [field]: event.target.value } as InspectorPatch)}
            className="h-7 w-7 shrink-0 cursor-pointer rounded border border-gray-200 bg-white dark:border-gray-700"
          />
          <input
            type="text"
            value={value}
            spellCheck={false}
            aria-invalid={!valid}
            onChange={(event) => {
              const next = event.target.value;
              // Only commit well-formed colours; the field keeps typing otherwise.
              if (isValidColorString(next)) onChange?.({ [field]: next } as InspectorPatch);
            }}
            className={`flex-1 rounded-md border bg-white px-2 py-1 font-mono text-gray-800 focus:outline-none dark:bg-gray-900 dark:text-gray-200 ${
              valid
                ? "border-gray-200 focus:border-blue-500 dark:border-gray-700"
                : "border-rose-400 focus:border-rose-500 dark:border-rose-600"
            }`}
          />
        </div>
        {valid ? (
          <ContrastHint fill={value} />
        ) : (
          <span className="text-rose-500">Expected a hex or rgb() colour.</span>
        )}
      </div>
    );
  };

  return (
    <div
      className={`flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm ${className}`}
      aria-label="Node property inspector"
    >
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 pb-2 dark:border-gray-800">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-gray-800 dark:text-gray-100">{node.label}</h3>
          <p className="truncate font-mono text-xs text-gray-400 dark:text-gray-500">{node.id}</p>
        </div>
        {node.layer !== undefined ? (
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            layer {node.layer}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {numberField("x", "X")}
        {numberField("y", "Y")}
        {numberField("width", "Width")}
        {numberField("height", "Height")}
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-gray-500 dark:text-gray-400">Shape</span>
        <select
          value={node.shape ?? "rounded"}
          onChange={(event) => onChange?.({ shape: event.target.value as CanvasNodeShape })}
          className="rounded-md border border-gray-200 bg-white px-2 py-1 text-gray-800 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        >
          {SHAPES.map((shape) => (
            <option key={shape} value={shape}>
              {shape}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        {colorField("fill", "Fill")}
        {colorField("stroke", "Stroke")}
      </div>

      {numberField("strokeWidth", "Stroke width", 0.5)}
    </div>
  );
}

/**
 * Readability hint for the fill as a label background: the contrast ratio is
 * the core module's own WCAG calculation, so the inspector's verdict matches
 * what the canvas labels actually use.
 */
function ContrastHint({ fill }: { readonly fill: string }) {
  const rgb = hexToRgb(fill);
  if (!rgb) return null;
  const onWhite = contrastRatio(rgb, { r: 255, g: 255, b: 255 });
  const onBlack = contrastRatio(rgb, { r: 0, g: 0, b: 0 });
  const ratio = Math.max(onWhite, onBlack);
  const { aa } = wcagLevels(
    ratio >= onBlack ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 },
    rgb,
  );
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-3 rounded-sm border border-black/10"
        style={{ backgroundColor: fill }}
        aria-hidden="true"
      />
      <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500">
        {ratio.toFixed(1)}:1 · {aa ? "WCAG AA" : "below AA"}
      </span>
    </div>
  );
}
