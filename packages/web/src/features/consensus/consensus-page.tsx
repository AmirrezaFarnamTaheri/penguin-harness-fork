import { useState } from "react";
import { QuorumConsensusEngine } from "@prismshadow/penguin-core/browser";
import { QuorumBoard } from "./quorum-board";
import { MailboxBureau } from "./mailbox-bureau";
import { HandoffTimeline } from "./handoff-timeline";
import type { LiveHandoffEvent, LiveMailboxEntry } from "../agent/use-cockpit-telemetry.js";

export interface ConsensusPageProps {
  embedded?: boolean;
  /** Live mailbox queues from the cockpit WS feed; absent keeps the local demo. */
  mailboxEntries?: LiveMailboxEntry[];
  /** Live task starts and directive dispatches from the cockpit WS feed; same rule. */
  handoffs?: LiveHandoffEvent[];
}

export function ConsensusPage({ embedded = false, mailboxEntries, handoffs }: ConsensusPageProps) {
  const [tab, setTab] = useState<"quorum" | "mailbox" | "handoff">("quorum");
  const [engine] = useState(() => new QuorumConsensusEngine());
  const [version, setVersion] = useState(0);
  // Each view labels itself live or demo; this names exactly which parts are real so the
  // header cannot claim a live feed the wiring does not actually supply.
  const liveParts = [
    mailboxEntries !== undefined && "messages",
    handoffs !== undefined && "handoffs",
  ].filter(Boolean) as string[];
  return (
    <div
      className={`min-w-0 overflow-y-auto text-sm text-gray-900 dark:text-gray-100 ${embedded ? "p-3" : "p-4 sm:p-6"}`}
    >
      <header className="mb-6 space-y-2">
        <h1 className="text-xl font-semibold">Agent coordination</h1>
        <p className="text-gray-600 dark:text-gray-400">
          {liveParts.length === 0
            ? "Try proposals, messages and handoffs with local sample data. Changes are not sent to agents or saved after leaving this page."
            : `${liveParts.map(capitalize).join(" and ")} reflect the current project. Decisions remain a local demo.`}
        </p>
      </header>
      <nav
        aria-label="Coordination views"
        className="mb-6 flex flex-wrap gap-2 border-b border-gray-200 pb-3 dark:border-gray-800"
      >
        {(
          [
            { value: "quorum", label: "Decisions" },
            { value: "mailbox", label: "Messages" },
            { value: "handoff", label: "Handoffs" },
          ] as const
        ).map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={tab === item.value}
            onClick={() => setTab(item.value)}
            className={`min-h-10 rounded-md px-4 py-2 ${tab === item.value ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div hidden={tab !== "quorum"}>
        <QuorumBoard engine={engine} version={version} onMutate={() => setVersion((v) => v + 1)} />
      </div>
      <div hidden={tab !== "mailbox"}>
        <MailboxBureau entries={mailboxEntries} />
      </div>
      <div hidden={tab !== "handoff"}>
        <HandoffTimeline handoffs={handoffs} />
      </div>
    </div>
  );
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
