import { sql } from "drizzle-orm";
import { check, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { payments } from "./payment";
import { users } from "./users";
export const payment_refunds = pgTable("payment_refunds", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  payment_id: integer().notNull().references(() => payments.id, { onDelete: "restrict" }),
  actor_id: integer().notNull().references(() => users.id, { onDelete: "restrict" }),
  request_id: uuid().notNull().unique(),
  amount: numeric({ precision: 12, scale: 2 }).notNull(),
  reason: text().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [check("payment_refunds_amount_check", sql`${table.amount} > 0`), check("payment_refunds_reason_check", sql`length(trim(${table.reason})) > 0`)]);
