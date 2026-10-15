import { relations } from "drizzle-orm";
import {
  decimal,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const products = pgTable(
  "products",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    name: varchar({ length: 255 }).notNull(),

    version: integer().notNull().default(1),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("products_id_idx").on(t.id),
    index("products_name_idx").on(t.name),
    unique("products_name_unique_idx").on(t.name),
  ],
);

export const product_variants = pgTable(
  "product_variants",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    product_id: integer()
      .references(() => products.id, {
        onUpdate: "cascade",
        onDelete: "cascade",
      })
      .notNull(),
    name: varchar({ length: 255 }).notNull(),
    sku: varchar({ length: 255 }).notNull(),
    description: varchar({ length: 255 }),
    price: decimal({ precision: 10, scale: 2 }).notNull(),
    unit: varchar({ length: 50 }).notNull(),
    weight_kg: decimal({ precision: 10, scale: 2 }),
    width_value: decimal({ precision: 10, scale: 2 }),
    width_unit: varchar({ length: 10 }),
    length_value: decimal({ precision: 10, scale: 2 }),
    length_unit: varchar({ length: 10 }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("product_variants_id_idx").on(t.id),
    unique("product_variants_product_id_sku_unique_idx").on(
      t.product_id,
      t.sku,
    ),
  ],
);

export const productRelations = relations(products, ({ many }) => ({
  variants: many(product_variants),
}));

export const productVariantRelations = relations(
  product_variants,
  ({ one }) => ({
    product: one(products, {
      fields: [product_variants.product_id],
      references: [products.id],
    }),
  }),
);

export type ProductInsert = Omit<
  typeof products.$inferInsert,
  "created_at" | "updated_at"
>;
export type ProductSelect = typeof products.$inferSelect;

export type ProductVariantInsert = Omit<
  typeof product_variants.$inferInsert,
  "created_at" | "updated_at"
>;
export type ProductVariantSelect = typeof product_variants.$inferSelect;
