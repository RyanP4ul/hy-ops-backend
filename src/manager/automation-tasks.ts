import { and, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
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
  users,
  automations,
  deliveries,
  deliveries_event,
} from "@/db/schema";
import { logger } from "../utils/logger";
import { taskManager } from "./task-manager";
import type { AutomationSelect } from "@/db/schema/automation";

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
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: new Date(),
      })
      .where(eq(automations.name, name));
    throw error;
  }
}

async function getRecipientIds() {
  const recipients = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        or(eq(users.role, "admin"), eq(users.role, "staff")),
        eq(users.is_archived, false),
      ),
    );

  return recipients.map(({ id }) => id);
}

async function createNotifications(
  recipientIds: number[],
  title: string,
  message: string,
  type: string,
) {
  if (recipientIds.length === 0) {
    return 0;
  }

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: notifications.user_id })
      .from(notifications)
      .where(
        and(
          inArray(notifications.user_id, recipientIds),
          eq(notifications.title, title),
        ),
      );
    const existingUserIds = new Set(existing.map(({ userId }) => userId));
    const missingUserIds = recipientIds.filter(
      (userId) => !existingUserIds.has(userId),
    );

    if (missingUserIds.length === 0) {
      return 0;
    }

    const results = await tx
      .insert(notifications)
      .values(
        missingUserIds.map((user_id) => ({
          user_id,
          title,
          message,
          type,
          created_at: Math.floor(Date.now() / 1000),
        })),
      )
      .returning({ id: notifications.id });

    return results.length;
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

  const lowStockRows = await db
    .select({
      productName: products.name,
      sku: product_variants.sku,
      quantity: inventory.quantity,
    })
    .from(inventory)
    .leftJoin(products, eq(inventory.product_id, products.id))
    .leftJoin(
      product_variants,
      eq(inventory.product_variant_id, product_variants.id),
    )
    .where(lte(inventory.quantity, threshold));

  if (lowStockRows.length === 0) {
    return;
  }

  const preview = lowStockRows
    .slice(0, 3)
    .map(
      ({ productName, sku, quantity }) => `${productName ?? sku} (${quantity})`,
    )
    .join(", ");
  const suffix =
    lowStockRows.length > 3 ? ` and ${lowStockRows.length - 3} more` : "";

  for (const { productName, sku, quantity } of lowStockRows) {
    await createNotifications(
      await getRecipientIds(),
      `Low stock detected for ${productName ?? sku}`,
      `${productName ?? sku} has a low stock quantity of ${quantity}. Please restock soon.`,
      "LOW_STOCK",
    );
  }

  logger.info(
    `[Automation] Low stock checker found ${lowStockRows.length} item(s).`,
  );
}

async function checkOverduePayments() {
  const now = new Date();
  const net30Cutoff = new Date(now);
  net30Cutoff.setDate(net30Cutoff.getDate() - 30);

  const orderTotals = db
    .select({
      orderId: order_items.order_id,
      total: sql<string | null>`case
        when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
        then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})::text
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

  const overdueRows = await db
    .select({
      orderId: orders.id,
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
        ),
        sql`${orderTotals.total} > coalesce(${paidTotals.total}, 0)`,
      ),
    );

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

  const preview = overdueRows
    .slice(0, 3)
    .map(({ orderNumber }) => orderNumber)
    .join(", ");
  const suffix =
    overdueRows.length > 3 ? ` and ${overdueRows.length - 3} more` : "";

  for (const { orderNumber } of overdueRows) {
    await createNotifications(
      await getRecipientIds(),
      `Overdue payment detected for order ${orderNumber}`,
      `Order ${orderNumber} has an overdue payment. Please follow up with the customer.`,
      "OVERDUE_PAYMENT",
    );
  }

  // await createNotifications(
  //   await getRecipientIds(),
  //   "Overdue payments detected",
  //   `${overdueRows.length} order payment(s) are overdue: ${preview}${suffix}.`,
  //   "OVERDUE_PAYMENT",
  // );

  logger.info(
    `[Automation] Overdue payment checker found ${overdueRows.length} order(s).`,
  );
}

async function checkDeliveryFollowUp() {
  const now = new Date();
  const deliveryRows = await db
    .select({
      id: deliveries.id,
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

  for (const delivery of needsFollowUp) {
    await createNotifications(
      await getRecipientIds(),
      `Delivery follow-up required for delivery ${delivery.id}`,
      `Delivery ${delivery.id} is ${delivery.hasIssue ? "marked with a delay or failure event" : "past its scheduled departure time"} and may need staff attention.`,
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
    await taskManager.updateInterval(runtimeTask.name, automation.interval_ms);
  } else {
    taskManager.register(runtimeTask.name, automation.interval_ms, callback);
  }

  if (automation.status === "ENABLED") {
    await taskManager.start(runtimeTask.name);
  } else {
    taskManager.stop(runtimeTask.name);
  }
}

export async function startAutomationTasks() {
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
