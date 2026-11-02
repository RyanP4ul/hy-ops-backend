import Elysia, { t } from "elysia";

export const productModel = new Elysia().model({
  "product.create": t.Object({
    name: t.String({ minLength: 1, maxLength: 60 }),
    variants: t.Array(
      t.Object({
        name: t.String({ minLength: 1, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 255 })),
        sku: t.String({ minLength: 1, maxLength: 60 }),
        price: t.String({ pattern: "^(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$", maxLength: 12 }),
        unit: t.String({ minLength: 1, maxLength: 60 }),
        width_value: t.String({ minLength: 1, maxLength: 60 }),
        width_unit: t.String({ minLength: 1, maxLength: 60 }),
        length_value: t.String({ minLength: 1, maxLength: 60 }),
        length_unit: t.String({ minLength: 1, maxLength: 60 }),
        weight_kg: t.String({ minLength: 1, maxLength: 60 }),
      }),
    ),
    version: t.Number({ minimum: 0 }),
  }),
  "product.update": t.Object({
    name: t.String({ minLength: 1, maxLength: 60 }),
    variants: t.Array(
      t.Object({
        id: t.Optional(t.Number({ minimum: 1 })),
        name: t.String({ minLength: 1, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 255 })),
        sku: t.String({ minLength: 1, maxLength: 60 }),
        price: t.String({ pattern: "^(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$", maxLength: 12 }),
        unit: t.String({ minLength: 1, maxLength: 60 }),
        width_value: t.String({ minLength: 1, maxLength: 60 }),
        width_unit: t.String({ minLength: 1, maxLength: 60 }),
        length_value: t.String({ minLength: 1, maxLength: 60 }),
        length_unit: t.String({ minLength: 1, maxLength: 60 }),
        weight_kg: t.String({ minLength: 1, maxLength: 60 }),
      }),
    ),
    version: t.Number({ minimum: 0 }),
  }),
});
