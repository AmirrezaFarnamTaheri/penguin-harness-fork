/**
 * Agent candidate panel for the composer's `/agent` switch picker, extracted from
 * chat-input.tsx (a mechanical move — the picker and its staged semantics are unchanged).
 */
import { useState } from "react";
import type { AgentSummary } from "@prismshadow/penguin-server/api";
import { S } from "../../lib/strings";
import { AgentAvatar } from "../../components/ui/agent-avatar";
import { agentDisplayName } from "../../state/project";
import { filterAgents } from "./agent-handoff";
import { PickerList } from "./model-select";

/**
 * Agent candidate panel for the `/agent` switch picker — the agent-side counterpart of
 * ModelMenuList, and now literally the same panel (PickerList: search, scroll cap, keyboard
 * navigation, current-entry marker). Only the row differs: the Agent avatar (the same identity
 * tile the draft Agent picker uses), the agentId in monospace — the id is what identifies an
 * Agent everywhere else in the app — and the display name after it when it differs. The
 * conversation's own Agent is marked like the model list marks the session's model; picking it
 * is still a real action (a fresh conversation with the same Agent), not a no-op.
 */
export function AgentMenuList({
  agents,
  currentAgentId,
  onPick,
}: {
  agents: AgentSummary[];
  /** The Agent this conversation already belongs to (marked ✓); undefined while it is unknown. */
  currentAgentId?: string;
  onPick: (agent: AgentSummary) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <PickerList
      items={filterAgents(agents, query)}
      itemKey={(a) => a.agentId}
      isCurrent={(a) => a.agentId === currentAgentId}
      query={query}
      onQueryChange={setQuery}
      // Quick search: supports agentId / display name
      searchPlaceholder={S.chat.agentSearchPlaceholder}
      emptyText={S.chat.agentsNoMatch}
      onPick={onPick}
      renderRow={(a) => (
        <>
          <AgentAvatar
            id={a.agentId}
            name={agentDisplayName(a)}
            size={16}
            className="shrink-0 rounded"
          />
          <span className="shrink-0 font-mono text-gray-800 dark:text-gray-200">{a.agentId}</span>
          {a.name && a.name !== a.agentId && (
            <span className="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-500">
              {a.name}
            </span>
          )}
        </>
      )}
    />
  );
}
