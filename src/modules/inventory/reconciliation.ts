import { WorkflowError } from "../../utils/workflow-error";
import { eq, inArray, sql } from "drizzle-orm";
import { inventory, orders, order_items, stock_movements, product_variants, warehouses, users } from "../../db/schema";
import { stockTransaction, type StockTransaction } from "./transaction";

async function plan(tx: StockTransaction) {
  const active = await tx.select().from(orders).where(inArray(orders.status, ["PENDING", "PROCESSING", "SCHEDULING", "SCHEDULED"])).orderBy(orders.id).for("update");
  const stocks = await tx.select().from(inventory).orderBy(inventory.id).for("update");
  const items = active.length ? await tx.select().from(order_items).where(inArray(order_items.order_id, active.map((order) => order.id))) : [];
  const expected = new Map<number, number>();
  const issues: string[] = [];
  for (const item of items) {
    const order = active.find((row) => row.id === item.order_id);
    const stock = stocks.find((row) => row.id === item.inventory_id);
    if (!stock || stock.warehouse_id !== order?.warehouse_id) issues.push(`Order ${item.order_id} has stock outside its warehouse.`);
    expected.set(item.inventory_id, (expected.get(item.inventory_id) ?? 0) + item.quantity);
  }
  const labels = await tx.select({ id: inventory.id, sku: product_variants.sku, warehouse: warehouses.name }).from(inventory)
    .leftJoin(product_variants, eq(inventory.product_variant_id, product_variants.id))
    .leftJoin(warehouses, eq(inventory.warehouse_id, warehouses.id));
  const labelsById = new Map(labels.map(row => [row.id, row]));
  const rows = stocks.map((stock) => {
    const reserved = expected.get(stock.id) ?? 0;
    if (reserved > stock.quantity) issues.push(`Inventory ${stock.id} needs ${reserved} units, but only ${stock.quantity} are on hand.`);
    return { sku: labelsById.get(stock.id)?.sku ?? "Unknown SKU", warehouse: labelsById.get(stock.id)?.warehouse ?? "Unknown warehouse", id: stock.id, version: stock.version, quantity: stock.quantity, current_reserved: stock.reserved, expected_reserved: reserved };
  });
  const token = new Bun.CryptoHasher("sha256").update(JSON.stringify({ rows, orders: active.map((o) => [o.id, o.version, o.stock_reserved]) })).digest("hex");
  return { rows, issues, token, orderIds: active.map((o) => o.id), legacyOrders: active.filter((o) => !o.stock_reserved).length };
}

export function previewReconciliation() { return stockTransaction(plan, true); }

export function reconcileReservations(token: string, reason: string, actorId: number) {
  if (!reason.trim()) throw new WorkflowError("A reconciliation reason is required.");
  return stockTransaction(async (tx) => {
    const [actor] = await tx.select().from(users).where(eq(users.id, actorId)).for("update");
    if (!actor || !actor.is_active || actor.is_archived || actor.role !== "admin") throw new WorkflowError("Only an active administrator can reconcile stock.");
    const current = await plan(tx);
    if (current.token !== token) throw new WorkflowError("Stock or orders changed. Preview reconciliation again.");
    if (current.issues.length) throw new WorkflowError(current.issues.join(" "));
    for (const row of current.rows) {
      await tx.update(inventory).set({ reserved: row.expected_reserved, version: sql`${inventory.version} + 1`, updated_at: Math.floor(Date.now() / 1000) }).where(eq(inventory.id, row.id));
      await tx.insert(stock_movements).values({ inventory_id: row.id, actor_id: actorId, kind: "reconciliation", quantity_delta: 0,
        reserved_delta: row.expected_reserved - row.current_reserved, quantity_after: row.quantity, reserved_after: row.expected_reserved, reason: reason.trim() });
    }
    if (current.orderIds.length) await tx.update(orders).set({ stock_reserved: true, version: sql`${orders.version} + 1`, updated_at: new Date() }).where(inArray(orders.id, current.orderIds));
    return { message: "Reservations reconciled against active, undispatched orders." };
  }, true);
}
