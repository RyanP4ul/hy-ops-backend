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
    reorder_point: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
  }),
  "inventory.update": t.Object({
    ...base_inventory_model.properties,
    reserved: t.Integer({ minimum: 0 }),
    version: t.Integer({ minimum: 0 }),
    reorder_point: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
    movement_kind: t.Optional(
      t.Union([
        t.Literal("adjustment"),
        t.Literal("inbound_receipt"),
        t.Literal("damage"),
        t.Literal("cycle_count"),
      ]),
    ),
    reason: t.Optional(t.String({ maxLength: 500 })),
  }),
});
