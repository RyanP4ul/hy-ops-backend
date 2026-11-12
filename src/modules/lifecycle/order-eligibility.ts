import { and, eq, not } from "drizzle-orm";
import { customers, inventory, order_items, orders, users, warehouses } from "../../db/schema";
import { WorkflowError } from "../../utils/workflow-error";
import type { StockTransaction } from "../inventory/transaction";
import { activeInventory, activeUser, activeWarehouse } from "./availability";

/** Also protects unfinished records inherited from before lifecycle enforcement. */
export async function assertOperationalOrder(tx: StockTransaction, orderId: number) {
  const [order] = await tx.select({ id: orders.id }).from(orders)
    .innerJoin(warehouses, eq(warehouses.id, orders.warehouse_id))
    .innerJoin(customers, eq(customers.id, orders.customer_id))
    .innerJoin(users, eq(users.id, customers.user_id))
    .where(and(eq(orders.id, orderId), activeWarehouse(), activeUser()));
  if (!order) throw new WorkflowError("Order requires an active customer and warehouse.");
  const [unavailable] = await tx.select({ id: inventory.id }).from(order_items)
    .innerJoin(inventory, eq(inventory.id, order_items.inventory_id))
    .where(and(eq(order_items.order_id, orderId), not(activeInventory()!))).limit(1);
  if (unavailable) throw new WorkflowError("Order contains inactive stock, products or warehouses.");
}
