import { WorkflowError } from "../../utils/workflow-error";
import { stockTransaction } from "./transaction";
import { stock_movements, users } from "../../db/schema";
import { db } from "@/db/index";
import {
  inventory,
  order_items,
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
  sql,
} from "drizzle-orm";
import { inventory_stock_status } from "./model";

export abstract class InventoryService {
  static async getMovements(id: number) {
    return db.select({ id: stock_movements.id, kind: stock_movements.kind, quantity_delta: stock_movements.quantity_delta,
      reserved_delta: stock_movements.reserved_delta, quantity_after: stock_movements.quantity_after, reserved_after: stock_movements.reserved_after,
      reason: stock_movements.reason, created_at: stock_movements.created_at, actor: users.name, order_id: stock_movements.order_id })
      .from(stock_movements).leftJoin(users, eq(users.id, stock_movements.actor_id)).where(eq(stock_movements.inventory_id, id)).orderBy(desc(stock_movements.id)).limit(100);
  }

  static async getReorderSuggestions(warehouseId: number | null = null) {
    const { threshold } = await this.getSummary(warehouseId);
    const rows = await db.select({ id: inventory.id, sku: product_variants.sku, warehouse: warehouses.name,
      available: sql<number>`${inventory.quantity} - ${inventory.reserved}`, unit: product_variants.unit,
      suggested: sql<number>`greatest(${threshold} + 1 - (${inventory.quantity} - ${inventory.reserved}), 0)` })
      .from(inventory).innerJoin(product_variants, eq(product_variants.id, inventory.product_variant_id))
      .innerJoin(warehouses, eq(warehouses.id, inventory.warehouse_id))
      .where(and(lte(sql`${inventory.quantity} - ${inventory.reserved}`, threshold), warehouseId === null ? undefined : eq(inventory.warehouse_id, warehouseId))).orderBy(inventory.id);
    return { threshold, rows };
  }

  static async getSummary(warehouseId: number | null = null) {
    const setting = await db.query.settings.findFirst({ where: eq(settings.name, "low_stock_threshold") });
    const configured = Number(setting?.value ?? 10);
    const threshold = Number.isSafeInteger(configured) && configured >= 0 ? configured : 10;
    const available = sql`${inventory.quantity} - ${inventory.reserved}`;
    const [summary] = await db.select({
      skus: sql<number>`count(distinct ${inventory.product_variant_id})`.mapWith(Number),
      low: sql<number>`count(*) filter (where ${available} > 0 and ${available} <= ${threshold})`.mapWith(Number),
      out: sql<number>`count(*) filter (where ${available} <= 0)`.mapWith(Number),
      reserved: sql<number>`coalesce(sum(${inventory.reserved}), 0)`.mapWith(Number),
      available: sql<number>`coalesce(sum(${available}), 0)`.mapWith(Number),
    }).from(inventory).where(warehouseId === null ? undefined : eq(inventory.warehouse_id, warehouseId));
    return { ...summary, threshold, warehouseId };
  }

  static async getInventoryTableRowById(id: number) {
    const [result] = await db
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
      .where(eq(inventory.id, id));

    return result;
  }

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
        {
          const configured = Number(low_status_result?.value ?? 10);
          low_stock_threshold = Number.isSafeInteger(configured) && configured >= 0 ? configured : 10;
          stockStatusQuery = and(
            gt(sql`${inventory.quantity} - ${inventory.reserved}`, 0),
            lte(sql`${inventory.quantity} - ${inventory.reserved}`, low_stock_threshold),
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
        {
          const configured = Number(high_status_result?.value ?? 100);
          high_stock_threshold = Number.isSafeInteger(configured) && configured >= 0 ? configured : 100;
          stockStatusQuery = gte(sql`${inventory.quantity} - ${inventory.reserved}`, high_stock_threshold);
        }
        break;
      case "out":
        stockStatusQuery = lte(sql`${inventory.quantity} - ${inventory.reserved}`, 0);
        break;
    }

    const whereQuery = and(
      searchQuery,
      stockStatusQuery,
      from !== null ? gte(inventory.created_at, from) : undefined,
      to !== null ? lte(inventory.created_at, to) : undefined,
      warehouse_id !== null
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

  static async createInventory(data: { warehouse_id: number; product_variant_id: number; quantity: number }) {
    if (!Number.isSafeInteger(data.quantity) || data.quantity < 0) throw new WorkflowError("Quantity must be a non-negative integer.");
    return stockTransaction(async (tx) => {
      const [variant] = await tx.select({ product_id: product_variants.product_id }).from(product_variants)
        .where(eq(product_variants.id, data.product_variant_id));
      if (!variant) throw new WorkflowError("Product variant not found.");
      const now = Math.floor(Date.now() / 1000);
      const result = await tx.insert(inventory).values({ ...data, product_id: variant.product_id, created_at: now, updated_at: now })
        .onConflictDoNothing().returning();
      if (!result.length) throw new WorkflowError("Inventory already exists for this variant and warehouse.");
      if (data.quantity > 0) await tx.insert(stock_movements).values({ inventory_id: result[0].id, kind: "opening", quantity_delta: data.quantity, reserved_delta: 0, quantity_after: data.quantity, reserved_after: 0, reason: "Opening inventory balance" });
      return result;
    });
  }

  static async updateInventory(inventory_id: number, data: { warehouse_id: number; product_variant_id: number; quantity: number; reserved: number; version: number; reason?: string }, actorId?: number) {
    return stockTransaction(async (tx) => {
      const [current] = await tx.select().from(inventory).where(eq(inventory.id, inventory_id)).for("update");
      if (!current || current.version !== data.version) throw new WorkflowError("Inventory not found or version mismatch.");
      if (current.warehouse_id !== data.warehouse_id || current.product_variant_id !== data.product_variant_id) {
        throw new WorkflowError("An inventory record's warehouse and variant cannot be changed. Create a separate record instead.");
      }
      if (data.reserved !== current.reserved) throw new WorkflowError("Reserved units are managed by orders and cannot be edited directly.");
      if (!Number.isSafeInteger(data.quantity) || data.quantity < current.reserved) throw new WorkflowError("On-hand quantity cannot be less than reserved units.");
      if (data.quantity !== current.quantity && !data.reason?.trim()) throw new WorkflowError("A reason is required for a stock adjustment.");
      if (data.quantity !== current.quantity) await tx.insert(stock_movements).values({ inventory_id, actor_id: actorId ?? null, kind: "adjustment", quantity_delta: data.quantity - current.quantity, reserved_delta: 0, quantity_after: data.quantity, reserved_after: current.reserved, reason: data.reason?.trim() ?? "" });
      await tx.update(inventory).set({ quantity: data.quantity, version: current.version + 1, updated_at: Math.floor(Date.now() / 1000) })
        .where(eq(inventory.id, inventory_id));
      return { message: `Inventory with ID ${inventory_id} updated successfully.` };
    });
  }

  static async deleteInventory(id: number, version: number) {
    return stockTransaction(async (tx) => {
      const [current] = await tx.select().from(inventory).where(eq(inventory.id, id)).for("update");
      if (!current || current.version !== version) throw new WorkflowError("Inventory not found or version mismatch.");
      if (current.quantity !== 0 || current.reserved !== 0) throw new WorkflowError("Only empty, unreserved inventory can be deleted.");
      const [reference] = await tx.select({ id: order_items.id }).from(order_items).where(eq(order_items.inventory_id, id)).limit(1);
      if (reference) throw new WorkflowError("This inventory is referenced by order history and cannot be deleted.");
      const [movement] = await tx.select({ id: stock_movements.id }).from(stock_movements).where(eq(stock_movements.inventory_id, id)).limit(1);
      if (movement) throw new WorkflowError("Inventory movement history must be retained.");
      await tx.delete(inventory).where(eq(inventory.id, id));
      return { message: `Inventory with ID ${id} deleted successfully.` };
    });
  }

  static async getInventoryNames(
    page: number = 1,
    limit: number = 10,
    warehouse_id: number = -1,
  ) {
    const offset = Math.max(page * limit, 0);

    const [total_count] = await db
      .select({
        count: count(),
      })
      .from(inventory)
      .where(
        and(gt(sql`${inventory.quantity} - ${inventory.reserved}`, 0), warehouse_id !== -1 ? eq(inventory.warehouse_id, warehouse_id) : undefined),
      );

    const result = await db
      .select({
        id: inventory.id,
        sku: product_variants.sku,
        name: products.name,
        quantity: sql<number>`${inventory.quantity} - ${inventory.reserved}`,
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
      .where(
        and(
          gt(sql`${inventory.quantity} - ${inventory.reserved}`, 0),
          warehouse_id !== -1
            ? eq(inventory.warehouse_id, warehouse_id)
            : undefined,
        ),
      );

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
        quantity: sql<number>`${inventory.quantity} - ${inventory.reserved}`,
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
