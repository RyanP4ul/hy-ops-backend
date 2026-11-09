// Loads the rows each report is built from. One function per date basis, each returning rows that already
// satisfy every active filter. `back = 1` loads the equal-length period before (for "vs previous period").
import { inArray, or } from "drizzle-orm";
import type { Filters } from "../reports.contract";
import type {
  EventView,
  InventoryView,
  OrderView,
  PaymentView,
  StopView,
} from "../domain/types";
import { orderMatches, rangeOf } from "../domain/filters";
import { findOrderViews, orderWhere } from "../repositories/orders.repository";
import { findCashMovements } from "../repositories/payments.repository";
import {
  deliveryWhere,
  findDeliveries,
  findEvents,
  findStops,
  stopOrderIds,
  findExternalDeliveries,
} from "../repositories/deliveries.repository";
import { findInventory } from "../repositories/inventory.repository";
import { orders } from "@/db/schema";

/** Order basis: orders created in the period. */
export async function ordersFor(
  f: Filters,
  now: number,
  back = 0,
): Promise<OrderView[]> {
  const rows = await findOrderViews(
    orderWhere(f, { range: rangeOf(f, now, back) }),
    now,
  );
  return rows.filter((o) => orderMatches(o, f));
}

/** Cash basis: payments by received_at. The order behind each payment must pass the order filters (its own date is irrelevant). */
export async function paymentsFor(
  f: Filters,
  now: number,
  back = 0,
): Promise<PaymentView[]> {
  const rows = await findCashMovements(f, rangeOf(f, now, back));
  const ids = [...new Set(rows.map((row) => row.orderId))];
  const orderRows = ids.length ? await findOrderViews(orderWhere(f, { extra: inArray(orders.id, ids) }), now) : [];
  const byId = new Map(
    orderRows.filter((o) => orderMatches(o, f)).map((o) => [o.id, o]),
  );
  return rows.flatMap((p) => {
    const order = byId.get(p.orderId);
    return order
      ? [
          {
            id: p.id,
            kind: p.kind,
            number: p.number,
            method: p.method,
            amount: p.amount,
            at: p.at,
            order,
          },
        ]
      : [];
  });
}

/** Delivery basis: stops by the delivery's scheduled_date. */
export async function stopsFor(
  f: Filters,
  now: number,
  back = 0,
): Promise<StopView[]> {
  const where = deliveryWhere(f, { range: rangeOf(f, now, back) });
  const external = await findExternalDeliveries(f, rangeOf(f, now, back));
  const [stops, deliveries, orderRows] = await Promise.all([
    findStops(where),
    findDeliveries(where),
    findOrderViews(
      orderWhere(f, { extra: or(inArray(orders.id, stopOrderIds(where)), external.length ? inArray(orders.id, external.map(row => row.orderId)) : undefined) }),
      now,
    ),
  ]);
  const deliveryById = new Map(deliveries.map((d) => [d.id, d]));
  const orderById = new Map(
    orderRows.filter((o) => orderMatches(o, f, false)).map((o) => [o.id, o]),
  );
  const fleetStops: StopView[] = stops.flatMap((s) => {
    const delivery = deliveryById.get(s.deliveryId);
    const order = orderById.get(s.orderId);
    return delivery && order
      ? [
          {
            id: s.id,
            status: s.status,
            deliveredAt: s.deliveredAt,
            delivery,
            order,
          },
        ]
      : [];
  });
  return [...fleetStops, ...external.flatMap(row => {
    const order = orderById.get(row.orderId);
    return order ? [{ id: row.view.id, status: row.completedAt ? "delivered" as const : "pending" as const, deliveredAt: row.completedAt, delivery: row.view, order }] : [];
  })];
}

export async function eventsFor(f: Filters, now: number): Promise<EventView[]> {
  const where = deliveryWhere(f, { range: rangeOf(f, now), warehouses: true });
  const [events, deliveries] = await Promise.all([
    findEvents(where),
    findDeliveries(where),
  ]);
  const deliveryById = new Map(deliveries.map((d) => [d.id, d]));
  return events.flatMap((e) => {
    const delivery = deliveryById.get(e.deliveryId);
    return delivery
      ? [{ id: e.id, type: e.type, reason: e.reason, at: e.at, delivery }]
      : [];
  });
}

export const inventoryFor = (f: Filters): Promise<InventoryView[]> =>
  findInventory(f);
