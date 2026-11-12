import { boolean, integer, pgEnum, pgTable, varchar } from "drizzle-orm/pg-core";
import { warehouses } from "./warehouses";

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
  is_archived: boolean().notNull().default(false),
  archived_at: integer(),
  is_active: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

export type VehicleInsert = typeof vehicles.$inferInsert;
export type VehicleSelect = typeof vehicles.$inferSelect;
