import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { deliveries_stops } from "./deliveries";
import { delivery_orders } from "./lalamove";

export const delivery_notifications = pgTable("delivery_notifications", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  stop_id: integer().references(() => deliveries_stops.id, { onDelete: "cascade" }),
  booking_id: integer().references(() => delivery_orders.id, { onDelete: "restrict" }),
  channel: text({ enum: ["sms", "email"] }).notNull(),
  event_key: text().notNull().default("delivered"),
  event_type: text({ enum: ["delivered", "cancelled", "rescheduled"] }).notNull().default("delivered"),
  scheduled_at: timestamp({ withTimezone: true }),
  reason: text(),
  recipient: text(),
  status: text({ enum: ["pending", "sending", "sent", "failed", "skipped"] }).notNull().default("pending"),
  provider_id: text(),
  error: text(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique("delivery_notification_stop_event_channel").on(table.stop_id, table.event_key, table.channel),
  unique("delivery_notification_booking_event_channel").on(table.booking_id, table.event_key, table.channel),
  check("delivery_notification_owner_valid", sql`(${table.stop_id} is not null)::integer + (${table.booking_id} is not null)::integer = 1`),
  index("delivery_notification_status_idx").on(table.status),
  check("delivery_notification_channel_valid", sql`${table.channel} in ('sms', 'email')`),
  check("delivery_notification_event_valid", sql`${table.event_type} in ('delivered', 'cancelled', 'rescheduled')`),
  check("delivery_notification_status_valid", sql`${table.status} in ('pending', 'sending', 'sent', 'failed', 'skipped')`),
]);
