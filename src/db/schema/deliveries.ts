import {
  check,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { vehicles } from "./vehicles";
import { orders } from "./order";
import { sql } from "drizzle-orm";

export const delivery_type = pgEnum("delivery_type", [
  "LALAMOVE",
  "PICKUP",
  "INTERNAL",
]);

export const deliveries_status = pgEnum("deliveries_status", [
  "scheduled",
  "in_transit",
  "completed",
  "cancelled",
]);

export const deliveries_orders_status = pgEnum("deliveries_orders_status", [
  "pending",
  "delivered",
  "failed",
]);

export const deliveries_event_type = pgEnum("deliveries_event_type", [
  "CANCELLED",
  "RESCHEDULED",
  "DELAYED",
  "FAILED",
]);

export const deliveries = pgTable(
  "deliveries",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    driver_id: integer()
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    vehicle_id: integer()
      .notNull()
      .references(() => vehicles.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    scheduled_date: date().notNull(),
    departure_time: time().notNull(),
    delivery_type: delivery_type("delivery_type").notNull().default("INTERNAL"),
    status: deliveries_status().notNull().default("scheduled"),
    version: integer().notNull().default(1),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("unique_delivery").on(
      table.driver_id,
      table.scheduled_date,
      table.departure_time,
    ),
  ],
);

export const deliveries_orders = pgTable("deliveries_orders", {
  delivery_id: integer()
    .notNull()
    .references(() => deliveries.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  order_id: integer()
    .notNull()
    .references(() => orders.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  status: deliveries_orders_status().notNull().default("pending"),
  delivered_at: timestamp({ withTimezone: true }),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const deliveries_event = pgTable("deliveries_event", {
  delivery_id: integer()
    .notNull()
    .references(() => deliveries.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  event_type: deliveries_event_type("event_type").notNull(),
  reason: text("reason"),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type deliveriesInsert = typeof deliveries.$inferInsert;
export type deliveriesSelect = typeof deliveries.$inferSelect;
