import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { deliveries, deliveries_stops } from "./deliveries";
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
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(), updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("customer_return_status", sql`${table.status} in ('requested','assigned','collected','received')`),
  check("customer_return_reason", sql`length(trim(${table.reason})) > 0`),
  check("customer_return_assignment", sql`(${table.status} = 'requested' and ${table.assigned_delivery_id} is null) or (${table.status} <> 'requested' and ${table.assigned_delivery_id} is not null)`),
  index("customer_return_warehouse_status").on(table.warehouse_id, table.status),
  index("customer_return_delivery").on(table.assigned_delivery_id),
]);
