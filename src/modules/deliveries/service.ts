import { CustomerReturnService } from "./customer-returns";
import { queueDeliveryNotifications, queueDeliveryEventNotifications } from "./notification-queue";
import { customer_returns } from "../../db/schema/customer-returns";
import { driver_stop_outcomes } from "../../db/schema/driver-outcomes";
import { assertDeliveryScope } from "./scope";
import { WorkflowError } from "../../utils/workflow-error";
import { stockTransaction } from "../inventory/transaction";
import { coordinates } from "../../utils/coordinates";
import { changeOrderStock } from "../order/stock";
import { db } from "@/db/index";
import {
  deliveries,
  deliveries_event,
  deliveries_expenses,
  deliveries_proof,
  deliveries_stops,
} from "@/db/schema/deliveries";
import {
  DeliveryAssignmentType,
  DeliveryCreateType,
  DeliveryEventType,
} from "./modal";
import { OrderService } from "../order/service";
import { orders } from "@/db/schema/order";
import { count, eq, ilike, and, sql, inArray } from "drizzle-orm";
import {
  customer_addresses,
  customers,
  drivers,
  users,
} from "@/db/schema/users";
import { vehicles } from "@/db/schema/vehicles";
import { inventory } from "@/db/schema/inventory";
import { stock_movements } from "../../db/schema/stock-movement";
import { order_items } from "@/db/schema/order";
import { warehouses } from "@/db/schema/warehouses";
import {
  isScheduledTripOverdue,
  nowEpochSeconds,
  toManilaIso,
  todayInManila,
} from "../../utils/time";

function schedulingConflict(error: unknown): never {
  const detail = error as { code?: string; cause?: { code?: string } };
  if (detail?.code === "23505" || detail?.cause?.code === "23505") {
    throw new WorkflowError(
      "This driver already has a delivery recorded at that departure time. Choose another time or driver.",
      409,
    );
  }
  throw error;
}

export abstract class DeliveryService {
  static async getDeliveryTableRowById(id: number) {
    const result = await this.getDelivery(0, 1, "", undefined, id);
    return result.rows.find((row) => row.delivery_id === id) ?? null;
  }

  static async getDelivery(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    status?:
      | "scheduled"
      | "in_transit"
      | "returning"
      | "completed"
      | "cancelled",
    deliveryId?: number,
    overdue = false,
    active = false,
    warehouseId?: number,
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;
    const whereQuery = and(
      warehouseId === undefined
        ? undefined
        : sql`exists (select 1 from vehicles scoped_vehicle where scoped_vehicle.id = ${deliveries.vehicle_id} and scoped_vehicle.warehouse_id = ${warehouseId})`,
      ilike(users.name, `%${search}%`),
      status ? eq(deliveries.status, status) : undefined,
      active
        ? inArray(deliveries.status, ["scheduled", "in_transit", "returning"])
        : undefined,
      deliveryId ? eq(deliveries.id, deliveryId) : undefined,
      overdue
        ? and(
            eq(deliveries.status, "scheduled"),
            sql`(${deliveries.scheduled_date} + ${deliveries.departure_time}) AT TIME ZONE 'Asia/Manila' < now()`,
          )
        : undefined,
    );

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
        vehicle_id: vehicles.id,
        delivery_type: deliveries.delivery_type,
        scheduled_date: deliveries.scheduled_date,
        departure_time: deliveries.departure_time,
        status: deliveries.status,
        version: deliveries.version,
      })
      .from(deliveries)
      .leftJoin(users, eq(deliveries.driver_id, users.id))
      .leftJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
      .where(whereQuery)
      .offset(offset)
      .limit(limit);

    const rows = result.map(async (row) => {
      const delivery_stop = await db
        .select({
          stop_id: deliveries_stops.id,
          return_id: customer_returns.id,
          return_status: customer_returns.status,
          order_id: orders.id,
          order_number: orders.order_number,
          status: deliveries_stops.status,
          failure_reason: driver_stop_outcomes.reason,
          shipping_address: orders.shipping_address,
          customer_address: orders.shipping_address,
        })
        .from(deliveries_stops)
        .leftJoin(orders, eq(deliveries_stops.order_id, orders.id))
        .leftJoin(
          driver_stop_outcomes,
          eq(driver_stop_outcomes.stop_id, deliveries_stops.id),
        )
        .leftJoin(
          customer_returns,
          eq(customer_returns.source_stop_id, deliveries_stops.id),
        )
        .where(eq(deliveries_stops.delivery_id, row.delivery_id));

      const [warehouse] = await db
        .select({
          id: warehouses.id,
          name: warehouses.name,
          street_address: warehouses.street_address,
          city: warehouses.city,
          state: warehouses.state,
          zip_code: warehouses.zip_code,
        })
        .from(vehicles)
        .innerJoin(warehouses, eq(warehouses.id, vehicles.warehouse_id))
        .where(eq(vehicles.id, row.vehicle_id ?? -1))
        .limit(1);

      return {
        ...row,
        is_overdue:
          row.status === "scheduled" &&
          isScheduledTripOverdue(row.scheduled_date, row.departure_time),
        orders: delivery_stop,
        pickups: await CustomerReturnService.list(undefined, row.delivery_id),
        warehouse: warehouse ?? null,
      };
    });

    return {
      rows: await Promise.all(rows),
      total: total_count.count,
    };
  }

  static async createDelivery(data: DeliveryCreateType, warehouseId?: number) {
    return await db
      .transaction(async (tx) => {
        if (
          !data.order_ids.length ||
          new Set(data.order_ids).size !== data.order_ids.length
        )
          throw new WorkflowError("Select distinct orders for delivery.");
        const selectedOrders = new Map<number, typeof orders.$inferSelect>();
        for (const id of [...data.order_ids].sort((a, b) => a - b)) {
          const [order] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, id))
            .for("update");
          if (!order || order.status !== "SCHEDULING")
            throw new WorkflowError(
              "An order is no longer ready for scheduling. Refresh and try again.",
            );
          selectedOrders.set(id, order);
        }
        const [driverAccount] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, data.driver_id),
              eq(users.role, "driver"),
              eq(users.is_archived, false),
            ),
          );
        if (!driverAccount)
          throw new WorkflowError("Selected driver account is unavailable.");
        const [vehicle] = await tx
          .select({ id: vehicles.id, warehouse_id: vehicles.warehouse_id })
          .from(vehicles)
          .where(
            and(
              eq(vehicles.id, data.vehicle_id),
              eq(vehicles.status, "available"),
            ),
          )
          .for("update");
        if (!vehicle)
          throw new WorkflowError("Selected vehicle is unavailable.");
        const [driverProfile] = await tx
          .select()
          .from(drivers)
          .where(eq(drivers.user_id, data.driver_id))
          .for("update");
        if (!driverProfile || driverProfile.status !== "available")
          throw new WorkflowError("Selected driver is unavailable.");
        if (
          warehouseId !== undefined &&
          (vehicle.warehouse_id !== warehouseId ||
            [...selectedOrders.values()].some(
              (o) => o.warehouse_id !== warehouseId,
            ))
        )
          throw new WorkflowError(
            "Assign deliveries only within your warehouse.",
            403,
          );
        const warehouseIds = new Set(
          [...selectedOrders.values()].map((order) => order.warehouse_id),
        );
        if (
          warehouseIds.size !== 1 ||
          !warehouseIds.has(vehicle.warehouse_id) ||
          !warehouseIds.has(driverProfile.warehouse_id)
        ) {
          throw new WorkflowError(
            "Orders, driver and vehicle must belong to the same warehouse.",
          );
        }

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
          throw new WorkflowError("Failed to create delivery.");
        }

        const is_deliveries_expenses_created = await tx
          .insert(deliveries_expenses)
          .values({
            delivery_id: delivery.id,
            delivery_allowance: String(data.delivery_allowance),
            fuel: String(data.fuel),
            toll: String(data.toll),
            status: "pending",
          });

        if (!is_deliveries_expenses_created) {
          throw new WorkflowError("Failed to create delivery expenses.");
        }

        let leg_index = 0;

        for (const order_id of data.order_ids) {
          const order = selectedOrders.get(order_id);

          if (!order) {
            throw new WorkflowError(
              `Order with ID ${order_id} does not exist. Delivery creation aborted.`,
            );
          }

          await tx
            .update(orders)
            .set({
              status: "SCHEDULED",
              version: sql`${orders.version} + 1`,
              updated_at: new Date(),
            })
            .where(eq(orders.id, order_id));

          const destination = coordinates(
            order.shipping_latitude,
            order.shipping_longitude,
          );
          if (!destination)
            throw new WorkflowError(
              `Confirm destination coordinates for ${order.order_number} before scheduling.`,
            );

          await tx.insert(deliveries_stops).values({
            delivery_id: delivery.id,
            order_id: order_id,
            leg_index: leg_index,
            latitude: destination.latitude,
            longitude: destination.longitude,
            status: "pending",
          });

          leg_index++;
        }

        return {
          id: delivery.id,
          order_ids: data.order_ids,
          message: `Delivery created successfully with ID: ${delivery.id}`,
        };
      })
      .catch(schedulingConflict);
  }

  static async eventDelivery(data: DeliveryEventType, warehouseId?: number) {
    if (!data.reason.trim())
      throw new WorkflowError("A reason is required.", 400);
    if (data.event_type === "RESCHEDULED") {
      const instant =
        data.scheduled_date && data.departure_time
          ? Date.parse(toManilaIso(data.scheduled_date, data.departure_time))
          : NaN;
      if (!Number.isFinite(instant) || instant <= Date.now())
        throw new WorkflowError(
          "Choose a future departure date and time in Asia/Manila.",
          400,
        );
    }
    return await db
      .transaction(async (tx) => {
        const [delivery] = await tx
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
          )
          .for("update");

        if (!delivery) {
          throw new WorkflowError(
            `Delivery with ID ${data.delivery_id} does not exist or is not in a valid state for this event.`,
          );
        }

        await assertDeliveryScope(tx, data.delivery_id, warehouseId);
        const [event] = await tx.insert(deliveries_event).values({
          delivery_id: data.delivery_id,
          event_type: data.event_type,
          reason: data.reason,
        }).returning({ id: deliveries_event.id });

        if (data.event_type === "CANCELLED") {
          await tx
            .update(deliveries)
            .set({
              status: "cancelled",
              version: delivery.version + 1,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(deliveries.id, data.delivery_id),
                eq(deliveries.status, "scheduled"),
                eq(deliveries.version, data.delivery_version),
              ),
            );

          const stops = await tx
            .select({ orderId: deliveries_stops.order_id })
            .from(deliveries_stops)
            .where(eq(deliveries_stops.delivery_id, data.delivery_id));
          for (const orderId of stops
            .map((stop) => stop.orderId)
            .sort((a, b) => a - b)) {
            await tx
              .update(orders)
              .set({
                status: "SCHEDULING",
                version: sql`${orders.version} + 1`,
                updated_at: new Date(),
              })
              .where(
                and(eq(orders.id, orderId), eq(orders.status, "SCHEDULED")),
              );
          }

          await queueDeliveryEventNotifications(tx, data.delivery_id, {
            eventKey: `event:${event.id}`, eventType: "cancelled", reason: data.reason.trim(),
          });

          return {
            delivery_id: data.delivery_id,
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
              updated_at: new Date(),
            })
            .where(
              and(
                eq(deliveries.id, data.delivery_id),
                eq(deliveries.status, "scheduled"),
                eq(deliveries.version, data.delivery_version),
              ),
            );

          await queueDeliveryEventNotifications(tx, data.delivery_id, {
            eventKey: `event:${event.id}`, eventType: "rescheduled", reason: data.reason.trim(),
            scheduledAt: new Date(toManilaIso(data.scheduled_date!, data.departure_time!)),
          });

          return {
            delivery_id: data.delivery_id,
            message: `Delivery with ID ${data.delivery_id} has been rescheduled successfully.`,
          };
        }
      })
      .catch(schedulingConflict);
  }

  static async updateAssignment(
    deliveryId: number,
    data: DeliveryAssignmentType,
    warehouseId?: number,
  ) {
    return await db
      .transaction(async (tx) => {
        const [delivery] = await tx
          .select({
            version: deliveries.version,
          })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.id, deliveryId),
              eq(deliveries.status, "scheduled"),
              eq(deliveries.version, data.delivery_version),
            ),
          )
          .for("update");

        if (!delivery) {
          throw new WorkflowError(
            `Delivery with ID ${deliveryId} does not exist or is not scheduled.`,
          );
        }

        await assertDeliveryScope(tx, deliveryId, warehouseId);
        const [driver] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, data.driver_id),
              eq(users.role, "driver"),
              eq(users.is_archived, false),
            ),
          );
        if (!driver) throw new WorkflowError("Selected driver is unavailable.");

        const [vehicle] = await tx
          .select({ id: vehicles.id, warehouse_id: vehicles.warehouse_id })
          .from(vehicles)
          .where(
            and(
              eq(vehicles.id, data.vehicle_id),
              eq(vehicles.status, "available"),
            ),
          )
          .for("update");
        if (!vehicle)
          throw new WorkflowError("Selected vehicle does not exist.");
        const [driverProfile] = await tx
          .select()
          .from(drivers)
          .where(eq(drivers.user_id, data.driver_id))
          .for("update");
        if (!driverProfile || driverProfile.status !== "available")
          throw new WorkflowError("Selected driver is unavailable.");
        const assignedOrders = await tx
          .select({ warehouseId: orders.warehouse_id })
          .from(deliveries_stops)
          .innerJoin(orders, eq(orders.id, deliveries_stops.order_id))
          .where(eq(deliveries_stops.delivery_id, deliveryId));
        if (
          !assignedOrders.length ||
          assignedOrders.some((o) => o.warehouseId !== vehicle.warehouse_id) ||
          driverProfile.warehouse_id !== vehicle.warehouse_id ||
          (warehouseId !== undefined && vehicle.warehouse_id !== warehouseId)
        )
          throw new WorkflowError(
            "Orders, driver and vehicle must remain in the same authorized warehouse.",
            403,
          );

        await tx
          .update(deliveries)
          .set({
            driver_id: data.driver_id,
            vehicle_id: data.vehicle_id,
            version: delivery.version + 1,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(deliveries.id, deliveryId),
              eq(deliveries.status, "scheduled"),
              eq(deliveries.version, data.delivery_version),
            ),
          );

        return {
          delivery_id: deliveryId,
          message: `Driver and vehicle for delivery with ID ${deliveryId} have been changed successfully.`,
        };
      })
      .catch(schedulingConflict);
  }

  static async getTotalActiveDeliveries() {
    const [total] = await db
      .select({ count: count() })
      .from(deliveries)
      .where(
        inArray(deliveries.status, ["scheduled", "in_transit", "returning"]),
      );
    return total?.count ?? 0;
  }

  static async dispatchDelivery(
    deliveryId: number,
    warehouseId?: number,
    driverStart?: { driverId: number; version: number },
  ) {
    await stockTransaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, deliveryId))
        .for("update");
      if (!delivery) throw new WorkflowError("Delivery not found");
      await assertDeliveryScope(tx, deliveryId, warehouseId);
      if (driverStart && delivery.driver_id !== driverStart.driverId)
        throw new WorkflowError("Assignment not found.", 404);
      if (delivery.status === "in_transit") return; // already dispatched
      if (delivery.status !== "scheduled") {
        throw new WorkflowError(
          `A ${delivery.status} delivery cannot be dispatched`,
        );
      }
      if (driverStart) {
        const now = new Date();
        if (delivery.version !== driverStart.version)
          throw new WorkflowError(
            "Assignment changed. Refresh the trip before starting.",
          );
        if (
          delivery.scheduled_date !== todayInManila(now) ||
          Date.parse(
            toManilaIso(delivery.scheduled_date, delivery.departure_time),
          ) > now.getTime()
        ) {
          throw new WorkflowError(
            "Start this trip on its scheduled Manila date, at or after departure time.",
          );
        }
      }
      if (
        !driverStart &&
        isScheduledTripOverdue(delivery.scheduled_date, delivery.departure_time)
      ) {
        throw new WorkflowError(
          "Delivery schedule has passed. Reschedule it before dispatching.",
        );
      }

      const [vehicle] = await tx
        .select()
        .from(vehicles)
        .where(eq(vehicles.id, delivery.vehicle_id))
        .for("update");
      if (!vehicle || vehicle.status !== "available") {
        throw new WorkflowError("Vehicle is not available");
      }

      const [driver] = await tx
        .select()
        .from(drivers)
        .where(eq(drivers.user_id, delivery.driver_id))
        .for("update");
      if (!driver) throw new WorkflowError("Driver profile not found.");
      const [driverAccount] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.id, delivery.driver_id), eq(users.is_archived, false)),
        );
      if (!driverAccount)
        throw new WorkflowError("Driver account is inactive.");
      if (driver.status !== "available") {
        throw new WorkflowError(
          `Driver is ${driver.status.replaceAll("_", " ")}`,
        );
      }

      const stops = await tx
        .select({ orderId: deliveries_stops.order_id })
        .from(deliveries_stops)
        .where(eq(deliveries_stops.delivery_id, deliveryId));
      if (stops.length === 0) throw new WorkflowError("Delivery has no stops");

      for (const orderId of [
        ...new Set(stops.map((stop) => stop.orderId)),
      ].sort((a, b) => a - b)) {
        const [order] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .for("update");
        if (!order || order.status !== "SCHEDULED")
          throw new WorkflowError(
            "Every delivery order must still be scheduled.",
          );
        if (!order.stock_reserved)
          throw new WorkflowError(
            "Legacy stock reservations must be reconciled by an administrator before dispatch.",
          );
        await changeOrderStock(tx, orderId, order.warehouse_id, "consume");
      }

      await tx
        .update(deliveries)
        .set({
          status: "in_transit",
          version: sql`${deliveries.version} + 1`,
          updated_at: new Date(),
        })
        .where(eq(deliveries.id, deliveryId));

      await tx
        .update(vehicles)
        .set({
          status: "on_delivery",
          version: sql`${vehicles.version} + 1`,
          updated_at: nowEpochSeconds(),
        })
        .where(eq(vehicles.id, vehicle.id));

      if (driver) {
        await tx
          .update(drivers)
          .set({ status: "on_delivery" })
          .where(eq(drivers.id, driver.id));
      }

      await tx
        .update(orders)
        .set({
          status: "IN_TRANSIT",
          version: sql`${orders.version} + 1`,
          updated_at: new Date(),
        })
        .where(
          inArray(
            orders.id,
            stops.map((s) => s.orderId),
          ),
        );
    });

    return { ok: true as const };
  }

  static async markStopDelivered(stopId: number, warehouseId?: number) {
    console.log(`Marking stop ${stopId} as delivered.`);
    await db.transaction(async (tx) => {
      const [identity] = await tx
        .select({ deliveryId: deliveries_stops.delivery_id })
        .from(deliveries_stops)
        .where(eq(deliveries_stops.id, stopId));
      if (!identity) throw new WorkflowError("Stop not found");
      // Serialize every stop and trip transition on the delivery before locking a stop.
      const [delivery] = await tx
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, identity.deliveryId))
        .for("update");
      const [stop] = await tx
        .select()
        .from(deliveries_stops)
        .where(eq(deliveries_stops.id, stopId))
        .for("update");
      if (!stop) throw new WorkflowError("Stop not found");
      await assertDeliveryScope(tx, identity.deliveryId, warehouseId);
      if (stop.status === "failed")
        throw new WorkflowError(
          "A failed stop cannot be marked delivered. Schedule a new attempt after return.",
        );
      if (stop.status === "delivered") return;
      if (!delivery || delivery.status !== "in_transit")
        throw new WorkflowError("Delivery is not in transit");

      const now = new Date();
      await tx
        .update(deliveries_stops)
        .set({ status: "delivered", delivered_at: now, updated_at: now })
        .where(eq(deliveries_stops.id, stopId));

      await tx
        .update(orders)
        .set({
          status: "COMPLETED",
          version: sql`${orders.version} + 1`,
          updated_at: now,
        })
        .where(eq(orders.id, stop.order_id));

      await queueDeliveryNotifications(tx, stopId, stop.order_id);

      const [pending] = await tx
        .select({ total: count() })
        .from(deliveries_stops)
        .where(
          and(
            eq(deliveries_stops.delivery_id, delivery.id),
            eq(deliveries_stops.status, "pending"),
          ),
        );

      const [pickups] = await tx
        .select({ total: count() })
        .from(customer_returns)
        .where(
          and(
            eq(customer_returns.assigned_delivery_id, delivery.id),
            eq(customer_returns.status, "assigned"),
          ),
        );
      await tx
        .update(deliveries)
        .set({
          status:
            (pending?.total ?? 0) + pickups.total === 0
              ? "returning"
              : "in_transit",
          version: sql`${deliveries.version} + 1`,
          updated_at: now,
        })
        .where(eq(deliveries.id, delivery.id));
    });

    return { ok: true as const };
  }

  static async completeDelivery(
    deliveryId: number,
    warehouseId?: number,
    actorId?: number,
  ) {
    await stockTransaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, deliveryId))
        .for("update");
      if (!delivery) throw new WorkflowError("Delivery not found");
      await assertDeliveryScope(tx, deliveryId, warehouseId);
      if (delivery.status === "completed") return; // idempotent
      if (delivery.status !== "returning") {
        throw new WorkflowError("Delivery is not returning to the warehouse");
      }

      const [pendingPickups] = await tx
        .select({ total: count() })
        .from(customer_returns)
        .where(
          and(
            eq(customer_returns.assigned_delivery_id, deliveryId),
            eq(customer_returns.status, "assigned"),
          ),
        );
      if (pendingPickups.total > 0)
        throw new WorkflowError(
          "Collect assigned customer returns before confirming warehouse receipt.",
        );
      await tx
        .update(customer_returns)
        .set({
          status: "received",
          received_at: new Date(),
          received_by: actorId ?? null,
          version: sql`${customer_returns.version} + 1`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(customer_returns.assigned_delivery_id, deliveryId),
            eq(customer_returns.status, "collected"),
          ),
        );
      // Customer returns are received for inspection; never automatically restock them.
      // Staff completion confirms every failed order was physically returned in full.
      const failedStops = await tx
        .select({ orderId: deliveries_stops.order_id })
        .from(deliveries_stops)
        .where(
          and(
            eq(deliveries_stops.delivery_id, deliveryId),
            eq(deliveries_stops.status, "failed"),
          ),
        )
        .orderBy(deliveries_stops.order_id);
      for (const { orderId } of failedStops) {
        const [order] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .for("update");
        if (!order || order.status !== "IN_TRANSIT")
          throw new WorkflowError(
            "Review failed order stock before confirming the warehouse return.",
          );
        const items = await tx
          .select()
          .from(order_items)
          .where(eq(order_items.order_id, orderId))
          .orderBy(order_items.inventory_id);
        for (const item of items) {
          const [stock] = await tx
            .select()
            .from(inventory)
            .where(eq(inventory.id, item.inventory_id))
            .for("update");
          if (!stock || stock.warehouse_id !== order.warehouse_id)
            throw new WorkflowError("Returned stock warehouse mismatch.");
          await tx
            .update(inventory)
            .set({
              quantity: stock.quantity + item.quantity,
              version: sql`${inventory.version} + 1`,
              updated_at: nowEpochSeconds(),
            })
            .where(eq(inventory.id, stock.id));
          await tx.insert(stock_movements).values({
            inventory_id: stock.id,
            order_id: orderId,
            kind: "delivery_return",
            quantity_delta: item.quantity,
            reserved_delta: 0,
            quantity_after: stock.quantity + item.quantity,
            reserved_after: stock.reserved,
            reason: `Failed delivery ${deliveryId}: staff confirmed full physical return`,
          });
        }
        await changeOrderStock(tx, orderId, order.warehouse_id, "reserve");
        await tx
          .update(orders)
          .set({
            status: "SCHEDULING",
            version: sql`${orders.version} + 1`,
            updated_at: new Date(),
          })
          .where(eq(orders.id, orderId));
      }
      await tx
        .update(deliveries)
        .set({
          status: "completed",
          version: sql`${deliveries.version} + 1`,
          updated_at: new Date(),
        })
        .where(eq(deliveries.id, deliveryId));

      await tx
        .update(vehicles)
        .set({
          status: "available",
          version: sql`${vehicles.version} + 1`,
          updated_at: nowEpochSeconds(),
        })
        .where(eq(vehicles.id, delivery.vehicle_id));

      await tx
        .update(drivers)
        .set({ status: "available" })
        .where(eq(drivers.user_id, delivery.driver_id));
    });

    return { ok: true as const };
  }

  static async createDeliveryProof(
    delivery_id: number,
    storage_key: string,
    warehouseId?: number,
  ) {
    await db.transaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, delivery_id))
        .for("update");

      if (!delivery) throw new WorkflowError("Delivery not found");
      await assertDeliveryScope(tx, delivery_id, warehouseId);

      await tx
        .update(deliveries_proof)
        .set({
          delivery_id: delivery_id,
          storage_key: storage_key,
        })
        .where(eq(deliveries.id, delivery_id));
    });
  }
}
