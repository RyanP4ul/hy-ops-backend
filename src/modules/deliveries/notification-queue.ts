import { eq } from "drizzle-orm";
import type { db } from "../../db";
import {
  customers,
  deliveries_stops,
  delivery_notifications,
  orders,
  users,
} from "../../db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DeliveryNotificationEvent = {
  eventKey: string;
  eventType: "delivered" | "cancelled" | "rescheduled";
  scheduledAt?: Date;
  reason?: string;
};

/** Runs in the delivery transaction: rolled-back outcomes never notify customers. */
export async function queueDeliveryNotifications(
  tx: Transaction,
  stopId: number,
  orderId: number,
  event: DeliveryNotificationEvent = { eventKey: "delivered", eventType: "delivered" },
) {
  console.log(
    `Queueing delivery notifications for stop ${stopId} and order ${orderId}.`,
  );
  const [contact] = await tx
    .select({
      email: users.email,
      phone: customers.phone_number,
      shippingPhone: orders.shipping_phone,
      salesChannel: orders.sales_channel,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customer_id))
    .innerJoin(users, eq(users.id, customers.user_id))
    .where(eq(orders.id, orderId));
  const phone = contact?.salesChannel === "WALK_IN" ? contact.shippingPhone?.trim() : contact?.phone?.trim() || contact?.shippingPhone?.trim();
  const email = contact?.email === "walkin@system.local" ? undefined : contact?.email?.trim();
  await tx
    .insert(delivery_notifications)
    .values([
      {
        stop_id: stopId,
        event_key: event.eventKey,
        event_type: event.eventType,
        scheduled_at: event.scheduledAt ?? null,
        reason: event.reason ?? null,
        channel: "sms",
        recipient: phone || null,
        status: phone ? "pending" : "skipped",
        error: phone ? null : "Customer has no phone number.",
      },
      {
        stop_id: stopId,
        event_key: event.eventKey,
        event_type: event.eventType,
        scheduled_at: event.scheduledAt ?? null,
        reason: event.reason ?? null,
        channel: "email",
        recipient: email || null,
        status: email ? "pending" : "skipped",
        error: email ? null : "Customer has no email address.",
      },
    ])
    .onConflictDoNothing({
      target: [delivery_notifications.stop_id, delivery_notifications.event_key, delivery_notifications.channel],
    });
}

/** External completion uses the same outbox, without inventing an internal stop. */
export async function queueExternalDeliveryNotification(tx: Transaction, bookingId: number, orderId: number) {
  const [contact] = await tx.select({ email: users.email, phone: orders.shipping_phone }).from(orders)
    .innerJoin(customers, eq(customers.id, orders.customer_id)).innerJoin(users, eq(users.id, customers.user_id)).where(eq(orders.id, orderId));
  for (const channel of ["sms", "email"] as const) {
    const recipient = channel === "sms" ? contact?.phone?.trim() : contact?.email?.trim();
    await tx.insert(delivery_notifications).values({ booking_id: bookingId, event_key: "delivered", event_type: "delivered", channel,
      recipient: recipient || null, status: recipient ? "pending" : "skipped", error: recipient ? null : "Customer contact is unavailable." })
      .onConflictDoNothing({ target: [delivery_notifications.booking_id, delivery_notifications.event_key, delivery_notifications.channel] });
  }
}

export async function queueDeliveryEventNotifications(tx: Transaction, deliveryId: number, event: DeliveryNotificationEvent) {
  const stops = await tx.select({ id: deliveries_stops.id, orderId: deliveries_stops.order_id })
    .from(deliveries_stops).where(eq(deliveries_stops.delivery_id, deliveryId));
  for (const stop of stops) await queueDeliveryNotifications(tx, stop.id, stop.orderId, event);
}
