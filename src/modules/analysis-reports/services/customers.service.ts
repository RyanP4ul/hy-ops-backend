import type { CustomerRow, CustomersResponse, Filters, OrderRow } from "../reports.contract";
import { orderMetrics, sumMoney, toOrderRow } from "../domain/metrics";
import type { OrderView } from "../domain/types";
import { ordersFor } from "./datasets";

/** One row per customer from live (non-cancelled) orders, biggest sales first. Orders must be newest-first. */
export function buildCustomerRows(live: OrderView[]): CustomerRow[] {
  const byCustomer = new Map<number, OrderView[]>();
  live.forEach((o) => byCustomer.set(o.customerId, [...(byCustomer.get(o.customerId) ?? []), o]));
  return [...byCustomer]
    .map(([id, r]) => ({
      id,
      name: r[0].customer,
      orders: r.length,
      sales: r.some((o) => o.total === null)
        ? null
        : sumMoney(r, (o) => o.total ?? 0),
      paid: sumMoney(r, (o) => o.paid),
      balance: r.some((o) => o.balance === null)
        ? null
        : sumMoney(r, (o) => o.balance ?? 0),
      lastOrderAt: r[0].at,
    }))
    .sort((a, b) => (b.sales ?? -1) - (a.sales ?? -1));
}

export async function getCustomers(f: Filters, now = Date.now()): Promise<CustomersResponse> {
  const m = orderMetrics(await ordersFor(f, now));
  const rows = buildCustomerRows(m.live);
  return { kpis: { customers: rows.length, repeat: rows.filter((c) => c.orders > 1).length, aov: m.aov, outstanding: m.outstanding }, rows };
}

/** Drill-down: one customer's live orders for the current period and filters. */
export async function getCustomerOrders(f: Filters, customerId: number, now = Date.now()): Promise<OrderRow[]> {
  const m = orderMetrics(await ordersFor(f, now));
  return m.live.filter((o) => o.customerId === customerId).map(toOrderRow);
}
