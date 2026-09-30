/**
 * Origin hint for a scheduled-task-triggered message: the origin block ([scheduled_task]) is
 * not rendered verbatim on screen; it collapses into one line reading "Triggered by scheduled
 * task '<name>'" plus a localized trigger timestamp (a static display with no navigation — task
 * management lives on the Agent settings page's "Scheduled Tasks" tab). The task prompt body
 * itself is rendered as usual by the caller.
 */
import { S } from "../../lib/strings";
import { formatDateTime } from "../../lib/format";
import { STREAM_BANNER_FRAME } from "./disclosure-row";
import type { ScheduledOrigin } from "./agent-handoff";

export function ScheduledBanner({ origin }: { origin: ScheduledOrigin }) {
  return (
    <p className={`anim-msg my-2 flex w-fit ${STREAM_BANNER_FRAME}`}>
      {S.chat.scheduledFrom(origin.name)}
      {origin.firedAt && (
        <span className="text-gray-500 dark:text-gray-400">{formatDateTime(origin.firedAt)}</span>
      )}
    </p>
  );
}
