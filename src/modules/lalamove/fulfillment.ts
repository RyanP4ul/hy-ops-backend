import { and, eq, inArray } from "drizzle-orm";
import type { StockTransaction } from "../inventory/transaction";
import { delivery_orders } from "../../db/schema/lalamove";
import { deliveries, deliveries_stops } from "../../db/schema/deliveries";
import { WorkflowError } from "../../utils/workflow-error";
/** Caller holds the sales-order row lock; used by both fulfillment paths. */
export async function assertNoExternalClaim(tx: Pick<StockTransaction, "select">, orderId: number) {
  const [attempt] = await tx.select({ id: delivery_orders.id }).from(delivery_orders)
    .where(and(eq(delivery_orders.order_id, orderId), eq(delivery_orders.active, true))).limit(1);
  if (attempt) throw new WorkflowError("This order has an active or unresolved Lalamove booking. Resolve it first.");
}
export async function assertNoInternalClaim(tx: Pick<StockTransaction, "select">, orderId: number) {
  const [stop] = await tx.select({ id: deliveries_stops.id }).from(deliveries_stops)
    .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
    .where(and(eq(deliveries_stops.order_id, orderId), inArray(deliveries.status, ["scheduled", "in_transit", "returning"]))).limit(1);
  if (stop) throw new WorkflowError("This order already belongs to an internal delivery.");
}
