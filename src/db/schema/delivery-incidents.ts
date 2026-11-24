import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { deliveries, deliveries_stops } from "./deliveries";
import { users } from "./users";
import { vehicles } from "./vehicles";

export const deliveryIncidentCategoryEnum = pgEnum(
  "delivery_incident_category",
  ["DELAY", "TRAFFIC", "BREAKDOWN", "ACCIDENT", "WEATHER", "OTHER"],
);

export const deliveryIncidentSeverityEnum = pgEnum(
  "delivery_incident_severity",
  ["low", "medium", "high", "critical"],
);

export const deliveryIncidentStatusEnum = pgEnum("delivery_incident_status", [
  "open",
  "acknowledged",
  "resolved",
]);

export const delivery_incidents = pgTable(
  "delivery_incidents",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    delivery_id: integer()
      .notNull()
      .references(() => deliveries.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    stop_id: integer().references(() => deliveries_stops.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    vehicle_id: integer().references(() => vehicles.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    reported_by: integer()
      .notNull()
      .references(() => users.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    category: deliveryIncidentCategoryEnum().notNull(),
    severity: deliveryIncidentSeverityEnum().notNull().default("medium"),
    status: deliveryIncidentStatusEnum().notNull().default("open"),
    description: text().notNull(),
    status_notes: text(),
    estimated_delay_minutes: integer(),
    latitude: numeric({ precision: 9, scale: 6 }),
    longitude: numeric({ precision: 9, scale: 6 }),
    resolved_by: integer().references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    resolved_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("delivery_incidents_delivery_idx").on(t.delivery_id),
    index("delivery_incidents_status_idx").on(t.status),
    index("delivery_incidents_created_idx").on(t.created_at),
  ],
);

export type DeliveryIncidentCategory =
  (typeof deliveryIncidentCategoryEnum.enumValues)[number];
export type DeliveryIncidentSeverity =
  (typeof deliveryIncidentSeverityEnum.enumValues)[number];
export type DeliveryIncidentStatus =
  (typeof deliveryIncidentStatusEnum.enumValues)[number];
export type DeliveryIncidentSelect = typeof delivery_incidents.$inferSelect;
export type DeliveryIncidentInsert = typeof delivery_incidents.$inferInsert;
