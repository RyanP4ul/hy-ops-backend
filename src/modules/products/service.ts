import { WorkflowError } from "../../utils/workflow-error";
import { db } from "@/db/index";
import { inventory } from "@/db/schema/inventory";
import {
  product_variants,
  ProductInsert,
  products,
  ProductVariantInsert,
} from "@/db/schema/products";
import { and, desc, eq, ilike, or, sql, notInArray } from "drizzle-orm";

function productConflict(error: unknown): never {
  const detail = error as { code?: string; cause?: { code?: string } };
  if (detail?.code === "23505" || detail?.cause?.code === "23505") throw new WorkflowError("A product name or variant SKU is already in use. Choose a unique value.", 409);
  throw error;
}

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
    variantFilter: string = "all",
  ) {
    const offset = Math.max(page * limit, 0);
    const variantExists = sql`exists (select 1 from product_variants pv where pv.product_id = ${products.id})`;
    const where = and(search ? or(ilike(products.name, `%${search}%`), sql`exists (select 1 from product_variants pv where pv.product_id = ${products.id} and (pv.name ilike ${`%${search}%`} or pv.sku ilike ${`%${search}%`}))`) : undefined,
      variantFilter === "with" ? variantExists : variantFilter === "without" ? sql`not (${variantExists})` : undefined);

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
        throw new WorkflowError("Failed to create product.");
      }

      const variants = data.variants.length ? await tx
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
        }) : [];

      if (!variants) {
        throw new WorkflowError("Failed to create product variants.");
      }

      return {
        product,
        variants,
      };
    }).catch(productConflict);

    if (!result) {
      throw new WorkflowError("Failed to create product and variants.");
    }

    return result;
  }

  static async updateProductVariant(
    tx: any,
    product_id: number,
    variant: Omit<ProductVariantInsert & { id?: number }, "product_id">,
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

    if (variantResult.count === 0) {
      throw new WorkflowError(
        "Failed to update product variant. Version mismatch or variant not found.",
      );
    }
  }

  static async createProductVariant(
    tx: any,
    product_id: number,
    variant: Omit<ProductVariantInsert & { id?: number }, "product_id">,
  ) {
    const { id, ...data } = variant;

    return await tx.insert(product_variants).values({
      ...data,
      product_id: product_id,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  static async updateProductById(
    product_id: number,
    data: Required<ProductInsert> & {
      variants: Omit<ProductVariantInsert & { id?: number }, "product_id">[];
    },
  ): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const result = await tx
        .update(products)
        .set({
          name: data.name,
          version: (data.version || 0) + 1,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(products.id, product_id),
            eq(products.version, data.version || 0),
          ),
        );

      if (result.count === 0) {
        throw new WorkflowError(
          "Failed to update product. Version mismatch or product not found.",
        );
      }

      const retained = data.variants.map((variant) => Number(variant.id)).filter((id) => id > 0);
      const removed = await tx.select({ id: product_variants.id }).from(product_variants).where(and(eq(product_variants.product_id, product_id), retained.length ? notInArray(product_variants.id, retained) : undefined)).for("update");
      for (const variant of removed) {
        const [stock] = await tx.select({ id: inventory.id }).from(inventory).where(eq(inventory.product_variant_id, variant.id)).limit(1);
        if (stock) throw new WorkflowError("A variant used by inventory cannot be removed. Keep it to preserve stock and order history.");
        await tx.delete(product_variants).where(eq(product_variants.id, variant.id));
      }
      for (const variant of data.variants) {
        if (!variant.id) { await this.createProductVariant(tx, product_id, variant); continue; }
        const [product_variant] = await tx.select({ id: product_variants.id }).from(product_variants).where(and(eq(product_variants.id, Number(variant.id)), eq(product_variants.product_id, product_id)));

        if (!product_variant) {
          await this.createProductVariant(tx, product_id, variant);
        } else {
          await this.updateProductVariant(tx, product_id, variant);
        }
      }

      return true;
    }).catch(productConflict);
  }

  static async deleteProductById(
    product_id: number,
    version: number,
  ): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, product_id), eq(products.version, version))).for("update");
      if (!product) throw new WorkflowError("Product changed or no longer exists. Refresh before deleting.");
      const [stock] = await tx.select({ id: inventory.id }).from(inventory).where(eq(inventory.product_id, product_id)).limit(1);
      if (stock) throw new WorkflowError("Products linked to inventory cannot be deleted. Their stock and history must be retained.");
      const result = await tx
        .delete(products)
        .where(and(eq(products.id, product_id), eq(products.version, version)));

      if (result.count === 0) {
        return false;
      }

      return true;
    });
  }
}
