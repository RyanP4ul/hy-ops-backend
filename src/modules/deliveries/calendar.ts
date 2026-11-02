import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { customer_returns, deliveries, deliveries_stops, orders, users, vehicles, warehouses } from "../../db/schema";

/** Project real runs directly: rescheduling/cancellation never leaves copied calendar events behind. */
export async function getDeliveryCalendar(warehouseId?: number) {
  const runs = await db.select({ id: deliveries.id, version: deliveries.version, date: deliveries.scheduled_date,
    start_time: deliveries.departure_time, status: deliveries.status, driver: users.name,
    vehicle: vehicles.plate_number, warehouse: warehouses.name, warehouseId: warehouses.id })
    .from(deliveries).innerJoin(users, eq(users.id, deliveries.driver_id))
    .innerJoin(vehicles, eq(vehicles.id, deliveries.vehicle_id)).innerJoin(warehouses, eq(warehouses.id, vehicles.warehouse_id))
    .where(warehouseId === undefined ? undefined : eq(vehicles.warehouse_id, warehouseId))
    .orderBy(asc(deliveries.scheduled_date), asc(deliveries.departure_time), asc(deliveries.id));
  if (!runs.length) return [];
  const ids = runs.map(run => run.id);
  const stops = await db.select({ deliveryId: deliveries_stops.delivery_id, id: orders.id, orderNumber: orders.order_number,
    recipient: orders.shipping_recipient, address: orders.shipping_address, status: deliveries_stops.status })
    .from(deliveries_stops).innerJoin(orders, eq(orders.id, deliveries_stops.order_id))
    .where(inArray(deliveries_stops.delivery_id, ids)).orderBy(asc(deliveries_stops.delivery_id), asc(deliveries_stops.leg_index), asc(deliveries_stops.id));
  const pickups = await db.select({ deliveryId: customer_returns.assigned_delivery_id }).from(customer_returns)
    .where(and(inArray(customer_returns.assigned_delivery_id, ids), inArray(customer_returns.status, ["assigned", "collected", "received"])));
  return runs.map(run => ({ ...run, orders: stops.filter(stop => stop.deliveryId === run.id).map(({ deliveryId: _, ...order }) => order),
    pickupCount: pickups.filter(pickup => pickup.deliveryId === run.id).length }));
}
