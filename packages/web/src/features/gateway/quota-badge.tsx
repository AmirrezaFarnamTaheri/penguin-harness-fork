import { useEffect, useState } from "react";

export interface QuotaBadgeProps {
  sessionPct?: number;
  weeklyPct?: number;
  resetsIn?: string;
  isCooling?: boolean;
  onClick?: () => void;
}

export function QuotaBadge({
  sessionPct = 0,
  weeklyPct = 0,
  resetsIn = "Normal",
  isCooling = false,
  onClick,
}: QuotaBadgeProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const isWarning = sessionPct >= 80 || isCooling;
  const isCritical = sessionPct >= 95 || isCooling;

  const dotBg = isCritical
    ? "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.6)]"
    : isWarning
      ? "bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.5)]"
      : "bg-cyan-500 dark:bg-cyan-400 shadow-[0_0_5px_rgba(6,182,212,0.4)]";

  const badgeBg = isCritical
    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30"
    : isWarning
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
      : "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/25";

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Session Quota: ${Math.round(sessionPct)}% (Resets in: ${resetsIn}) • Weekly: ${Math.round(weeklyPct)}%`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-all duration-150 select-none hover:opacity-90 ${badgeBg}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotBg}`} />
      <span>{Math.round(sessionPct)}%</span>
      <span className="opacity-30">|</span>
      <span className="opacity-80 text-[10px]">W: {Math.round(weeklyPct)}%</span>
    </button>
  );
}
