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
import { generateHyphenatedSku, isValidSku, normalizeSku } from "./sku";

type ProductVariantInput = Omit<ProductVariantInsert, "product_id" | "sku"> & {
  id?: number;
  sku?: string;
};

async function resolveVariantSku(
  tx: any,
  productName: string,
  variant: ProductVariantInput,
  batchUsedSkus: Set<string>,
  excludeVariantId?: number,
): Promise<string> {
  const rawSku = variant.sku?.trim() ?? "";
  if (rawSku && rawSku.toUpperCase() !== "HY-") {
    const normalized = normalizeSku(rawSku);
    if (!isValidSku(normalized)) {
      throw new WorkflowError(
        `SKU "${rawSku}" must use letters, numbers, and hyphens (e.g., HY-LN-32MM).`,
      );
    }
    batchUsedSkus.add(normalized);
    return normalized;
  }

  const existingRows: { id: number; sku: string }[] = await tx
    .select({ id: product_variants.id, sku: product_variants.sku })
    .from(product_variants);
  const used = new Set<string>(batchUsedSkus);
  for (const row of existingRows) {
    if (excludeVariantId !== undefined && row.id === excludeVariantId) continue;
    used.add(normalizeSku(row.sku));
  }

  const generated = generateHyphenatedSku(productName, variant.name, used);
  batchUsedSkus.add(generated);
  return generated;
}

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
      where: and(eq(products.id, id), eq(products.is_archived, false)),
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
    const where = and(eq(products.is_archived, false), search ? or(ilike(products.name, `%${search}%`), sql`exists (select 1 from product_variants pv where pv.product_id = ${products.id} and (pv.name ilike ${`%${search}%`} or pv.sku ilike ${`%${search}%`}))`) : undefined,
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
        variants: ProductVariantInput[];
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

      const batchUsedSkus = new Set<string>();
      const preparedVariants: ProductVariantInsert[] = [];
      for (const variant of data.variants) {
        const sku = await resolveVariantSku(tx, data.name, variant, batchUsedSkus);
        preparedVariants.push({
          ...variant,
          sku,
          product_id: product.id,
        });
      }

      const variants = preparedVariants.length
        ? await tx
            .insert(product_variants)
            .values(preparedVariants)
            .returning({
              id: product_variants.id,
              sku: product_variants.sku,
            })
        : [];

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
    productName: string,
    variant: ProductVariantInput,
    batchUsedSkus: Set<string>,
  ) {
    const { id, ...rest } = variant;
    const sku = await resolveVariantSku(
      tx,
      productName,
      variant,
      batchUsedSkus,
      Number(id),
    );

    const variantResult = await tx
      .update(product_variants)
      .set({ ...rest, sku, updated_at: new Date() })
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
    productName: string,
    variant: ProductVariantInput,
    batchUsedSkus: Set<string>,
  ) {
    const { id, ...rest } = variant;
    const sku = await resolveVariantSku(tx, productName, variant, batchUsedSkus);

    return await tx.insert(product_variants).values({
      ...rest,
      sku,
      product_id: product_id,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  static async updateProductById(
    product_id: number,
    data: Required<ProductInsert> & {
      variants: ProductVariantInput[];
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
            eq(products.is_archived, false),
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
      const batchUsedSkus = new Set<string>();
      for (const variant of data.variants) {
        if (!variant.id) {
          await this.createProductVariant(tx, product_id, data.name, variant, batchUsedSkus);
          continue;
        }
        const [product_variant] = await tx.select({ id: product_variants.id }).from(product_variants).where(and(eq(product_variants.id, Number(variant.id)), eq(product_variants.product_id, product_id)));

        if (!product_variant) {
          await this.createProductVariant(tx, product_id, data.name, variant, batchUsedSkus);
        } else {
          await this.updateProductVariant(tx, product_id, data.name, variant, batchUsedSkus);
        }
      }

      return true;
    }).catch(productConflict);
  }

  static async deleteProductById(
    product_id: number,
    version: number,
  ): Promise<boolean> {
    throw new WorkflowError("Archive this product and schedule deletion from Archives after the 30-day retention period.", 405);
  }
}
