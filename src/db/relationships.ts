import { relations } from "drizzle-orm";
import { inventory } from "./schema/inventory";
import { warehouses } from "./schema/warehouses";
import { product_variants, products } from "./schema/products";

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

export const warehouseRelations = relations(warehouses, ({ many }) => ({
  inventory: many(inventory),
}));
