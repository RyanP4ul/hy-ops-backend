export type inventory_stock_status = "all" | "high" | "low" | "out";

import Elysia, { t } from "elysia";

const base_inventory_model = t.Object({
  quantity: t.Integer({ minimum: 0 }),
  warehouse_id: t.Integer({ minimum: 1 }),
  product_variant_id: t.Integer({ minimum: 1 }),
});

export const inventoryModel = new Elysia().model({
  "inventory.create": t.Object({
    ...base_inventory_model.properties,
  }),
  "inventory.update": t.Object({
    ...base_inventory_model.properties,
    reserved: t.Integer({ minimum: 0 }),
    version: t.Integer({ minimum: 0 }),
    reason: t.Optional(t.String({ maxLength: 500 })),
  }),
});
