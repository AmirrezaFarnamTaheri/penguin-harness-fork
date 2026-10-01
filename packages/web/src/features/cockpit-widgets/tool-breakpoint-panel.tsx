/**
 * The existing approval wait, presented as a tool breakpoint. The pending SSE payload is
 * authoritative; a streamed preview or model-written description is not what is approved.
 * Decisions use the existing server approval route. Argument editing is intentionally not
 * offered: that route and the core approval callback accept decisions, not replacements.
 */
import type { ReactNode } from "react";
import type { PendingApproval } from "../../lib/omni/stream-controller";
import { S } from "../../lib/strings";
import { ApprovalButtons } from "../chat/approval-buttons";

export interface ToolBreakpointPanelProps {
  pending: PendingApproval | undefined;
  onDecide: (decision: "allow" | "deny") => Promise<void>;
  /** Optional decoded file payload, in addition to the full raw arguments. */
  children?: ReactNode;
}

export function ToolBreakpointPanel({ pending, onDecide, children }: ToolBreakpointPanelProps) {
  if (!pending) return null;
  const { name, arguments: argumentsJson, tool_call_id: toolCallId } = pending.toolCall.payload;
  const target = pending.approvalTarget;
  const label = target
    ? `${name} → ${target.name}${target.permission ? ` (${target.permission})` : ""}`
    : name;

  return (
    <section
      aria-label={S.chat.approvalWaiting}
      className="min-w-0 border-t border-gray-100 bg-amber-50 px-3 py-2 dark:border-gray-800 dark:bg-amber-950/30"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all rounded-md bg-white px-1.5 py-0.5 font-mono text-xs font-semibold text-gray-700 dark:bg-gray-900 dark:text-gray-300">
          {label}
        </span>
        <span className="text-xs text-gray-700 dark:text-gray-300">{S.chat.approvalWaiting}</span>
      </div>
      <pre className="mb-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-white/70 px-2 py-1.5 text-xs leading-5 text-gray-700 dark:bg-gray-950/40 dark:text-gray-300">
        {argumentsJson}
      </pre>
      {children}
      <ApprovalButtons key={toolCallId} onDecide={onDecide} />
    </section>
  );
}
