import {
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { warehouses } from "./warehouses";
import { product_variants, products } from "./products";
import { relations, sql } from "drizzle-orm";

export const inventory = pgTable(
  "inventory",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    warehouse_id: integer()
      .notNull()
      .references(() => warehouses.id, {
        onDelete: "set null",
        onUpdate: "cascade",
      }),
    product_id: integer()
      .notNull()
      .references(() => products.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    product_variant_id: integer()
      .notNull()
      .references(() => product_variants.id, {
        onDelete: "set null",
        onUpdate: "cascade",
      }),
    quantity: integer().notNull(),
    reserved: integer().notNull().default(0),
    version: integer().notNull().default(1),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    unique("inventory_warehouse_product_id_product_variant_id_unique_idx").on(
      t.warehouse_id,
      t.product_id,
      t.product_variant_id,
    ),
  ],
);

export const inventoryRelations = relations(inventory, ({ one }) => ({
  warehouse: one(warehouses, {
    fields: [inventory.warehouse_id],
    references: [warehouses.id],
  }),
  product_variant: one(product_variants, {
    fields: [inventory.product_variant_id],
    references: [product_variants.id],
  }),
}));

export type InventoryInsert = typeof inventory.$inferInsert;
export type InventorySelect = typeof inventory.$inferSelect;
