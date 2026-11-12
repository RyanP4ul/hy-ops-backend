import { relations } from "drizzle-orm";
import {
  integer,
  pgTable,
  varchar,
  boolean,
  numeric,
} from "drizzle-orm/pg-core";
import { inventory } from "./inventory";

export const warehouses = pgTable("warehouses", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar().notNull(),
  phone_number: varchar({ length: 20 }),
  street_address: varchar().notNull(),
  city: varchar().notNull(),
  state: varchar().notNull(),
  zip_code: varchar().notNull(),
  latitude: numeric(),
  longitude: numeric(),
  pickup_contact_name: varchar(),
  pickup_contact_phone: varchar(),
  is_active: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  is_archived: boolean().notNull().default(false),
  archived_at: integer(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

export const warehouseRelations = relations(warehouses, ({ many }) => ({
  inventory: many(inventory),
}));

export type WarehouseInsert = Omit<
  typeof warehouses.$inferInsert,
  "is_archived" | "archived_at"
>;
export type WarehouseSelect = Omit<
  typeof warehouses.$inferSelect,
  "is_archived" | "archived_at"
>;
