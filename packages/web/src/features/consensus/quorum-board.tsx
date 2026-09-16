import { useState, useMemo } from "react";
import { QuorumConsensusEngine } from "@prismshadow/penguin-core/browser";
import type { TopicStanding, TopicConsensusStatus } from "@prismshadow/penguin-core/browser";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Modal } from "../../components/ui/modal";
import { RequiredMark } from "../../components/ui/field";

export interface QuorumBoardProps {
  engine?: QuorumConsensusEngine;
  version?: number;
  onMutate?: () => void;
}

export function QuorumBoard({
  engine: externalEngine,
  version: externalVersion,
  onMutate,
}: QuorumBoardProps = {}) {
  const [internalEngine] = useState(() => new QuorumConsensusEngine());
  const engine = externalEngine ?? internalEngine;

  const [internalVersion, setInternalVersion] = useState(0);
  const version = externalVersion ?? internalVersion;

  const triggerMutate = () => {
    setInternalVersion((v) => v + 1);
    onMutate?.();
  };

  const [filter, setFilter] = useState<TopicConsensusStatus | "all">("all");

  // Propose Modal
  const [proposeOpen, setProposeOpen] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [newProposer, setNewProposer] = useState("agent-architect");
  const [newThreshold, setNewThreshold] = useState(2);

  // Endorse / Refute Modal
  const [activeActionTopic, setActiveActionTopic] = useState<TopicStanding | null>(null);
  const [actionKind, setActionKind] = useState<"endorse" | "refute">("endorse");
  const [actionAgent, setActionAgent] = useState("agent-reviewer");
  const [actionGrounds, setActionGrounds] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const topics: TopicStanding[] = useMemo(() => {
    // dependency on version forces re-evaluation
    void version;
    const all = engine.listStandings();
    if (filter === "all") return all;
    return all.filter((t) => t.status === filter);
  }, [engine, filter, version]);

  const handleCreateTopic = () => {
    if (!newTopic.trim()) return;
    engine.proposeTopic({
      topic: newTopic.trim(),
      proposerId: newProposer.trim(),
      policy: { threshold: newThreshold, requireGrounded: true, refutationCap: 1 },
    });
    setProposeOpen(false);
    setNewTopic("");
    triggerMutate();
  };

  const handleExecuteAction = () => {
    if (!activeActionTopic || !actionGrounds.trim()) return;
    try {
      if (actionKind === "endorse") {
        engine.endorseTopic(activeActionTopic.topicId, actionAgent, actionGrounds.trim());
      } else {
        engine.refuteTopic(activeActionTopic.topicId, actionAgent, actionGrounds.trim());
      }
      setActiveActionTopic(null);
      setActionGrounds("");
      setActionError(null);
      triggerMutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm ">
      {/* Top Filter and Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-1 bg-white dark:bg-gray-950 p-1 rounded-lg border border-gray-200 dark:border-gray-800">
          {(["all", "debating", "settled", "refuted"] as const).map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
              className={`px-2.5 py-2 rounded text-sm capitalize transition-colors ${
                filter === status
                  ? "bg-cyan-500/20 text-gray-900 dark:text-gray-100 font-semibold border border-cyan-500/30"
                  : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              }`}
            >
              {status}
            </button>
          ))}
        </div>

        <Button size="sm" variant="primary" onClick={() => setProposeOpen(true)}>
          Propose decision
        </Button>
      </div>

      {/* Topics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-1 sm:grid-cols-1 sm:grid-cols-2 gap-3.5">
        {topics.length === 0 ? (
          <div className="col-span-full p-8 text-center text-sm text-gray-600 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 rounded-md">
            No decisions in this view. Propose a decision to collect peer feedback.
          </div>
        ) : (
          topics.map((t) => {
            const peerEndorsements = t.supporters.filter((s) => s.agentId !== t.proposerId).length;
            const threshold = t.policy.threshold;
            const progressPct = Math.min(100, Math.round((peerEndorsements / threshold) * 100));

            return (
              <div
                key={t.topicId}
                className="py-4 border-b border-gray-200 dark:border-gray-800 flex flex-col gap-3"
              >
                {/* Card Header */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="font-semibold text-sm text-gray-900 dark:text-gray-100 leading-snug">
                      {t.topic}
                    </span>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      Proposer:{" "}
                      <strong className="text-gray-600 dark:text-gray-400">{t.proposerId}</strong>
                    </span>
                  </div>
                  <span
                    className={`px-2 py-2 rounded text-sm  font-semibold  shrink-0 ${
                      t.status === "settled"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30"
                        : t.status === "refuted"
                          ? "bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/30"
                          : "bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30"
                    }`}
                  >
                    {t.status}
                  </span>
                </div>

                {/* Consensus Progress Bar */}
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center justify-between text-sm text-gray-600 dark:text-gray-400">
                    <span>Peer endorsements:</span>
                    <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {peerEndorsements} / {threshold} required ({progressPct}%)
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-white dark:bg-gray-950 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        t.status === "settled"
                          ? "bg-emerald-500"
                          : t.status === "refuted"
                            ? "bg-rose-500"
                            : "bg-cyan-500"
                      }`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>

                <details>
                  <summary className="cursor-pointer py-2 font-medium">
                    Evidence and objections
                  </summary>
                  {/* Grounded Evidence Supporters */}
                  <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800">
                    <div className="flex flex-wrap items-center justify-between text-sm text-gray-600 dark:text-gray-400 font-semibold ">
                      <span>Endorsements ({t.supporters.length})</span>
                    </div>
                    {t.supporters.length === 0 ? (
                      <div className="text-sm text-gray-600 dark:text-gray-400 italic">
                        No peer endorsements yet.
                      </div>
                    ) : (
                      t.supporters.map((s, idx) => (
                        <div
                          key={idx}
                          className="text-sm flex flex-wrap items-start gap-1.5 text-gray-900 dark:text-gray-100"
                        >
                          <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                            ✓
                          </span>
                          <div>
                            <strong className="text-gray-900 dark:text-gray-100">
                              {s.agentId}:
                            </strong>{" "}
                            <span className="text-gray-600 dark:text-gray-400">
                              {s.grounds ?? "Approved"}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Refutations */}
                  {t.refuters.length > 0 && (
                    <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-rose-950/20 border border-rose-900/30">
                      <div className="text-sm text-rose-700 dark:text-rose-400 font-semibold ">
                        Refutations ({t.refuters.length})
                      </div>
                      {t.refuters.map((r, idx) => (
                        <div
                          key={idx}
                          className="text-sm flex flex-wrap items-start gap-1.5 text-rose-300"
                        >
                          <span className="text-rose-700 dark:text-rose-400 font-semibold">✗</span>
                          <div>
                            <strong className="text-rose-200">{r.agentId}:</strong>{" "}
                            <span className="text-rose-400/90">{r.grounds}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
                {/* Action Buttons for In-Debate */}
                {t.status === "debating" && (
                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1 border-t border-gray-200 dark:border-gray-800">
                    <Button
                      size="sm"
                      variant="danger"
                      className="text-sm min-h-9"
                      onClick={() => {
                        setActiveActionTopic(t);
                        setActionKind("refute");
                        setActionGrounds("");
                        setActionError(null);
                      }}
                    >
                      Refute
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-sm min-h-9"
                      onClick={() => {
                        setActiveActionTopic(t);
                        setActionKind("endorse");
                        setActionGrounds("");
                        setActionError(null);
                      }}
                    >
                      Endorse with evidence
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Propose Topic Modal */}
      <Modal
        open={proposeOpen}
        title="Propose a decision"
        onClose={() => setProposeOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setProposeOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleCreateTopic}
              disabled={
                !newTopic.trim() ||
                !newProposer.trim() ||
                !Number.isInteger(newThreshold) ||
                newThreshold < 1 ||
                newThreshold > 5
              }
            >
              Create Proposal
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-gray-900 dark:text-gray-100">
          <div>
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
              Decision Topic Summary <RequiredMark />
            </label>
            <Input
              aria-label="New topic"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="e.g. Refactor AST indexing to background worker thread"
              size="sm"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
                Proposer Agent
              </label>
              <Input
                aria-label="New proposer"
                value={newProposer}
                onChange={(e) => setNewProposer(e.target.value)}
                size="sm"
              />
            </div>
            <div>
              <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
                Endorsements Threshold
              </label>
              <Input
                aria-label="New threshold"
                type="number"
                min="1"
                max="5"
                value={newThreshold}
                onChange={(e) => setNewThreshold(Number(e.target.value))}
                size="sm"
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* Endorse / Refute Modal */}
      <Modal
        open={activeActionTopic !== null}
        title={actionKind === "endorse" ? "Endorse Decision Topic" : "Refute Decision Topic"}
        onClose={() => setActiveActionTopic(null)}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setActiveActionTopic(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={actionKind === "endorse" ? "primary" : "danger"}
              disabled={!actionAgent.trim() || !actionGrounds.trim()}
              onClick={handleExecuteAction}
            >
              Confirm {actionKind === "endorse" ? "Endorsement" : "Refutation"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-gray-900 dark:text-gray-100">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {actionError && (
              <p role="alert" className="text-red-700 dark:text-red-400">
                {actionError}
              </p>
            )}
            Topic:{" "}
            <strong className="text-gray-900 dark:text-gray-100">{activeActionTopic?.topic}</strong>
          </div>

          <div>
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
              Acting Agent Role
            </label>
            <Input
              aria-label="Action agent"
              value={actionAgent}
              onChange={(e) => setActionAgent(e.target.value)}
              size="sm"
            />
          </div>

          <div>
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
              Evidence or citation <RequiredMark />
            </label>
            <Input
              aria-label="Action grounds"
              value={actionGrounds}
              onChange={(e) => setActionGrounds(e.target.value)}
              placeholder="Cite the benchmark, file, or test proving this assertion..."
              size="sm"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
