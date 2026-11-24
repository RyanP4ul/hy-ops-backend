import { stockTransaction } from "../inventory/transaction";
import { commandHash, replayReceipt, saveReceipt } from "../driver/sync-receipts";
import { activeUser, activeVehicle, activeWarehouse } from "../lifecycle/availability";
import { and, asc, count, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  customer_returns,
  customer_return_disposition_items,
  customers,
  warehouses,
  deliveries,
  deliveries_stops,
  driver_return_proofs,
  drivers,
  orders,
  users,
  vehicles,
  order_items,
  inventory,
  products,
  product_variants,
  stock_movements,
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
  private static async hydrateRows(
    rows: { task: typeof customer_returns.$inferSelect; orderNumber: string }[],
    connection: Pick<typeof db, "select"> = db,
  ) {
    const [items, proofCounts] = rows.length
      ? await Promise.all([
          connection
            .select({
              orderId: order_items.order_id,
              inventoryId: order_items.inventory_id,
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
            ),
          connection
            .select({
              returnId: driver_return_proofs.return_id,
              total: count(),
            })
            .from(driver_return_proofs)
            .where(
              inArray(
                driver_return_proofs.return_id,
                rows.map((row) => row.task.id),
              ),
            )
            .groupBy(driver_return_proofs.return_id),
        ])
      : [[], []];
    const itemsByOrder = new Map<
      number,
      { inventoryId: number; name: string; qty: number }[]
    >();
    for (const item of items) {
      const list = itemsByOrder.get(item.orderId) ?? [];
      list.push({
        inventoryId: item.inventoryId,
        name: `${item.name} - ${item.variant}`,
        qty: item.qty,
      });
      itemsByOrder.set(item.orderId, list);
    }
    const proofsByReturn = new Map(proofCounts.map((p) => [p.returnId, Number(p.total)]));
    return rows.map(({ task, orderNumber }) => ({
      id: task.id,
      orderId: task.order_id,
      orderNumber,
      sourceStopId: task.source_stop_id,
      items: itemsByOrder.get(task.order_id) ?? [],
      proofCount: proofsByReturn.get(task.id) ?? 0,
      warehouseId: task.warehouse_id,
      status: task.status,
      version: task.version,
      reason: task.reason,
      failureReason: task.failure_reason,
      failedAt: task.failed_at,
      cancellationReason: task.cancellation_reason,
      cancelledAt: task.cancelled_at,
      disposition: task.disposition,
      dispositionNotes: task.disposition_notes,
      dispositionAt: task.disposition_at,
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

  static async list(
    actor?: AssignmentActor,
    deliveryId?: number,
    connection: Pick<typeof db, "select"> = db,
    includeReceived = false,
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
            ? notInArray(
                customer_returns.status,
                includeReceived ? ["cancelled"] : ["received", "cancelled"],
              )
            : eq(customer_returns.assigned_delivery_id, deliveryId),
        ),
      )
      .orderBy(asc(customer_returns.created_at), asc(customer_returns.id));
    return this.hydrateRows(rows, connection);
  }

  static async listByDeliveryIds(
    deliveryIds: number[],
    connection: Pick<typeof db, "select"> = db,
  ) {
    const grouped = new Map<number, Awaited<ReturnType<typeof CustomerReturnService.list>>>();
    if (!deliveryIds.length) return grouped;
    const rows = await connection
      .select({ task: customer_returns, orderNumber: orders.order_number })
      .from(customer_returns)
      .innerJoin(orders, eq(orders.id, customer_returns.order_id))
      .where(inArray(customer_returns.assigned_delivery_id, deliveryIds))
      .orderBy(asc(customer_returns.created_at), asc(customer_returns.id));
    const hydrated = await this.hydrateRows(rows, connection);
    for (const item of hydrated) {
      if (item.deliveryId === null) continue;
      const bucket = grouped.get(item.deliveryId) ?? [];
      bucket.push(item);
      grouped.set(item.deliveryId, bucket);
    }
    return grouped;
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
    return stockTransaction(async (tx) => {
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
        if (existing && existing.status !== "cancelled")
          return { id: existing.id, status: existing.status };
        const [home] = await tx.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.id, order.warehouse_id), activeWarehouse())).for("share");
        if (!home) throw new WorkflowError("Activate the receiving warehouse before requesting a return pickup.");

        if (existing && existing.status === "cancelled") {
          const [reopened] = await tx
            .update(customer_returns)
            .set({
              status: "requested",
              reason,
              request_key: input.operationKey,
              requested_by: Number(actor.sub),
              cancellation_reason: null,
              cancelled_by: null,
              cancelled_at: null,
              failure_reason: null,
              failed_by: null,
              failed_at: null,
              failure_key: null,
              version: existing.version + 1,
              updated_at: new Date(),
            })
            .where(eq(customer_returns.id, existing.id))
            .returning();
          return { id: reopened.id, status: reopened.status };
        }

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
          activeVehicle(),
          eq(vehicles.warehouse_id, task.warehouse_id),
          inArray(vehicles.status, ["available", "on_delivery"]),
        ),
      );
    const active = await db
      .select({ run: deliveries, driverName: users.name })
      .from(deliveries)
      .innerJoin(users, eq(users.id, deliveries.driver_id))
      .where(
        and(
          inArray(deliveries.status, ["in_transit", "returning"]),
          eq(users.role, "driver"),
          activeUser(),
        ),
      );
    const availableDrivers = await db
      .select({ id: users.id, name: users.name })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.user_id))
      .where(
        and(
          or(
            eq(drivers.warehouse_id, task.warehouse_id),
            eq(drivers.allow_multi_warehouse, true),
          ),
          eq(drivers.status, "available"),
          eq(users.role, "driver"),
          activeUser(),
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
    return stockTransaction(async (tx) => {
        if (hint)
          await tx
            .select()
            .from(deliveries)
            .where(eq(deliveries.id, hint.id))
            .for("update");
        const [vehicle] = await tx
          .select()
          .from(vehicles)
          .where(and(eq(vehicles.id, input.vehicleId), activeVehicle()))
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
          (driver.warehouse_id !== task.warehouse_id &&
            !driver.allow_multi_warehouse)
        )
          throw new WorkflowError(
            "Choose a vehicle from the order's warehouse and a driver assigned to it (or with multi-warehouse enabled).",
            403,
          );
        const [account] = await tx
          .select()
          .from(users)
          .where(
            and(
              eq(users.id, input.driverId),
              eq(users.role, "driver"),
              activeUser(),
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
    input: { version: number; operationKey: string; tripVersion?: number },
  ) {
    const hash = commandHash("collected", id, { version: input.version, tripVersion: input.tripVersion });
    const [hint] = await db
      .select()
      .from(customer_returns)
      .where(eq(customer_returns.id, id));
    const assignedDeliveryId = hint?.assigned_delivery_id;
    if (!assignedDeliveryId)
      throw new WorkflowError("Assigned return pickup not found.", 404);
    return stockTransaction(async (tx) => {
        const receipt = await replayReceipt(tx, actorId, input.operationKey, hash);
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
        if (receipt) return receipt;
        if (
          ["collected", "received"].includes(task.status) &&
          task.collection_key === input.operationKey &&
          task.collected_by === actorId
        )
          return { ok: true, deliveryId: run.id };
        if (
          task.status !== "assigned" ||
          task.version !== input.version ||
          (input.tripVersion !== undefined && run.version !== input.tripVersion) ||
          !["in_transit", "returning"].includes(run.status)
        )
          throw new WorkflowError(
            "Pickup changed. Refresh before confirming collection.",
          );
        const [proofTotal] = await tx
          .select({ total: count() })
          .from(driver_return_proofs)
          .where(eq(driver_return_proofs.return_id, id));
        if (Number(proofTotal?.total ?? 0) < 1) {
          throw new WorkflowError(
            "Upload a photo or signature proof of collection before confirming pickup.",
            409,
          );
        }
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
        return saveReceipt(tx, actorId, input.operationKey, hash, {
          ok: true, deliveryId: run.id, entityId: id, kind: "collected",
          previousTripVersion: run.version, tripVersion: run.version + 1,
        });
      })
      .catch(conflict);
  }

  static async fail(
    actorId: number,
    id: number,
    input: {
      version: number;
      operationKey: string;
      reason: string;
      tripVersion?: number;
    },
  ) {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new WorkflowError("Enter a failure reason of up to 500 characters.", 400);
    const hash = commandHash("return_failed", id, {
      version: input.version,
      reason,
      tripVersion: input.tripVersion,
    });
    const [hint] = await db
      .select()
      .from(customer_returns)
      .where(eq(customer_returns.id, id));
    const assignedDeliveryId = hint?.assigned_delivery_id;
    if (!assignedDeliveryId)
      throw new WorkflowError("Assigned return pickup not found.", 404);
    return stockTransaction(async (tx) => {
        const receipt = await replayReceipt(tx, actorId, input.operationKey, hash);
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
          !task ||
          run.driver_id !== actorId ||
          task.assigned_delivery_id !== run.id
        )
          throw new WorkflowError("Assigned return pickup not found.", 404);
        if (receipt) return receipt;
        if (
          task.status === "failed" &&
          task.failure_key === input.operationKey &&
          task.failed_by === actorId
        )
          return { ok: true, deliveryId: run.id };
        if (
          task.status !== "assigned" ||
          task.version !== input.version ||
          (input.tripVersion !== undefined && run.version !== input.tripVersion) ||
          !["in_transit", "returning"].includes(run.status)
        )
          throw new WorkflowError(
            "Pickup changed. Refresh before reporting failure.",
          );
        const now = new Date();
        await tx
          .update(customer_returns)
          .set({
            status: "failed",
            failure_reason: reason,
            failed_by: actorId,
            failed_at: now,
            failure_key: input.operationKey,
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
        return saveReceipt(tx, actorId, input.operationKey, hash, {
          ok: true,
          deliveryId: run.id,
          entityId: id,
          kind: "return_failed",
          previousTripVersion: run.version,
          tripVersion: run.version + 1,
        });
      })
      .catch(conflict);
  }

  static async unassign(
    actor: AssignmentActor,
    id: number,
    input: { version: number; reason?: string },
  ) {
    const warehouse = await staffWarehouse(actor);
    const [hint] = await db
      .select({ assignedDeliveryId: customer_returns.assigned_delivery_id })
      .from(customer_returns)
      .where(eq(customer_returns.id, id));
    return stockTransaction(async (tx) => {
      if (hint?.assignedDeliveryId) {
        await tx
          .select({ id: deliveries.id })
          .from(deliveries)
          .where(eq(deliveries.id, hint.assignedDeliveryId))
          .for("update");
      }
      const [task] = await tx
        .select()
        .from(customer_returns)
        .where(eq(customer_returns.id, id))
        .for("update");
      if (!task || (warehouse !== undefined && task.warehouse_id !== warehouse))
        throw new WorkflowError("Return pickup not found.", 404);
      if (task.assigned_delivery_id !== (hint?.assignedDeliveryId ?? null))
        throw new WorkflowError("Pickup assignment changed. Refresh and try again.");
      if (
        !["assigned", "failed"].includes(task.status) ||
        task.version !== input.version
      )
        throw new WorkflowError(
          "Only assigned or failed pickups matching the latest version can be unassigned.",
        );
      const previousDeliveryId = task.assigned_delivery_id;
      const now = new Date();
      await tx
        .update(customer_returns)
        .set({
          status: "requested",
          assigned_delivery_id: null,
          assignment_key: null,
          assigned_by: null,
          failure_reason: null,
          failed_by: null,
          failed_at: null,
          failure_key: null,
          version: task.version + 1,
          updated_at: now,
        })
        .where(eq(customer_returns.id, id));

      if (previousDeliveryId) {
        const [run] = await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, previousDeliveryId));
        if (run && run.status === "in_transit") {
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
          if (stops.total + pickups.total === 0) {
            await tx
              .update(deliveries)
              .set({
                status: "returning",
                version: run.version + 1,
                updated_at: now,
              })
              .where(eq(deliveries.id, run.id));
          }
        }
      }
      return { ok: true as const, id, status: "requested" as const };
    });
  }

  static async cancel(
    actor: AssignmentActor,
    id: number,
    input: { version: number; reason: string },
  ) {
    const warehouse = await staffWarehouse(actor);
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new WorkflowError("Enter a cancellation reason of up to 500 characters.", 400);
    return stockTransaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(customer_returns)
        .where(eq(customer_returns.id, id))
        .for("update");
      if (!task || (warehouse !== undefined && task.warehouse_id !== warehouse))
        throw new WorkflowError("Return pickup not found.", 404);
      if (
        !["requested", "failed"].includes(task.status) ||
        task.version !== input.version
      )
        throw new WorkflowError(
          "Only unassigned requested or failed pickups can be cancelled. Unassign active pickups first.",
        );
      const now = new Date();
      await tx
        .update(customer_returns)
        .set({
          status: "cancelled",
          assigned_delivery_id: null,
          assignment_key: null,
          assigned_by: null,
          cancellation_reason: reason,
          cancelled_by: Number(actor.sub),
          cancelled_at: now,
          version: task.version + 1,
          updated_at: now,
        })
        .where(eq(customer_returns.id, id));
      return { ok: true as const, id, status: "cancelled" as const };
    });
  }

  static async dispose(
    actor: AssignmentActor,
    id: number,
    input: {
      version: number;
      operationKey: string;
      notes: string;
      items: Array<{
        inventoryId: number;
        restockedQty: number;
        damagedQty: number;
      }>;
    },
  ) {
    const warehouse = await staffWarehouse(actor);
    const notes = input.notes.trim();
    if (!notes || notes.length > 500)
      throw new WorkflowError(
        "Enter inspection notes of up to 500 characters.",
        400,
      );
    if (!input.items.length)
      throw new WorkflowError("Provide disposition quantities for every item.", 400);

    return stockTransaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(customer_returns)
        .where(eq(customer_returns.id, id))
        .for("update");
      if (!task || (warehouse !== undefined && task.warehouse_id !== warehouse))
        throw new WorkflowError("Return pickup not found.", 404);
      if (
        task.disposition !== null &&
        task.disposition_key === input.operationKey &&
        task.disposition_by === Number(actor.sub)
      ) {
        return { ok: true as const, id: task.id, disposition: task.disposition };
      }
      if (task.status !== "received")
        throw new WorkflowError(
          "Only physically received customer returns can be inspected and dispositioned.",
        );
      if (task.disposition !== null || task.version !== input.version)
        throw new WorkflowError(
          "This return has already been dispositioned or changed. Refresh before retrying.",
          409,
        );

      const expectedItems = await tx
        .select({
          inventoryId: order_items.inventory_id,
          quantity: order_items.quantity,
        })
        .from(order_items)
        .where(eq(order_items.order_id, task.order_id))
        .orderBy(asc(order_items.inventory_id));

      if (expectedItems.length !== input.items.length)
        throw new WorkflowError(
          "Disposition must include every line item from the original order.",
          400,
        );

      const submittedByInventory = new Map<
        number,
        { restockedQty: number; damagedQty: number }
      >();
      for (const item of input.items) {
        if (
          !Number.isSafeInteger(item.restockedQty) ||
          !Number.isSafeInteger(item.damagedQty) ||
          item.restockedQty < 0 ||
          item.damagedQty < 0
        ) {
          throw new WorkflowError(
            "Restocked and damaged quantities must be non-negative integers.",
            400,
          );
        }
        if (submittedByInventory.has(item.inventoryId)) {
          throw new WorkflowError("Duplicate inventory item in disposition.", 400);
        }
        submittedByInventory.set(item.inventoryId, {
          restockedQty: item.restockedQty,
          damagedQty: item.damagedQty,
        });
      }

      let totalRestocked = 0;
      let totalDamaged = 0;

      for (const expected of expectedItems) {
        const submitted = submittedByInventory.get(expected.inventoryId);
        if (
          !submitted ||
          submitted.restockedQty + submitted.damagedQty !== expected.quantity
        ) {
          throw new WorkflowError(
            `Disposition quantities for inventory #${expected.inventoryId} must sum to ${expected.quantity}.`,
            400,
          );
        }

        const [stock] = await tx
          .select()
          .from(inventory)
          .where(eq(inventory.id, expected.inventoryId))
          .for("update");
        if (!stock || stock.warehouse_id !== task.warehouse_id)
          throw new WorkflowError("Returned inventory warehouse mismatch.");

        let nextQty = stock.quantity;
        if (submitted.restockedQty > 0) {
          nextQty = stock.quantity + submitted.restockedQty;
          await tx
            .update(inventory)
            .set({
              quantity: nextQty,
              version: sql`${inventory.version} + 1`,
              updated_at: nowEpochSeconds(),
            })
            .where(eq(inventory.id, stock.id));
          await tx.insert(stock_movements).values({
            inventory_id: stock.id,
            order_id: task.order_id,
            actor_id: Number(actor.sub),
            kind: "customer_return_restock",
            quantity_delta: submitted.restockedQty,
            reserved_delta: 0,
            quantity_after: nextQty,
            reserved_after: stock.reserved,
            reason: `Customer return #${task.id} restocked: ${notes}`,
          });
        }
        if (submitted.damagedQty > 0) {
          await tx.insert(stock_movements).values({
            inventory_id: stock.id,
            order_id: task.order_id,
            actor_id: Number(actor.sub),
            kind: "customer_return_damaged",
            quantity_delta: 0,
            reserved_delta: 0,
            quantity_after: nextQty,
            reserved_after: stock.reserved,
            reason: `Customer return #${task.id} damaged write-off (${submitted.damagedQty} units): ${notes}`,
          });
        }

        await tx.insert(customer_return_disposition_items).values({
          return_id: task.id,
          inventory_id: stock.id,
          restocked_qty: submitted.restockedQty,
          damaged_qty: submitted.damagedQty,
        });

        totalRestocked += submitted.restockedQty;
        totalDamaged += submitted.damagedQty;
      }

      const disposition =
        totalRestocked > 0 && totalDamaged > 0
          ? "partial"
          : totalRestocked > 0
            ? "restocked"
            : "damaged";
      const now = new Date();

      await tx
        .update(customer_returns)
        .set({
          disposition,
          disposition_notes: notes,
          disposition_by: Number(actor.sub),
          disposition_at: now,
          disposition_key: input.operationKey,
          version: task.version + 1,
          updated_at: now,
        })
        .where(eq(customer_returns.id, task.id));

      await tx.execute(
        sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({
          type: "RESOURCE_CHANGED",
          payload: { resource: "inventory", eventId: crypto.randomUUID() },
        })})`,
      );
      await tx.execute(
        sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({
          type: "RESOURCE_CHANGED",
          payload: { resource: "deliveries", eventId: crypto.randomUUID() },
        })})`,
      );

      return { ok: true as const, id: task.id, disposition };
    }).catch(conflict);
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
