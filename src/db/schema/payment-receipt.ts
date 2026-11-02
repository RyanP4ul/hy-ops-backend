import { integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { payments } from "./payment";
export const payment_receipts = pgTable("payment_receipts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  payment_id: integer().notNull().references(() => payments.id, { onDelete: "restrict" }),
  amount: numeric({ precision: 12, scale: 2 }).notNull(),
  kind: text().notNull().default("receipt"),
  received_at: timestamp({ withTimezone: true }).notNull(),
});
