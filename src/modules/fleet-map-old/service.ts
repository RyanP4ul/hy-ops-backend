import { db } from "@/db/index";
import { deliveries, deliveries_stops } from "@/db/schema/deliveries";
import { inventory } from "@/db/schema/inventory";
import { order_items, orders } from "@/db/schema/order";
import { product_variants } from "@/db/schema/products";
import { customers, drivers, users } from "@/db/schema/users";
import { vehicles } from "@/db/schema/vehicles";
import { count, eq, ilike, and, sql } from "drizzle-orm";

export abstract class FleetMapService {
  static async getOrders(order_id: number) {
    const rows = await db
      .select({
        order_id: orders.id,
        customer_id: orders.customer_id,
        payment_arrangement: orders.payment_arrangement,
        notes: orders.notes,
      })
      .from(orders)
      .where(eq(orders.id, order_id));

    const new_rows = rows.map(async (row) => {
      const [customer] = await db
        .select({
          id: customers.id,
          name: users.name,
          phone: customers.phone_number,
        })
        .from(customers)
        .leftJoin(users, eq(customers.user_id, users.id))
        .where(eq(customers.id, row.customer_id));

      const order_item_query = await db
        .select({
          id: order_items.id,
          name: product_variants.name,
          quantity: order_items.quantity,
          total: sql<number | null>`case
            when ${order_items.unit_price_snapshot} is null then null
            else ${order_items.unit_price_snapshot} * ${order_items.quantity}
          end`,
        })
        .from(order_items)
        .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
        .leftJoin(
          product_variants,
          eq(inventory.product_variant_id, product_variants.id),
        )
        .where(eq(order_items.order_id, row.order_id));
      return {
        ...row,
        customer,
        order_items: order_item_query,
      };
    });

    return Promise.all(new_rows);
  }
  static async getFleetMap() {
    const rows = await db
      .select({
        vehicle_id: vehicles.id,
        driver_name: users.name,
        plate_number: vehicles.plate_number,
        type: vehicles.type,
      })
      .from(deliveries)
      .leftJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
      .leftJoin(drivers, eq(deliveries.driver_id, drivers.id))
      .leftJoin(users, eq(drivers.user_id, users.id));

    const new_rows = rows.map(async (row, index) => {
      const stops = await db
        .select({
          stop_id: deliveries_stops.id,
          status: deliveries_stops.status,
          leg_index: deliveries_stops.leg_index,
        })
        .from(deliveries_stops)
        .where(eq(deliveries_stops.delivery_id, row.vehicle_id || -1));

      const new_stops = stops.map(async (stop) => {
        const orders = await this.getOrders(stop.stop_id || -1);

        return {
          ...stop,
          orders,
        };
      });

      return {
        ...row,
        stops: await Promise.all(new_stops),
      };
    });

    return Promise.all(new_rows);
  }
}
