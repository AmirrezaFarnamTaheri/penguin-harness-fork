import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  simulateKeyProbe,
  type KeyHealthItem,
  type KeyProbeResult,
} from "./key-fleet-types";

export interface KeyProbeModalProps {
  keyItem: KeyHealthItem;
  provider: string;
  modelId: string;
  onClose: () => void;
}

export function KeyProbeModal({
  keyItem,
  provider,
  modelId,
  onClose,
}: KeyProbeModalProps) {
  const [probing, setProbing] = useState(true);
  const [result, setResult] = useState<KeyProbeResult | null>(null);

  const runProbe = () => {
    setProbing(true);
    // Simulate brief network latency check
    setTimeout(() => {
      const probeResult = simulateKeyProbe(keyItem.maskedKey, provider);
      setResult(probeResult);
      setProbing(false);
    }, 450);
  };

  useEffect(() => {
    runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyItem.maskedKey, provider]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              API Key Live Latency Probe
            </h3>
            <p className="text-xs text-muted-foreground">
              Testing endpoint roundtrip latency and authorization validity
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close dialog"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex flex-col gap-4 py-5">
          {/* Target Info */}
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3 text-xs">
            <div>
              <span className="text-muted-foreground">Target Key:</span>
              <div className="font-mono font-medium text-foreground">
                {keyItem.maskedKey}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Provider / Model:</span>
              <div className="font-medium text-foreground">
                {provider} / {modelId}
              </div>
            </div>
          </div>

          {probing ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-xs text-muted-foreground">
                Dispatching handshake probe to {provider} gateway...
              </span>
            </div>
          ) : result ? (
            <div className="flex flex-col gap-4">
              {/* Latency & Status Card */}
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Badge tone={result.status === "ok" ? "green" : "red"}>
                    {result.status === "ok" ? "HTTP 200 OK" : "Probe Failed"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    RTT:
                  </span>
                  <span className="font-mono text-sm font-bold text-foreground">
                    {result.latencyMs} ms
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(result.timestamp).toLocaleTimeString()}
                </span>
              </div>

              {/* Latency Sparkline Graph */}
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <span className="text-xs font-medium text-foreground">
                  Roundtrip Latency History (Recent Probes)
                </span>
                <div className="h-20 w-full">
                  <svg className="h-full w-full overflow-visible" viewBox="0 0 200 60">
                    {/* Horizontal grid lines */}
                    <line x1="0" y1="15" x2="200" y2="15" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2,2" />
                    <line x1="0" y1="35" x2="200" y2="35" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2,2" />
                    <line x1="0" y1="55" x2="200" y2="55" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2,2" />

                    {/* Sparkline polyline */}
                    {result.sparkline.length > 1 && (
                      <>
                        <polyline
                          fill="none"
                          stroke="rgb(16, 185, 129)"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          points={result.sparkline
                            .map((val, idx) => {
                              const x = (idx / (result.sparkline.length - 1)) * 190 + 5;
                              const min = 30;
                              const max = 250;
                              const y = 55 - ((val - min) / (max - min)) * 45;
                              return `${x},${Math.max(5, Math.min(55, y))}`;
                            })
                            .join(" ")}
                        />
                        {/* Point circles */}
                        {result.sparkline.map((val, idx) => {
                          const x = (idx / (result.sparkline.length - 1)) * 190 + 5;
                          const min = 30;
                          const max = 250;
                          const y = 55 - ((val - min) / (max - min)) * 45;
                          return (
                            <circle
                              key={idx}
                              cx={x}
                              cy={Math.max(5, Math.min(55, y))}
                              r={idx === result.sparkline.length - 1 ? 4 : 2.5}
                              className={
                                idx === result.sparkline.length - 1
                                  ? "fill-emerald-400 stroke-card stroke-2"
                                  : "fill-emerald-600"
                              }
                            />
                          );
                        })}
                      </>
                    )}
                  </svg>
                </div>
              </div>

              {result.details && (
                <div className="rounded bg-muted/40 p-2.5 font-mono text-[11px] text-muted-foreground">
                  {result.details}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={probing}
            onClick={runProbe}
          >
            {probing ? "Probing..." : "Probe Again"}
          </Button>
        </div>
      </div>
    </div>
  );
}
