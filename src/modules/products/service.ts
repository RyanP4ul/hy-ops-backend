import { db } from "@/db/index";
import { inventory } from "@/db/schema/inventory";
import {
  product_variants,
  ProductInsert,
  products,
  ProductVariantInsert,
} from "@/db/schema/products";
import { and, desc, eq, ilike } from "drizzle-orm";

export abstract class ProductService {
  static async getProductById(id: number) {
    const product = await db.query.products.findFirst({
      columns: {
        created_at: false,
        updated_at: false,
      },
      where: eq(products.id, id),
      with: {
        variants: {
          columns: {
            product_id: false,
            created_at: false,
            updated_at: false,
          },
        },
      },
    });
    return product;
  }

  static async getProductVariant(id: number, product_id: number) {
    const variant = await db.query.product_variants.findFirst({
      columns: {
        id: false,
        product_id: false,
        created_at: false,
        updated_at: false,
      },
      where: and(
        eq(product_variants.id, id),
        eq(product_variants.product_id, product_id),
      ),
    });
    return variant;
  }

  static async getProductByOffset(
    page: number = 1,
    limit: number = 10,
    search: string = "",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;

    const where = !is_search_empty
      ? ilike(products.name, `%${search}%`)
      : undefined;

    const total_page = await db.query.products.findMany({
      columns: {
        id: true,
      },
      where,
    });

    const lists = await db.query.products.findMany({
      columns: {
        created_at: false,
        updated_at: false,
      },
      offset,
      where,
      limit,
      orderBy: desc(products.id),
      with: {
        variants: {
          columns: {
            product_id: false,
            created_at: false,
            updated_at: false,
          },
        },
      },
    });

    return {
      rows: lists,
      total: total_page.length,
    };
  }

  static async doesProductExistByName(name: string): Promise<boolean> {
    const product = await db.query.products.findFirst({
      columns: { id: true },
      where: eq(products.name, name),
    });

    return product !== undefined;
  }

  static async createProduct(
    data: Required<
      ProductInsert & {
        variants: Omit<ProductVariantInsert, "product_id">[];
      }
    >,
  ) {
    const result = await db.transaction(async (tx) => {
      const [product] = await tx
        .insert(products)
        .values({
          ...data,
        })
        .returning({
          id: products.id,
        });

      if (!product) {
        throw new Error("Failed to create product.");
      }

      const variants = await tx
        .insert(product_variants)
        .values(
          data.variants.map((variant) => ({
            ...variant,
            product_id: product.id,
          })),
        )
        .returning({
          id: product_variants.id,
          sku: product_variants.sku,
        });

      if (!variants) {
        throw new Error("Failed to create product variants.");
      }

      return {
        product,
        variants,
      };
    });

    if (!result) {
      throw new Error("Failed to create product and variants.");
    }

    return result;
  }

  static async updateProductVariant(
    tx: any,
    product_id: number,
    variant: Omit<ProductVariantInsert & { id: Number }, "product_id">,
  ) {
    const { id, ...data } = variant;

    const variantResult = await tx
      .update(product_variants)
      .set(data)
      .where(
        and(
          eq(product_variants.id, Number(variant.id)),
          eq(product_variants.product_id, product_id),
        ),
      );

    if (variantResult.rowCount === 0) {
      throw new Error(
        "Failed to update product variant. Version mismatch or variant not found.",
      );
    }
  }

  static async createProductVariant(
    tx: any,
    product_id: number,
    variant: Omit<ProductVariantInsert & { id: Number }, "product_id">,
  ) {
    const { id, ...data } = variant;

    return await tx.insert(product_variants).values({
      ...data,
      product_id: product_id,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    });
  }

  static async updateProductById(
    product_id: number,
    data: Required<ProductInsert> & {
      variants: Omit<ProductVariantInsert & { id: Number }, "product_id">[];
    },
  ): Promise<Boolean> {
    return await db.transaction(async (tx) => {
      const result = await tx
        .update(products)
        .set({
          ...data,
          version: (data.version || 0) + 1,
        })
        .where(
          and(
            eq(products.id, product_id),
            eq(products.version, data.version || 0),
          ),
        );

      if (result.rowCount === 0) {
        throw new Error(
          "Failed to update product. Version mismatch or product not found.",
        );
      }

      for (const variant of data.variants) {
        const product_variant = await this.getProductVariant(
          Number(variant.id),
          product_id,
        );

        if (!product_variant) {
          await this.createProductVariant(tx, product_id, variant);
        } else {
          await this.updateProductVariant(tx, product_id, variant);
        }
      }

      return true;
    });
  }

  static async deleteProductById(
    product_id: number,
    version: number,
  ): Promise<Boolean> {
    return await db.transaction(async (tx) => {
      const result = await tx
        .delete(products)
        .where(and(eq(products.id, product_id), eq(products.version, version)));

      if (result.rowCount === 0) {
        return false;
      }

      return true;
    });
  }
}
