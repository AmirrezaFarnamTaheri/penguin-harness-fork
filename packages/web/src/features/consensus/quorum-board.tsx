import { useState, useMemo } from "react";
import { QuorumConsensusEngine } from "@prismshadow/penguin-core/browser";
import type { TopicStanding, TopicConsensusStatus } from "@prismshadow/penguin-core/browser";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Modal } from "../../components/ui/modal";
import { RequiredMark } from "../../components/ui/field";

export function QuorumBoard() {
  const [engine] = useState(() => new QuorumConsensusEngine());

  const [version, setVersion] = useState(0);
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
    setVersion((v) => v + 1);
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
      setVersion((v) => v + 1);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-4 font-mono text-xs select-none">
      {/* Top Filter and Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-lg border border-gray-800">
          {(["all", "debating", "settled", "refuted"] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setFilter(status)}
              className={`px-2.5 py-1 rounded text-[11px] capitalize transition-colors ${
                filter === status
                  ? "bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {status}
            </button>
          ))}
        </div>

        <Button size="sm" variant="primary" onClick={() => setProposeOpen(true)}>
          + Propose Decision Topic
        </Button>
      </div>

      {/* Topics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {topics.length === 0 ? (
          <div className="col-span-full p-8 text-center text-sm text-gray-500 border border-dashed border-gray-800 rounded-xl">
            No quorum consensus topics found. Propose a decision topic above to begin deliberation.
          </div>
        ) : (
          topics.map((t) => {
            const peerEndorsements = t.supporters.filter((s) => s.agentId !== t.proposerId).length;
            const threshold = t.policy.threshold;
            const progressPct = Math.min(100, Math.round((peerEndorsements / threshold) * 100));

            return (
              <div
                key={t.topicId}
                className="p-4 rounded-xl border border-gray-800 bg-gray-950 flex flex-col gap-3"
              >
                {/* Card Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="font-bold text-sm text-gray-100 leading-snug">{t.topic}</span>
                    <span className="text-[10px] text-gray-500">
                      Proposer: <strong className="text-gray-400">{t.proposerId}</strong>
                    </span>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider shrink-0 ${
                      t.status === "settled"
                        ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                        : t.status === "refuted"
                          ? "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                          : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                    }`}
                  >
                    {t.status}
                  </span>
                </div>

                {/* Consensus Progress Bar */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11px] text-gray-400">
                    <span>Peer Endorsement Quorum:</span>
                    <span className="font-semibold text-gray-200">
                      {peerEndorsements} / {threshold} required ({progressPct}%)
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
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

                {/* Grounded Evidence Supporters */}
                <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-gray-900/50 border border-gray-900">
                  <div className="flex items-center justify-between text-[10px] text-gray-400 font-semibold uppercase">
                    <span>Grounded Endorsements ({t.supporters.length})</span>
                  </div>
                  {t.supporters.length === 0 ? (
                    <div className="text-[11px] text-gray-600 italic">
                      No peer endorsements yet.
                    </div>
                  ) : (
                    t.supporters.map((s, idx) => (
                      <div key={idx} className="text-[11px] flex items-start gap-1.5 text-gray-300">
                        <span className="text-emerald-400 font-bold">✓</span>
                        <div>
                          <strong className="text-gray-200">{s.agentId}:</strong>{" "}
                          <span className="text-gray-400">{s.grounds ?? "Approved"}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Refutations */}
                {t.refuters.length > 0 && (
                  <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-rose-950/20 border border-rose-900/30">
                    <div className="text-[10px] text-rose-400 font-semibold uppercase">
                      Refutations ({t.refuters.length})
                    </div>
                    {t.refuters.map((r, idx) => (
                      <div key={idx} className="text-[11px] flex items-start gap-1.5 text-rose-300">
                        <span className="text-rose-500 font-bold">✗</span>
                        <div>
                          <strong className="text-rose-200">{r.agentId}:</strong>{" "}
                          <span className="text-rose-400/90">{r.grounds}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Action Buttons for In-Debate */}
                {t.status === "debating" && (
                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-gray-900">
                    <Button
                      size="sm"
                      variant="danger"
                      className="text-[11px] h-7"
                      onClick={() => {
                        setActiveActionTopic(t);
                        setActionKind("refute");
                        setActionGrounds("");
                      }}
                    >
                      Refute
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-[11px] h-7"
                      onClick={() => {
                        setActiveActionTopic(t);
                        setActionKind("endorse");
                        setActionGrounds("");
                      }}
                    >
                      Endorse with Grounds
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
        title="Propose Multi-Agent Consensus Topic"
        onClose={() => setProposeOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setProposeOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleCreateTopic}>
              Create Proposal
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 font-mono text-xs text-gray-300">
          <div>
            <label className="block mb-1 text-gray-400 font-medium">
              Decision Topic Summary <RequiredMark />
            </label>
            <Input
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="e.g. Refactor AST indexing to background worker thread"
              size="sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block mb-1 text-gray-400 font-medium">Proposer Agent</label>
              <Input
                value={newProposer}
                onChange={(e) => setNewProposer(e.target.value)}
                size="sm"
              />
            </div>
            <div>
              <label className="block mb-1 text-gray-400 font-medium">Endorsements Threshold</label>
              <Input
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
              onClick={handleExecuteAction}
            >
              Confirm {actionKind === "endorse" ? "Endorsement" : "Refutation"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 font-mono text-xs text-gray-300">
          <div className="text-[11px] text-gray-400">
            Topic: <strong className="text-gray-200">{activeActionTopic?.topic}</strong>
          </div>

          <div>
            <label className="block mb-1 text-gray-400 font-medium">Acting Agent Role</label>
            <Input value={actionAgent} onChange={(e) => setActionAgent(e.target.value)} size="sm" />
          </div>

          <div>
            <label className="block mb-1 text-gray-400 font-medium">
              Grounded Citation or Evidence <RequiredMark />
            </label>
            <Input
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
