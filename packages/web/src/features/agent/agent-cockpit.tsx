import { lazy, Suspense, useId, useState } from "react";
import { Modal } from "../../components/ui/modal.js";
import { Button } from "../../components/ui/button.js";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useProject, projectDisplayName } from "../../state/project";
import { useLocale } from "../../state/locale";
import { useCockpitTelemetry, type LiveTurnSummary } from "./use-cockpit-telemetry.js";
import { cockpitCopy, cockpitGroups, isCockpitTool, type CockpitTool } from "./cockpit-copy";

const TopologyPage = lazy(() =>
  import("../topology/topology-page").then((m) => ({ default: m.TopologyPage })),
);
const GuardianPage = lazy(() =>
  import("../guardian/guardian-page").then((m) => ({ default: m.GuardianPage })),
);
const ConsensusPage = lazy(() =>
  import("../consensus/consensus-page").then((m) => ({ default: m.ConsensusPage })),
);
const ContextBreakdownPage = lazy(() =>
  import("../context/context-breakdown-page").then((m) => ({ default: m.ContextBreakdownPage })),
);
const MemoryPage = lazy(() =>
  import("../memory/memory-page").then((m) => ({ default: m.MemoryPage })),
);
const ModelsKeyFleetPage = lazy(() =>
  import("../models/models-key-fleet-page").then((m) => ({ default: m.ModelsKeyFleetPage })),
);
const TraceFlamegraphPage = lazy(() =>
  import("../traces/trace-flamegraph-page").then((m) => ({ default: m.TraceFlamegraphPage })),
);
const SnapshotsPage = lazy(() =>
  import("../snapshots/snapshots-page").then((m) => ({ default: m.SnapshotsPage })),
);

export interface AgentCockpitProps {
  open?: boolean;
  onClose?: () => void;
  sessionId?: string;
  embedded?: boolean;
}
export interface SwarmAgentNode {
  id: string;
  name?: string;
  description?: string;
  role: "orchestrator" | "coder" | "reviewer" | "researcher" | "tester";
  status: "idle" | "active" | "waiting_approval" | "handoff";
  tasksCompleted: number;
  currentTask?: string;
  handoffTarget?: string;
}
export interface SwarmEdge {
  from: string;
  to: string;
  kind: "directive" | "handoff" | "review_gate";
  activeCount: number;
}
const fieldClass =
  "w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100";
const muted = "text-sm leading-6 text-gray-600 dark:text-gray-400";

export function AgentCockpit(props: AgentCockpitProps) {
  const { currentProject } = useProject();
  const { locale } = useLocale();
  const c = cockpitCopy(locale);
  // A closed dialog must not keep a project stream or drafts alive in the background.
  if (props.open === false && !props.embedded) return null;
  const content = currentProject ? (
    <CockpitWorkspace
      key={`${currentProject.projectId}:${props.sessionId ?? ""}`}
      projectId={currentProject.projectId}
      sessionId={props.sessionId}
    />
  ) : (
    <p className="p-6 text-sm text-gray-600 dark:text-gray-400">{c.projectRequired}</p>
  );
  if (props.embedded || props.open === undefined) return content;
  return (
    <Modal
      open={true}
      onClose={props.onClose ?? (() => {})}
      title={c.title}
      widthClass="sm:max-w-6xl"
    >
      {content}
    </Modal>
  );
}

function CockpitWorkspace({ projectId, sessionId }: { projectId: string; sessionId?: string }) {
  const { currentProject } = useProject();
  const { locale } = useLocale();
  const c = cockpitCopy(locale);
  const id = useId();
  const [tool, setTool] = useState<CockpitTool>("swarm");
  const telemetry = useCockpitTelemetry(projectId, sessionId);
  const [goal, setGoal] = useState("");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [taskFinished, setTaskFinished] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const selectedRecipient = telemetry.swarmAgents.some((agent) => agent.id === recipient)
    ? recipient
    : "";
  const connection =
    telemetry.transport === "ws"
      ? c.connected
      : telemetry.transport === "http"
        ? c.polling
        : telemetry.transport === "connecting"
          ? c.connecting
          : c.offline;
  const turns = telemetry.turnSummaries;
  const turnStatus = (status: LiveTurnSummary["status"]) =>
    status === "running" ? c.runningStatus : status === "completed" ? c.completedStatus : c[status];

  const history = (
    <section aria-label={c.history} className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{c.history}</h3>
        <p className={muted}>{c.historyHint}</p>
      </div>
      {turns.length === 0 ? (
        <p className={`${muted} py-8`}>{c.noHistory}</p>
      ) : (
        <ol className="divide-y divide-gray-200 dark:divide-gray-800">
          {[...turns].reverse().map((turn) => (
            <li key={`${turn.turnId}:${turn.terminalSeq}`} className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-all font-mono text-sm">{turn.turnId}</span>
                <span
                  className={`text-sm font-medium ${turn.status === "failed" ? "text-red-700 dark:text-red-400" : "text-gray-600 dark:text-gray-300"}`}
                >
                  {turnStatus(turn.status)}
                </span>
              </div>
              {turn.outcome && (
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                  {turn.outcome}
                </p>
              )}
              <details className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                <summary className="w-fit cursor-pointer py-2">
                  {c.duration}: {turn.durationMs.toLocaleString(locale)} ms
                </summary>
                <p>
                  {c.sequence}: {turn.terminalSeq} · {c.records}: {turn.streamRecords}
                </p>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  return (
    <div className="min-h-full min-w-0 bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="space-y-4 border-b border-gray-200 px-4 py-5 dark:border-gray-800 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{c.title}</h1>
            <p className={`${muted} mt-1`}>{c.description}</p>
          </div>
          <Button
            className="min-h-11"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await telemetry.refresh();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            {refreshing ? c.refreshing : c.refresh}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
          <span className="break-all font-medium text-gray-900 dark:text-gray-100">
            {currentProject ? projectDisplayName(currentProject) : projectId}
          </span>
          <span role="status">{connection}</span>
          {sessionId && (
            <span className="break-all">
              {c.session}: {sessionId}
            </span>
          )}
        </div>
      </header>
      <div className="flex min-w-0 flex-col lg:flex-row">
        <nav
          aria-label={c.navigation}
          className="shrink-0 border-b border-gray-200 p-4 dark:border-gray-800 lg:w-52 lg:border-b-0 lg:border-r lg:p-3"
        >
          <label
            className="flex flex-col gap-2 text-sm font-medium lg:hidden"
            htmlFor={`${id}-tool`}
          >
            {c.chooseTool}
            <select
              id={`${id}-tool`}
              className={fieldClass}
              value={tool}
              onChange={(event) => {
                if (isCockpitTool(event.target.value)) setTool(event.target.value);
              }}
            >
              {cockpitGroups.map((group) => (
                <optgroup key={group.key} label={c[group.key]}>
                  {group.tools.map((item) => (
                    <option key={item} value={item}>
                      {c[item]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="hidden space-y-5 lg:block">
            {cockpitGroups.map((group) => (
              <div key={group.key}>
                <p className="px-3 pb-1 text-xs font-semibold text-gray-500 dark:text-gray-400">
                  {c[group.key]}
                </p>
                {group.tools.map((item) => (
                  <button
                    type="button"
                    key={item}
                    aria-current={tool === item ? "page" : undefined}
                    onClick={() => setTool(item)}
                    className={`flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-brand-600 ${tool === item ? "bg-gray-100 font-medium text-gray-950 dark:bg-gray-800 dark:text-white" : "text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900"}`}
                  >
                    {c[item]}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0 flex-1 space-y-6 p-4 sm:p-6">
          {telemetry.error && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {telemetry.error}
            </div>
          )}
          {tool === "swarm" && (
            <div className="space-y-8">
              <form
                className="max-w-3xl space-y-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!goal.trim() || telemetry.isDispatching) return;
                  setTaskFinished(false);
                  if (await telemetry.triggerTask(goal.trim())) {
                    setGoal("");
                    setTaskFinished(true);
                  }
                }}
              >
                <label htmlFor={`${id}-goal`} className="block text-lg font-semibold">
                  {c.goal}
                </label>
                <textarea
                  id={`${id}-goal`}
                  rows={4}
                  className={`${fieldClass} resize-y leading-6`}
                  placeholder={c.goalPlaceholder}
                  aria-describedby={`${id}-goal-hint`}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  disabled={telemetry.isDispatching}
                />
                <p id={`${id}-goal-hint`} className={muted}>
                  {c.goalHint}
                </p>
                <Button
                  type="submit"
                  variant="primary"
                  className="min-h-11"
                  disabled={!goal.trim() || telemetry.isDispatching}
                >
                  {telemetry.isDispatching ? c.running : c.launch}
                </Button>
                {taskFinished && (
                  <p role="status" className={muted}>
                    {c.taskSuccess}
                  </p>
                )}
              </form>
              <section aria-label={c.agents}>
                <h3 className="mb-3 text-base font-semibold">{c.agents}</h3>
                {telemetry.swarmAgents.length === 0 ? (
                  <p className={muted}>{c.noAgents}</p>
                ) : (
                  <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                    {telemetry.swarmAgents.map((agent) => (
                      <li
                        key={agent.id}
                        className="flex flex-wrap items-start justify-between gap-3 py-4"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="break-all text-sm font-medium">
                            {agent.name ? `${agent.name} (${agent.id})` : agent.id}{" "}
                            <span className="font-normal text-gray-500">· {agent.role}</span>
                          </p>
                          {agent.description && (
                            <p className={`${muted} whitespace-pre-wrap break-words`}>
                              {agent.description}
                            </p>
                          )}
                          {agent.currentTask && (
                            <p className={`${muted} break-words`}>{agent.currentTask}</p>
                          )}
                          {agent.handoffTarget && (
                            <p className={`${muted} break-all`}>
                              {c.handoff}: {agent.handoffTarget}
                            </p>
                          )}
                        </div>
                        <div className="text-sm">
                          <p className="font-medium">{c[agent.status]}</p>
                          <p className={muted}>
                            {c.completed}: {agent.tasksCompleted}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <details className="border-t border-gray-200 pt-3 dark:border-gray-800">
                <summary className="cursor-pointer py-2 text-sm font-medium">
                  {c.channels} ({telemetry.swarmEdges.length})
                </summary>
                {telemetry.swarmEdges.length === 0 ? (
                  <p className={muted}>{c.noChannels}</p>
                ) : (
                  <ul className="space-y-2 py-3">
                    {telemetry.swarmEdges.map((edge, i) => (
                      <li
                        key={`${edge.from}:${edge.to}:${edge.kind}:${i}`}
                        className="break-all text-sm"
                      >
                        {edge.from} → {edge.to}{" "}
                        <span className="text-gray-500">
                          · {edge.kind} ({edge.activeCount})
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
              {history}
            </div>
          )}
          {tool === "ledger" && history}
          {tool === "mailbox" && (
            <section className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">{c.mailbox}</h2>
                <p className={muted}>{c.messageHint}</p>
              </div>
              <form
                className="max-w-2xl space-y-4"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!selectedRecipient || !message.trim() || sending) return;
                  setSending(true);
                  setSent(false);
                  try {
                    if (await telemetry.dispatchDirective(selectedRecipient, message.trim())) {
                      setMessage("");
                      setSent(true);
                    }
                  } finally {
                    setSending(false);
                  }
                }}
              >
                <label className="block space-y-2 text-sm font-medium" htmlFor={`${id}-recipient`}>
                  <span>{c.recipient}</span>
                  <select
                    id={`${id}-recipient`}
                    className={fieldClass}
                    value={selectedRecipient}
                    onChange={(event) => {
                      setRecipient(event.target.value);
                      setSent(false);
                    }}
                    disabled={sending}
                  >
                    <option value="">{c.chooseRecipient}</option>
                    {telemetry.swarmAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name
                          ? `${agent.name} (${agent.id} · ${agent.role})`
                          : `${agent.id} (${agent.role})`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2 text-sm font-medium" htmlFor={`${id}-message`}>
                  <span>{c.message}</span>
                  <textarea
                    id={`${id}-message`}
                    rows={3}
                    className={fieldClass}
                    value={message}
                    onChange={(event) => {
                      setMessage(event.target.value);
                      setSent(false);
                    }}
                    disabled={sending}
                  />
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  className="min-h-11"
                  disabled={!selectedRecipient || !message.trim() || sending}
                >
                  {sending ? c.sending : c.send}
                </Button>
                {sent && (
                  <p role="status" className={muted}>
                    {c.sent}
                  </p>
                )}
              </form>
              {telemetry.mailboxEntries.length === 0 ? (
                <p className={muted}>{c.noMailbox}</p>
              ) : (
                <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                  {telemetry.mailboxEntries.map((box) => (
                    <li key={box.agentName} className="space-y-2 py-4">
                      <h3 className="break-all text-sm font-medium">{box.agentName}</h3>
                      <p className={muted}>
                        {c.queue}: {box.queueDepth} · {c.replies}: {box.pendingReplies}
                      </p>
                      <details className="text-sm text-gray-600 dark:text-gray-400">
                        <summary className="cursor-pointer py-2">
                          {c.lease}: {box.leaseState}
                        </summary>
                        {box.leaseRemainingSec !== undefined && <p>{box.leaseRemainingSec} s</p>}
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {tool === "loop" && (
            <section className="max-w-3xl space-y-6">
              <h2 className="text-lg font-semibold">{c.loop}</h2>
              <dl className="divide-y divide-gray-200 text-sm dark:divide-gray-800">
                {[
                  [c.task, telemetry.activeTaskId ?? c.noTask],
                  [c.failures, String(turns.filter((turn) => turn.status === "failed").length)],
                  [c.protection, c.unknown],
                  [
                    c.lastUpdate,
                    telemetry.lastEventTime
                      ? new Date(telemetry.lastEventTime).toLocaleString(locale)
                      : c.notReceived,
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-wrap justify-between gap-3 py-4">
                    <dt className="text-gray-600 dark:text-gray-400">{label}</dt>
                    <dd className="break-all font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className={muted}>{c.healthHint}</p>
              <Button className="min-h-11" onClick={() => setTool("guardian")}>
                {c.reviewSafety}
              </Button>
              {history}
            </section>
          )}
          <Suspense
            fallback={
              <p role="status" className={`${muted} py-6`}>
                {c.connecting}
              </p>
            }
          >
            {tool === "topology" && <TopologyPage embedded />}
            {tool === "guardian" && <GuardianPage embedded />}
            {tool === "consensus" && (
              <ConsensusPage embedded mailboxEntries={telemetry.mailboxEntries} />
            )}
            {tool === "context" && <ContextBreakdownPage embedded sessionId={sessionId} />}
            {tool === "memory" && <MemoryPage embedded />}
            {tool === "keys" && <ModelsKeyFleetPage embedded />}
            {tool === "flamegraph" && <TraceFlamegraphPage embedded />}
            {tool === "snapshots" && <SnapshotsPage embedded />}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

export function CockpitPage() {
  const { locale } = useLocale();
  useDocumentTitle(cockpitCopy(locale).title);
  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <AgentCockpit embedded />
    </div>
  );
}
