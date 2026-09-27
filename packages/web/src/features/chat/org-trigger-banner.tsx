/**
 * Origin hint for a message the organization scheduler sent (the `[org_trigger]` block): the
 * block is not rendered verbatim; it folds into one line — which organization, what kind of
 * trigger, the event / message / ticket it names, and the budget line — the same shape as the
 * scheduled-task banner beside it. The trigger's body renders as usual below.
 */
import { S } from "../../lib/strings";
import { formatDateTime } from "../../lib/format";
import { Badge } from "../../components/ui/badge";
import { STREAM_BANNER_FRAME } from "./disclosure-row";
import { summarizeOrgTrigger } from "./org-trigger";
import type { OrgTriggerOrigin } from "./org-trigger";

export function OrgTriggerBanner({ origin }: { origin: OrgTriggerOrigin }) {
  const t = summarizeOrgTrigger(origin);
  const kind = S.chat.orgTriggerKinds[t.kind] ?? t.kind;
  return (
    // `flex-wrap` is this one's own addition: a long subject + change + budget line can exceed
    // the row, and wrapping the notice beats letting it overflow the transcript.
    <p className={`anim-msg my-2 flex w-fit flex-wrap ${STREAM_BANNER_FRAME}`}>
      <span>{S.chat.orgTriggerFrom(t.org)}</span>
      <Badge tone="brand">{kind}</Badge>
      {t.subject !== null && (
        <span className="font-mono text-gray-700 dark:text-gray-300">
          {t.subject}
          {t.change !== null && ` · ${t.change}`}
        </span>
      )}
      {t.firedAt !== null && (
        <span className="text-gray-400 dark:text-gray-500">{formatDateTime(t.firedAt)}</span>
      )}
      {t.budget !== null && (
        <span className="text-gray-400 dark:text-gray-500">
          {S.chat.orgTriggerBudget(t.budget)}
        </span>
      )}
    </p>
  );
}
