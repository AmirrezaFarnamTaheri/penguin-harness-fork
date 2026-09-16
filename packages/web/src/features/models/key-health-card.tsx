import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import {
  calculateKeySuccessRate,
  formatCooldownTimer,
  type KeyActionType,
  type KeyHealthItem,
} from "./key-fleet-types";

export interface KeyHealthCardProps {
  keyItem: KeyHealthItem;
  provider: string;
  modelId: string;
  onAction?: (action: KeyActionType, item: KeyHealthItem) => void;
  disabled?: boolean;
}

export function KeyHealthCard({
  keyItem,
  provider,
  modelId,
  onAction,
  disabled = false,
}: KeyHealthCardProps) {
  const [remainingMs, setRemainingMs] = useState(keyItem.cooldownRemainingMs);

  useEffect(() => {
    setRemainingMs(keyItem.cooldownRemainingMs);
    if (keyItem.status !== "cooldown" || keyItem.cooldownRemainingMs <= 0) return;

    const interval = setInterval(() => {
      setRemainingMs((prev) => Math.max(0, prev - 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [keyItem.cooldownRemainingMs, keyItem.status]);

  const successRate = calculateKeySuccessRate(keyItem.successCount, keyItem.failureCount);
  const totalCalls = keyItem.successCount + keyItem.failureCount;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40">
      {/* Header: Masked Key, Copy, Status Badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-foreground">
            {keyItem.maskedKey}
          </span>
          <CopyButton text={keyItem.maskedKey} label="Copy masked key" />
        </div>

        <div>
          {keyItem.status === "healthy" && <Badge tone="green">Healthy</Badge>}
          {keyItem.status === "cooldown" && (
            <Badge tone="amber">Cooldown ({formatCooldownTimer(remainingMs)})</Badge>
          )}
          {keyItem.status === "evicted" && <Badge tone="red">Evicted (401)</Badge>}
        </div>
      </div>

      {/* Invocation Statistics & Success Bar */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Success Rate</span>
          <span className="font-medium text-foreground">
            {successRate}% ({keyItem.successCount}/{totalCalls})
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all duration-300 ${
              successRate >= 90
                ? "bg-emerald-500"
                : successRate >= 70
                  ? "bg-amber-500"
                  : "bg-red-500"
            }`}
            style={{ width: `${successRate}%` }}
          />
        </div>
      </div>

      {/* Leases & Last Used Metadata */}
      <div className="flex items-center justify-between border-t border-border/50 pt-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span>Active Leases:</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground">
            {keyItem.activeLeases ?? 0}
          </span>
        </div>
        {keyItem.lastUsedAt ? (
          <span>Used {new Date(keyItem.lastUsedAt).toLocaleTimeString()}</span>
        ) : (
          <span>Unused</span>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 pt-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onAction?.("probe", keyItem)}
        >
          Probe Latency
        </Button>

        {keyItem.status === "healthy" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onAction?.("cooldown", keyItem)}
          >
            Force Cooldown
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onAction?.("revive", keyItem)}
          >
            Revive Key
          </Button>
        )}

        {keyItem.status !== "evicted" && (
          <Button
            variant="danger"
            size="sm"
            disabled={disabled}
            onClick={() => onAction?.("evict", keyItem)}
          >
            Evict
          </Button>
        )}
      </div>
    </div>
  );
}
