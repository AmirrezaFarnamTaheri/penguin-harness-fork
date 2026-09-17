import type { ScheduleItem, SchedulesResponse } from "./types.js";

/** Parsed TOML intent only: not a mutable KanbanTask or a claim of runtime eligibility. */
export interface ScheduleKanbanCard extends Pick<
  ScheduleItem,
  "name" | "enabled" | "startAt" | "period" | "endAt"
> {
  /** Project/agent/filename identity; unchanged when the file's contents change. */
  id: string;
}

export interface ScheduleKanbanResponse {
  cards: ScheduleKanbanCard[];
  invalidFiles: SchedulesResponse["invalidFiles"];
}
