import type { Filters, SalesResponse } from "../reports.contract";
import { byValueDesc, delta, groupMoney, orderMetrics, sumBy, toOrderRow } from "../domain/metrics";
import { ordersFor } from "./datasets";

export async function getSales(f: Filters, now = Date.now()): Promise<SalesResponse> {
  const [orders, prevOrders] = await Promise.all([ordersFor(f, now), ordersFor(f, now, 1)]);
  const m = orderMetrics(orders), pm = orderMetrics(prevOrders);
  const lines = m.live
    .flatMap((o) => o.items);
  const verifiedOrders = m.live.filter((o) => o.total !== null);
  const pricedLines = verifiedOrders.flatMap((o) => o.items);

  return {
    kpis: { revenue: m.revenue, revenueDelta: delta(m.revenue, pm.revenue), orders: m.count, cancelled: m.cancelled, aov: m.aov, units: sumBy(lines, (i) => i.qty) },
    byProduct: groupMoney(pricedLines, (i) => i.product, (i) => i.line ?? 0).sort(byValueDesc),
    byWarehouse: groupMoney(verifiedOrders, (o) => o.warehouse, (o) => o.total ?? 0),
    byCustomer: groupMoney(verifiedOrders, (o) => o.customer, (o) => o.total ?? 0).sort(byValueDesc),
    orders: orders.map(toOrderRow),
  };
}
