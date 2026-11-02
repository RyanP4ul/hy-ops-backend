import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { deliveries_stops } from "./deliveries";
import { users } from "./users";

export const driver_stop_proofs = pgTable("driver_stop_proofs", {
  id: uuid().primaryKey(), stop_id: integer().notNull().references(() => deliveries_stops.id, { onDelete: "restrict" }),
  actor_id: integer().notNull().references(() => users.id, { onDelete: "restrict" }), operation_key: uuid().notNull().unique(),
  kind: text().notNull(), storage_key: text().notNull().unique(), content_type: text().notNull(),
  sha256: text().notNull(), byte_size: integer().notNull(), created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, t => [unique("driver_proof_stop_operation").on(t.stop_id, t.operation_key), index("driver_proofs_stop_idx").on(t.stop_id)]);
