import { db } from "@/db/index";
import { product_variants } from "@/db/schema/products";
import { inventory } from "@/db/schema/inventory";
import { and, asc, count, eq, ilike, notExists, sql } from "drizzle-orm";

export abstract class ProductVariantService {
  static async getProductVariants(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    excludeInventoryWarehouseId?: number,
  ) {
    const is_search_empty = search.length === 0;
    const offset = Math.max(page * limit, 0);

    const where = and(sql`exists (select 1 from products lifecycle_p where lifecycle_p.id = ${product_variants.product_id} and lifecycle_p.is_active and not lifecycle_p.is_archived)`, !is_search_empty
      ? ilike(product_variants.sku, `%${search}%`)
      : undefined,
      excludeInventoryWarehouseId === undefined ? undefined : notExists(
        db.select({ id: inventory.id }).from(inventory).where(and(
          eq(inventory.warehouse_id, excludeInventoryWarehouseId),
          eq(inventory.product_variant_id, product_variants.id),
        )),
      ));

    const [total] = await db.select({ value: count() }).from(product_variants).where(where);

    const product_variants_rows = await db.query.product_variants.findMany({
      columns: {
        id: true,
        sku: true,
        price: true,
        product_id: true,
      },
      where,
      limit,
      offset,
      orderBy: asc(product_variants.id),
    });

    return {
      rows: product_variants_rows,
      total: total.value,
    };
  }
}
