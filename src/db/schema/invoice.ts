import { inventory } from "./inventory";
import { orders } from "./order";
import { customers, users } from "./users";
import {
  integer,
  pgTable,
  text,
  jsonb,
  numeric,
  pgEnum,
  timestamp,
} from "drizzle-orm/pg-core";

export const invoice_status = pgEnum("invoice_status", [
  "DRAFT",
  "ISSUED",
  "VOID",
]);

export const invoices = pgTable("invoices", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  invoice_number: text().notNull(),
  order_id: integer()
    .notNull()
    .references(() => orders.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  customer_id: integer()
    .notNull()
    .references(() => customers.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  status: invoice_status().notNull().default("DRAFT"),
  issue_date: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const invoice_payments = pgTable("invoice_payments", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  invoice_id: integer()
    .notNull()
    .references(() => invoices.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  payment_method: text().notNull(),
  payment_details: jsonb().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type InvoiceInsert = typeof invoices.$inferInsert;
export type InvoiceSelect = typeof invoices.$inferSelect;
