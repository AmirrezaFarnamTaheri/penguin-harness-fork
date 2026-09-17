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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    setLoadError(null);
    try {
      const res = await api.getCommandPolicy(projectId);
      setEnabled(res.enabled);
      setRules(res.rules ?? []);
    } catch (err) {
      setRules([]);
      setLoadError(err instanceof Error ? err.message : "Could not load the command policy.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const handleSavePolicy = async () => {
    if (!projectId || loading || loadError) return;
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
    <div className="flex flex-col gap-4 py-4 border-b border-gray-200 dark:border-gray-800 text-sm ">
      {/* Header with Master Toggle */}
      <div className="flex flex-wrap items-center justify-between pb-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100">
            Project Execution Policy
          </h3>
          <span className="text-sm px-2 py-2 rounded bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400">
            {rules.length} rules
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex flex-wrap items-center gap-2 cursor-pointer text-sm text-gray-900 dark:text-gray-100">
            <span>Enable command policy:</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={loading || !!loadError || saving}
              className="rounded bg-white dark:bg-gray-950 border-gray-700 text-cyan-500 focus:ring-0"
            />
          </label>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAddOpen(true)}
            disabled={loading || !!loadError || saving}
          >
            + Add Rule
          </Button>

          <Button
            size="sm"
            variant="primary"
            onClick={handleSavePolicy}
            disabled={saving || loading || !!loadError}
          >
            {saving ? "Saving..." : "Save Policy"}
          </Button>
        </div>
      </div>

      {loading && <p role="status">Loading command policy…</p>}
      {loadError && (
        <div role="alert" className="text-sm text-red-700 dark:text-red-400">
          <p>Could not load the command policy. No rules have been changed. {loadError}</p>
          <Button variant="secondary" onClick={() => void loadPolicy()}>
            Retry loading policy
          </Button>
        </div>
      )}
      {/* Rules List */}
      <div className="flex flex-col gap-2 max-h-[380px] overflow-y-auto">
        {loading || loadError ? null : rules.length === 0 ? (
          <div className="py-8 text-center text-gray-600 dark:text-gray-400">
            No command policy rules configured.
          </div>
        ) : (
          rules.map((rule, idx) => {
            const isRuleActive = rule.enabled ?? true;
            return (
              <div
                key={idx}
                className={`p-3 rounded-lg border transition-colors flex flex-wrap items-center justify-between gap-3 ${
                  isRuleActive
                    ? "bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800"
                    : "bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800 opacity-60"
                }`}
              >
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {rule.name}
                    </span>
                    <span
                      className={`text-sm px-1.5 py-0.2 rounded font-medium ${
                        isRuleActive
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                          : "bg-white dark:bg-gray-950 text-gray-600 dark:text-gray-400"
                      }`}
                    >
                      {isRuleActive ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  {rule.description && (
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      {rule.description}
                    </div>
                  )}
                  <div className="text-sm text-gray-600 dark:text-gray-400 truncate">
                    Pattern:{" "}
                    <code className="font-mono break-words whitespace-pre-wrap  break-words whitespace-pre-wrap text-gray-900 dark:text-gray-100 font-semibold">
                      {rule.pattern}
                    </code>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleToggleRule(idx)}
                    className="px-2 py-1 rounded bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-gray-900 dark:text-gray-100 hover:text-gray-900 dark:hover:text-white transition-colors"
                  >
                    {isRuleActive ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteRule(idx)}
                    className="px-2 py-1 rounded bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-rose-700 dark:text-rose-400 hover:bg-rose-950/40 transition-colors"
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
        <div className="flex flex-col gap-3 text-sm text-gray-900 dark:text-gray-100">
          <div>
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
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
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
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
              <p className="mt-1 text-sm text-rose-700 dark:text-rose-400 font-semibold">
                {patternError}
              </p>
            )}
          </div>

          <div>
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
              Description (Optional)
            </label>
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
