import Elysia, { t } from "elysia";

export const productModel = new Elysia().model({
  "product.create": t.Object({
    name: t.String({ minLength: 1, maxLength: 60 }),
    variants: t.Array(
      t.Object({
        name: t.String({ minLength: 1, maxLength: 60 }),
        sku: t.String({ minLength: 1, maxLength: 60 }),
        price: t.String({ minLength: 1, maxLength: 60 }),
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
        id: t.Number(),
        name: t.String({ minLength: 1, maxLength: 60 }),
        sku: t.String({ minLength: 1, maxLength: 60 }),
        price: t.String({ minLength: 1, maxLength: 60 }),
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
