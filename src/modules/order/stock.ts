import { assertOperationalOrder } from "../lifecycle/order-eligibility";
import { activeInventory } from "../lifecycle/availability";
import { WorkflowError } from "../../utils/workflow-error";
import { and, asc, eq, sql } from "drizzle-orm";
import type { db } from "../../db";
import { inventory } from "../../db/schema/inventory";
import { order_items, orders } from "../../db/schema/order";
import { stock_movements } from "../../db/schema/stock-movement";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Caller must hold the order lock; stock rows are always locked in ID order. */
export async function changeOrderStock(tx: Transaction, orderId: number, warehouseId: number, mode: "reserve" | "release" | "consume") {
  if (mode !== "release") await assertOperationalOrder(tx, orderId);
  const items = await tx.select({ inventoryId: order_items.inventory_id, quantity: order_items.quantity })
    .from(order_items).where(eq(order_items.order_id, orderId)).orderBy(asc(order_items.inventory_id));
  if (!items.length) throw new WorkflowError("Order has no stock items.");
  for (const item of items) {
    const [stock] = await tx.select().from(inventory).where(eq(inventory.id, item.inventoryId)).for("update");
    if (!stock || stock.warehouse_id !== warehouseId) throw new WorkflowError("Order stock must belong to its selected warehouse.");
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw new WorkflowError("Order quantities must be positive integers.");
    if (mode !== "release") {
      const [eligible] = await tx.select({ id: inventory.id }).from(inventory).where(and(eq(inventory.id, stock.id), activeInventory()));
      if (!eligible) throw new WorkflowError("Stock, product or warehouse is inactive or archived.");
    }
    if (mode === "reserve" && stock.quantity - stock.reserved < item.quantity) throw new WorkflowError("Insufficient available stock. Refresh the order items.");
    if (mode !== "reserve" && stock.reserved < item.quantity) throw new WorkflowError("Stock reservation is inconsistent. Review this order before continuing.");
    if (mode === "consume" && stock.quantity < item.quantity) throw new WorkflowError("Insufficient on-hand stock for dispatch.");
    await tx.update(inventory).set({
      quantity: mode === "consume" ? stock.quantity - item.quantity : stock.quantity,
      reserved: mode === "reserve" ? stock.reserved + item.quantity : stock.reserved - item.quantity,
      version: sql`${inventory.version} + 1`, updated_at: Math.floor(Date.now() / 1000),
    }).where(eq(inventory.id, stock.id));
    await tx.insert(stock_movements).values({ inventory_id: stock.id, order_id: orderId, kind: mode,
      quantity_delta: mode === "consume" ? -item.quantity : 0,
      reserved_delta: mode === "reserve" ? item.quantity : -item.quantity,
      quantity_after: mode === "consume" ? stock.quantity - item.quantity : stock.quantity,
      reserved_after: mode === "reserve" ? stock.reserved + item.quantity : stock.reserved - item.quantity,
      reason: `Order ${orderId}: ${mode}` });
  }
  await tx.update(orders).set({ stock_reserved: mode === "reserve" }).where(eq(orders.id, orderId));
}
