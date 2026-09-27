/**
 * The Jev observation for one tool call, as a footnote on that call's card.
 *
 * It is deliberately a footnote and not a card of its own. Three reasons, each learned the hard
 * way: a pre-tool-use observation arrives BETWEEN two tool calls, so as a stream item it split
 * every Reasoning-and-Tools group it landed in; eight metrics printed inline on every call is
 * noise the reader cannot triage; and an observation that looks like a status badge is read as a
 * verdict, which it is not. So: one muted line on the card, the numbers behind a disclosure, and
 * the advisory-only sentence always in reach.
 *
 * The numbers are the provider's opinion about a tool call, bound to that call and to nothing
 * else. This component can never allow, deny or approve anything — the command policy, the
 * Environment permission and the human approval callback are the authority, and they are
 * rendered elsewhere in this same card.
 */
import { useState } from "react";
import { S } from "../../lib/strings";
import { formatPercent, humanizeDuration, humanizeTokens } from "../../lib/format";
import { Chevron } from "../../components/ui/chevron";
import type { JevAdvisory } from "../../lib/omni/stream-model";

/** The provider's choice vocabulary, in the reader's words. An unknown label is not shown raw. */
function choiceLabel(choice: string): string {
  switch (choice) {
    case "matches":
      return S.coordination.choiceMatches;
    case "different_tool":
      return S.coordination.choiceDifferent;
    case "no_tool":
      return S.coordination.choiceNone;
    default:
      return S.coordination.choiceUnknown;
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      {/* text-gray-500 dark:text-gray-400 — the same ink the rest of the card's secondary text
          uses. The previous gray-400 label sat at 2.4:1 on white, below AA for body text. */}
      <dt className="truncate text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="truncate font-mono text-gray-700 dark:text-gray-300">{value}</dd>
    </div>
  );
}

export function JevAdvisoryNote({ advisory }: { advisory: JevAdvisory }) {
  const [open, setOpen] = useState(false);
  const unavailable = advisory.status === "unavailable";
  const tokens =
    advisory.inputTokens !== undefined || advisory.outputTokens !== undefined
      ? `${humanizeTokens(advisory.inputTokens ?? 0)} / ${humanizeTokens(advisory.outputTokens ?? 0)}`
      : undefined;

  return (
    <div className="border-t border-gray-100 px-3 py-1.5 dark:border-gray-800/60">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-gray-500 transition-colors duration-150 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          {/* Fixed-width mark: the line must not reflow when the status word changes length. */}
          <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide">
            {S.coordination.jevAdvisory}
          </span>
          <span className="min-w-0 truncate">
            {unavailable ? S.coordination.unavailable : choiceLabel(advisory.choice)}
          </span>
          {advisory.confidence !== undefined && !unavailable && (
            <span className="hidden shrink-0 font-mono text-[10px] sm:inline">
              {formatPercent(advisory.confidence)}
            </span>
          )}
          <span className="min-w-0 flex-1" />
          <Chevron open={open} className="shrink-0 text-gray-400" />
        </button>
      </div>

      {open && (
        <div className="anim-fade mt-1.5">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] sm:grid-cols-4">
            {advisory.confidence !== undefined && (
              <Metric
                label={S.coordination.confidence}
                value={formatPercent(advisory.confidence)}
              />
            )}
            {advisory.riskScore !== undefined && (
              <Metric
                label={S.coordination.risk}
                value={`${S.coordination.riskOf(advisory.riskScore)}`}
              />
            )}
            {advisory.needsToolProbability !== undefined && (
              <Metric
                label={S.coordination.needsTool}
                value={formatPercent(advisory.needsToolProbability)}
              />
            )}
            {advisory.argumentsCompleteProbability !== undefined && (
              <Metric
                label={S.coordination.argumentsComplete}
                value={formatPercent(advisory.argumentsCompleteProbability)}
              />
            )}
            {advisory.requiresApprovalProbability !== undefined && (
              <Metric
                label={S.coordination.approvalLikely}
                value={formatPercent(advisory.requiresApprovalProbability)}
              />
            )}
            {advisory.latencyMs !== undefined && (
              <Metric
                label={S.coordination.latency}
                value={humanizeDuration(advisory.latencyMs, { compact: true })}
              />
            )}
            {tokens !== undefined && <Metric label={S.coordination.tokens} value={tokens} />}
            {advisory.model !== undefined && (
              <div className="col-span-2 min-w-0">
                <dt className="truncate text-gray-500 dark:text-gray-400">
                  {S.coordination.model}
                </dt>
                <dd
                  className="truncate font-mono text-gray-700 dark:text-gray-300"
                  title={advisory.model}
                >
                  {advisory.model}
                </dd>
              </div>
            )}
          </dl>
          {advisory.reason !== undefined && (
            <p className="mt-1.5 break-words text-[10px] leading-4 text-gray-600 dark:text-gray-300">
              <span className="text-gray-500 dark:text-gray-400">{S.coordination.reason}: </span>
              {advisory.reason}
            </p>
          )}
          {/* Not a disclaimer for its own sake: this is the line that keeps a reader from
              reading a number above as a decision. It is present in every expanded advisory. */}
          <p className="mt-1.5 text-[10px] leading-4 text-gray-500 dark:text-gray-400">
            {S.coordination.advisoryOnly}
          </p>
        </div>
      )}
    </div>
  );
}
