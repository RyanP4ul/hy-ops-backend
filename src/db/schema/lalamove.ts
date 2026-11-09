import { users } from "./users";
import { orders } from "./order";
import { sql } from "drizzle-orm";
import { integer, pgTable, text, jsonb, numeric, timestamp, uuid, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// export const pod_enum = pgEnum("pod_enum", ["PENDING", "DELIVERED", "SIGNED", "FAILED"]);

export const delivery_orders = pgTable("delivery_orders", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  order_id: integer().references(() => orders.id, { onDelete: "restrict" }),
  environment: text().notNull().default("sandbox"),
  market: text().notNull().default("PH"),
  booking_state: text().notNull().default("CONFIRMED"),
  active: boolean().notNull().default(false),
  idempotency_key: uuid().unique(),
  request_fingerprint: text(),
  service_type: text(),
  route_snapshot: jsonb(),
  share_link: text(),
  driver_id: text(),
  driver_details: jsonb(),
  failure_message: text(),
  resolution_note: text(),
  last_synced_at: timestamp({ withTimezone: true }),
  picked_up_at: timestamp({ withTimezone: true }),
  completed_at: timestamp({ withTimezone: true }),
  lalamove_order_id: text("lalamove_order_id"),
  quotation_id: text("quotation_id").notNull(),

  booked_by: integer("booked_by")
    .notNull()
    .references(() => users.id),

  recipient_name: text("recipient_name").notNull(),
  recipient_phone: text("recipient_phone").notNull(),

  pickup_address: text("pickup_address").notNull(),
  dropoff_address: text("dropoff_address").notNull(),

  delivery_fee: numeric("delivery_fee", {
    precision: 12,
    scale: 2,
  }),

  currency: text("currency"),
  // status: pgEnum("status", ["PENDING", "DELIVERED", "SIGNED", "FAILED"]).notNull().default("PENDING"),
  status: text("status").notNull().default("PENDING"),

  lalamove_response: jsonb("lalamove_response"),

  created_at: integer()
    .notNull()
    .default(sql`extract(epoch from now())::integer`),
  updated_at: integer()
    .notNull()
    .default(sql`extract(epoch from now())::integer`),
}, (table) => [uniqueIndex("lalamove_active_order_unique").on(table.order_id).where(sql`${table.active} = true`),
  uniqueIndex("lalamove_provider_order_unique").on(table.environment, table.market, table.lalamove_order_id)]);

export const lalamove_quotations = pgTable("lalamove_quotations", {
  id: uuid().primaryKey().defaultRandom(),
  order_id: integer().notNull().references(() => orders.id, { onDelete: "restrict" }),
  booked_by: integer().notNull().references(() => users.id),
  order_version: integer().notNull(),
  environment: text().notNull(),
  market: text().notNull(),
  fingerprint: text().notNull(),
  route: jsonb().notNull(),
  provider_quote: jsonb().notNull(),
  expires_at: timestamp({ withTimezone: true }).notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const lalamove_events = pgTable("lalamove_events", {
  id: uuid().primaryKey().defaultRandom(),
  dedupe_key: text().notNull().unique(),
  environment: text().notNull(),
  event_type: text().notNull(),
  provider_order_id: text(),
  payload: jsonb().notNull(),
  state: text().notNull().default("PENDING"),
  attempts: integer().notNull().default(0),
  last_error: text(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  processed_at: timestamp({ withTimezone: true }),
  next_attempt_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const lalamove_provider_ids = pgTable("lalamove_provider_ids", {
  identity: text().primaryKey(),
  booking_id: integer().notNull().references(() => delivery_orders.id, { onDelete: "restrict" }),
});

export type DeliveryOrderInsert = typeof delivery_orders.$inferInsert;
export type DeliveryOrderSelect = typeof delivery_orders.$inferSelect;
