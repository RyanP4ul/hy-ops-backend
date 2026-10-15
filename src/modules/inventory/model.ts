export type inventory_stock_status = "all" | "high" | "low" | "out";

import Elysia, { t } from "elysia";

const base_inventory_model = t.Object({
  quantity: t.Number(),
  warehouse_id: t.Number(),
  product_variant_id: t.Number(),
});

export const inventoryModel = new Elysia().model({
  "inventory.create": t.Object({
    ...base_inventory_model.properties,
  }),
  "inventory.update": t.Object({
    ...base_inventory_model.properties,
    reserved: t.Number(),
    version: t.Number({ minimum: 0 }),
  }),
});
