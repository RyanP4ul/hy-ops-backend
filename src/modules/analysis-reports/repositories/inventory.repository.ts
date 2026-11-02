import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  inventory,
  order_items,
  orders,
  product_variants,
  products,
  warehouses,
} from "@/db/schema";
import type { Filters } from "../reports.contract";
import type { InventoryView } from "../domain/types";
import { db } from "@/db/index";

/** Current stock snapshot, filtered by warehouse and product. */
export async function findInventory(f: Filters): Promise<InventoryView[]> {
  const rows = await db
    .select({
      id: inventory.id,
      warehouseId: inventory.warehouse_id,
      warehouse: warehouses.name,
      productId: inventory.product_id,
      product: products.name,
      variantId: product_variants.id,
      variant: product_variants.name,
      sku: product_variants.sku,
      unit: product_variants.unit,
      price: product_variants.price,
      quantity: inventory.quantity,
      reserved: inventory.reserved,
    })
    .from(inventory)
    .innerJoin(warehouses, eq(inventory.warehouse_id, warehouses.id))
    .innerJoin(products, eq(inventory.product_id, products.id))
    .innerJoin(
      product_variants,
      eq(inventory.product_variant_id, product_variants.id),
    )
    .where(
      and(
        f.warehouses.length
          ? inArray(inventory.warehouse_id, f.warehouses.map(Number))
          : undefined,
        f.products.length
          ? inArray(inventory.product_id, f.products.map(Number))
          : undefined,
      ),
    )
    .orderBy(warehouses.name, products.name, product_variants.name);
  return rows.map((r) => ({
    ...r,
    price: Number(r.price),
    available: r.quantity - r.reserved,
  }));
}

/** inventory_id -> epoch ms of the newest non-cancelled order containing it (all time; there is no stock-movement table). */
export async function findLastSoldAt(): Promise<Map<number, number>> {
  const rows = await db
    .select({
      inventoryId: order_items.inventory_id,
      last: sql<Date>`max(${orders.created_at})`.mapWith(orders.created_at),
    })
    .from(order_items)
    .innerJoin(orders, eq(order_items.order_id, orders.id))
    .where(ne(orders.status, "CANCELLED"))
    .groupBy(order_items.inventory_id);
  return new Map(rows.map((r) => [r.inventoryId, r.last.getTime()]));
}
