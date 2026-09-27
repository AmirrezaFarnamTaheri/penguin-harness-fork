/**
 * The rename affordance shared by the two key surfaces (the fleet page and the pool view).
 *
 * One editor, not two, so the rules cannot drift: the name is required, the label is not, and
 * the 409 a taken name earns is shown as a 409 rather than swallowed into a generic failure.
 * Both surfaces show the same key, and a control that behaved differently depending on which
 * page you were on would be its own bug report.
 *
 * It never asks for, sends, or displays a key. The target is the masked string the caller
 * already has, and the server resolves it against the pool it holds — the fleet is
 * write-only at rest, and naming a key must not become a way to hand one back.
 */
import { useState } from "react";
import * as api from "../../api/endpoints";
import { S } from "../../lib/strings";
import { apiErrorText } from "../../lib/api-error";
import { Button } from "../../components/ui/button";
import { Input, Textarea } from "../../components/ui/input";

export interface KeyNameEditorProps {
  projectId: string;
  provider: string;
  modelId: string;
  /** The masked key, exactly as the surface shows it. */
  maskedKey: string;
  /** The name in force, or undefined for a key that has never been named. */
  name?: string;
  label?: string;
  /** Renames in place and reports the saved values, so the caller can re-render. */
  onSaved: (saved: { name: string; label?: string; keyId: string }) => void;
  onCancel: () => void;
}

export function KeyNameEditor({
  projectId,
  provider,
  modelId,
  maskedKey,
  name,
  label,
  onSaved,
  onCancel,
}: KeyNameEditorProps) {
  const [draftName, setDraftName] = useState(name ?? "");
  const [draftLabel, setDraftLabel] = useState(label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = draftName.trim();
    if (trimmed === "") {
      setError(S.models.keyNameRequired);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await api.putModelKeyName(projectId, {
        provider,
        modelId,
        maskedKey,
        name: trimmed,
        // An emptied label is sent as an empty string, which the server stores as "no label" —
        // so clearing the box actually clears it instead of leaving yesterday's note behind.
        label: draftLabel.trim(),
      });
      onSaved({
        name: saved.name,
        ...(saved.label === undefined ? {} : { label: saved.label }),
        keyId: saved.keyId,
      });
    } catch (err) {
      // A 409 arrives here as `key_name_taken` and is localized from the code; the field keeps
      // what was typed, so the user changes one word rather than retyping the label.
      setError(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/40">
      <Input
        // The editor only exists because the user asked to rename something, so it opens on
        // the field they have to fill in. `autoFocus` rather than an effect: `Input` does not
        // forward a ref, and a focus effect that cannot reach the node is a focus effect that
        // silently does nothing.
        autoFocus
        label={S.models.keyNameLabel}
        hint={S.models.keyNameHint}
        required
        size="sm"
        value={draftName}
        maxLength={64}
        placeholder={S.models.keyNamePlaceholder}
        onChange={(e) => setDraftName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <Textarea
        label={S.models.keyLabelLabel}
        size="sm"
        rows={2}
        value={draftLabel}
        maxLength={500}
        placeholder={S.models.keyLabelPlaceholder}
        onChange={(e) => setDraftLabel(e.target.value)}
        onKeyDown={(e) => {
          // Enter is a newline here, which is the whole reason a label is a textarea; only
          // Escape leaves, and leaving loses nothing because nothing has been sent yet.
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />

      {error !== null && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          {S.models.keyNameCancel}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={saving}>
          {S.models.keyNameSave}
        </Button>
      </div>
    </div>
  );
}
