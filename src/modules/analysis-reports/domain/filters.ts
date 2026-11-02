import { WorkflowError } from "../../../utils/workflow-error";
import {
  ARRAY_FILTER_KEYS,
  DATE_PRESETS,
  DEFAULT_FILTERS,
  DELIVERY_STATUSES,
  DELIVERY_TYPES,
  ORDER_STATUSES,
  PAYMENT_ARRANGEMENTS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type ArrayFilterKey,
  type DatePreset,
  type Filters,
} from "../reports.contract";
import { DAY, dayStart, manilaDay } from "../../../utils/time";
import type { DeliveryView, OrderView, Range } from "./types";

// ---- Query string -> Filters ----
const ALLOWED: Partial<Record<ArrayFilterKey, readonly string[]>> = {
  arrangements: PAYMENT_ARRANGEMENTS,
  payStatuses: PAYMENT_STATUSES,
  orderStatuses: ORDER_STATUSES,
  deliveryStatuses: DELIVERY_STATUSES,
  deliveryTypes: DELIVERY_TYPES,
  paymentMethods: PAYMENT_METHODS,
};
const NUMERIC: readonly ArrayFilterKey[] = [
  "customers",
  "products",
  "warehouses",
];

/**
 * Turns raw query params (arrays arrive comma-separated) into a safe Filters object.
 * Enum values are whitelisted and ids must be integers, so nothing unexpected reaches a SQL enum cast.
 */
export function parseFilters(q: Record<string, unknown>): Filters {
  const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : ""); // other params (type, format, threshold) are ignored
  const f: Filters = { ...DEFAULT_FILTERS };
  f.preset = (DATE_PRESETS as readonly string[]).includes(str("preset"))
    ? (str("preset") as DatePreset)
    : DEFAULT_FILTERS.preset;
  f.from = str("from");
  f.to = str("to");
  f.overdueOnly = str("overdueOnly") === "true";
  for (const key of ARRAY_FILTER_KEYS) {
    let list = str(key)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (NUMERIC.includes(key)) list = list.filter((s) => /^\d+$/.test(s) && Number(s) > 0 && Number(s) <= 2147483647);
    const allowed = ALLOWED[key];
    if (allowed) list = list.filter((s) => allowed.includes(s));
    f[key] = [...new Set(list)];
  }
  return f;
}

// ---- Date ranges ----
const PRESET_DAYS: Record<string, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const isCustom = (f: Filters) =>
  f.preset === "custom" && !!f.from && !!f.to;

/** [start, end) on Manila day boundaries. `back = 1` gives the equal-length period immediately before. */
export function rangeOf(f: Filters, now: number, back = 0): Range {
  if (f.preset === "custom" && (!f.from || !f.to)) throw new WorkflowError("Choose both start and end dates.", 400);
  const today = manilaDay(now);
  let start: number, end: number;
  if (isCustom(f)) {
    start = dayStart(f.from);
    end = dayStart(f.to) + DAY;
  } else {
    end = dayStart(today) + DAY;
    start =
      f.preset === "mtd"
        ? dayStart(today.slice(0, 8) + "01")
        : f.preset === "ytd"
          ? dayStart(today.slice(0, 5) + "01-01")
          : end - (PRESET_DAYS[f.preset] ?? 30) * DAY;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (isCustom(f) && (!/^\d{4}-\d{2}-\d{2}$/.test(f.from) || !/^\d{4}-\d{2}-\d{2}$/.test(f.to) || manilaDay(start) !== f.from || manilaDay(end - DAY) !== f.to))) throw new WorkflowError("Choose a valid date range, with the end on or after the start.", 400);
  const len = end - start;
  return { start: start - back * len, end: end - back * len };
}

/** The range as Manila calendar days: `from` inclusive, `to` exclusive. Used against `date` columns. */
export const rangeDays = (r: Range) => ({
  from: manilaDay(r.start),
  to: manilaDay(r.end),
});

// ---- In-memory filters for values that are derived (payment status, latest delivery) and so can't be WHERE clauses ----
export const has = (list: string[], v: string) =>
  !list.length || list.includes(v);

export const deliveryMatches = (d: DeliveryView | null, f: Filters) =>
  !(f.deliveryStatuses.length || f.deliveryTypes.length || f.vehicles.length) ||
  (!!d &&
    has(f.deliveryStatuses, d.status) &&
    has(f.deliveryTypes, d.type) &&
    has(f.vehicles, d.vehicle));

/**
 * Order filters applied after loading. Customer / warehouse / status / product filters already ran in SQL
 * (see orders.repository `orderWhere`). `withDelivery` also applies delivery status/type/vehicle via the order's latest delivery.
 */
export const orderMatches = (o: OrderView, f: Filters, withDelivery = true) =>
  has(f.arrangements, o.arrangement) &&
  has(f.payStatuses, o.payStatus) &&
  (!f.overdueOnly || o.payStatus === "OVERDUE") &&
  (!withDelivery || deliveryMatches(o.delivery, f));
