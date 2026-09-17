import type { ExecutionSpan } from "./flamegraph-types";

function clampStep(step: number, maxSteps: number): number {
  return Number.isFinite(step) ? Math.max(0, Math.min(maxSteps, Math.floor(step))) : 0;
}

/** The converter returns roots in taskIndex order. Replay a prefix, not a reconstructed runtime. */
export function replayTraceTurns(spans: ExecutionSpan[], step: number): ExecutionSpan[] {
  return spans.slice(0, clampStep(step, spans.length));
}

export function TimeTravelSlider({
  maxSteps,
  currentStep,
  onStepChange,
}: {
  maxSteps: number;
  currentStep: number;
  onStepChange: (step: number) => void;
}) {
  const max = Number.isFinite(maxSteps) ? Math.max(0, Math.floor(maxSteps)) : 0;
  const step = clampStep(currentStep, max);
  return (
    <section aria-label="Recorded trace replay" className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="tabular-nums">
          {step} / {max} recorded turns
        </span>
        <input
          aria-label="Recorded trace turn"
          aria-valuetext={`${step} of ${max} recorded turns`}
          type="range"
          min={0}
          max={max}
          step={1}
          value={step}
          disabled={max === 0}
          onChange={(event) => onStepChange(clampStep(Number(event.target.value), max))}
          className="min-h-9 min-w-32 flex-1 accent-blue-600"
        />
        <button
          type="button"
          disabled={max === 0 || step === max}
          onClick={() => onStepChange(max)}
          className="min-h-9 rounded-md border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700"
        >
          Latest recorded
        </button>
      </div>
      <p className="text-gray-600 dark:text-gray-400">
        {max === 0
          ? "No recorded turns to replay."
          : "Read-only replay of the loaded trace file, one recorded turn at a time. No tools are re-executed and no session state is rewound."}
      </p>
    </section>
  );
}
