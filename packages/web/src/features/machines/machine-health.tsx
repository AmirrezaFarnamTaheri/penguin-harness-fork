import type { MachineInfo } from "@prismshadow/penguin-server/api";
import { S } from "../../lib/strings";
import { formatDateTime } from "../../lib/format";

/** A dated probe result, never inferred from installation or an open SSH connection. */
export function MachineHealth({ status }: { status: MachineInfo["status"] }) {
  return (
    <span className="block min-w-0 text-xs text-gray-600 dark:text-gray-400">
      {status === null ? (
        S.machines.health.unknown
      ) : (
        <>
          <span>{S.machines.health[status.state]}</span>
          {" · "}
          <span>{S.machines.health.lastProbe} </span>
          <time dateTime={status.checkedAt}>{formatDateTime(status.checkedAt)}</time>
          {status.detail && (
            <span className="block break-words whitespace-pre-wrap">{status.detail}</span>
          )}
        </>
      )}
    </span>
  );
}
