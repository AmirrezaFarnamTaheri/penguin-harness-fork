/**
 * LiveBrowserViewport — the cockpit's eye on one isolated browser session.
 *
 * It paints the compressed frame stream the steerable cluster emits onto a <canvas> instead of
 * swapping <img> sources: a canvas keeps the decoded surface owned by a single element, so a
 * frame decoded out of order, or a decode that completes after the widget unmounted, can never
 * tear the picture or touch a detached node. Frames arrive already serialized to a data URL (or
 * a raw base64 JPEG body), so no transport concern lives here — the parent owns the stream and
 * hands this widget the frames it wants painted.
 *
 * The header reports only what the frame stream itself proves: the session state as the cluster
 * last reported it, the frame's own dimensions, a rolling FPS derived from frame timestamp
 * deltas (never an assumed cadence — the cluster throttles under load, and the figure has to
 * move with it), and the dropped-frame count the parent aggregates from sequence gaps.
 */
import React, { useEffect, useMemo, useRef } from "react";
import type { BrowserSessionState, ViewportFrame } from "@prismshadow/penguin-core/browser";

export interface LiveBrowserViewportProps {
  /** Frames for one target, oldest first; the last element is painted. */
  frames: ViewportFrame[];
  sessionId?: string;
  state?: BrowserSessionState;
  /** Frames the parent counted as dropped from sequence gaps, if it tracks them. */
  droppedFrames?: number;
  className?: string;
}

/** How many recent timestamps the rolling FPS averages over. */
const FPS_WINDOW = 20;

const STATE_BADGE: Record<BrowserSessionState, { label: string; class: string }> = {
  pending: {
    label: "Pending",
    class: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200",
  },
  launching: {
    label: "Launching",
    class: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border-blue-300",
  },
  live: {
    label: "● Live",
    class:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-300",
  },
  reconnecting: {
    label: "Reconnecting",
    class: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-300",
  },
  ending: {
    label: "Ending",
    class: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200",
  },
  ended: {
    label: "Ended",
    class: "bg-gray-100 text-gray-500 dark:bg-gray-800/60 dark:text-gray-400 border-gray-200",
  },
  failed: {
    label: "Failed",
    class: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border-rose-300",
  },
};

export function LiveBrowserViewport({
  frames,
  sessionId,
  state,
  droppedFrames,
  className,
}: LiveBrowserViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // An Image decode is async; a frame whose onload fires after unmount must not touch the canvas.
  const mountedRef = useRef(false);

  const lastFrame = frames[frames.length - 1];
  const stateBadge = state === undefined ? null : STATE_BADGE[state];

  const fps = useMemo(() => {
    const times: number[] = [];
    for (const frame of frames.slice(-FPS_WINDOW)) {
      const ms = Date.parse(frame.timestamp);
      if (!Number.isNaN(ms)) times.push(ms);
    }
    if (times.length < 2) return null;
    let totalDelta = 0;
    let samples = 0;
    for (let i = 1; i < times.length; i++) {
      const previous = times[i - 1];
      const current = times[i];
      // Both guards are unreachable while the loop bound holds; they only satisfy the
      // noUncheckedIndexedAccess rule that flags every indexed element as possibly absent.
      if (previous === undefined || current === undefined) continue;
      const delta = current - previous;
      if (delta > 0) {
        totalDelta += delta;
        samples += 1;
      }
    }
    if (samples === 0) return null;
    return 1000 / (totalDelta / samples);
  }, [frames]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = lastFrame;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const image = new Image();
    image.onload = () => {
      if (!mountedRef.current) return;
      // Only reassign the backing store when the geometry actually changes: assigning either
      // dimension clears the canvas, which would blank a frame that arrived between two
      // same-sized paints.
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, frame.width, frame.height);
    };
    image.src = frame.encoding === "data-url" ? frame.data : `data:image/jpeg;base64,${frame.data}`;
  }, [lastFrame]);

  return (
    <div
      className={`rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 text-xs shadow-xs space-y-3 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {stateBadge && (
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${stateBadge.class}`}
          >
            {stateBadge.label}
          </span>
        )}
        <span className="text-gray-400 font-mono text-[10px]">
          {lastFrame ? `${lastFrame.width}×${lastFrame.height}` : "no frames"}
        </span>
        <span className="text-gray-400 font-mono text-[10px]">
          {fps === null ? "— fps" : `${fps.toFixed(1)} fps`}
        </span>
        <span className="text-gray-400 font-mono text-[10px]">{frames.length} painted</span>
        {droppedFrames !== undefined && droppedFrames > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border-rose-300">
            {droppedFrames} dropped
          </span>
        )}
        {sessionId && (
          <span className="ml-auto truncate text-gray-400 font-mono text-[10px]">{sessionId}</span>
        )}
      </div>

      {lastFrame ? (
        <canvas
          ref={canvasRef}
          width={lastFrame.width}
          height={lastFrame.height}
          className="block w-full h-auto rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950"
        />
      ) : (
        <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-gray-300 px-4 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
          No viewport yet — the session has not delivered a frame.
        </div>
      )}
    </div>
  );
}
