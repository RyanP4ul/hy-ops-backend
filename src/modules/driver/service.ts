import { CustomerReturnService } from "../deliveries/customer-returns";
import { queueDeliveryNotifications } from "../deliveries/notification-queue";
import { customer_returns } from "../../db/schema/customer-returns";
import { historyBounds, type HistoryFilter } from "./history-filter";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  customers,
  deliveries,
  deliveries_stops,
  driver_stop_outcomes,
  drivers,
  inventory,
  order_items,
  orders,
  payments,
  products,
  product_variants,
  users,
  vehicles,
  warehouses,
} from "../../db/schema";
import { WorkflowError } from "../../utils/workflow-error";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../utils/money";
import { assertDriverOwnership, assertOutcomeCommand } from "./policy";

export class DriverService {
  static async profile(actorId: number) {
    const [profile] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: drivers.phone_number,
        warehouseId: warehouses.id,
        warehouse: warehouses.name,
        latitude: warehouses.latitude,
        longitude: warehouses.longitude,
      })
      .from(users)
      .innerJoin(drivers, eq(drivers.user_id, users.id))
      .innerJoin(warehouses, eq(warehouses.id, drivers.warehouse_id))
      .where(
        and(
          eq(users.id, actorId),
          eq(users.role, "driver"),
          eq(users.is_archived, false),
        ),
      );
    if (!profile)
      throw new WorkflowError("Driver profile is unavailable.", 404);
    return profile;
  }

  static async trips(actorId: number, page = 0, pageSize = 20, past = false) {
    const predicate = and(
      eq(deliveries.driver_id, actorId),
      past
        ? inArray(deliveries.status, ["completed", "cancelled"])
        : inArray(deliveries.status, ["scheduled", "in_transit", "returning"]),
    );
    const [total] = await db
      .select({ value: count() })
      .from(deliveries)
      .where(predicate);
    const rows = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(predicate)
      .orderBy(
        sql`case when ${deliveries.status} in ('in_transit', 'returning') then 0 else 1 end`,
        past ? desc(deliveries.scheduled_date) : asc(deliveries.scheduled_date),
        asc(deliveries.departure_time),
        asc(deliveries.id),
      )
      .limit(pageSize)
      .offset(page * pageSize);
    return {
      items: await Promise.all(rows.map((r) => this.trip(actorId, r.id))),
      total: total.value,
      page,
      pageSize,
    };
  }

  static async trip(actorId: number, id: number) {
    // Keep this read consistent if staff reassign while stop/customer details are loaded.
    return db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.id, id), eq(deliveries.driver_id, actorId)))
        .for("share");
      assertDriverOwnership(run?.driver_id, actorId);
      const [vehicle] = await tx
        .select()
        .from(vehicles)
        .where(eq(vehicles.id, run.vehicle_id));
      const [warehouse] = await tx
        .select({
          id: warehouses.id,
          name: warehouses.name,
          latitude: warehouses.latitude,
          longitude: warehouses.longitude,
        })
        .from(warehouses)
        .where(eq(warehouses.id, vehicle.warehouse_id));
      const stops = await tx
        .select({
          stop: deliveries_stops,
          order: orders,
          customerName: users.name,
        })
        .from(deliveries_stops)
        .innerJoin(orders, eq(orders.id, deliveries_stops.order_id))
        .innerJoin(customers, eq(customers.id, orders.customer_id))
        .innerJoin(users, eq(users.id, customers.user_id))
        .where(eq(deliveries_stops.delivery_id, id))
        .orderBy(asc(deliveries_stops.leg_index), asc(deliveries_stops.id));
      const result = [];
      for (const { stop, order, customerName } of stops) {
        const items = await tx
          .select({
            id: order_items.id,
            name: products.name,
            variant: product_variants.name,
            qty: order_items.quantity,
            price: order_items.unit_price_snapshot,
          })
          .from(order_items)
          .innerJoin(inventory, eq(inventory.id, order_items.inventory_id))
          .innerJoin(products, eq(products.id, inventory.product_id))
          .innerJoin(
            product_variants,
            eq(product_variants.id, inventory.product_variant_id),
          )
          .where(eq(order_items.order_id, order.id))
          .orderBy(asc(order_items.id));
        const verified =
          items.length > 0 && items.every((i) => i.price !== null);
        const total = verified
          ? items.reduce((sum, item) => {
              if (item.price === null)
                throw new WorkflowError("Historical price is unverified.");
              return sum + moneyToMinorUnits(item.price) * BigInt(item.qty);
            }, 0n)
          : null;
        // payments.amount is the retained receipt aggregate; refunds are already deducted.
        const paidRows = await tx
          .select({ amount: payments.amount })
          .from(payments)
          .where(eq(payments.order_id, order.id));
        const paid = paidRows.reduce(
          (sum, p) => sum + moneyToMinorUnits(p.amount),
          0n,
        );
        const balance =
          total === null ? null : total > paid ? total - paid : 0n;
        const [outcome] = await tx
          .select()
          .from(driver_stop_outcomes)
          .where(eq(driver_stop_outcomes.stop_id, stop.id));
        result.push({
          id: stop.id,
          orderId: order.id,
          orderNumber: order.order_number,
          customer: customerName,
          contact: order.shipping_recipient ?? customerName,
          phone: order.shipping_phone,
          address: order.shipping_address,
          latitude: stop.latitude,
          longitude: stop.longitude,
          status: stop.status,
          sequence: stop.leg_index,
          payment: order.payment_arrangement,
          total: total === null ? null : minorUnitsToMoney(total),
          paid: minorUnitsToMoney(paid),
          collectNow:
            balance === null
              ? null
              : minorUnitsToMoney(
                  ["PARTIALLY_PAID", "PAY_ON_DELIVERY"].includes(
                    order.payment_arrangement ?? "",
                  )
                    ? balance
                    : 0n,
                ),
          items,
          doneAt:
            outcome?.recorded_at ??
            stop.delivered_at ??
            (stop.status === "failed" ? stop.updated_at : null),
          reason: outcome?.reason ?? null,
          canDeliver: run.status === "in_transit" && stop.status === "pending",
          canFail: run.status === "in_transit" && stop.status === "pending",
        });
      }
      return {
        id: run.id,
        status: run.status,
        version: run.version,
        scheduledDate: run.scheduled_date,
        departureTime: run.departure_time,
        scheduledAt: `${run.scheduled_date}T${run.departure_time}+08:00`,
        kind: run.delivery_type,
        vehicle: {
          id: vehicle.id,
          type: vehicle.type,
          plate: vehicle.plate_number,
        },
        warehouse,
        updatedAt: run.updated_at,
        pickups: await CustomerReturnService.list(undefined, run.id, tx),
        stops: result,
      };
    });
  }

  static async history(
    actorId: number,
    page = 0,
    pageSize = 20,
    filter: HistoryFilter = {},
  ) {
    const { start, end } = historyBounds(filter);
    const time = sql`case when ${deliveries_stops.status} = 'pending' and ${deliveries.status} = 'cancelled' then ${deliveries.updated_at} else coalesce((select recorded_at from driver_stop_outcomes o where o.stop_id = ${deliveries_stops.id}), ${deliveries_stops.delivered_at}, ${deliveries_stops.updated_at}) end`;
    const status = sql`case when ${deliveries_stops.status} = 'pending' and ${deliveries.status} = 'cancelled' then 'cancelled' else ${deliveries_stops.status}::text end`;
    const predicate = and(
      eq(deliveries.driver_id, actorId),
      sql`(${deliveries_stops.status} <> 'pending' OR ${deliveries.status} = 'cancelled')`,
      start ? sql`${time} >= ${start}::timestamptz` : undefined,
      end ? sql`${time} < ${end}::timestamptz` : undefined,
      filter.status ? sql`${status} = ${filter.status}` : undefined,
    );
    const [total] = await db
      .select({ value: count() })
      .from(deliveries_stops)
      .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
      .where(predicate);
    const rows = await db
      .select({
        stopId: deliveries_stops.id,
        deliveryId: deliveries.id,
        cancelled: deliveries.status,
        updatedAt: deliveries.updated_at,
      })
      .from(deliveries_stops)
      .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
      .where(predicate)
      .orderBy(sql`${time} desc`, desc(deliveries_stops.id))
      .limit(pageSize)
      .offset(page * pageSize);
    const items = [];
    for (const row of rows) {
      const trip = await this.trip(actorId, row.deliveryId);
      const stop = trip.stops.find((s) => s.id === row.stopId);
      if (!stop) throw new WorkflowError("Assignment stop not found.", 404);
      items.push({
        tripId: trip.id,
        ...stop,
        status:
          stop.status === "pending" && row.cancelled === "cancelled"
            ? "cancelled"
            : stop.status,
        doneAt: stop.doneAt ?? row.updatedAt,
      });
    }
    return { items, total: total.value, page, pageSize };
  }

  static async outcome(
    actorId: number,
    stopId: number,
    command: { version: number; operationKey: string; reason?: string },
    outcome: "delivered" | "failed",
  ) {
    console.log(
      `Driver ${actorId} marking stop ${stopId} as ${outcome} with command`,
      command,
    );
    const reason = outcome === "failed" ? command.reason?.trim() : undefined;

    if (outcome === "failed" && !reason)
      throw new WorkflowError("A failure reason is required.", 400);

    return db
      .transaction(async (tx) => {
        const [identity] = await tx
          .select({ deliveryId: deliveries_stops.delivery_id })
          .from(deliveries_stops)
          .where(eq(deliveries_stops.id, stopId));
        if (!identity) throw new WorkflowError("Assignment not found.", 404);
        const [run] = await tx
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, identity.deliveryId))
          .for("update");
        assertDriverOwnership(run?.driver_id, actorId);
        const [stop] = await tx
          .select()
          .from(deliveries_stops)
          .where(eq(deliveries_stops.id, stopId))
          .for("update");
        const [existing] = await tx
          .select()
          .from(driver_stop_outcomes)
          .where(eq(driver_stop_outcomes.stop_id, stopId));
        if (
          assertOutcomeCommand({
            status: run.status,
            version: command.version,
            currentVersion: run.version,
            existing,
            actorId,
            key: command.operationKey,
            outcome,
            reason,
          }) === "replay"
        )
          return { ok: true, deliveryId: run.id };
        if (stop.status !== "pending")
          throw new WorkflowError(
            "Stop outcome already changed. Refresh the trip.",
          );
        const [keyUsed] = await tx
          .select({ id: driver_stop_outcomes.stop_id })
          .from(driver_stop_outcomes)
          .where(eq(driver_stop_outcomes.operation_key, command.operationKey));
        if (keyUsed)
          throw new WorkflowError("This operation key has already been used.");
        await tx.insert(driver_stop_outcomes).values({
          stop_id: stopId,
          actor_id: actorId,
          operation_key: command.operationKey,
          outcome,
          reason,
        });
        const now = new Date();
        await tx
          .update(deliveries_stops)
          .set({
            status: outcome,
            delivered_at: outcome === "delivered" ? now : null,
            updated_at: now,
          })
          .where(eq(deliveries_stops.id, stopId));
        // Failed orders stay IN_TRANSIT until staff physically accepts their stock return.
        if (outcome === "delivered")
          await tx
            .update(orders)
            .set({
              status: "COMPLETED",
              version: sql`${orders.version} + 1`,
              updated_at: now,
            })
            .where(eq(orders.id, stop.order_id));
        if (outcome === "delivered")
          await queueDeliveryNotifications(tx, stopId, stop.order_id);
        const [pending] = await tx
          .select({ value: count() })
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
              pending.value + pickups.total === 0 ? "returning" : "in_transit",
            version: sql`${deliveries.version} + 1`,
            updated_at: now,
          })
          .where(eq(deliveries.id, run.id));
        return { ok: true, deliveryId: run.id };
      })
      .catch((error: unknown) => {
        const detail = error as { code?: string; cause?: { code?: string } };
        if (detail?.code === "23505" || detail?.cause?.code === "23505")
          throw new WorkflowError("This operation key has already been used.");
        throw error;
      });
  }
}
