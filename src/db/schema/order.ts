import { sql } from "drizzle-orm";
import { inventory } from "./inventory";
import { products } from "./products";
import { customers, users } from "./users";
import {
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
} from "drizzle-orm/pg-core";

export const delivery_type = pgEnum("delivery_type", [
  "LALAMOVE",
  "PICKUP",
  "INTERNAL",
]);

export const order_status = pgEnum("order_status", [
  "PENDING",
  "PROCESSING",
  "READY_FOR_DELIVERY",
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

export const orders = pgTable("orders", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  order_number: varchar("order_number", {
    length: 32,
  })
    .notNull()
    .unique(),
  customer_id: integer("customer_id")
    .notNull()
    .references(() => customers.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  delivery_type: delivery_type("delivery_type").notNull().default("INTERNAL"),
  payment_arrangement: payment_arrangement("payment_arrangement").default(
    "NET_30",
  ),
  notes: text("notes"),
  status: order_status("status").notNull().default("PENDING"),

  shipping_recipient: text("shipping_recipient"),
  shipping_phone: text("shipping_phone"),
  shipping_address: text("shipping_address"),

  version: integer("version").notNull().default(1),

  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

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
