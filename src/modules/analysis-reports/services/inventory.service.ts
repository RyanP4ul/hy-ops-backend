import type { Filters, InventoryResponse } from "../reports.contract";
import { byValueDesc, groupSum, orderMetrics } from "../domain/metrics";
import { findLastSoldAt } from "../repositories/inventory.repository";
import { inventoryFor, ordersFor } from "./datasets";

export async function getInventory(f: Filters, now = Date.now()): Promise<InventoryResponse> {
  const [stock, orders, lastSold] = await Promise.all([inventoryFor(f), ordersFor(f, now), findLastSoldAt()]);
  const lines = orderMetrics(orders).live.flatMap((i) => i.items).filter((i) => !f.products.length || f.products.includes(String(i.productId)));
  const sold = new Map<number, number>();
  lines.forEach((i) => sold.set(i.inventoryId, (sold.get(i.inventoryId) ?? 0) + i.qty));

  return {
    rows: stock.map((r) => ({
      id: r.id, product: r.product, variant: r.variant, sku: r.sku, warehouse: r.warehouse, unit: r.unit, price: r.price,
      quantity: r.quantity, reserved: r.reserved, available: r.available, unitsSold: sold.get(r.id) ?? 0, lastSoldAt: lastSold.get(r.id) ?? null,
    })),
    topSellers: groupSum(lines, (i) => i.sku, (i) => i.qty).sort(byValueDesc),
  };
}
