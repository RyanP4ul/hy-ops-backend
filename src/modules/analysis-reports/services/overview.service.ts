import type { Filters, OverviewResponse } from "../reports.contract";
import { GRAINS } from "../reports.contract";
import { deliveryMetrics, delta, groupSum, orderMetrics, sumMoney, sumBy, toOrderRow, trend } from "../domain/metrics";
import { ordersFor, paymentsFor, stopsFor } from "./datasets";

export async function getOverview(f: Filters, now = Date.now()): Promise<OverviewResponse> {
  const [orders, prevOrders, pays, prevPays, stops, prevStops] = await Promise.all([
    ordersFor(f, now), ordersFor(f, now, 1), paymentsFor(f, now), paymentsFor(f, now, 1), stopsFor(f, now), stopsFor(f, now, 1),
  ]);
  const m = orderMetrics(orders), pm = orderMetrics(prevOrders);
  const dm = deliveryMetrics(stops), pdm = deliveryMetrics(prevStops);
  const cash = sumMoney(pays, (p) => p.amount), prevCash = sumMoney(prevPays, (p) => p.amount);
  const revenueRows = m.live
    .filter((o) => o.total !== null)
    .map((o) => ({ at: o.at, v: o.total ?? 0 }));

  return {
    kpis: {
      revenue: m.revenue, revenueDelta: delta(m.revenue, pm.revenue),
      orders: m.count, ordersDelta: delta(m.count, pm.count),
      cash, cashDelta: delta(cash, prevCash),
      outstanding: m.outstanding,
      delivered: dm.delivered, deliveredDelta: delta(dm.delivered, pdm.delivered),
      failureRate: dm.rate,
    },
    trend: Object.fromEntries(GRAINS.map((g) => [g, trend(revenueRows, g)])) as OverviewResponse["trend"],
    ordersByStatus: groupSum(orders, (o) => o.status, () => 1), // includes cancelled
    paymentStatus: groupSum(m.live, (o) => o.payStatus, () => 1),
    recentOrders: orders.slice(0, 5).map(toOrderRow),
  };
}
