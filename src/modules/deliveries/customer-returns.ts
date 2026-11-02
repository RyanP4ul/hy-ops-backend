import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  customer_returns,
  customers,
  deliveries,
  deliveries_stops,
  drivers,
  orders,
  users,
  vehicles,
  order_items,
  inventory,
  products,
  product_variants,
} from "../../db/schema";
import { WorkflowError } from "../../utils/workflow-error";
import { todayInManila, nowEpochSeconds } from "../../utils/time";
import { haversineDistanceKm } from "../../utils/coordination";
import { positionSource } from "../fleet-map/source";
import { staffWarehouse, type AssignmentActor } from "./scope";

function coordinates(
  latitude: string | null,
  longitude: string | null,
): [number, number] | null {
  if (latitude === null || longitude === null) return null;
  const lat = Number(latitude),
    lng = Number(longitude);
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
    ? [lng, lat]
    : null;
}

export class CustomerReturnService {
  static async list(
    actor?: AssignmentActor,
    deliveryId?: number,
    connection: Pick<typeof db, "select"> = db,
  ) {
    const warehouse = actor ? await staffWarehouse(actor) : undefined;
    const rows = await connection
      .select({ task: customer_returns, orderNumber: orders.order_number })
      .from(customer_returns)
      .innerJoin(orders, eq(orders.id, customer_returns.order_id))
      .where(
        and(
          warehouse === undefined
            ? undefined
            : eq(customer_returns.warehouse_id, warehouse),
          deliveryId === undefined
            ? ne(customer_returns.status, "received")
            : eq(customer_returns.assigned_delivery_id, deliveryId),
        ),
      )
      .orderBy(asc(customer_returns.created_at), asc(customer_returns.id));
    const items = rows.length
      ? await connection
          .select({
            orderId: order_items.order_id,
            qty: order_items.quantity,
            name: products.name,
            variant: product_variants.name,
          })
          .from(order_items)
          .innerJoin(inventory, eq(inventory.id, order_items.inventory_id))
          .innerJoin(products, eq(products.id, inventory.product_id))
          .innerJoin(
            product_variants,
            eq(product_variants.id, inventory.product_variant_id),
          )
          .where(
            inArray(
              order_items.order_id,
              rows.map((row) => row.task.order_id),
            ),
          )
      : [];
    return rows.map(({ task, orderNumber }) => ({
      id: task.id,
      orderId: task.order_id,
      orderNumber,
      sourceStopId: task.source_stop_id,
      items: items
        .filter((item) => item.orderId === task.order_id)
        .map((item) => ({
          name: `${item.name} - ${item.variant}`,
          qty: item.qty,
        })),
      warehouseId: task.warehouse_id,
      status: task.status,
      version: task.version,
      reason: task.reason,
      customer: task.recipient,
      address: task.address,
      phone: task.phone,
      coordinates: coordinates(task.latitude, task.longitude),
      deliveryId: task.assigned_delivery_id,
      collectedAt: task.collected_at,
      receivedAt: task.received_at,
      createdAt: task.created_at,
    }));
  }

  static async request(
    actor: AssignmentActor,
    stopId: number,
    input: { reason: string; operationKey: string },
  ) {
    const warehouse = await staffWarehouse(actor),
      reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new WorkflowError("Enter a reason of up to 500 characters.", 400);
    return db
      .transaction(async (tx) => {
        const [identity] = await tx
          .select()
          .from(deliveries_stops)
          .where(eq(deliveries_stops.id, stopId));
        if (!identity)
          throw new WorkflowError("Delivered stop not found.", 404);
        await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, identity.delivery_id))
          .for("update");
        const [order] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, identity.order_id))
          .for("update");
        if (
          !order ||
          (warehouse !== undefined && order.warehouse_id !== warehouse)
        )
          throw new WorkflowError("Order not found in your warehouse.", 404);
        const [stop] = await tx
          .select()
          .from(deliveries_stops)
          .where(eq(deliveries_stops.id, stopId));
        if (stop.status !== "delivered" || order.status !== "COMPLETED") {
          console.log(
            `Stop status: ${stop.status}, order status: ${order.status}`,
          );
          throw new WorkflowError(
            "Only goods already delivered to the customer can be flagged for retrieval.",
          );
        }
        const [existing] = await tx
          .select()
          .from(customer_returns)
          .where(eq(customer_returns.order_id, order.id));
        if (existing) return { id: existing.id, status: existing.status };
        const [customer] = await tx
          .select({ name: users.name })
          .from(customers)
          .innerJoin(users, eq(users.id, customers.user_id))
          .where(eq(customers.id, order.customer_id));
        const [task] = await tx
          .insert(customer_returns)
          .values({
            order_id: order.id,
            source_stop_id: stopId,
            warehouse_id: order.warehouse_id,
            requested_by: Number(actor.sub),
            request_key: input.operationKey,
            reason,
            address: order.shipping_address ?? "Address unavailable",
            recipient: order.shipping_recipient ?? customer.name,
            phone: order.shipping_phone,
            latitude: stop.latitude,
            longitude: stop.longitude,
          })
          .returning();
        return { id: task.id, status: task.status };
      })
      .catch(conflict);
  }

  static async candidates(actor: AssignmentActor, id: number) {
    const warehouse = await staffWarehouse(actor);
    const [task] = await db
      .select()
      .from(customer_returns)
      .where(
        and(
          eq(customer_returns.id, id),
          warehouse === undefined
            ? undefined
            : eq(customer_returns.warehouse_id, warehouse),
        ),
      );
    if (!task) throw new WorkflowError("Return pickup not found.", 404);
    const fleet = await db
      .select()
      .from(vehicles)
      .where(
        and(
          eq(vehicles.warehouse_id, task.warehouse_id),
          inArray(vehicles.status, ["available", "on_delivery"]),
        ),
      );
    const active = await db
      .select({ run: deliveries, driverName: users.name })
      .from(deliveries)
      .innerJoin(users, eq(users.id, deliveries.driver_id))
      .where(inArray(deliveries.status, ["in_transit", "returning"]));
    const availableDrivers = await db
      .select({ id: users.id, name: users.name })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.user_id))
      .where(
        and(
          eq(drivers.warehouse_id, task.warehouse_id),
          eq(drivers.status, "available"),
          eq(users.role, "driver"),
          eq(users.is_archived, false),
        ),
      );
    const fixes = new Map(
      (await positionSource.latest()).map((fix) => [fix.vehicleId, fix]),
    );
    const target = coordinates(task.latitude, task.longitude);
    const choices = fleet
      .flatMap((vehicle) => {
        const run = active.find((row) => row.run.vehicle_id === vehicle.id);
        if ((vehicle.status === "on_delivery") !== Boolean(run)) return [];
        const fix = fixes.get(vehicle.id),
          age = fix ? Date.now() - fix.recordedAt.getTime() : Infinity;
        const distanceKm =
          target &&
          fix &&
          age >= -30000 &&
          age <= 120000 &&
          coordinates(String(fix.latitude), String(fix.longitude))
            ? haversineDistanceKm(
                { lat: fix.latitude, lng: fix.longitude },
                { lat: target[1], lng: target[0] },
              )
            : null;
        return [
          {
            id: vehicle.id,
            plate: vehicle.plate_number,
            status: vehicle.status,
            driverId: run?.run.driver_id ?? null,
            driverName: run?.driverName ?? null,
            distanceKm,
            recordedAt: fix?.recordedAt ?? null,
          },
        ];
      })
      .sort(
        (a, b) =>
          (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
          a.id - b.id,
      );
    return { vehicles: choices, drivers: availableDrivers };
  }

  static async assign(
    actor: AssignmentActor,
    id: number,
    input: {
      version: number;
      vehicleId: number;
      driverId: number;
      operationKey: string;
    },
  ) {
    const warehouse = await staffWarehouse(actor);
    const [hint] = await db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.vehicle_id, input.vehicleId),
          inArray(deliveries.status, ["in_transit", "returning"]),
        ),
      );
    return db
      .transaction(async (tx) => {
        if (hint)
          await tx
            .select()
            .from(deliveries)
            .where(eq(deliveries.id, hint.id))
            .for("update");
        const [vehicle] = await tx
          .select()
          .from(vehicles)
          .where(eq(vehicles.id, input.vehicleId))
          .for("update");
        const [driver] = await tx
          .select()
          .from(drivers)
          .where(eq(drivers.user_id, input.driverId))
          .for("update");
        const [task] = await tx
          .select()
          .from(customer_returns)
          .where(eq(customer_returns.id, id))
          .for("update");
        if (
          !task ||
          (warehouse !== undefined && task.warehouse_id !== warehouse)
        )
          throw new WorkflowError("Return pickup not found.", 404);
        if (
          !vehicle ||
          !driver ||
          vehicle.warehouse_id !== task.warehouse_id ||
          driver.warehouse_id !== task.warehouse_id
        )
          throw new WorkflowError(
            "Choose a vehicle and driver from the order's warehouse.",
            403,
          );
        const [account] = await tx
          .select()
          .from(users)
          .where(
            and(
              eq(users.id, input.driverId),
              eq(users.role, "driver"),
              eq(users.is_archived, false),
            ),
          );
        if (!account) throw new WorkflowError("Driver is unavailable.");
        const [active] = await tx
          .select()
          .from(deliveries)
          .where(
            and(
              eq(deliveries.vehicle_id, vehicle.id),
              inArray(deliveries.status, ["in_transit", "returning"]),
            ),
          );
        if (active?.id !== hint?.id)
          throw new WorkflowError(
            "Vehicle assignment changed. Refresh before assigning.",
          );
        if (
          task.status === "assigned" &&
          task.assignment_key === input.operationKey &&
          task.assigned_by === Number(actor.sub) &&
          task.assigned_delivery_id === active?.id &&
          active.driver_id === input.driverId
        )
          return { ok: true, deliveryId: active.id };
        if (task.status !== "requested" || task.version !== input.version)
          throw new WorkflowError(
            "Pickup changed or is already assigned. Refresh before continuing.",
          );
        if (
          active &&
          (active.driver_id !== input.driverId ||
            vehicle.status !== "on_delivery" ||
            driver.status !== "on_delivery")
        )
          throw new WorkflowError(
            "Use the active vehicle's currently assigned driver.",
          );
        if (
          !active &&
          (vehicle.status !== "available" || driver.status !== "available")
        )
          throw new WorkflowError("Vehicle or driver is busy.");
        const [otherRun] = await tx
          .select()
          .from(deliveries)
          .where(
            and(
              eq(deliveries.driver_id, input.driverId),
              inArray(deliveries.status, ["in_transit", "returning"]),
            ),
          );
        if (otherRun && otherRun.id !== active?.id)
          throw new WorkflowError(
            "Driver is assigned to another active vehicle.",
          );
        const now = new Date();
        let deliveryId = active?.id;
        if (!deliveryId) {
          const [created] = await tx
            .insert(deliveries)
            .values({
              driver_id: input.driverId,
              vehicle_id: vehicle.id,
              status: "in_transit",
              delivery_type: "INTERNAL",
              scheduled_date: todayInManila(now),
              departure_time: new Date(now.getTime() + 8 * 3600000)
                .toISOString()
                .slice(11, 23),
            })
            .returning();
          deliveryId = created.id;
        } else
          await tx
            .update(deliveries)
            .set({
              status: "in_transit",
              version: sql`${deliveries.version} + 1`,
              updated_at: now,
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
        await tx
          .update(drivers)
          .set({ status: "on_delivery" })
          .where(eq(drivers.id, driver.id));
        await tx
          .update(customer_returns)
          .set({
            status: "assigned",
            assigned_delivery_id: deliveryId,
            assignment_key: input.operationKey,
            assigned_by: Number(actor.sub),
            version: task.version + 1,
            updated_at: now,
          })
          .where(eq(customer_returns.id, id));
        return { ok: true, deliveryId };
      })
      .catch(conflict);
  }

  static async collect(
    actorId: number,
    id: number,
    input: { version: number; operationKey: string },
  ) {
    const [hint] = await db
      .select()
      .from(customer_returns)
      .where(eq(customer_returns.id, id));
    const assignedDeliveryId = hint?.assigned_delivery_id;
    if (!assignedDeliveryId)
      throw new WorkflowError("Assigned return pickup not found.", 404);
    return db
      .transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, assignedDeliveryId))
          .for("update");
        const [task] = await tx
          .select()
          .from(customer_returns)
          .where(eq(customer_returns.id, id))
          .for("update");
        if (
          !run ||
          run.driver_id !== actorId ||
          task.assigned_delivery_id !== run.id
        )
          throw new WorkflowError("Assigned return pickup not found.", 404);
        if (
          ["collected", "received"].includes(task.status) &&
          task.collection_key === input.operationKey &&
          task.collected_by === actorId
        )
          return { ok: true, deliveryId: run.id };
        if (
          task.status !== "assigned" ||
          task.version !== input.version ||
          !["in_transit", "returning"].includes(run.status)
        )
          throw new WorkflowError(
            "Pickup changed. Refresh before confirming collection.",
          );
        const now = new Date();
        await tx
          .update(customer_returns)
          .set({
            status: "collected",
            collected_by: actorId,
            collection_key: input.operationKey,
            collected_at: now,
            version: task.version + 1,
            updated_at: now,
          })
          .where(eq(customer_returns.id, id));
        const [stops] = await tx
          .select({ total: count() })
          .from(deliveries_stops)
          .where(
            and(
              eq(deliveries_stops.delivery_id, run.id),
              eq(deliveries_stops.status, "pending"),
            ),
          );
        const [pickups] = await tx
          .select({ total: count() })
          .from(customer_returns)
          .where(
            and(
              eq(customer_returns.assigned_delivery_id, run.id),
              eq(customer_returns.status, "assigned"),
            ),
          );
        await tx
          .update(deliveries)
          .set({
            status:
              stops.total + pickups.total === 0 ? "returning" : "in_transit",
            version: run.version + 1,
            updated_at: now,
          })
          .where(eq(deliveries.id, run.id));
        return { ok: true, deliveryId: run.id };
      })
      .catch(conflict);
  }
}

function conflict(error: unknown): never {
  const detail = error as { code?: string; cause?: { code?: string } };
  if (detail.code === "23505" || detail.cause?.code === "23505")
    throw new WorkflowError(
      "This pickup operation was already recorded. Refresh before retrying.",
    );
  throw error;
}
