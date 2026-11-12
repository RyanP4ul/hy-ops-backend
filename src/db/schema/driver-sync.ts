import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

// Receipts intentionally survive assignment changes and are never served to another actor.
export const driver_sync_receipts = pgTable("driver_sync_receipts", {
  operation_key: uuid().primaryKey(),
  actor_id: integer().notNull().references(() => users.id, { onDelete: "restrict" }),
  request_hash: text().notNull(),
  result: jsonb().$type<Record<string, unknown>>().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, t => [index("driver_sync_receipts_actor_idx").on(t.actor_id)]);
