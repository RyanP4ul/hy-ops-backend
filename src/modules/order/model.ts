import Elysia, { Static, t } from "elysia";

export const orderSchema = t.Object({
  customer_id: t.Numeric({ minimum: 1 }),
  delivery_type: t.Union([
    t.Literal("LALAMOVE"),
    t.Literal("PICKUP"),
    t.Literal("INTERNAL"),
  ]),
  notes: t.Optional(t.String()),
  payment_method: t.Union([
    t.Literal("BANK_TRANSFER"),
    t.Literal("CASH"),
    t.Literal("GCASH"),
  ]),
  payment_arrangement: t.Union([
    t.Literal("FULLY_PAID"),
    t.Literal("PARTIALLY_PAID"),
    t.Literal("NET_30"),
  ]),
  amount_paid: t.Numeric({ minimum: 0 }),
});

export type OrderType = Static<typeof orderSchema>;

export const orderItemSchema = t.Object({
  inventory_id: t.Numeric({ minimum: 1 }),
  quantity: t.Numeric({ minimum: 1 }),
});

export type OrderItemType = Static<typeof orderItemSchema>;

export const orderUpdateSchema = t.Object({
  customer_id: t.Optional(t.Numeric({ minimum: 1 })),
  delivery_type: t.Optional(
    t.Union([
      t.Literal("LALAMOVE"),
      t.Literal("PICKUP"),
      t.Literal("INTERNAL"),
    ]),
  ),
  notes: t.Optional(t.String()),
});

export type OrderUpdateType = Static<typeof orderUpdateSchema>;

export const orderItemUpdateSchema = t.Object({
  quantity: t.Numeric({ minimum: 1 }),
});

export type OrderItemUpdateType = Static<typeof orderItemUpdateSchema>;

export const orderModel = new Elysia().model({
  "order.create": t.Object({
    ...orderSchema.properties,
    items: t.Array(
      t.Object({
        ...orderItemSchema.properties,
      }),
    ),
  }),
  "order.update": t.Object({
    ...orderUpdateSchema.properties,
  }),
  "order.add_item": t.Object({
    ...orderItemSchema.properties,
  }),
  "order.update_item": t.Object({
    ...orderItemUpdateSchema.properties,
  }),
});
