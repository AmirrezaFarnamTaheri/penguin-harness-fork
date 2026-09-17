import { useEffect, useState, useRef, useCallback } from "react";
import { Modal } from "../../components/ui/modal";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { simulateKeyProbe, type KeyHealthItem, type KeyProbeResult } from "./key-fleet-types";

export interface KeyProbeModalProps {
  keyItem: KeyHealthItem;
  provider: string;
  modelId: string;
  isDemo?: boolean;
  projectId?: string;
  onClose: () => void;
}

export function KeyProbeModal({
  keyItem,
  provider,
  modelId,
  isDemo = false,
  projectId = "default",
  onClose,
}: KeyProbeModalProps) {
  const [probing, setProbing] = useState(true);
  const [result, setResult] = useState<KeyProbeResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const runProbe = useCallback(async () => {
    abortRef.current?.abort();
    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    setProbing(true);
    setResult(null);
    if (isDemo) {
      setResult({ ...simulateKeyProbe(keyItem.maskedKey, provider), isSimulated: true });
      setProbing(false);
      return;
    }
    let failure = "The probe could not reach the server. Check the connection and retry.";
    try {
      const res = await fetch(`/api/cockpit/keys/probe?project=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          projectId,
          provider,
          keyId: keyItem.keyId,
          maskedKey: keyItem.maskedKey,
        }),
      });
      if (abortCtrl.signal.aborted) return;
      failure = `Probe failed (HTTP ${res.status}). Check the provider credentials and retry.`;
      if (res.ok) {
        const json = await res.json();
        if (json.result) {
          setResult(json.result);
          setProbing(false);
          return;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      // network / server error
    }

    if (abortCtrl.signal.aborted) return;

    setResult({
      keyId: keyItem.keyId,
      maskedKey: keyItem.maskedKey,
      provider,
      latencyMs: 0,
      status: "error",
      timestamp: Date.now(),
      sparkline: [],
      details: failure,
      isSimulated: false,
    });
    setProbing(false);
  }, [projectId, provider, keyItem.keyId, keyItem.maskedKey, isDemo]);

  useEffect(() => {
    void runProbe();
    return () => {
      abortRef.current?.abort();
    };
  }, [runProbe]);

  return (
    <Modal
      open
      title={isDemo ? "Key probe (local demo)" : "Key probe"}
      onClose={onClose}
      widthClass="sm:max-w-lg"
    >
      {/* Modal Body */}
      <div className="flex flex-col gap-4 py-5">
        {/* Target Info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg bg-gray-100 dark:bg-gray-900 p-3 text-sm">
          <div>
            <span className="text-gray-600 dark:text-gray-400">Target Key:</span>
            <div className=" font-medium text-gray-900 dark:text-gray-100">{keyItem.maskedKey}</div>
          </div>
          <div>
            <span className="text-gray-600 dark:text-gray-400">Provider / Model:</span>
            <div className="font-medium text-gray-900 dark:text-gray-100">
              {provider} / {modelId}
            </div>
          </div>
        </div>

        {probing ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            <span className="text-sm text-gray-600 dark:text-gray-400">Checking {provider}…</span>
          </div>
        ) : result ? (
          <div className="flex flex-col gap-4">
            {/* Latency & Status Card */}
            <div className="flex flex-wrap items-center justify-between rounded-lg border border-gray-200 dark:border-gray-800 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={result.status === "ok" ? "green" : "red"}>
                  {result.status === "ok" ? "Probe succeeded" : "Probe failed"}
                </Badge>
                <span className="text-sm text-gray-600 dark:text-gray-400">RTT:</span>
                <span className=" text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {result.status === "ok" ? `${result.latencyMs} ms` : "Not measured"}
                </span>
              </div>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {new Date(result.timestamp).toLocaleTimeString()}
              </span>
            </div>

            <details className="border-t border-gray-200 py-3 dark:border-gray-800">
              <summary className="cursor-pointer text-sm font-medium">
                Recent probe latencies
              </summary>
              <p className="mt-2 text-sm tabular-nums">
                {result.sparkline.length
                  ? result.sparkline.map((value) => `${value} ms`).join(" · ")
                  : "No probe history available."}
              </p>
            </details>
            {result.details && (
              <div
                role={result.status === "error" ? "alert" : "status"}
                className="break-words text-sm text-gray-600 dark:text-gray-400"
              >
                {result.details}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Modal Footer */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-800 pt-4">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" size="sm" disabled={probing} onClick={runProbe}>
          {probing ? "Probing..." : "Probe Again"}
        </Button>
      </div>
    </Modal>
  );
}
