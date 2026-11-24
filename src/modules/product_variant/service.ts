import { db } from "@/db/index";
import { product_variants, products } from "@/db/schema/products";
import { inventory } from "@/db/schema/inventory";
import { and, asc, count, eq, ilike, notExists, or } from "drizzle-orm";

export abstract class ProductVariantService {
  static async getProductVariants(
    page: number = 0,
    limit: number = 10,
    search: string = "",
    excludeInventoryWarehouseId?: number,
  ) {
    const is_search_empty = search.length === 0;
    const offset = Math.max(page * limit, 0);

    const where = and(
      eq(products.is_active, true),
      eq(products.is_archived, false),
      !is_search_empty
        ? or(
            ilike(product_variants.sku, `%${search}%`),
            ilike(product_variants.name, `%${search}%`),
            ilike(products.name, `%${search}%`),
            ilike(product_variants.description, `%${search}%`),
          )
        : undefined,
      excludeInventoryWarehouseId === undefined
        ? undefined
        : notExists(
            db
              .select({ id: inventory.id })
              .from(inventory)
              .where(
                and(
                  eq(inventory.warehouse_id, excludeInventoryWarehouseId),
                  eq(inventory.product_variant_id, product_variants.id),
                ),
              ),
          ),
    );

    const [total] = await db
      .select({ value: count() })
      .from(product_variants)
      .innerJoin(products, eq(products.id, product_variants.product_id))
      .where(where);

    const product_variants_rows = await db
      .select({
        id: product_variants.id,
        sku: product_variants.sku,
        name: product_variants.name,
        variant_name: product_variants.name,
        product_name: products.name,
        description: product_variants.description,
        price: product_variants.price,
        unit: product_variants.unit,
        weight_kg: product_variants.weight_kg,
        width_value: product_variants.width_value,
        width_unit: product_variants.width_unit,
        length_value: product_variants.length_value,
        length_unit: product_variants.length_unit,
        product_id: product_variants.product_id,
      })
      .from(product_variants)
      .innerJoin(products, eq(products.id, product_variants.product_id))
      .where(where)
      .orderBy(asc(product_variants.id))
      .limit(limit)
      .offset(offset);

    return {
      rows: product_variants_rows,
      total: total.value,
    };
  }
}
