import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { deliveries_stops } from "./deliveries";
import { users } from "./users";

export const driver_stop_outcomes = pgTable("driver_stop_outcomes", {
  stop_id: integer().primaryKey().references(() => deliveries_stops.id, { onDelete: "restrict" }),
  actor_id: integer().notNull().references(() => users.id, { onDelete: "restrict" }),
  operation_key: uuid().notNull().unique(),
  outcome: text().notNull(),
  reason: text(),
  recorded_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("driver_outcome_valid", sql`${t.outcome} in ('delivered', 'failed')`),
  check("driver_failure_reason_required", sql`${t.outcome} <> 'failed' OR length(trim(${t.reason})) > 0 AND ${t.reason} IS NOT NULL`)]);
