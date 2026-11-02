import { WorkflowError } from "../../utils/workflow-error";

export type HistoryFilter = { from?: string; to?: string; status?: "delivered" | "failed" | "cancelled" };
export function historyBounds(filter: HistoryFilter) {
  const parse = (value?: string) => {
    if (!value) return undefined;
    const date = new Date(`${value}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== value) throw new WorkflowError("Use valid YYYY-MM-DD Manila dates.", 400);
    return date;
  };
  const start = parse(filter.from), endDay = parse(filter.to);
  if (start && endDay && start > endDay) throw new WorkflowError("The start date must be before the end date.", 400);
  if (filter.status && !["delivered", "failed", "cancelled"].includes(filter.status)) throw new WorkflowError("Invalid history status.", 400);
  return { start: start?.toISOString(), end: endDay ? new Date(endDay.getTime() + 86400000).toISOString() : undefined };
}
