import { db } from "@/db/index";
import {
  deliveries,
  deliveries_event,
  deliveries_orders,
} from "@/db/schema/deliveries";
import { DeliveryCreateType, DeliveryEventType } from "./modal";
import { OrderService } from "../order/service";
import { orders } from "@/db/schema/order";
import { count, eq, ilike, and } from "drizzle-orm";
import { users } from "@/db/schema/users";
import { vehicles } from "@/db/schema/vehicles";

export abstract class DeliveryService {
  static async getDelivery(
    page: number = 1,
    limit: number = 10,
    search: string = "",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;
    const whereQuery = ilike(users.name, `%${search}%`);

    const [total_count] = await db
      .select({ count: count() })
      .from(deliveries)
      .leftJoin(users, eq(deliveries.driver_id, users.id))
      .where(whereQuery);

    const result = await db
      .select({
        delivery_id: deliveries.id,
        driver_name: users.name,
        vehicle_plate_number: vehicles.plate_number,
        vehicle_type: vehicles.type,
        delivery_type: deliveries.delivery_type,
        scheduled_date: deliveries.scheduled_date,
        departure_time: deliveries.departure_time,
        status: deliveries.status,
        version: deliveries.version,
      })
      .from(deliveries)
      .leftJoin(users, eq(deliveries.driver_id, users.id))
      .leftJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
      .leftJoin(
        deliveries_orders,
        eq(deliveries.id, deliveries_orders.delivery_id),
      )
      .where(whereQuery)
      .offset(offset)
      .limit(limit);

    const rows = result.map(async (row) => {
      const delivery_order = await db
        .select({
          order_id: orders.id,
          order_number: orders.order_number,
          status: deliveries_orders.status,
        })
        .from(deliveries_orders)
        .leftJoin(orders, eq(deliveries_orders.order_id, orders.id))
        .where(eq(deliveries_orders.delivery_id, row.delivery_id));

      return {
        ...row,
        orders: delivery_order,
      };
    });

    return {
      rows: await Promise.all(rows),
      total: total_count.count,
    };
  }

  static async createDelivery(data: DeliveryCreateType) {
    return await db.transaction(async (tx) => {
      const [delivery] = await tx
        .insert(deliveries)
        .values({
          driver_id: data.driver_id,
          vehicle_id: data.vehicle_id,
          scheduled_date: data.scheduled_date,
          departure_time: data.scheduled_time,
          delivery_type: data.delivery_type,
          status: "scheduled",
        })
        .returning({
          id: deliveries.id,
        });

      if (!delivery) {
        throw new Error("Failed to create delivery.");
      }

      for (const order_id of data.order_ids) {
        const order = await OrderService.getOrderById(order_id);

        if (!order) {
          throw new Error(
            `Order with ID ${order_id} does not exist. Delivery creation aborted.`,
          );
        }

        await tx
          .update(orders)
          .set({ status: "SCHEDULED" })
          .where(eq(orders.id, order_id));

        await tx.insert(deliveries_orders).values({
          delivery_id: delivery.id,
          order_id: order_id,
          status: "pending",
        });
      }

      return {
        message: `Delivery created successfully with ID: ${delivery.id}`,
      };
    });
  }

  static async eventDelivery(data: DeliveryEventType) {
    return await db.transaction(async (tx) => {
      const [delivery] = await db
        .select({
          version: deliveries.version,
        })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.id, data.delivery_id),
            eq(deliveries.status, "scheduled"),
            eq(deliveries.version, data.delivery_version),
          ),
        );

      if (!delivery) {
        throw new Error(
          `Delivery with ID ${data.delivery_id} does not exist or is not in a valid state for this event.`,
        );
      }

      await tx.insert(deliveries_event).values({
        delivery_id: data.delivery_id,
        event_type: data.event_type,
        reason: data.reason,
      });

      if (data.event_type === "CANCELLED") {
        await tx
          .update(deliveries)
          .set({
            status: "cancelled",
            version: delivery.version + 1,
          })
          .where(
            and(
              eq(deliveries.id, data.delivery_id),
              eq(deliveries.status, "scheduled"),
              eq(deliveries.version, data.delivery_version),
            ),
          );

        // NOTIFY ALL CUSTOMERS THAT THEIR DELIVERY HAS BEEN CANCELLED
        // USING SMS

        return {
          message: `Delivery with ID ${data.delivery_id} has been cancelled successfully.`,
        };
      } else if (data.event_type === "RESCHEDULED") {
        await tx
          .update(deliveries)
          .set({
            status: "scheduled",
            scheduled_date: data.scheduled_date,
            departure_time: data.departure_time,
            version: delivery.version + 1,
          })
          .where(
            and(
              eq(deliveries.id, data.delivery_id),
              eq(deliveries.status, "scheduled"),
              eq(deliveries.version, data.delivery_version),
            ),
          );

        return {
          message: `Delivery with ID ${data.delivery_id} has been rescheduled successfully.`,
        };
      }
    });
  }
}
