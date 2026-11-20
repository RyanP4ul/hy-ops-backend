import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { warehouses } from "./warehouses";
import { product_variants } from "./products";
import { users } from "./users";

export const stock_transfers = pgTable(
  "stock_transfers",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    transfer_number: varchar("transfer_number", { length: 32 }).notNull().unique(),
    from_warehouse_id: integer("from_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    to_warehouse_id: integer("to_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    notes: text("notes"),
    requested_by: integer("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    dispatched_by: integer("dispatched_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    dispatched_at: timestamp("dispatched_at", { withTimezone: true }),
    received_by: integer("received_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    received_at: timestamp("received_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "stock_transfers_distinct_warehouses",
      sql`${table.from_warehouse_id} <> ${table.to_warehouse_id}`,
    ),
    check(
      "stock_transfers_status_valid",
      sql`${table.status} in ('draft', 'in_transit', 'received', 'cancelled')`,
    ),
    index("stock_transfers_from_warehouse_idx").on(table.from_warehouse_id),
    index("stock_transfers_to_warehouse_idx").on(table.to_warehouse_id),
  ],
);

export const stock_transfer_items = pgTable(
  "stock_transfer_items",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    transfer_id: integer("transfer_id")
      .notNull()
      .references(() => stock_transfers.id, { onDelete: "cascade" }),
    product_variant_id: integer("product_variant_id")
      .notNull()
      .references(() => product_variants.id, { onDelete: "restrict" }),
    quantity_sent: integer("quantity_sent").notNull(),
    quantity_received: integer("quantity_received"),
  },
  (table) => [
    unique("stock_transfer_item_unique").on(
      table.transfer_id,
      table.product_variant_id,
    ),
    check("stock_transfer_qty_positive", sql`${table.quantity_sent} > 0`),
    check(
      "stock_transfer_received_nonneg",
      sql`${table.quantity_received} is null or ${table.quantity_received} >= 0`,
    ),
  ],
);
