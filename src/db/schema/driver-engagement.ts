import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { deliveries_stops } from "./deliveries";
import { customer_returns } from "./customer-returns";
import { users } from "./users";

export const driver_stop_proofs = pgTable("driver_stop_proofs", {
  id: uuid().primaryKey(), stop_id: integer().notNull().references(() => deliveries_stops.id, { onDelete: "restrict" }),
  actor_id: integer().notNull().references(() => users.id, { onDelete: "restrict" }), operation_key: uuid().notNull().unique(),
  kind: text().notNull(), storage_key: text().notNull().unique(), content_type: text().notNull(),
  sha256: text().notNull(), byte_size: integer().notNull(), created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, t => [unique("driver_proof_stop_operation").on(t.stop_id, t.operation_key), index("driver_proofs_stop_idx").on(t.stop_id)]);

export const driver_return_proofs = pgTable("driver_return_proofs", {
  id: uuid().primaryKey(),
  return_id: integer("return_id").notNull().references(() => customer_returns.id, { onDelete: "restrict" }),
  actor_id: integer("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  operation_key: uuid("operation_key").notNull().unique(),
  kind: text("kind").notNull(),
  storage_key: text("storage_key").notNull().unique(),
  content_type: text("content_type").notNull(),
  sha256: text("sha256").notNull(),
  byte_size: integer("byte_size").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("driver_return_proof_operation").on(t.return_id, t.operation_key),
  index("driver_return_proofs_return_idx").on(t.return_id),
]);
