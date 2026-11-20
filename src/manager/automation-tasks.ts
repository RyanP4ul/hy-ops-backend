import { and, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db/index";
import {
  inventory,
  notifications,
  order_items,
  orders,
  payments,
  product_variants,
  products,
  settings,
  staffs,
  users,
  automations,
  deliveries,
  deliveries_event,
  vehicles,
  warehouses,
} from "@/db/schema";
import { logger } from "../utils/logger";
import { taskManager } from "./task-manager";
import type { AutomationSelect } from "@/db/schema/automation";
import { activeInventory } from "../modules/lifecycle/availability";

const LOW_STOCK_TASK = "low_stock_checker";
const OVERDUE_PAYMENT_TASK = "overdue_payment_checker";
const DELIVERY_FOLLOW_UP_TASK = "delivery_follow_up_checker";

const runtimeTasks = {
  "Low Stock Checker": {
    name: LOW_STOCK_TASK,
    callback: checkLowStock,
  },
  "Overdue Payment Checker": {
    name: OVERDUE_PAYMENT_TASK,
    callback: checkOverduePayments,
  },
  "Delivery Follow-up Checker": {
    name: DELIVERY_FOLLOW_UP_TASK,
    callback: checkDeliveryFollowUp,
  },
} as const;

async function runAndRecord(
  name: string,
  interval: number,
  callback: () => Promise<void>,
) {
  const lastRunAt = new Date();
  try {
    await callback();
    await db
      .update(automations)
      .set({
        status: "ENABLED",
        last_run_at: lastRunAt,
        next_run_at: new Date(Date.now() + interval),
        last_error: null,
        updated_at: new Date(),
      })
      .where(eq(automations.name, name));
  } catch (error) {
    await db
      .update(automations)
      .set({
        status: "FAILED",
        last_run_at: lastRunAt,
        next_run_at: new Date(Date.now() + interval),
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: new Date(),
      })
      .where(eq(automations.name, name));
    throw error;
  }
}

const NOTIFICATION_READ_COOLDOWN_SECONDS = 24 * 60 * 60;
const COD_REMITTANCE_GRACE_MS = 24 * 60 * 60 * 1000;

export async function getRecipientIdsForWarehouse(warehouseId?: number) {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        eq(users.is_active, true),
        eq(users.is_archived, false),
      ),
    );

  const staffRows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(staffs, eq(staffs.user_id, users.id))
    .where(
      and(
        eq(users.role, "staff"),
        eq(users.is_active, true),
        eq(users.is_archived, false),
        warehouseId === undefined ? undefined : eq(staffs.warehouse_id, warehouseId),
      ),
    );

  return [...new Set([...admins.map((r) => r.id), ...staffRows.map((r) => r.id)])];
}

export async function createNotifications(
  recipientIds: number[],
  title: string,
  message: string,
  type: string,
) {
  if (recipientIds.length === 0) {
    return 0;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: notifications.id,
        userId: notifications.user_id,
        isRead: notifications.is_read,
        message: notifications.message,
        createdAt: notifications.created_at,
      })
      .from(notifications)
      .where(
        and(
          inArray(notifications.user_id, recipientIds),
          eq(notifications.title, title),
        ),
      )
      .orderBy(desc(notifications.id));

    const unreadByUser = new Map<number, { id: number; message: string }>();
    const latestReadByUser = new Map<number, { message: string; createdAt: number }>();

    for (const row of existing) {
      if (!row.isRead && !unreadByUser.has(row.userId)) {
        unreadByUser.set(row.userId, { id: row.id, message: row.message });
      } else if (row.isRead && !latestReadByUser.has(row.userId)) {
        latestReadByUser.set(row.userId, { message: row.message, createdAt: row.createdAt });
      }
    }

    const toInsert: number[] = [];
    let mutated = 0;

    for (const userId of recipientIds) {
      const unread = unreadByUser.get(userId);
      if (unread) {
        if (unread.message !== message) {
          await tx
            .update(notifications)
            .set({ message, created_at: nowSeconds })
            .where(eq(notifications.id, unread.id));
          mutated += 1;
        }
        continue;
      }

      const lastRead = latestReadByUser.get(userId);
      if (
        lastRead &&
        lastRead.message === message &&
        nowSeconds - lastRead.createdAt < NOTIFICATION_READ_COOLDOWN_SECONDS
      ) {
        continue;
      }

      toInsert.push(userId);
    }

    if (toInsert.length > 0) {
      const results = await tx
        .insert(notifications)
        .values(
          toInsert.map((user_id) => ({
            user_id,
            title,
            message,
            type,
            is_read: false,
            created_at: nowSeconds,
          })),
        )
        .returning({ id: notifications.id });
      mutated += results.length;
    }

    if (mutated > 0) {
      await tx.execute(
        sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({
          type: "RESOURCE_CHANGED",
          payload: { resource: "notifications", eventId: crypto.randomUUID() },
        })})`,
      );
    }

    return mutated;
  });
}

async function checkLowStock() {
  logger.info("[Automation] Running low stock checker...");
  const thresholdSetting = await db.query.settings.findFirst({
    columns: { value: true },
    where: eq(settings.name, "low_stock_threshold"),
  });
  const threshold = Number(thresholdSetting?.value ?? 10);

  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(
      `Invalid low_stock_threshold setting: ${thresholdSetting?.value}`,
    );
  }

  const availableExpr = sql<number>`(${inventory.quantity} - ${inventory.reserved})`.mapWith(Number);
  const effectiveThresholdExpr = sql<number>`coalesce(${inventory.reorder_point}, ${threshold})`.mapWith(Number);

  const lowStockRows = await db
    .select({
      warehouseId: inventory.warehouse_id,
      warehouseName: warehouses.name,
      productName: products.name,
      sku: product_variants.sku,
      quantity: inventory.quantity,
      reserved: inventory.reserved,
      available: availableExpr,
      effectiveThreshold: effectiveThresholdExpr,
    })
    .from(inventory)
    .innerJoin(warehouses, eq(inventory.warehouse_id, warehouses.id))
    .leftJoin(products, eq(inventory.product_id, products.id))
    .leftJoin(
      product_variants,
      eq(inventory.product_variant_id, product_variants.id),
    )
    .where(and(activeInventory(), lte(availableExpr, effectiveThresholdExpr)));

  if (lowStockRows.length === 0) {
    return;
  }

  const recipientCache = new Map<number, number[]>();
  for (const row of lowStockRows) {
    let recipients = recipientCache.get(row.warehouseId);
    if (!recipients) {
      recipients = await getRecipientIdsForWarehouse(row.warehouseId);
      recipientCache.set(row.warehouseId, recipients);
    }
    const label = row.productName
      ? `${row.productName}${row.sku ? ` (${row.sku})` : ""}`
      : row.sku ?? "Inventory item";
    await createNotifications(
      recipients,
      `Low stock: ${label} — ${row.warehouseName}`,
      `${row.available} available (${row.quantity} on hand, ${row.reserved} reserved; reorder point: ${row.effectiveThreshold}).`,
      "LOW_STOCK",
    );
  }

  logger.info(
    `[Automation] Low stock checker found ${lowStockRows.length} item(s).`,
  );
}

export function findOverduePayments() {
  const now = new Date();
  const net30Cutoff = new Date(now);
  net30Cutoff.setDate(net30Cutoff.getDate() - 30);
  const codCutoff = new Date(now.getTime() - COD_REMITTANCE_GRACE_MS);

  const orderTotals = db
    .select({
      orderId: order_items.order_id,
      total: sql<string | null>`case
        when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
        then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})
        else null
      end`.as("order_total"),
    })
    .from(order_items)
    .groupBy(order_items.order_id)
    .as("automation_order_totals");

  const paidTotals = db
    .select({
      orderId: payments.order_id,
      total: sql<string>`coalesce(sum(${payments.amount}), 0)`.as("paid_total"),
    })
    .from(payments)
    .groupBy(payments.order_id)
    .as("automation_paid_totals");

  return db
    .select({
      orderId: orders.id,
      warehouseId: orders.warehouse_id,
      orderNumber: orders.order_number,
      paymentArrangement: orders.payment_arrangement,
      createdAt: orders.created_at,
      orderTotal: orderTotals.total,
      paidTotal: paidTotals.total,
    })
    .from(orders)
    .leftJoin(orderTotals, eq(orders.id, orderTotals.orderId))
    .leftJoin(paidTotals, eq(orders.id, paidTotals.orderId))
    .where(
      and(
        ne(orders.status, "CANCELLED"),
        or(
          and(
            eq(orders.payment_arrangement, "PARTIALLY_PAID"),
            lte(orders.created_at, net30Cutoff),
          ),
          and(
            eq(orders.payment_arrangement, "NET_30"),
            lte(orders.created_at, net30Cutoff),
          ),
          and(
            eq(orders.payment_arrangement, "PAY_ON_DELIVERY"),
            eq(orders.status, "COMPLETED"),
            lte(orders.updated_at, codCutoff),
          ),
        ),
        sql`${orderTotals.total} > coalesce(${paidTotals.total}, 0)`,
      ),
    );

}

async function checkOverduePayments() {
  const overdueRows = await findOverduePayments();
  if (overdueRows.length === 0) {
    return;
  }

  await db
    .update(payments)
    .set({ payment_status: "OVERDUE" })
    .where(
      and(
        inArray(
          payments.order_id,
          overdueRows.map(({ orderId }) => orderId),
        ),
        ne(payments.payment_status, "PAID"),
      ),
    );

  const recipientCache = new Map<number, number[]>();
  for (const row of overdueRows) {
    let recipients = recipientCache.get(row.warehouseId);
    if (!recipients) {
      recipients = await getRecipientIdsForWarehouse(row.warehouseId);
      recipientCache.set(row.warehouseId, recipients);
    }
    const detail =
      row.paymentArrangement === "PAY_ON_DELIVERY"
        ? "Completed COD order has unremitted balance past 24h."
        : "Payment is past due.";
    await createNotifications(
      recipients,
      `Overdue payment: Order ${row.orderNumber}`,
      detail,
      "OVERDUE_PAYMENT",
    );
  }

  logger.info(
    `[Automation] Overdue payment checker found ${overdueRows.length} order(s).`,
  );
}

async function checkDeliveryFollowUp() {
  const now = new Date();
  const deliveryRows = await db
    .select({
      id: deliveries.id,
      warehouseId: vehicles.warehouse_id,
      scheduledDate: deliveries.scheduled_date,
      departureTime: deliveries.departure_time,
      status: deliveries.status,
      hasIssue: sql<boolean>`exists (
        select 1
        from ${deliveries_event}
        where ${deliveries_event.delivery_id} = ${deliveries.id}
          and ${deliveries_event.event_type} in ('DELAYED', 'FAILED')
      )`,
    })
    .from(deliveries)
    .innerJoin(vehicles, eq(deliveries.vehicle_id, vehicles.id))
    .where(
      or(
        eq(deliveries.status, "scheduled"),
        eq(deliveries.status, "in_transit"),
      ),
    );

  const needsFollowUp = deliveryRows.filter((delivery) => {
    const scheduledAt = new Date(
      `${delivery.scheduledDate}T${delivery.departureTime}`,
    );
    return delivery.hasIssue || scheduledAt <= now;
  });

  const recipientCache = new Map<number, number[]>();
  for (const delivery of needsFollowUp) {
    let recipients = recipientCache.get(delivery.warehouseId);
    if (!recipients) {
      recipients = await getRecipientIdsForWarehouse(delivery.warehouseId);
      recipientCache.set(delivery.warehouseId, recipients);
    }
    await createNotifications(
      recipients,
      `Delivery #${delivery.id} needs attention`,
      delivery.hasIssue ? "Delay or failure reported." : "Past scheduled departure.",
      "DELIVERY_FOLLOW_UP",
    );
  }

  if (needsFollowUp.length > 0) {
    logger.info(
      `[Automation] Delivery follow-up checker found ${needsFollowUp.length} delivery(ies).`,
    );
  }
}

export async function configureAutomationTask(automation: AutomationSelect) {
  const runtimeTask =
    runtimeTasks[automation.name as keyof typeof runtimeTasks];
  if (!runtimeTask) return;
  if (!automation.interval_ms || automation.interval_ms < 1) {
    throw new Error(
      `Automation "${automation.name}" must have a positive interval_ms.`,
    );
  }

  const callback = () =>
    runAndRecord(
      automation.name,
      automation.interval_ms as number,
      runtimeTask.callback,
    );

  if (taskManager.has(runtimeTask.name)) {
    await taskManager.updateInterval(runtimeTask.name, automation.interval_ms, callback);
  } else {
    taskManager.register(runtimeTask.name, automation.interval_ms, callback);
  }

  if (automation.status !== "DISABLED") {
    await taskManager.start(runtimeTask.name);
  } else {
    taskManager.stop(runtimeTask.name);
  }
}

export async function startAutomationTasks() {
  await db.delete(automations).where(inArray(automations.name, [
    "Notification Cleanup", "Daily Summary Preview",
  ]));
  const registeredAutomations = await db
    .select()
    .from(automations)
    .where(
      or(
        eq(automations.name, "Low Stock Checker"),
        eq(automations.name, "Overdue Payment Checker"),
        eq(automations.name, "Delivery Follow-up Checker"),
      ),
    );

  for (const automation of registeredAutomations) {
    await configureAutomationTask(automation);
  }
}

export { checkLowStock, checkOverduePayments };
