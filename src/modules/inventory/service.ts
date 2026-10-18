import { db } from "@/db/index";
import {
  inventory,
  InventoryInsert,
  InventorySelect,
  product_variants,
  products,
  settings,
  warehouses,
} from "@/db/schema";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lte,
  or,
} from "drizzle-orm";
import { inventory_stock_status } from "./model";

export abstract class InventoryService {
  static async getProductByOffset(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    stock_status: inventory_stock_status = "all",
    warehouse_id: number | null = null,
    from: number | null = null,
    to: number | null = null,
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;

    let stockStatusQuery = undefined;
    let low_stock_threshold = 10;
    let high_stock_threshold = 100;

    const searchQuery = !is_search_empty
      ? or(
          ilike(product_variants.sku, `%${search}%`),
          ilike(products.name, `%${search}%`),
        )
      : undefined;

    switch (stock_status) {
      case "low":
        const low_status_result = await db.query.settings.findFirst({
          columns: {
            value: true,
          },
          where: eq(settings.name, "low_stock_threshold"),
        });
        if (low_status_result) {
          low_stock_threshold = parseInt(low_status_result.value);
          stockStatusQuery = and(
            gt(inventory.quantity, 0),
            lte(inventory.quantity, low_stock_threshold),
          );
        }
        break;
      case "high":
        const high_status_result = await db.query.settings.findFirst({
          columns: {
            value: true,
          },
          where: eq(settings.name, "high_stock_threshold"),
        });
        if (high_status_result) {
          high_stock_threshold = parseInt(high_status_result.value);
          stockStatusQuery = gte(inventory.quantity, high_stock_threshold);
        }
        break;
      case "out":
        stockStatusQuery = eq(inventory.quantity, 0);
        break;
    }

    const whereQuery = and(
      searchQuery,
      stockStatusQuery,
      from != null ? gte(inventory.created_at, from) : undefined,
      to != null ? lte(inventory.created_at, to) : undefined,
      warehouse_id != null
        ? eq(inventory.warehouse_id, warehouse_id)
        : undefined,
    );

    const totalResult = await db
      .select({
        count: count(),
      })
      .from(inventory)
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .leftJoin(products, eq(product_variants.product_id, products.id))
      .where(whereQuery);

    const lists = await db
      .select({
        id: inventory.id,
        product_name: products.name,
        description: product_variants.description,
        sku: product_variants.sku,
        warehouse_name: warehouses.name,
        reserved: inventory.reserved,
        quantity: inventory.quantity,
        price: product_variants.price,
        version: inventory.version,
      })
      .from(inventory)
      .leftJoin(warehouses, eq(inventory.warehouse_id, warehouses.id))
      .leftJoin(products, eq(inventory.product_id, products.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(whereQuery)
      .orderBy(desc(inventory.id))
      .offset(offset)
      .limit(limit);

    return {
      rows: lists,
      total: totalResult[0].count,
    };
  }

  static async getInventoryById(id: number) {
    const [result] = await db
      .select({
        id: inventory.id,
        quantity: inventory.quantity,
        reserved: inventory.reserved,
        warehouse_id: inventory.warehouse_id,
        warehouse_name: warehouses.name,
        product_variant_id: inventory.product_variant_id,
        product_variant_sku: product_variants.sku,
      })
      .from(inventory)
      .leftJoin(warehouses, eq(inventory.warehouse_id, warehouses.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(eq(inventory.id, id));
    return result;
  }

  static async createInventory(
    data: Omit<
      InventoryInsert,
      "reserved" | "version" | "created_at" | "updated_at"
    >,
  ) {
    return await db.transaction(async (tx) => {
      const [inventory_query] = await db
        .select({
          product_variant_sku: product_variants.sku,
          warehouse_name: warehouses.name,
        })
        .from(inventory)
        .leftJoin(
          product_variants,
          eq(inventory.product_variant_id, product_variants.id),
        )
        .leftJoin(warehouses, eq(inventory.warehouse_id, warehouses.id))
        .where(
          and(
            eq(inventory.product_variant_id, data.product_variant_id),
            eq(inventory.warehouse_id, data.warehouse_id),
          ),
        );

      if (inventory_query) {
        throw new Error(
          `Inventory already exists for product variant ${inventory_query.product_variant_sku} in warehouse ${inventory_query.warehouse_name}.`,
        );
      }

      const result = await tx
        .insert(inventory)
        .values({
          ...data,
          version: 0,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .returning();

      if (result.length === 0) {
        throw new Error("Failed to create inventory.");
      }

      return result;
    });
  }

  static async updateInventory(
    inventory_id: number,
    data: Omit<Required<InventoryInsert>, "created_at" | "updated_at">,
  ) {
    return await db.transaction(async (tx) => {
      const result = await tx
        .update(inventory)
        .set({
          ...data,
          version: data.version + 1,
        })
        .where(
          and(
            eq(inventory.id, inventory_id),
            eq(inventory.version, data.version),
          ),
        );

      if (result.rowCount === 0) {
        throw new Error("Inventory not found or version mismatch.");
      }

      return {
        message: `Inventory with ID ${inventory_id} updated successfully.`,
      };
    });
  }

  static async deleteInventory(id: number, version: number) {
    return await db.transaction(async (tx) => {
      const result = await tx
        .delete(inventory)
        .where(and(eq(inventory.id, id), eq(inventory.version, version)));

      if (result.rowCount === 0) {
        throw new Error("Inventory not found or version mismatch.");
      }

      return {
        message: `Inventory with ID ${id} deleted successfully.`,
      };
    });
  }

  static async getInventoryNames(page: number = 1, limit: number = 10) {
    const offset = Math.max(page * limit, 0);

    const [total_count] = await db
      .select({
        count: count(),
      })
      .from(inventory);

    const result = await db
      .select({
        id: inventory.id,
        sku: product_variants.sku,
        name: products.name,
        quantity: inventory.quantity,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .orderBy(desc(inventory.id))
      .offset(offset)
      .limit(limit)
      .where(gt(inventory.quantity, 0));

    return {
      rows: result,
      total: total_count.count,
    };
  }

  static async getInventoryDetailById(ids: number[]) {
    const result = await db
      .select({
        inventory_id: inventory.id,
        product_id: products.id,
        product_variant_name: product_variants.name,
        product_variant_sku: product_variants.sku,
        quantity: inventory.quantity,
        price: product_variants.price,
        description: product_variants.description,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(inArray(inventory.id, ids));

    return result;
  }

  // static async getInventoryByOffset(page: number | null = 1, limit: number = 10) {
  //   const lists = await db.query.inventory.findMany({
  //     columns: {
  //       id: false,
  //       created_at: false,
  //       updated_at: false,
  //     },
  //     offset: page ? (page - 1) * limit : 0,
  //     limit,
  //     orderBy: desc(inventory.id),
  //     with: {
  //       product_variant: {
  //         columns: {
  //           id: false,
  //           created_at: false,
  //           updated_at: false,
  //         },
  //         with: {
  //           product: {
  //             columns: {
  //               id: false,
  //               created_at: false,
  //               updated_at: false,
  //             },
  //           },
  //         },
  //       },
  //     },
  //   });
  //   const grouped = Object.values(
  //     lists.reduce<Record<number, ProductGrouped>>((acc, item) => {
  //       const productId = item.product_variant.product_id;
  //       if (!acc[productId]) {
  //         acc[productId] = {
  //           name: item.product_variant.product.name,
  //           description: item.product_variant.product.description,
  //           variants: [],
  //         };
  //       }
  //       acc[productId].variants.push({
  //         product_variant_id: item.product_variant_id,
  //         name: item.product_variant.name,
  //         sku: item.product_variant.sku,
  //         price: item.product_variant.price,
  //         quantity: item.quantity,
  //       });
  //       return acc;
  //     }, {}),
  //   );
  //   return grouped;
  // }
}
