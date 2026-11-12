import {
  check,
  date,
  integer,
  jsonb,
  numeric,
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

export type DriverStopPlan = {
  driverId: number;
  nextStopId: number | null;
  skippedStopIds: number[];
};

export const delivery_type = pgEnum("delivery_type", [
  "LALAMOVE",
  "PICKUP",
  "INTERNAL",
]);

export const deliveries_status = pgEnum("deliveries_status", [
  "scheduled",
  "in_transit",
  "completed",
  "returning",
  "cancelled",
]);

export const deliveries_stop_status = pgEnum("deliveries_stops_status", [
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
    driver_stop_plan: jsonb().$type<DriverStopPlan>(),
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

export const deliveries_stops = pgTable("deliveries_stops", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
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
  leg_index: integer().notNull().default(0),
  status: deliveries_stop_status().notNull().default("pending"),
  latitude: numeric("latitude", { precision: 10, scale: 6 }).notNull(),
  longitude: numeric("longitude", { precision: 10, scale: 6 }).notNull(),
  delivered_at: timestamp({ withTimezone: true }),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const deliveries_event = pgTable("deliveries_event", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
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

export const deliveries_expeneses_status_enum = pgEnum(
  "deliveries_expenses_status",
  ["pending", "approved", "rejected"],
);

export const deliveries_expenses = pgTable("deliveries_expenses", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  delivery_id: integer()
    .notNull()
    .references(() => deliveries.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  delivery_allowance: numeric("delivery_allowance", {
    precision: 12,
    scale: 2,
  }).notNull(),
  fuel: numeric("fuel", {
    precision: 12,
    scale: 2,
  }).notNull(),
  toll: numeric("toll", {
    precision: 12,
    scale: 2,
  }).notNull(),
  status: deliveries_expeneses_status_enum("status")
    .notNull()
    .default("pending"),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const deliveries_proof = pgTable("deliveries_proof", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  delivery_id: integer()
    .notNull()
    .references(() => deliveries.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  storage_key: varchar("storage_key", {
    length: 512,
  })
    .notNull()
    .unique(),
  content_type: varchar("content_type", {
    length: 128,
  })
    .notNull()
    .default("image/webp"),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type deliveriesInsert = typeof deliveries.$inferInsert;
export type deliveriesSelect = typeof deliveries.$inferSelect;
