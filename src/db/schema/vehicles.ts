import { integer, pgEnum, pgTable, varchar } from "drizzle-orm/pg-core";

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
  plate_number: varchar({ length: 255 }).notNull().unique(),
  status: vehicleStatusEnum().notNull().default("available"),
  type: vehicleTypeEnum().notNull().default("truck"),
  image: varchar({ length: 255 }).notNull(),
  version: integer().notNull().default(1),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

export type VehicleInsert = typeof vehicles.$inferInsert;
export type VehicleSelect = typeof vehicles.$inferSelect;
