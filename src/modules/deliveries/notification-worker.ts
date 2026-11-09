import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  deliveries_stops,
  delivery_notifications,
  orders,
  delivery_orders,
} from "../../db/schema";
import { gmailSender, type EmailSender } from "../email";
import { buildEmailMessage } from "../email/message";
import { InvoiceService } from "../invoice/service";
import { buildInvoiceAttachment } from "../invoice/email-invoice";
import { SmsGateway } from "../sms/service";

type Job = typeof delivery_notifications.$inferSelect;

/** Separate channels keep an email failure from suppressing the delivery SMS. */
async function sendNotification(
  job: Job,
  sms: SmsGateway,
  emailSender: EmailSender,
) {
  try {
    const [delivery] = job.booking_id ? await db.select({ orderId: orders.id, orderNumber: orders.order_number,
      status: delivery_orders.status }).from(delivery_orders).innerJoin(orders, eq(orders.id, delivery_orders.order_id))
      .where(eq(delivery_orders.id, job.booking_id)) : await db
      .select({
        orderId: orders.id,
        orderNumber: orders.order_number,
        status: deliveries_stops.status,
      })
      .from(deliveries_stops)
      .innerJoin(orders, eq(orders.id, deliveries_stops.order_id))
      .where(eq(deliveries_stops.id, job.stop_id ?? -1));

    if (!delivery) throw new Error("Delivery stop is unavailable.");
    if (job.event_type === "delivered" && !["delivered", "COMPLETED"].includes(delivery.status))
      throw new Error("Delivery stop is not delivered.");

    if (!job.recipient) throw new Error("Notification recipient is missing.");

    // Use the event's saved schedule so later reschedules do not rewrite this message.
    let update: string;
    let subject: string;
    if (job.event_type === "cancelled") {
      update = `The delivery for your order ${delivery.orderNumber} has been cancelled. Your order is awaiting a new delivery schedule.`;
      subject = `Delivery cancelled - ${delivery.orderNumber}`;
    } else if (job.event_type === "rescheduled") {
      if (!job.scheduled_at) throw new Error("Rescheduled delivery departure is missing.");
      const departure = job.scheduled_at.toLocaleString("en-PH", {
        timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      update = `The delivery for your order ${delivery.orderNumber} has been rescheduled. New departure: ${departure} (Manila time).`;
      subject = `Delivery rescheduled - ${delivery.orderNumber}`;
    } else {
      update = `Your order ${delivery.orderNumber} has been delivered. Thank you for your order!`;
      subject = `Delivery confirmation and invoice - ${delivery.orderNumber}`;
    }
    const reason = job.reason ? `\nReason: ${job.reason}` : "";

    let providerId: string | undefined;
    if (job.channel === "sms") {
      let deviceId = process.env.DELIVERY_SMS_DEVICE_ID?.trim();
      if (!deviceId) {
        const stats = await sms.stats();
        deviceId = stats.per_device
          .filter((device) => device.is_active)
          .sort((a, b) => a.device_id.localeCompare(b.device_id))[0]?.device_id;
      }
      if (!deviceId)
        throw new Error(
          "No active SMS device is available for delivery notifications.",
        );
      const result = await sms.send({
        device_id: deviceId,
        phone_number: job.recipient,
        message: `HY COMPANY: ${update}${reason}`,
      });
      providerId = result.id === undefined ? undefined : String(result.id);
    } else {
      let raw: string;
      if (job.event_type === "delivered") {
        const invoice = await InvoiceService.getInvoiceByOrderId(delivery.orderId);
        raw = buildEmailMessage(job.recipient, subject,
          `Hello ${invoice.customer.name ?? ""},\n\n${update}\n\nYour invoice ${invoice.invoice_number} is attached as a PDF.\n\nThank you for choosing HY COMPANY.`,
          buildInvoiceAttachment(invoice));
      } else {
        raw = buildEmailMessage(job.recipient, subject, `Hello,\n\n${update}${reason}\n\nThank you for choosing HY COMPANY.`);
      }
      providerId = await emailSender(raw);
      if (!providerId)
        throw new Error(
          "Email submission was not acknowledged. Check the sender mailbox before retrying.",
        );
    }
    await db
      .update(delivery_notifications)
      .set({
        status: "sent",
        provider_id: providerId ?? null,
        error: null,
        updated_at: new Date(),
      })
      .where(eq(delivery_notifications.id, job.id));
  } catch (error) {
    // No automatic resend: a provider timeout can happen after accepting a message.
    // Persist the issue for review without changing the successful delivery outcome.
    const message =
      error instanceof Error
        ? error.message
        : "Notification submission was not confirmed.";
    console.error(
      `Delivery notification ${job.id} (${job.channel}, stop ${job.stop_id}) failed: ${message}`,
    );
    await db
      .update(delivery_notifications)
      .set({
        status: "failed",
        error: message.slice(0, 1000),
        updated_at: new Date(),
      })
      .where(eq(delivery_notifications.id, job.id));
  }
}

export function startDeliveryNotificationWorker(
  sms = new SmsGateway(),
  emailSender: EmailSender = gmailSender,
) {
  let running: Promise<void> | undefined;
  let stopped = false;
  async function drain() {
    // Claim before contacting providers. Concurrent server instances cannot send the same job.
    const jobs = await db.transaction(async (tx) => {
      const pending = await tx
        .select()
        .from(delivery_notifications)
        .where(eq(delivery_notifications.status, "pending"))
        .orderBy(delivery_notifications.id)
        .limit(10)
        .for("update", { skipLocked: true });
      for (const job of pending)
        await tx
          .update(delivery_notifications)
          .set({ status: "sending", updated_at: new Date() })
          .where(eq(delivery_notifications.id, job.id));
      return pending;
    });
    const results = await Promise.allSettled(
      jobs.map((job) => sendNotification(job, sms, emailSender)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected")
        console.error(
          `Could not persist delivery notification ${jobs[index].id} result. Review its provider submission before retrying.`,
        );
    });
  }
  function tick() {
    if (stopped || running) return;
    running = drain()
      .catch(() =>
        console.error(
          "Delivery notification queue could not be processed. Check the database and migrations.",
        ),
      )
      .finally(() => {
        running = undefined;
      });
  }
  const timer = setInterval(tick, 5000);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
