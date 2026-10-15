import { db } from "@/db/index";
import { product_variants } from "@/db/schema/products";
import { ilike } from "drizzle-orm";

export abstract class ProductVariantService {
  static async getProductVariants(
    page: number = 1,
    limit: number = 10,
    search: string = "",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;

    const where = !is_search_empty
      ? ilike(product_variants.sku, `%${search}%`)
      : undefined;

    const total_page = await db.query.product_variants.findMany({
      columns: {
        id: true,
      },
      where,
    });

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
    });

    return {
      rows: product_variants_rows,
      total: total_page.length,
    };
  }
}
