import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { deliveries, deliveries_stops } from "./deliveries";
import { inventory } from "./inventory";
import { orders } from "./order";
import { users } from "./users";
import { warehouses } from "./warehouses";

export const customer_returns = pgTable("customer_returns", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  order_id: integer().notNull().unique().references(() => orders.id, { onDelete: "restrict" }),
  source_stop_id: integer().notNull().unique().references(() => deliveries_stops.id, { onDelete: "restrict" }),
  warehouse_id: integer().notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  requested_by: integer().notNull().references(() => users.id, { onDelete: "restrict" }),
  request_key: uuid().notNull().unique(), reason: text().notNull(),
  status: text().notNull().default("requested"), version: integer().notNull().default(1),
  address: text().notNull(), recipient: text().notNull(), phone: text(),
  latitude: text(), longitude: text(),
  assigned_delivery_id: integer().references(() => deliveries.id, { onDelete: "restrict" }),
  assignment_key: uuid().unique(), assigned_by: integer().references(() => users.id, { onDelete: "restrict" }),
  collected_by: integer().references(() => users.id, { onDelete: "restrict" }), collection_key: uuid().unique(),
  collected_at: timestamp({ withTimezone: true }), received_at: timestamp({ withTimezone: true }),
  received_by: integer().references(() => users.id, { onDelete: "restrict" }),
  failure_reason: text(),
  failed_by: integer().references(() => users.id, { onDelete: "restrict" }),
  failed_at: timestamp({ withTimezone: true }),
  failure_key: uuid().unique(),
  cancellation_reason: text(),
  cancelled_by: integer().references(() => users.id, { onDelete: "restrict" }),
  cancelled_at: timestamp({ withTimezone: true }),
  disposition: text(),
  disposition_notes: text(),
  disposition_by: integer().references(() => users.id, { onDelete: "restrict" }),
  disposition_at: timestamp({ withTimezone: true }),
  disposition_key: uuid().unique(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(), updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("customer_return_status", sql`${table.status} in ('requested','assigned','collected','received','failed','cancelled')`),
  check("customer_return_reason", sql`length(trim(${table.reason})) > 0`),
  check("customer_return_assignment", sql`(${table.status} in ('requested','cancelled') and ${table.assigned_delivery_id} is null) or (${table.status} in ('assigned','collected','received','failed') and ${table.assigned_delivery_id} is not null)`),
  check("customer_return_failure_reason", sql`${table.status} <> 'failed' or (${table.failure_reason} is not null and length(trim(${table.failure_reason})) > 0)`),
  check("customer_return_disposition_valid", sql`${table.disposition} is null or ${table.disposition} in ('restocked','damaged','partial')`),
  index("customer_return_warehouse_status").on(table.warehouse_id, table.status),
  index("customer_return_delivery").on(table.assigned_delivery_id),
]);

export const customer_return_disposition_items = pgTable("customer_return_disposition_items", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  return_id: integer().notNull().references(() => customer_returns.id, { onDelete: "cascade" }),
  inventory_id: integer().notNull().references(() => inventory.id, { onDelete: "restrict" }),
  restocked_qty: integer().notNull().default(0),
  damaged_qty: integer().notNull().default(0),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique("customer_return_disposition_item_unique").on(table.return_id, table.inventory_id),
  check("customer_return_disposition_qty_nonneg", sql`${table.restocked_qty} >= 0 and ${table.damaged_qty} >= 0 and (${table.restocked_qty} + ${table.damaged_qty}) > 0`),
]);
