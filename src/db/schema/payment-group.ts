import { sql } from "drizzle-orm";
import { check, integer, numeric, pgTable, primaryKey, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { customers } from "./users";
import { payment_method, payments } from "./payment";

// These are immutable checkout receipts. Financial totals continue to use the
// per-order receipt allocations, so the parent amount is never counted twice.
export const payment_groups = pgTable("payment_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  payment_number: varchar("payment_number", { length: 32 }).notNull().unique(),
  customer_id: integer("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
  payment_method: payment_method("payment_method").notNull(),
  payment_type: varchar("payment_type", { length: 100 }),
  reference_number: varchar("reference_number", { length: 100 }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  received_at: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [check("payment_group_amount_positive", sql`${table.amount} > 0`)]);

export const payment_group_allocations = pgTable("payment_group_allocations", {
  group_id: uuid("group_id").notNull().references(() => payment_groups.id, { onDelete: "restrict" }),
  payment_id: integer("payment_id").notNull().references(() => payments.id, { onDelete: "restrict" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
}, table => [
  primaryKey({ columns: [table.group_id, table.payment_id] }),
  unique("payment_group_allocation_payment_unique").on(table.payment_id),
  check("payment_group_allocation_nonnegative", sql`${table.amount} >= 0`),
]);
