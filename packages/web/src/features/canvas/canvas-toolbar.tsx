/**
 * Cockpit vector toolbar (Track 5, Tier 3).
 *
 * The control strip for the agentic vector canvas: tool selection, zoom
 * controls (bounds and clamping come from the core camera module so this UI can
 * never offer a zoom the canvas would reject) and the canvas theme picker.
 * Presentational only — every action is a callback, no state of its own beyond
 * the hover affordances buttons already give.
 */
import { MAX_ZOOM, MIN_ZOOM, clampZoom } from "@prismshadow/penguin-core/canvas";
import { CANVAS_THEME_KEYS, type CanvasThemeKey } from "./vector-canvas.js";

export type CanvasTool = "select" | "pan";

export interface CanvasToolbarProps {
  readonly tool?: CanvasTool;
  readonly onToolChange?: (tool: CanvasTool) => void;
  /** Current camera zoom, shown as a percentage. */
  readonly zoom?: number;
  readonly onZoomIn?: () => void;
  readonly onZoomOut?: () => void;
  readonly onZoomReset?: () => void;
  readonly onZoomFit?: () => void;
  readonly theme?: CanvasThemeKey;
  readonly onThemeChange?: (theme: CanvasThemeKey) => void;
  /** Visible/total node counts, surfaced as the culling health readout. */
  readonly visibleCount?: number;
  readonly totalCount?: number;
  readonly className?: string;
}

const TOOLS: ReadonlyArray<{
  readonly id: CanvasTool;
  readonly label: string;
  readonly title: string;
}> = [
  { id: "select", label: "Select", title: "Select and inspect nodes (V)" },
  { id: "pan", label: "Pan", title: "Drag to pan the canvas (H or hold Space)" },
];

export function CanvasToolbar({
  tool = "select",
  onToolChange,
  zoom = 1,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onZoomFit,
  theme = "dark-obsidian",
  onThemeChange,
  visibleCount,
  totalCount,
  className = "",
}: CanvasToolbarProps) {
  const zoomPercent = Math.round(clampZoom(zoom) * 100);
  const canZoomIn = zoom < MAX_ZOOM;
  const canZoomOut = zoom > MIN_ZOOM;
  const cullingActive =
    typeof visibleCount === "number" && typeof totalCount === "number" && totalCount > 0;

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-gray-200 bg-white/90 px-2 py-1.5 text-sm shadow-sm backdrop-blur dark:border-gray-800 dark:bg-gray-900/90 ${className}`}
      role="toolbar"
      aria-label="Vector canvas controls"
    >
      <div className="flex items-center gap-0.5" role="group" aria-label="Canvas tool">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            title={entry.title}
            aria-pressed={tool === entry.id}
            onClick={() => onToolChange?.(entry.id)}
            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
              tool === entry.id
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="h-5 w-px shrink-0 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

      <div className="flex items-center gap-0.5" role="group" aria-label="Canvas zoom">
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          disabled={!canZoomOut}
          onClick={onZoomOut}
          className="rounded-md px-2 py-1 text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          −
        </button>
        <button
          type="button"
          title="Reset zoom to 100%"
          onClick={onZoomReset}
          className="min-w-[3rem] rounded-md px-1.5 py-1 text-center font-mono text-xs tabular-nums text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          disabled={!canZoomIn}
          onClick={onZoomIn}
          className="rounded-md px-2 py-1 text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          +
        </button>
        <button
          type="button"
          title="Fit all nodes to the viewport"
          onClick={onZoomFit}
          className="rounded-md px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Fit
        </button>
      </div>

      <div className="h-5 w-px shrink-0 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

      <div className="flex items-center gap-1" role="group" aria-label="Canvas theme">
        {CANVAS_THEME_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            title={`Theme: ${key}`}
            aria-pressed={theme === key}
            onClick={() => onThemeChange?.(key)}
            className={`h-6 w-6 rounded-full border-2 transition-shadow ${
              theme === key
                ? "ring-2 ring-blue-500 ring-offset-1"
                : "border-gray-300 dark:border-gray-600"
            }`}
            style={{ backgroundColor: themeSwatch(key) }}
            aria-label={`Switch to ${key} theme`}
          />
        ))}
      </div>

      {cullingActive ? (
        <>
          <div className="h-5 w-px shrink-0 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
          <span
            className="font-mono text-xs tabular-nums text-gray-500 dark:text-gray-400"
            title="Nodes rendered after viewport culling"
          >
            {visibleCount}/{totalCount} nodes
          </span>
        </>
      ) : null}
    </div>
  );
}

/** One recognisable colour per theme, for the swatch buttons. */
function themeSwatch(key: CanvasThemeKey): string {
  switch (key) {
    case "clean-blueprint":
      return "#eef3f8";
    case "technical-paper":
      return "#f7f4ec";
    case "dark-obsidian":
    default:
      return "#0d0f12";
  }
}
