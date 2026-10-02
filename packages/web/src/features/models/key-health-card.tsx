import { useEffect, useState, type ReactNode } from "react";
import { sharedUiClock } from "../../lib/ui-clock";
import { useUiClock } from "../../lib/use-ui-clock";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import { S } from "../../lib/strings";
import { calculateKeySuccessRate, formatCooldownTimer, keyNameOf } from "./key-fleet-types";
import type { KeyActionType, KeyHealthItem } from "./key-fleet-types";

export interface KeyHealthCardProps {
  keyItem: KeyHealthItem;
  provider: string;
  modelId: string;
  onAction?: (action: KeyActionType, item: KeyHealthItem) => void;
  disabled?: boolean;
  /** Whether the viewer may name keys (the Project owner may; a member may not). */
  canRename?: boolean;
  /** Opens the rename editor for this key, replacing the name line. */
  onRename?: (item: KeyHealthItem) => void;
  /** True while this specific key's rename editor is open. */
  renaming?: boolean;
  /** The editor itself, rendered in place of the name line. */
  children?: ReactNode;
}

export function KeyHealthCard({
  keyItem,
  provider,
  modelId,
  onAction,
  disabled = false,
  canRename = false,
  onRename,
  renaming = false,
  children,
}: KeyHealthCardProps) {
  // The cooldown is an absolute deadline measured once when the report arrives, not a per-tick
  // decrement (F2): decrementing drifts — a tab restored after 60 s showed a value that was 60 s
  // too large, and a throttled timer was worse still — whereas reading the shared clock's `now`
  // converges the moment the tab wakes.
  const clock = sharedUiClock();
  const [deadlineMs, setDeadlineMs] = useState(() => clock.now() + keyItem.cooldownRemainingMs);
  useEffect(() => {
    setDeadlineMs(clock.now() + keyItem.cooldownRemainingMs);
  }, [clock, keyItem.cooldownRemainingMs, keyItem.status]);
  const ticking = keyItem.status === "cooldown" && keyItem.cooldownRemainingMs > 0;
  const nowMs = useUiClock(1000, { enabled: ticking });
  const remainingMs = ticking ? Math.max(0, deadlineMs - nowMs) : keyItem.cooldownRemainingMs;

  const successRate = calculateKeySuccessRate(keyItem.successCount, keyItem.failureCount);
  const totalCalls = keyItem.successCount + keyItem.failureCount;
  const { name, isUnnamed } = keyNameOf(keyItem, S.models.keyUnnamed);

  return (
    <div
      data-testid="key-health-card"
      className="flex flex-col gap-3 border-b border-gray-200 dark:border-gray-800 p-4 transition-colors hover:border-gray-400"
    >
      {/* Header: Masked Key, Copy, Status Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
              {keyItem.maskedKey}
            </span>
            <CopyButton text={keyItem.maskedKey} label="Copy masked key" />
          </div>
          {renaming ? null : (
            <div className="flex flex-wrap items-center gap-2">
              {isUnnamed ? (
                <span className="text-sm text-gray-500 italic dark:text-gray-400">
                  {S.models.keyUnnamed}
                </span>
              ) : (
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{name}</span>
              )}
              {canRename && onRename && (
                <button
                  type="button"
                  onClick={() => onRename(keyItem)}
                  disabled={disabled}
                  className="text-xs text-blue-700 underline underline-offset-2 hover:no-underline disabled:opacity-60 dark:text-blue-400"
                >
                  {isUnnamed ? S.models.keyNameAction : S.models.keyNameEdit}
                </button>
              )}
            </div>
          )}
          {keyItem.label !== undefined && keyItem.label !== "" && (
            <span className="text-xs text-gray-500 dark:text-gray-400">{keyItem.label}</span>
          )}
        </div>

        <div>
          {keyItem.status === "healthy" && <Badge tone="green">Healthy</Badge>}
          {keyItem.status === "cooldown" && (
            <Badge tone="amber">Cooldown ({formatCooldownTimer(remainingMs)})</Badge>
          )}
          {keyItem.status === "evicted" && <Badge tone="red">Evicted</Badge>}
        </div>
      </div>

      {children}

      {/* Invocation Statistics & Success Bar */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>Success Rate</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {successRate}% ({keyItem.successCount}/{totalCalls})
          </span>
        </div>
      </div>

      {/* Leases & Last Used Metadata */}
      <div className="flex flex-wrap items-center justify-between border-t border-gray-200 dark:border-gray-800 pt-2 text-sm text-gray-600 dark:text-gray-400">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>Active Leases:</span>
          <span className="rounded bg-gray-100 dark:bg-gray-900 px-1.5 py-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
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
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-800 pt-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onAction?.("probe", keyItem)}
        >
          Probe
        </Button>

        {keyItem.status === "healthy" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onAction?.("cooldown", keyItem)}
          >
            Pause for 60 seconds
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onAction?.("revive", keyItem)}
          >
            Make available
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
