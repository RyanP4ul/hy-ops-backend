import { and, eq, inArray, or, sql } from "drizzle-orm";
import { archives, customer_returns, deliveries, inventory, order_items, orders, products, users, vehicles, warehouses, audit_logs } from "../../db/schema";
import { WorkflowError } from "../../utils/workflow-error";
import { revokeLiveSessions } from "../../utils/session-events";
import { stockTransaction, type StockTransaction } from "../inventory/transaction";
import { assertOtherAccount, lockUserMutation, type MutationActor } from "../user/mutation-policy";

export const lifecycleTables = { products, inventory, warehouses, vehicles, users };
export type LifecycleResource = keyof typeof lifecycleTables;
export type LifecycleAction = "activate" | "deactivate" | "archive";
const openOrders = ["PENDING", "PROCESSING", "SCHEDULING", "SCHEDULED", "IN_TRANSIT"] as const;

export async function assertNoDependencies(tx: StockTransaction, resource: LifecycleResource, id: number) {
  const stockFilter = resource === "products" ? eq(inventory.product_id, id)
    : resource === "inventory" ? eq(inventory.id, id) : resource === "warehouses" ? eq(inventory.warehouse_id, id) : undefined;
  if (stockFilter) {
    const [reserved] = await tx.select({ id: inventory.id }).from(inventory).where(and(stockFilter, sql`${inventory.reserved} > 0`)).limit(1);
    const [order] = await tx.select({ id: orders.id }).from(orders)
      .innerJoin(order_items, eq(order_items.order_id, orders.id)).innerJoin(inventory, eq(inventory.id, order_items.inventory_id))
      .where(and(stockFilter, inArray(orders.status, [...openOrders]))).limit(1);
    if (reserved || order) throw new WorkflowError("Complete or cancel linked orders and release stock reservations first.");
  }
  if (resource === "warehouses" || resource === "users") {
    const filter = resource === "warehouses"
      ? or(eq(orders.warehouse_id, id), eq(orders.lalamove_pickup_warehouse_id, id))
      : sql`${orders.customer_id} in (select id from customers where user_id = ${id})`;
    const [order] = await tx.select({ id: orders.id }).from(orders).where(and(filter, inArray(orders.status, [...openOrders]))).limit(1);
    if (order) throw new WorkflowError("Complete or cancel linked orders first.");
  }
  if (resource === "warehouses") {
    const [pickup] = await tx.select({ id: customer_returns.id }).from(customer_returns)
      .where(and(eq(customer_returns.warehouse_id, id), inArray(customer_returns.status, ["requested", "assigned", "collected"]))).limit(1);
    if (pickup) throw new WorkflowError("Receive outstanding customer returns before disabling this warehouse.");
  }
  if (["users", "vehicles", "warehouses"].includes(resource)) {
    const filter = resource === "users" ? eq(deliveries.driver_id, id) : resource === "vehicles" ? eq(deliveries.vehicle_id, id)
      : sql`${deliveries.vehicle_id} in (select id from vehicles where warehouse_id = ${id})`;
    const [trip] = await tx.select({ id: deliveries.id }).from(deliveries)
      .where(and(filter, inArray(deliveries.status, ["scheduled", "in_transit", "returning"]))).limit(1);
    if (trip) throw new WorkflowError("Reassign or complete linked scheduled and active trips first.");
  }
}

export class LifecycleService {
  static async change(resource: LifecycleResource, id: number, version: number, action: LifecycleAction, actor: MutationActor) {
    // Existing stock barrier prevents checkout/reservation races with status changes.
    const result = await stockTransaction(async (tx) => {
      await lockUserMutation(tx, actor);
      if (resource === "users") assertOtherAccount(actor.id, id);
      const table = lifecycleTables[resource];
      const [row] = await tx.select().from(table).where(eq(table.id, id)).for("update");
      if (!row || row.version !== version || ("is_archived" in row && row.is_archived)) throw new WorkflowError("Record changed or was archived. Refresh before retrying.");
      if (resource === "users" && "email" in row && row.email === "walkin@system.local") throw new WorkflowError("The system walk-in account cannot be disabled.");
      if (action !== "activate") await assertNoDependencies(tx, resource, id);
      const now = Math.floor(Date.now() / 1000);
      const update = { is_active: action === "activate", version: row.version + 1,
        updated_at: resource === "products" ? new Date() : now,
        ...(action === "archive" ? { is_archived: true, archived_at: now } : {}),
        ...(resource === "users" ? { token_version: sql`${users.token_version} + 1`, refresh_token: null } : {}) };
      await tx.update(table).set(update).where(eq(table.id, id));
      let archiveId: number | undefined;
      if (action === "archive") {
        const [archive] = await tx.insert(archives).values({ entity_type: resource, entity_id: String(id), archived_by: actor.id, archived_at: now }).returning({ id: archives.id });
        archiveId = archive!.id;
      }
      await tx.insert(audit_logs).values({ user_id: actor.id, action: `${({ products: "PRODUCT", inventory: "INVENTORY", warehouses: "WAREHOUSE", vehicles: "VEHICLE", users: "USER" })[resource]}_${action === "activate" ? "ACTIVATED" : action === "deactivate" ? "DEACTIVATED" : "ARCHIVED"}`,
        entity_type: resource, entity_id: String(id), description: `${resource} ${id}: ${action}`,
        old_value: JSON.stringify({ is_active: row.is_active }), new_value: JSON.stringify({ is_active: update.is_active, is_archived: action === "archive" }),
        metadata: JSON.stringify({ archiveId }), ip_address: "unknown", user_agent: "unknown", created_at: now });
      return { id: archiveId ?? id, message: `Record ${action === "activate" ? "activated" : action === "deactivate" ? "deactivated" : "archived"} successfully.` };
    }, true);
    if (resource === "users") revokeLiveSessions(id);
    return result;
  }
}
