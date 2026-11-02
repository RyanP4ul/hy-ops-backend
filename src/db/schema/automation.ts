import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const automation_status = pgEnum("automation_status", [
  "ENABLED",
  "DISABLED",
  "FAILED",
]);

export const automations = pgTable(
  "automations",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    name: varchar({ length: 100 }).notNull(),
    description: text().notNull(),
    schedule: varchar({ length: 100 }).notNull(),
    interval_ms: integer("interval_ms"),
    daily_time: varchar("daily_time", { length: 5 }),
    status: automation_status().notNull().default("DISABLED"),
    notes: text(),
    last_run_at: timestamp("last_run_at", {
      withTimezone: true,
    }),
    next_run_at: timestamp("next_run_at", {
      withTimezone: true,
    }),
    last_error: text("last_error"),
    created_at: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("automations_name_unique").on(table.name)],
);

export type AutomationInsert = typeof automations.$inferInsert;
export type AutomationSelect = typeof automations.$inferSelect;
