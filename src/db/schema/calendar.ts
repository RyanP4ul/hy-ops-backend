import {
  integer,
  pgTable,
  varchar,
  time,
  date,
  pgEnum,
  timestamp,
} from "drizzle-orm/pg-core";

export const calendar_event_enum = pgEnum("calendar_event_enum", [
  "DELIVERY",
  "ORDER_FULFILLMENT",
  "INVENTORY_WAREHOUSE",
  "VEHICLE_MAINTENANCE",
  "STAFF_SCHEDULE",
  "MEETING_APPOINTMENT",
  "OTHER",
]);

export type CalendarEventType = (typeof calendar_event_enum.enumValues)[number];

export const calendar_events = pgTable("calendar_events", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  title: varchar({ length: 50 }).notNull(),
  category: calendar_event_enum().notNull().default("OTHER"),
  date: date().notNull(),
  start_time: time().notNull(),
  end_time: time().notNull(),
  version: integer().notNull().default(1),
  created_at: timestamp({
    withTimezone: true,
  }),
});

export type CalendarEventInsert = typeof calendar_events.$inferInsert;
export type CalendarEventSelect = typeof calendar_events.$inferSelect;
