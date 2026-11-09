import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  deliveries,
  deliveries_event,
  deliveries_expenses,
  deliveries_stops,
  users,
  vehicles,
  delivery_orders,
  orders,
} from "@/db/schema";
import type {
  DeliveryStatus,
  DeliveryType,
  ExpenseStatus,
  Filters,
  StopStatus,
} from "../reports.contract";
import type { DeliveryView, Range } from "../domain/types";
import { rangeDays } from "../domain/filters";
import { db } from "@/db/index";
import { deliveryMatches } from "../domain/filters";
import { manilaDay } from "../../../utils/time";

/** External bookings are report projections only; negative IDs cannot collide with fleet runs. */
export async function findExternalDeliveries(f?: Filters, range?: Range, orderIds?: () => SQLWrapper) {
  const rows = await db.select({ booking: delivery_orders, warehouseId: orders.warehouse_id }).from(delivery_orders)
    .innerJoin(orders, eq(orders.id, delivery_orders.order_id)).where(and(
      eq(delivery_orders.environment, "production"),
      inArray(delivery_orders.booking_state, ["CONFIRMED", "REVIEW", "UNKNOWN"]),
      orderIds ? inArray(orders.id, orderIds()) : undefined,
      range ? and(gte(delivery_orders.created_at, Math.floor(range.start / 1000)), lt(delivery_orders.created_at, Math.floor(range.end / 1000))) : undefined,
      f?.warehouses.length ? inArray(orders.warehouse_id, f.warehouses.map(Number)) : undefined,
    )).orderBy(desc(delivery_orders.id));
  return rows.filter(row => row.booking.lalamove_order_id).map(({ booking: b, warehouseId }) => {
    const view: DeliveryView = { id: -b.id, date: manilaDay(b.created_at * 1000), departureAt: b.picked_up_at?.getTime() ?? b.created_at * 1000,
      type: "LALAMOVE", status: b.completed_at ? "completed" : b.picked_up_at ? "in_transit" : ["CANCELED", "REJECTED", "EXPIRED"].includes(b.status) ? "cancelled" : "scheduled",
      vehicle: "Lalamove (external)", driver: (b.driver_details as { name?: string } | null)?.name ?? "Lalamove courier", warehouseId,
      cost: b.currency === "PHP" && b.delivery_fee !== null ? Number(b.delivery_fee) : 0, costStatus: b.completed_at ? "approved" : "pending" };
    return { orderId: b.order_id!, completedAt: b.completed_at?.getTime() ?? null, view };
  }).filter(row => !f || deliveryMatches(row.view, f));
}

/**
 * WHERE for the deliveries table (joined with vehicles).
 * `range` filters on scheduled_date; `warehouses` filters on the vehicle's warehouse (used for events, which have no order to carry it).
 */
export function deliveryWhere(
  f: Filters,
  opts: { range?: Range; warehouses?: boolean } = {},
): SQL | undefined {
  const c: (SQL | undefined)[] = [];
  if (opts.range) {
    const { from, to } = rangeDays(opts.range);
    c.push(
      gte(deliveries.scheduled_date, from),
      lt(deliveries.scheduled_date, to),
    );
  }
  if (f.deliveryStatuses.length)
    c.push(inArray(deliveries.status, f.deliveryStatuses as DeliveryStatus[]));
  if (f.deliveryTypes.length)
    c.push(
      inArray(deliveries.delivery_type, f.deliveryTypes as DeliveryType[]),
    );
  if (f.vehicles.length) c.push(inArray(vehicles.plate_number, f.vehicles));
  if (opts.warehouses && f.warehouses.length)
    c.push(inArray(vehicles.warehouse_id, f.warehouses.map(Number)));
  return and(...c);
}

/** Deliveries with vehicle, driver name and total expense. `where` may reference deliveries and vehicles columns. */
export async function findDeliveries(
  where: SQL | undefined,
): Promise<DeliveryView[]> {
  const ids = () =>
    db
      .select({ id: deliveries.id })
      .from(deliveries)
      .innerJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
      .where(where);

  const [rows, expenses] = await Promise.all([
    db
      .select({
        id: deliveries.id,
        date: deliveries.scheduled_date,
        time: deliveries.departure_time,
        type: deliveries.delivery_type,
        status: deliveries.status,
        vehicle: vehicles.plate_number,
        warehouseId: vehicles.warehouse_id,
        driver: users.name,
      })
      .from(deliveries)
      .innerJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
      .innerJoin(users, eq(deliveries.driver_id, users.id)) // deliveries.driver_id references users.id in your schema
      .where(where),
    db
      .select({
        deliveryId: deliveries_expenses.delivery_id,
        allowance: deliveries_expenses.delivery_allowance,
        fuel: deliveries_expenses.fuel,
        toll: deliveries_expenses.toll,
        status: deliveries_expenses.status,
      })
      .from(deliveries_expenses)
      .where(inArray(deliveries_expenses.delivery_id, ids()))
      .orderBy(deliveries_expenses.id),
  ]);

  const expenseByDelivery = new Map(expenses.map((e) => [e.deliveryId, e])); // if a delivery has several expense rows, the newest wins
  return rows.map((d) => {
    const e = expenseByDelivery.get(d.id);
    return {
      id: d.id,
      date: d.date,
      departureAt: new Date(`${d.date}T${d.time}+08:00`).getTime(),
      type: d.type,
      status: d.status,
      vehicle: d.vehicle,
      driver: d.driver,
      warehouseId: d.warehouseId,
      cost: e ? Number(e.allowance) + Number(e.fuel) + Number(e.toll) : 0,
      costStatus: (e?.status ?? null) as ExpenseStatus | null,
    };
  });
}

export interface StopRow {
  id: number;
  status: StopStatus;
  deliveredAt: number | null;
  deliveryId: number;
  orderId: number;
}

export async function findStops(where: SQL | undefined): Promise<StopRow[]> {
  const rows = await db
    .select({
      id: deliveries_stops.id,
      status: deliveries_stops.status,
      deliveredAt: deliveries_stops.delivered_at,
      deliveryId: deliveries_stops.delivery_id,
      orderId: deliveries_stops.order_id,
    })
    .from(deliveries_stops)
    .innerJoin(deliveries, eq(deliveries_stops.delivery_id, deliveries.id))
    .innerJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
    .where(where)
    .orderBy(deliveries_stops.id);
  return rows.map((r) => ({
    ...r,
    deliveredAt: r.deliveredAt?.getTime() ?? null,
  }));
}

/** Sub-query of the order ids that have a stop on deliveries matching `where`. */
export const stopOrderIds = (where: SQL | undefined) =>
  db
    .select({ id: deliveries_stops.order_id })
    .from(deliveries_stops)
    .innerJoin(deliveries, eq(deliveries_stops.delivery_id, deliveries.id))
    .innerJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
    .where(where);

export interface EventRow {
  id: number;
  type: string;
  reason: string | null;
  at: number;
  deliveryId: number;
}

export async function findEvents(where: SQL | undefined): Promise<EventRow[]> {
  const rows = await db
    .select({
      id: deliveries_event.id,
      type: deliveries_event.event_type,
      reason: deliveries_event.reason,
      at: deliveries_event.created_at,
      deliveryId: deliveries_event.delivery_id,
    })
    .from(deliveries_event)
    .innerJoin(deliveries, eq(deliveries_event.delivery_id, deliveries.id))
    .innerJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
    .where(where)
    .orderBy(desc(deliveries_event.created_at));
  return rows.map((r) => ({ ...r, at: r.at.getTime() }));
}

/**
 * For each order, its most recent delivery (the stop with the highest id).
 * `orderIds` returns a sub-query of order ids, so no big id list is sent to Postgres.
 */
export async function findLatestDeliveryByOrder(
  orderIds: () => SQLWrapper,
): Promise<Map<number, DeliveryView>> {
  const [latest, views] = await Promise.all([
    db
      .selectDistinctOn([deliveries_stops.order_id], {
        orderId: deliveries_stops.order_id,
        deliveryId: deliveries_stops.delivery_id,
      })
      .from(deliveries_stops)
      .where(inArray(deliveries_stops.order_id, orderIds()))
      .orderBy(deliveries_stops.order_id, desc(deliveries_stops.id)),
    findDeliveries(
      inArray(
        deliveries.id,
        db
          .select({ id: deliveries_stops.delivery_id })
          .from(deliveries_stops)
          .where(inArray(deliveries_stops.order_id, orderIds())),
      ),
    ),
  ]);
  const byId = new Map(views.map((d) => [d.id, d]));
  const out = new Map<number, DeliveryView>();
  for (const l of latest) {
    const d = byId.get(l.deliveryId);
    if (d) out.set(l.orderId, d);
  }
  for (const row of await findExternalDeliveries(undefined, undefined, orderIds)) {
    // Query is newest-first. A sales order has one fulfillment summary even after rebooking.
    if (!out.has(row.orderId) || out.get(row.orderId)!.type !== "LALAMOVE") out.set(row.orderId, row.view);
  }
  return out;
}
