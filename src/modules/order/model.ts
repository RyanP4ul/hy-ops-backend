import Elysia, { Static, t } from "elysia";

export const orderSchema = t.Object({
  warehouse_id: t.Numeric({ minimum: 1 }),
  customer_id: t.Numeric({ minimum: 1 }),
  notes: t.Optional(t.String()),
  delivery_type: t.Optional(t.Union([t.Literal("INTERNAL"), t.Literal("LALAMOVE"), t.Literal("PICKUP")])),
  payment_type: t.Optional(t.String({ minLength: 1, maxLength: 100, pattern: "\\S" })),
  payment_method: t.Union([
    t.Literal("BANK_TRANSFER"),
    t.Literal("CASH"),
    t.Literal("CARD"),
  ]),
  payment_arrangement: t.Union([
    t.Literal("FULLY_PAID"),
    t.Literal("PARTIALLY_PAID"),
    t.Literal("NET_30"),
  ]),
  amount_paid: t.Numeric({ minimum: 0 }),
  is_custom_shipping: t.Boolean(),
  customer_address_id: t.Optional(t.Numeric({ minimum: 1 })),
  shipping_recipient: t.Optional(t.String({ maxLength: 60 })),
  shipping_phone: t.Optional(t.String({ maxLength: 20 })),
  shipping_address: t.Optional(t.String({ maxLength: 255 })),
  shipping_latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
  shipping_longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
});

export type OrderType = Static<typeof orderSchema>;

export const savedShippingAddressSchema = t.Object({
  address_line: t.String({ minLength: 1, maxLength: 255, pattern: "\\S" }),
  barangay: t.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  city_municipality: t.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  province: t.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  postal_code: t.Optional(t.String({ maxLength: 20 })),
  latitude: t.Number({ minimum: -90, maximum: 90 }),
  longitude: t.Number({ minimum: -180, maximum: 180 }),
});

export type SavedShippingAddress = Static<typeof savedShippingAddressSchema>;

export const orderItemSchema = t.Object({
  inventory_id: t.Numeric({ minimum: 1 }),
  quantity: t.Integer({ minimum: 1 }),
});

export type OrderItemType = Static<typeof orderItemSchema>;

export const orderUpdateSchema = t.Object({
  customer_id: t.Optional(t.Numeric({ minimum: 1 })),
  notes: t.Optional(t.String()),
});

export type OrderUpdateType = Static<typeof orderUpdateSchema>;

export const orderItemUpdateSchema = t.Object({
  quantity: t.Integer({ minimum: 1 }),
});

export type OrderItemUpdateType = Static<typeof orderItemUpdateSchema>;

export const orderCreateSchema = t.Object({
  ...orderSchema.properties,
  items: t.Array(orderItemSchema, { minItems: 1 }),
});
export type CreateOrderInput = Static<typeof orderCreateSchema>;

const separateOrderBatchSchema = t.Object({
  customer_id: t.Numeric({ minimum: 1 }),
  payment_mode: t.Optional(t.Literal("SEPARATE")),
  orders: t.Array(t.Omit(orderCreateSchema, ["customer_id"]), { minItems: 1, maxItems: 25 }),
});
const combinedOrderBatchSchema = t.Object({
  customer_id: t.Numeric({ minimum: 1 }),
  payment_mode: t.Literal("COMBINED"),
  payment: t.Object({
    payment_method: orderSchema.properties.payment_method,
    payment_type: orderSchema.properties.payment_type,
    amount_paid: t.Numeric({ minimum: 0.01, maximum: 9999999999.99 }),
    reference_number: t.Optional(t.String({ maxLength: 100 })),
  }),
  orders: t.Array(t.Object({
    ...t.Omit(orderCreateSchema, ["customer_id", "payment_method", "payment_type", "payment_arrangement", "amount_paid"]).properties,
    expected_total: t.Optional(t.Numeric({ minimum: 0 })),
  }), { minItems: 1, maxItems: 25 }),
});
export const orderBatchSchema = t.Union([separateOrderBatchSchema, combinedOrderBatchSchema]);
export type OrderBatchInput = Static<typeof orderBatchSchema>;

export const orderModel = new Elysia().model({
  "order.create": orderCreateSchema,
  "order.batch": orderBatchSchema,
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
