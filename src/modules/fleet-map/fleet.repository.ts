import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
  customers,
  deliveries,
  deliveries_stops,
  inventory,
  order_items,
  orders,
  payments,
  product_variants,
  products,
  users,
  vehicles,
  warehouses,
} from "../../db/schema";
import { db } from "@/db/index";

/**
 * Read side of the fleet map. Everything is fetched set-based (one query per table
 * group, joined by `inArray`) so the cost does not grow with the number of trips.
 */

export function listWarehouses() {
  return db
    .select()
    .from(warehouses)
    .where(eq(warehouses.is_archived, false))
    .orderBy(asc(warehouses.id));
}

export function listVehicles() {
  return db.select().from(vehicles).orderBy(asc(vehicles.id));
}

/**
 * Trips the map cares about: everything upcoming or running, plus trips that finished
 * today (so a vehicle that just got back still shows its completed route).
 */
export function listRelevantDeliveries(today: string) {
  return db
    .select({ delivery: deliveries, driverName: users.name })
    .from(deliveries)
    .innerJoin(users, eq(users.id, deliveries.driver_id))
    .where(
      or(
        inArray(deliveries.status, ["scheduled", "in_transit", "returning"]),
        and(
          eq(deliveries.status, "completed"),
          eq(deliveries.scheduled_date, today),
        ),
      ),
    )
    .orderBy(asc(deliveries.scheduled_date), asc(deliveries.departure_time));
}

export async function listStops(deliveryIds: number[]) {
  if (deliveryIds.length === 0) return [];
  return db
    .select({
      stop: deliveries_stops,
      order: orders,
      customer: customers,
      customerUserName: users.name,
    })
    .from(deliveries_stops)
    .innerJoin(orders, eq(orders.id, deliveries_stops.order_id))
    .innerJoin(customers, eq(customers.id, orders.customer_id))
    .innerJoin(users, eq(users.id, customers.user_id))
    .where(inArray(deliveries_stops.delivery_id, deliveryIds))
    .orderBy(
      asc(deliveries_stops.delivery_id),
      asc(deliveries_stops.leg_index),
      asc(deliveries_stops.id),
    );
}

export async function listOrderItems(orderIds: number[]) {
  if (orderIds.length === 0) return [];
  return db
    .select({
      id: order_items.id,
      orderId: order_items.order_id,
      quantity: order_items.quantity,
      price: order_items.unit_price_snapshot,
      productName: products.name,
      variantName: product_variants.name,
    })
    .from(order_items)
    .innerJoin(inventory, eq(inventory.id, order_items.inventory_id))
    .innerJoin(
      product_variants,
      eq(product_variants.id, inventory.product_variant_id),
    )
    .innerJoin(products, eq(products.id, inventory.product_id))
    .where(inArray(order_items.order_id, orderIds))
    .orderBy(asc(order_items.id));
}

export async function listPayments(orderIds: number[]) {
  if (orderIds.length === 0) return [];
  return db
    .select({
      orderId: payments.order_id,
      method: payments.payment_method,
      status: payments.payment_status,
      amount: payments.amount,
    })
    .from(payments)
    .where(inArray(payments.order_id, orderIds))
    .orderBy(desc(payments.received_at), desc(payments.id));
}

export type DeliveryRow = Awaited<
  ReturnType<typeof listRelevantDeliveries>
>[number];
export type StopRow = Awaited<ReturnType<typeof listStops>>[number];
export type OrderItemRow = Awaited<ReturnType<typeof listOrderItems>>[number];
export type PaymentRow = Awaited<ReturnType<typeof listPayments>>[number];
export type VehicleRow = Awaited<ReturnType<typeof listVehicles>>[number];
export type WarehouseRow = Awaited<ReturnType<typeof listWarehouses>>[number];
