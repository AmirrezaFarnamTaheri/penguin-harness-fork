import { useEffect, useState, useCallback } from "react";
import type { CommandPolicyRuleDto } from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Modal } from "../../components/ui/modal";
import { RequiredMark } from "../../components/ui/field";
import { toastSuccess, toastError } from "../../components/ui/toast";

export interface RulePolicyEditorProps {
  projectId: string;
}

export function RulePolicyEditor({ projectId }: RulePolicyEditorProps) {
  const [enabled, setEnabled] = useState(true);
  const [rules, setRules] = useState<CommandPolicyRuleDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // New Rule Dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPattern, setNewPattern] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [patternError, setPatternError] = useState<string | null>(null);

  const loadPolicy = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await api.getCommandPolicy(projectId);
      setEnabled(res.enabled);
      setRules(res.rules ?? []);
    } catch {
      // Fallback default rules
      setEnabled(true);
      setRules([
        {
          name: "block-root-rm",
          pattern: "rm\\s+-[a-zA-Z]*rf.*(/|~|\\*)",
          description: "Block recursive deletion of root or wildcard files",
          enabled: true,
        },
        {
          name: "block-dd-raw",
          pattern: "dd\\s+.*of=/dev/(sd|nvme)",
          description: "Block raw disk block overwrite via dd",
          enabled: true,
        },
        {
          name: "block-fork-bomb",
          pattern: ":\\(\\)\\s*\\{",
          description: "Block bash fork-bomb recursion",
          enabled: true,
        },
        {
          name: "warn-hard-reset",
          pattern: "git\\s+reset\\s+--hard",
          description: "Intercept uncommitted work loss from git reset --hard",
          enabled: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const handleSavePolicy = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      await api.putCommandPolicy(projectId, { enabled, rules });
      toastSuccess("Command policy updated successfully.");
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Failed to update command policy.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleRule = (idx: number) => {
    setRules((prev) => {
      const next = [...prev];
      const target = next[idx];
      if (target) {
        next[idx] = { ...target, enabled: !(target.enabled ?? true) };
      }
      return next;
    });
  };

  const handleDeleteRule = (idx: number) => {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCreateRule = () => {
    if (!newName.trim()) return;
    if (!newPattern.trim()) {
      setPatternError("Pattern cannot be empty.");
      return;
    }
    try {
      new RegExp(newPattern);
    } catch {
      setPatternError("Invalid regular expression pattern.");
      return;
    }

    const rule: CommandPolicyRuleDto = {
      name: newName.trim(),
      pattern: newPattern.trim(),
      description: newDesc.trim() || undefined,
      enabled: true,
    };

    setRules((prev) => [...prev, rule]);
    setAddOpen(false);
    setNewName("");
    setNewPattern("");
    setNewDesc("");
    setPatternError(null);
  };

  return (
    <div className="flex flex-col gap-4 p-4 rounded-xl border border-gray-800 bg-gray-950 font-mono text-xs select-none">
      {/* Header with Master Toggle */}
      <div className="flex items-center justify-between pb-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-sm text-gray-100">Project Execution Policy</h3>
          <span className="text-[10px] px-2 py-0.5 rounded bg-gray-900 border border-gray-800 text-gray-400">
            {rules.length} rules
          </span>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer text-[11px] text-gray-300">
            <span>Enforce Sandbox Barrier:</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded bg-gray-900 border-gray-700 text-cyan-500 focus:ring-0"
            />
          </label>

          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            + Add Rule
          </Button>

          <Button size="sm" variant="primary" onClick={handleSavePolicy} disabled={saving}>
            {saving ? "Saving..." : "Save Policy"}
          </Button>
        </div>
      </div>

      {/* Rules List */}
      <div className="flex flex-col gap-2 max-h-[380px] overflow-y-auto">
        {rules.length === 0 ? (
          <div className="py-8 text-center text-gray-600">No command policy rules configured.</div>
        ) : (
          rules.map((rule, idx) => {
            const isRuleActive = rule.enabled ?? true;
            return (
              <div
                key={idx}
                className={`p-3 rounded-lg border transition-colors flex items-center justify-between gap-3 ${
                  isRuleActive
                    ? "bg-gray-900/50 border-gray-800"
                    : "bg-gray-950/40 border-gray-900 opacity-60"
                }`}
              >
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-200">{rule.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded font-medium ${
                        isRuleActive
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : "bg-gray-800 text-gray-500"
                      }`}
                    >
                      {isRuleActive ? "ENFORCED" : "BYPASSED"}
                    </span>
                  </div>
                  {rule.description && (
                    <div className="text-[11px] text-gray-400">{rule.description}</div>
                  )}
                  <div className="text-[10px] text-gray-500 truncate">
                    Pattern: <code className="text-cyan-400 font-bold">{rule.pattern}</code>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleToggleRule(idx)}
                    className="px-2 py-1 rounded bg-gray-900 border border-gray-800 text-gray-300 hover:text-white transition-colors"
                  >
                    {isRuleActive ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteRule(idx)}
                    className="px-2 py-1 rounded bg-gray-900 border border-gray-800 text-rose-400 hover:bg-rose-950/40 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add Rule Modal */}
      <Modal
        open={addOpen}
        title="Add Command Safety Policy Rule"
        onClose={() => setAddOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleCreateRule}>
              Add Rule
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 font-mono text-xs text-gray-300">
          <div>
            <label className="block mb-1 text-gray-400 font-medium">
              Rule Identifier <RequiredMark />
            </label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. block-dangerous-reset"
              size="sm"
            />
          </div>

          <div>
            <label className="block mb-1 text-gray-400 font-medium">
              Regular Expression Pattern <RequiredMark />
            </label>
            <Input
              value={newPattern}
              onChange={(e) => {
                setNewPattern(e.target.value);
                setPatternError(null);
              }}
              placeholder="e.g. git\s+clean\s+-[a-zA-Z]*f"
              size="sm"
            />
            {patternError && (
              <p className="mt-1 text-[11px] text-rose-400 font-semibold">{patternError}</p>
            )}
          </div>

          <div>
            <label className="block mb-1 text-gray-400 font-medium">Description (Optional)</label>
            <Input
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Explains what risk this rule catches"
              size="sm"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
