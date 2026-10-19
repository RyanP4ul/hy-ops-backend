import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { customers } from "./users";
import { sql } from "drizzle-orm";
import { orders } from "./order";

export const payment_method = pgEnum("payment_method", [
  "CASH",
  "BANK_TRANSFER",
  "CARD",
]);

export type PaymentMethodType = (typeof payment_method.enumValues)[number];

export const payment_status = pgEnum("payment_status", [
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
]);

export const payments = pgTable(
  "payments",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    payment_number: varchar({ length: 32 }).notNull().unique(),
    order_id: integer("order_id")
      .notNull()
      .references(() => orders.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    customer_id: integer("customer_id")
      .notNull()
      .references(() => customers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    payment_method: payment_method("payment_method").notNull(),
    payment_status: payment_status("payment_status")
      .notNull()
      .default("UNPAID"),
    amount: numeric("amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    reference_number: varchar("reference_number", {
      length: 100,
    }),
    version: integer("version").notNull().default(1),
    received_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_payment_order_id").on(table.order_id),
    index("idx_payment_customer_id").on(table.customer_id),
    unique("unique_payment_number").on(table.payment_number),
    check("payment_amount_check", sql`${table.amount} >= 0`),
  ],
);

export type PaymentInsert = typeof payments.$inferInsert;
export type PaymentSelect = typeof payments.$inferSelect;
