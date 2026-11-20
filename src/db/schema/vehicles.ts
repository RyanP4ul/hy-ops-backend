import { boolean, check, index, integer, numeric, pgEnum, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { warehouses } from "./warehouses";
import { users } from "./users";

export const vehicleStatusEnum = pgEnum("vehicle_status_enum", [
  "available",
  "unavailable",
  "maintenance",
  "on_delivery",
]);

export const vehicleTypeEnum = pgEnum("vehicle_type_enum", [
  "truck",
  "van",
  "other",
]);

export const vehicles = pgTable("vehicles", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  warehouse_id: integer()
    .notNull()
    .references(() => warehouses.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  plate_number: varchar({ length: 255 }).notNull().unique(),
  status: vehicleStatusEnum().notNull().default("available"),
  type: vehicleTypeEnum().notNull().default("truck"),
  max_weight_kg: numeric("max_weight_kg", { precision: 10, scale: 2 }),
  max_volume_cbm: numeric("max_volume_cbm", { precision: 10, scale: 3 }),
  current_odometer_km: integer("current_odometer_km").notNull().default(0),
  next_service_odometer_km: integer("next_service_odometer_km"),
  is_archived: boolean().notNull().default(false),
  archived_at: integer(),
  is_active: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

export const vehicle_maintenance_logs = pgTable(
  "vehicle_maintenance_logs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    vehicle_id: integer("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade", onUpdate: "cascade" }),
    reported_by: integer("reported_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    completed_by: integer("completed_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    maintenance_type: varchar("maintenance_type", { length: 32 })
      .notNull()
      .default("repair"),
    status: varchar("status", { length: 24 }).notNull().default("open"),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description"),
    workshop_name: varchar("workshop_name", { length: 160 }),
    odometer_km: integer("odometer_km"),
    estimated_cost: numeric("estimated_cost", { precision: 12, scale: 2 }),
    actual_cost: numeric("actual_cost", { precision: 12, scale: 2 }),
    put_in_maintenance: boolean("put_in_maintenance").notNull().default(true),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expected_return_at: timestamp("expected_return_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vehicle_maintenance_logs_vehicle_idx").on(t.vehicle_id, t.status),
    check(
      "vehicle_maint_type_check",
      sql`${t.maintenance_type} IN ('preventive', 'repair', 'tire_battery', 'inspection', 'breakdown')`,
    ),
    check(
      "vehicle_maint_status_check",
      sql`${t.status} IN ('open', 'in_progress', 'completed', 'cancelled')`,
    ),
  ],
);

export type VehicleInsert = typeof vehicles.$inferInsert;
export type VehicleSelect = typeof vehicles.$inferSelect;
export type VehicleMaintenanceLogInsert = typeof vehicle_maintenance_logs.$inferInsert;
export type VehicleMaintenanceLogSelect = typeof vehicle_maintenance_logs.$inferSelect;
