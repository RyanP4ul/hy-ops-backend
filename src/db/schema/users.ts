import {
  integer,
  pgTable,
  varchar,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";

export const roleEnums = pgEnum("role", [
  "admin",
  "staff",
  "customer",
  "driver",
]);
export const driverStatusEnums = pgEnum("driver_status", [
  "available",
  "unavailable",
  "day_off",
  "on_delivery",
  "on_break",
  "on_leave",
  "on_accident",
  "on_personal_leave",
  "on_sick_leave",
]);

export type DriverStatus = (typeof driverStatusEnums.enumValues)[number];

export const users = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: varchar().notNull().unique(),
  name: varchar().notNull(),
  password_hash: varchar().notNull(),
  role: roleEnums().notNull(),
  refresh_token: varchar(),
  token_version: integer().default(0).notNull(),
  last_login: integer(),
  version: integer().default(1).notNull(),
  is_archived: boolean().default(false).notNull(),
  archived_at: integer(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

export type UserRole = (typeof roleEnums.enumValues)[number];
export type UserInsert = typeof users.$inferInsert;
export type UserSelect = typeof users.$inferSelect;

export const customers = pgTable("customers", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  user_id: integer()
    .notNull()
    .references(() => users.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  company_name: varchar().notNull().default("none"),
  address: varchar().notNull(),
  phone_number: varchar().notNull(),
});

export type CustomerInsert = typeof customers.$inferInsert;
export type CustomerSelect = typeof customers.$inferSelect;

export const drivers = pgTable("drivers", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  user_id: integer()
    .notNull()
    .references(() => users.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  status: driverStatusEnums().notNull().default("available"),
  phone_number: varchar().notNull(),
});

export type DriverInsert = typeof drivers.$inferInsert;
export type DriverSelect = typeof drivers.$inferSelect;
