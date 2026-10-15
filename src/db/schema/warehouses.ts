import { relations } from "drizzle-orm";
import { integer, pgTable, varchar, boolean } from "drizzle-orm/pg-core";
import { inventory } from "./inventory";

export const warehouses = pgTable("warehouses", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar().notNull(),
  street_address: varchar().notNull(),
  city: varchar().notNull(),
  state: varchar().notNull(),
  zip_code: varchar().notNull(),
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
