// Pure calculations over already-loaded views. No database access here.
import type { Grain, OrderRow, Point } from "../reports.contract";
import { DAY, manilaDay } from "../../../utils/time";
import type { OrderView, StopView } from "./types";

export const sumMoney = <T,>(rows: T[], amount: (row: T) => number) => rows.reduce((sum, row) => sum + Math.round(amount(row) * 100), 0) / 100;

export const sumBy = <T,>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);

export function groupSum<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): Point[] {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(key(r), (m.get(key(r)) ?? 0) + val(r)));
  return [...m].map(([name, value]) => ({ name, value }));
}
/** Currency groups accumulate integer centavos, including negative refunds. */
export function groupMoney<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): Point[] {
  return groupSum(rows, key, (row) => Math.round(val(row) * 100)).map(({ name, value }) => ({ name, value: value / 100 }));
}
export const byValueDesc = (a: Point, b: Point) => b.value - a.value;

/** % change from `previous` to `current`; null when there is nothing to compare against. */
export const delta = (
  current: number | null,
  previous: number | null,
) =>
  current === null || previous === null || !previous
    ? null
    : ((current - previous) / previous) * 100;

export function orderMetrics(orders: OrderView[]) {
  const live = orders.filter((o) => o.status !== "CANCELLED"); // cancelled orders never count as sales
  const revenue = live.some((o) => o.total === null)
    ? null
    : sumMoney(live, (o) => o.total ?? 0);
  const outstanding = live.some((o) => o.balance === null)
    ? null
    : sumMoney(live, (o) => o.balance ?? 0);
  const overdueOrders = live.filter((o) => o.payStatus === "OVERDUE");
  const overdue = live.some((o) => o.balance === null)
    ? null
    : sumMoney(overdueOrders, (o) => o.balance ?? 0);
  return {
    live, count: live.length, cancelled: orders.length - live.length, revenue,
    paid: sumMoney(live, (o) => o.paid), outstanding, overdue,
    aov: revenue === null ? null : live.length ? revenue / live.length : 0,
  };
}

export function deliveryMetrics(stops: StopView[]) {
  const valid = stops.filter((s) => s.delivery.status !== "cancelled");
  const deliveries = [...new Map(valid.map((s) => [s.delivery.id, s.delivery])).values()]; // a delivery counts once however many stops it has
  const delivered = valid.filter((s) => s.status === "delivered").length;
  const failed = valid.filter((s) => s.status === "failed").length;

  const lastStopAt = new Map<number, number>();
  valid.forEach((s) => { if (s.deliveredAt) lastStopAt.set(s.delivery.id, Math.max(lastStopAt.get(s.delivery.id) ?? 0, s.deliveredAt)); });
  const mins = deliveries.flatMap((d) => {
    const lastStop = lastStopAt.get(d.id);
    return d.status === "completed" && lastStop !== undefined
      ? [(lastStop - d.departureAt) / 6e4]
      : [];
  });

  return {
    deliveries, delivered, failed,
    rate: delivered + failed ? (failed / (delivered + failed)) * 100 : 0,
    avgMin: mins.length ? sumBy(mins, (x) => x) / mins.length : 0,
    cost: sumBy(deliveries.filter((d) => d.costStatus === "approved"), (d) => d.cost),
  };
}

export function agingBuckets(orders: OrderView[], now: number): Point[] {
  const b: Record<string, number> = { "Not yet due": 0, "1–30 days": 0, "31–60 days": 0, "61–90 days": 0, "90+ days": 0, "No due date": 0 };
  orders.filter((o) => o.status !== "CANCELLED").forEach((o) => {
    if (o.balance === null || o.balance <= 0) return;
    const d = o.dueAt === null ? null : Math.ceil((now - o.dueAt) / DAY);
    b[d === null ? "No due date" : d <= 0 ? "Not yet due" : d <= 30 ? "1–30 days" : d <= 60 ? "31–60 days" : d <= 90 ? "61–90 days" : "90+ days"] += Math.round(o.balance * 100);
  });
  return Object.entries(b).map(([name, value]) => ({ name, value: value / 100 }));
}

export function trend(rows: { at: number; v: number }[], grain: Grain): Point[] {
  const key = (t: number) => {
    const d = manilaDay(t);
    if (grain === "day") return d;
    if (grain === "month") return d.slice(0, 7);
    const x = new Date(d + "T00:00:00Z"); // week buckets start on Monday
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x.toISOString().slice(0, 10);
  };
  return groupMoney(rows, (r) => key(r.at), (r) => r.v).sort((a, b) => a.name.localeCompare(b.name));
}

export const toOrderRow = (o: OrderView): OrderRow => ({
  salesChannel: o.salesChannel,
  id: o.id, number: o.number, at: o.at, customerId: o.customerId, customer: o.customer, warehouse: o.warehouse, itemCount: o.items.length,
  total: o.total, paid: o.paid, balance: o.balance, arrangement: o.arrangement, dueAt: o.dueAt, payStatus: o.payStatus, status: o.status,
});
