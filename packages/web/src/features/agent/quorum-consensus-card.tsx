import React, { useState } from "react";
import type { TopicStanding } from "@prismshadow/penguin-core";
import { Button } from "../../components/ui/button.js";
import { Badge } from "../../components/ui/badge.js";

export interface QuorumConsensusCardProps {
  standing: TopicStanding;
  currentAgentId?: string;
  onEndorse?: (topicId: string, grounds: string) => void;
  onRefute?: (topicId: string, grounds: string) => void;
}

const STATUS_BADGES: Record<string, { label: string; class: string }> = {
  settled: {
    label: "Ratified & Settled",
    class:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-300",
  },
  debating: {
    label: "Quorum Debating",
    class: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border-blue-300",
  },
  proposed: {
    label: "Proposed",
    class: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-300",
  },
  refuted: {
    label: "Refuted & Blocked",
    class: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border-rose-300",
  },
};

export function QuorumConsensusCard({
  standing,
  currentAgentId = "current-agent",
  onEndorse,
  onRefute,
}: QuorumConsensusCardProps) {
  const [groundsInput, setGroundsInput] = useState("");
  const [isRefuting, setIsRefuting] = useState(false);

  const statusBadge = STATUS_BADGES[standing.status] ?? STATUS_BADGES.proposed!;
  const threshold = standing.policy.threshold;
  const currentSupporters = standing.supporters.length;

  const handleAction = () => {
    if (!groundsInput.trim()) return;
    if (isRefuting) {
      onRefute?.(standing.topicId, groundsInput.trim());
    } else {
      onEndorse?.(standing.topicId, groundsInput.trim());
    }
    setGroundsInput("");
    setIsRefuting(false);
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 text-xs shadow-xs space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusBadge.class}`}
            >
              {statusBadge.label}
            </span>
            <span className="text-gray-400 font-mono text-[10px]">
              threshold: {currentSupporters}/{threshold}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug">
            {standing.topic}
          </h3>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 font-mono">
            Proposed by {standing.proposerId}
          </p>
        </div>
      </div>

      {/* Supporters / Grounds list */}
      <div className="space-y-1.5 pt-2 border-t border-gray-100 dark:border-gray-800">
        <span className="font-semibold text-gray-700 dark:text-gray-300 text-[11px]">
          Peer Endorsements ({standing.supporters.length}):
        </span>
        {standing.supporters.map((sup, idx) => (
          <div
            key={idx}
            className="flex flex-col gap-0.5 rounded-md bg-gray-50 dark:bg-gray-800/60 p-2 border border-gray-200/60 dark:border-gray-800"
          >
            <div className="flex items-center justify-between text-[10px] font-mono text-gray-500 dark:text-gray-400">
              <span className="font-semibold text-blue-600 dark:text-blue-400">
                ✓ {sup.agentId}
              </span>
              <span>{new Date(sup.timestamp).toLocaleTimeString()}</span>
            </div>
            {sup.grounds && (
              <p className="text-[11px] text-gray-700 dark:text-gray-300 italic">
                &ldquo;{sup.grounds}&rdquo;
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Refutations if any */}
      {standing.refuters.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-rose-100 dark:border-rose-950/60">
          <span className="font-semibold text-rose-700 dark:text-rose-400 text-[11px]">
            Contradicting Objections ({standing.refuters.length}):
          </span>
          {standing.refuters.map((ref, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-0.5 rounded-md bg-rose-50/50 dark:bg-rose-950/30 p-2 border border-rose-200/60 dark:border-rose-900"
            >
              <div className="flex items-center justify-between text-[10px] font-mono text-rose-600 dark:text-rose-400">
                <span className="font-semibold">✗ {ref.agentId}</span>
                <span>{new Date(ref.timestamp).toLocaleTimeString()}</span>
              </div>
              <p className="text-[11px] text-rose-800 dark:text-rose-300 italic">
                &ldquo;{ref.grounds}&rdquo;
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Interactive Action input */}
      {standing.status === "debating" && (onEndorse || onRefute) && (
        <div className="pt-2 border-t border-gray-100 dark:border-gray-800 space-y-2">
          <textarea
            rows={2}
            value={groundsInput}
            onChange={(e) => setGroundsInput(e.target.value)}
            placeholder={
              isRefuting
                ? "State verified counter-evidence or violation..."
                : "Cite grounded source files or benchmark evidence..."
            }
            className="w-full text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-2 focus:outline-hidden focus:ring-1 focus:ring-blue-500 font-sans"
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setIsRefuting(!isRefuting)}
              className="text-[11px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer"
            >
              {isRefuting ? "Switch to Endorse" : "Switch to Refute / Object"}
            </button>
            <Button
              size="sm"
              variant={isRefuting ? "danger" : "primary"}
              onClick={handleAction}
              disabled={!groundsInput.trim()}
            >
              {isRefuting ? "Submit Refutation" : "Endorse with Grounds"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
