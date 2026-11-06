import { sql } from "drizzle-orm";
import { warehouses } from "./warehouses";
import { inventory } from "./inventory";
import { products } from "./products";
import { customers, users } from "./users";
import {
  boolean,
  integer,
  pgTable,
  text,
  jsonb,
  numeric,
  pgEnum,
  unique,
  index,
  check,
  timestamp,
  varchar,
  uuid,
} from "drizzle-orm/pg-core";

export const order_status = pgEnum("order_status", [
  "PENDING",
  "PROCESSING",
  "SCHEDULING",
  "SCHEDULED",
  "IN_TRANSIT",
  "COMPLETED",
  "CANCELLED",
]);

export const payment_arrangement = pgEnum("payment_arrangement", [
  "FULLY_PAID",
  "PARTIALLY_PAID",
  "PAY_ON_DELIVERY",
  "NET_30",
]);

export const order_groups = pgTable("order_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  group_number: varchar("group_number", { length: 32 }).notNull().unique(),
  customer_id: integer("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  order_number: varchar("order_number", {
    length: 32,
  })
    .notNull()
    .unique(),
  warehouse_id: integer("warehouse_id")
    .notNull()
    .references(() => warehouses.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
  customer_id: integer("customer_id")
    .notNull()
    .references(() => customers.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  payment_arrangement: payment_arrangement("payment_arrangement").default(
    "NET_30",
  ),
  order_group_id: uuid("order_group_id").references(() => order_groups.id, { onDelete: "restrict" }),
  order_group_position: integer("order_group_position"),
  notes: text("notes"),
  stock_reserved: boolean("stock_reserved").notNull().default(false),
  status: order_status("status").notNull().default("PENDING"),

  shipping_recipient: text("shipping_recipient"),
  shipping_phone: text("shipping_phone"),
  shipping_address: text("shipping_address"),
  shipping_latitude: numeric("shipping_latitude", { precision: 10, scale: 6 }),
  shipping_longitude: numeric("shipping_longitude", { precision: 10, scale: 6 }),
  shipping_address_source_id: integer("shipping_address_source_id"),

  version: integer("version").notNull().default(1),

  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("orders_group_index").on(table.order_group_id),
  unique("orders_group_position_unique").on(table.order_group_id, table.order_group_position),
]);

export const order_items = pgTable(
  "order_items",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    order_id: integer("order_id")
      .notNull()
      .references(() => orders.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inventory_id: integer("inventory_id")
      .notNull()
      .references(() => inventory.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    quantity: integer("quantity").notNull(),
    unit_price_snapshot: numeric("unit_price_snapshot", {
      precision: 10,
      scale: 2,
    }),
    price_source: varchar("price_source", { length: 32 })
      .notNull()
      .default("legacy_unknown"),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("order_inventory_unique").on(table.order_id, table.inventory_id),
    index("order_id_index").on(table.order_id),
    index("inventory_id_index").on(table.inventory_id),
    check("quantity_check", sql`quantity > 0`),
  ],
);

export type OrderInsert = typeof orders.$inferInsert;
export type OrderSelect = typeof orders.$inferSelect;
export type OrderItemInsert = typeof order_items.$inferInsert;
export type OrderItemSelect = typeof order_items.$inferSelect;
